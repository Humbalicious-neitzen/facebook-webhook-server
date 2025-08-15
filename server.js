// server.js (CommonJS)
// Roameo Resorts AutoReplyBot — Messenger + ChatGPT + standby support

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const LRU = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 10000;

// ===== ENV =====
const APP_SECRET = process.env.APP_SECRET;                   // Meta app secret
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;     // Page token (the one that returns name "Roameo Resorts" in /me)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;           // OpenAI key
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Optional behavior flags
const ALLOW_REPLY_IN_STANDBY = (process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
// If you're secondary (Page Inbox is primary), set this to "true" to call /take_thread_control before replying
const AUTO_TAKE_THREAD_CONTROL = (process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing env vars. Required: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN. ChatGPT requires OPENAI_API_KEY.');
}

// Capture raw body for HMAC verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Idempotency (Meta may retry deliveries)
const dedupe = new LRU({ max: 5000, ttl: 1000 * 60 * 60 }); // 1 hour

// ===== Healthcheck
app.get('/', (_req, res) => res.send('Roameo AutoReplyBot running'));

// ===== Webhook VERIFY (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== HMAC verify
function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256']; // "sha256=..."
  if (!signature || !req.rawBody || !APP_SECRET) return false;

  const expectedHash = crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  const expected = `sha256=${expectedHash}`;

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ===== Webhook RECEIVE (POST)
app.post('/webhook', async (req, res) => {
  // Ack immediately
  res.sendStatus(200);

  if (!verifySignature(req)) {
    console.error('❌ Signature verification failed');
    return;
  }

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    // Deduplicate per entry
    const entryKey = `${entry.id}:${entry.time}`;
    if (dedupe.has(entryKey)) continue;
    dedupe.set(entryKey, true);

    // Primary receiver events
    if (Array.isArray(entry.messaging)) {
      for (const event of entry.messaging) {
        routeEvent(event, { source: 'messaging' }).catch(logErr);
      }
    }

    // Secondary receiver (standby) events
    if (Array.isArray(entry.standby)) {
      for (const event of entry.standby) {
        routeEvent(event, { source: 'standby' }).catch(logErr);
      }
    }
  }
});

function logErr(err) {
  console.error('❌ Handler error:', err?.response?.data || err.message || err);
}

// ===== Router for message/delivery/read/postback/echo etc.
async function routeEvent(event, ctx = { source: 'messaging' }) {
  // Ignore delivery/read receipts
  if (event.delivery || event.read) return;

  // Ignore message echoes (messages you sent)
  if (event.message?.is_echo) return;

  // Handle text messages
  if (event.message && event.sender?.id) {
    // In standby, either ignore, take control, or reply depending on flags
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) {
      console.log('ℹ️ Standby message ignored (ALLOW_REPLY_IN_STANDBY=false)');
      return;
    }
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) {
      await takeThreadControl(event.sender.id).catch(() => {});
    }
    await handleMessage(event);
    return;
  }

  // Handle postbacks (if you add buttons later)
  if (event.postback && event.sender?.id) {
    await sendText(event.sender.id, 'Thanks for reaching out! How can I help today?');
  }

  // Log anything else for visibility
  console.log('📩 Incoming webhook payload:');
  console.dir({ object: 'page', entry: [{ messaging: [event] }] }, { depth: null });
}

// ===== Core: handle incoming text with rules + ChatGPT fallback
async function handleMessage(event) {
  const psid = event.sender.id;
  const text = (event.message.text || '').trim();

  console.log('✅ PSID:', psid);
  if (text) console.log('💬 Message Text:', text);

  if (!text) {
    await sendText(psid, 'Thanks for contacting Roameo Resorts! How can I help today?');
    return;
  }

  const lower = text.toLowerCase();

  // Quick intent shortcuts (fast answers without LLM)
  if (/\brate|price|cost|room\b/.test(lower)) {
    return sendText(psid, 'You can view current rates and availability here: https://www.roameoresorts.com/');
  }
  if (/\blocation|where|address|map|directions\b/.test(lower)) {
    return sendText(psid, 'We’re located in Naran. Directions & details: https://www.roameoresorts.com/');
  }
  if (lower.includes('check-in') || lower.includes('checkin') || lower.includes('check out') || lower.includes('checkout')) {
    return sendText(psid, 'Check-in is 3 pm and check-out is 11 am. For bookings: https://www.roameoresorts.com/');
  }

  await sendTyping(psid);

  // Guardrailed system prompt
  const systemPrompt = `
You are Roameo Resorts' helpful assistant.
- Tone: friendly, concise, professional.
- Never invent availability, prices, or policies.
- For rates/availability/booking, ALWAYS direct to https://www.roameoresorts.com/.
- Location: Naran. Check-in 3 pm, check-out 11 am.
- If unrelated to Roameo Resorts, politely redirect and share the website link.
- Keep replies under 80 words unless asked for more.
  `.trim();

  let finalText = 'Thanks for reaching out! For bookings and details: https://www.roameoresorts.com/';
  if (OPENAI_API_KEY) {
    try {
      const ai = await chatGPT(systemPrompt, text);
      if (ai && ai.trim()) finalText = ai.trim();
    } catch (e) {
      console.error('⚠️ OpenAI error:', e?.response?.data || e.message);
    }
  }
  await sendText(psid, finalText);
}

// ===== OpenAI helper
async function chatGPT(systemPrompt, userText) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  };
  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ],
    temperature: 0.3,
    max_tokens: 200
  };
  const { data } = await axios.post(url, payload, { headers, timeout: 10000 });
  return data?.choices?.[0]?.message?.content || null;
}

// ===== Messenger Send API helpers
async function sendTyping(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, sender_action: 'typing_on' };
  try { await axios.post(url, payload, { params, timeout: 8000 }); } catch {}
}

async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text }
  };
  try {
    await axios.post(url, payload, { params, timeout: 10000 });
  } catch (err) {
    console.error('❌ Send API error:', err?.response?.data || err.message);
    throw err;
  }
}

// ===== Handover Protocol (optional)
async function takeThreadControl(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/take_thread_control';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid } };
  try {
    await axios.post(url, payload, { params, timeout: 10000 });
    console.log('🤝 Took thread control for', psid);
  } catch (err) {
    console.error('❌ take_thread_control error:', err?.response?.data || err.message);
  }
}

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
