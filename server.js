const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const LRU = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 10000;

// ===== ENV VARS (already set in Render) =====
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Raw body for signature check
app.use(bodyParser.json({ verify: (req, _, buf) => { req.rawBody = buf; }}));

// Simple idempotency (Meta retries)
const dedupe = new LRU({ max: 5000, ttl: 1000 * 60 * 60 });

// Health
app.get('/', (_, res) => res.send('Roameo AutoReplyBot running'));

// Verify webhook (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Signature verify helper
function verifySignature(req) {
  const sig = req.headers['x-hub-signature-256']; // "sha256=..."
  if (!sig || !req.rawBody || !APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Webhook receive (POST)
app.post('/webhook', async (req, res) => {
  // ack fast
  res.sendStatus(200);

  if (!verifySignature(req)) { console.error('❌ Signature verification failed'); return; }
  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    const key = `${entry.id}:${entry.time}`;
    if (dedupe.has(key)) continue;
    dedupe.set(key, true);

    for (const event of entry.messaging || []) {
      if (event.message && event.sender?.id) {
        handleMessage(event).catch(err => console.error('❌ Handler error:', err?.response?.data || err.message));
      }
    }
  }
});

// === Core: route + ChatGPT ===
async function handleMessage(event) {
  const psid = event.sender.id;
  const text = (event.message.text || '').trim();

  if (!text) { await sendText(psid, 'Thanks for contacting Roameo Resorts! How can I help today?'); return; }

  // quick wins
  const lower = text.toLowerCase();
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

  const systemPrompt = `
You are Roameo Resorts' helpful assistant.
- Tone: friendly, concise, professional.
- Never invent availability, prices, or policies.
- For rates/availability/booking, ALWAYS direct to https://www.roameoresorts.com/.
- Location: Naran. Check-in 3 pm, check-out 11 am.
- If unrelated to Roameo Resorts, politely redirect and share the website link.
- Keep replies under 80 words unless asked for more.
  `.trim();

  const reply = await chatGPT(systemPrompt, text).catch(() => null);
  const finalText = reply?.trim() || 'Thanks for reaching out! For bookings and details: https://www.roameoresorts.com/';
  await sendText(psid, finalText);
}

// OpenAI chat
async function chatGPT(systemPrompt, userText) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
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

// Messenger Send API helpers
async function sendTyping(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, sender_action: 'typing_on' };
  try { await axios.post(url, payload, { params, timeout: 8000 }); } catch {}
}
async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
