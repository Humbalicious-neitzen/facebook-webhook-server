// server.js — Roameo Resorts omni-channel bot
// FB DMs + FB comment replies + IG DMs + IG comment replies + ChatGPT + admin helpers

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 10000;

// ===== ENV =====
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // Page token for Roameo Resorts
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Toggle: turn auto-replies on/off without code changes
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'false').toLowerCase() === 'true';

// IG comment management token (long-lived USER token for the IG account owner)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Handover/standby flags
const ALLOW_REPLY_IN_STANDBY = String(process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

// Admin guard for helper endpoints
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // set to a random string in Render

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing env vars. Required: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('ℹ️ OPENAI_API_KEY not set. Will use canned replies only.');
}

// Keep raw body for HMAC verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Idempotency cache (Meta retries webhooks)
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1 hour

// Healthcheck
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));

// Webhook VERIFY (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// HMAC signature verify
function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256']; // "sha256=..."
  if (!signature || !req.rawBody || !APP_SECRET) return false;
  const expectedHash = crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  const expected = `sha256=${expectedHash}`;
  try {
    // constant-time compare
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Webhook RECEIVE (POST)
app.post('/webhook', async (req, res) => {
  // Verify signature BEFORE acknowledging to avoid processing spoofed payloads
  if (!verifySignature(req)) {
    console.error('❌ Signature verification failed');
    return res.sendStatus(403);
  }

  // Ack fast to satisfy Meta (then do async processing)
  res.sendStatus(200);

  const body = req.body;
  if (!body || !body.object) {
    console.log('🤷 Unknown webhook payload:', req.body);
    return;
  }

  try {
    // Facebook Page object (Messenger + Page feed)
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        const entryKey = `page:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(entryKey)) continue;
        dedupe.set(entryKey, true);

        // Messenger (primary)
        if (Array.isArray(entry.messaging)) {
          for (const event of entry.messaging) {
            console.log('📨 MESSAGING EVENT:', JSON.stringify(event));
            await routeMessengerEvent(event, { source: 'messaging' }).catch(logErr);
          }
        }

        // Page feed (comments, reactions, edits, deletes)
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            console.log('📰 FEED CHANGE:', JSON.stringify(change));
            await routePageChange(change).catch(logErr);
          }
        }

        // Messenger (standby / secondary receiver)
        if (Array.isArray(entry.standby)) {
          for (const event of entry.standby) {
            console.log('⏸️ STANDBY EVENT:', JSON.stringify(event));
            await routeMessengerEvent(event, { source: 'standby' }).catch(logErr);
          }
        }
      }
      return;
    }

    // Instagram object (IG DMs + comments)
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        const entryKey = `ig:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(entryKey)) continue;
        dedupe.set(entryKey, true);

        if (Array.isArray(entry.messaging)) {
          for (const event of entry.messaging) {
            console.log('📨 IG MESSAGING EVENT:', JSON.stringify(event));
            await routeInstagramMessage(event).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            console.log('🖼️ IG CHANGE:', JSON.stringify(change));
            await routeInstagramChange(change).catch(logErr);
          }
        }
      }
      return;
    }

    // Unknown object (log for visibility)
    console.log('📦 Incoming webhook payload (unknown object):', JSON.stringify(body));
  } catch (err) {
    logErr(err);
  }
});

function logErr(err) {
  console.error('💥 Handler error:', err?.response?.data || err.message || err);
}

/* =========================
   Facebook Messenger (DMs)
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging' }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  // Text messages
  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) {
      await takeThreadControl(event.sender.id).catch(() => {});
    }
    return handleTextMessage(event.sender.id, event.message.text || '', { channel: 'messenger' });
  }

  // Postbacks (if you use quick replies / buttons)
  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', { channel: 'messenger' });
  }

  console.log('ℹ️ Messenger event (unhandled):', JSON.stringify(event));
}

/* =========================
   Facebook Page comments (feed)
   ========================= */
async function routePageChange(change) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  const item = v.item; // 'comment', 'post', 'photo', etc.
  const verb = v.verb; // 'add', 'edited', 'remove', etc.

  // We want to show webhook payloads in logs for your video even if it's an edit/delete
  if (item === 'comment' && v.comment_id) {
    const commentId = v.comment_id;
    const text = (v.message || '').trim();
    console.log('💬 FB comment event:', { verb, commentId, text, parent_id: v.parent_id, post_id: v.post_id, from: v.from });

    if (verb !== 'add') return; // only auto-reply on new comments

    if (!AUTO_REPLY_ENABLED) {
      console.log('🤖 Auto-reply disabled — would reply to FB comment.');
      return;
    }
    const reply = await decideReply(text);
    await replyToFacebookComment(commentId, reply);
  }
}

async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { message };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* =========================
   Instagram DMs
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    return handleTextMessage(igUserId, event.message.text || '', { channel: 'instagram' });
  }

  console.log('ℹ️ IG messaging event (unhandled):', JSON.stringify(event));
}

/* =========================
   Instagram comments
   ========================= */
async function routeInstagramChange(change) {
  const v = change.value || {};
  const field = change.field || '';
  const isComment =
    field === 'comments' ||
    field.toLowerCase().includes('comment') ||
    (v.item === 'comment');

  if (isComment && (v.comment_id || v.id)) {
    const commentId = v.comment_id || v.id;
    const text = (v.text || v.message || '').trim();
    console.log('💬 IG comment event:', { field, verb: v.verb, commentId, text, media_id: v.media_id, from: v.from });

    if (v.verb && v.verb !== 'add') return; // only reply on new comments

    if (!AUTO_REPLY_ENABLED) {
      console.log('🤖 Auto-reply disabled — would reply to IG comment.');
      return;
    }
    const reply = await decideReply(text);
    await replyToInstagramComment(commentId, reply);
  }
}

async function replyToInstagramComment(commentId, message) {
  // IG replies use /{comment-id}/replies with a *user* token that can manage the IG biz account
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  const params = { access_token: IG_MANAGE_TOKEN };
  const payload = { message };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* =========================
   Shared text handling (DMs)
   ========================= */
async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  console.log('🧑 PSID:', psid);
  if (text) console.log('✉️ Message Text:', text);

  if (!AUTO_REPLY_ENABLED) {
    console.log('🤖 Auto-reply disabled — would send DM.');
    return;
  }

  const reply = await decideReply(text);
  await sendText(psid, reply);
}

/* =========================
   Reply logic (uses OpenAI only when enabled)
   ========================= */
async function decideReply(text) {
  const t = (text || '').toLowerCase();

  // Fast paths (no OpenAI)
  if (/\brate|price|cost|room\b/.test(t)) return 'You can view current rates and availability here: https://www.roameoresorts.com/';
  if (/\blocation|where|address|map|directions\b/.test(t)) return 'We’re located in Naran. Directions & details: https://www.roameoresorts.com/';
  if (t.includes('check-in') || t.includes('checkin') || t.includes('check out') || t.includes('checkout')) {
    return 'Check-in is 3 pm; check-out is 11 am. For bookings: https://www.roameoresorts.com/';
  }

  // If auto-replies are OFF or OpenAI key missing, use a safe canned reply (NO OpenAI calls)
  if (!AUTO_REPLY_ENABLED || !OPENAI_API_KEY) {
    return 'Thanks for reaching out! For bookings and details: https://www.roameoresorts.com/';
    }

  try {
    const systemPrompt = `
You are Roameo Resorts' helpful assistant.
- Tone: friendly, concise, professional.
- Never invent availability, prices, or policies.
- For rates/availability/booking, ALWAYS direct to https://www.roameoresorts.com/.
- Location: Naran. Check-in 3 pm, check-out 11 am.
- If unrelated to Roameo Resorts, politely redirect and share the website link.
- Keep replies under 80 words unless asked for more.
`.trim();

    const url = 'https://api.openai.com/v1/chat/completions';
    const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
    const payload = {
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text || '' }
      ],
      temperature: 0.3,
      max_tokens: 200
    };
    const { data } = await axios.post(url, payload, { headers, timeout: 10000 });
    const ai = data?.choices?.[0]?.message?.content?.trim();
    return ai || 'Thanks for reaching out! For bookings and details: https://www.roameoresorts.com/';
  } catch (e) {
    console.error('🧠 OpenAI error:', e?.response?.data || e.message);
    return 'Thanks for reaching out! For bookings and details: https://www.roameoresorts.com/';
  }
}

/* =========================
   Send API (Messenger + IG DMs)
   ========================= */
async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = {
    recipient: { id: psid },
    messaging_type: 'RESPONSE',
    message: { text }
  };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* =========================
   Handover Protocol (optional)
   ========================= */
async function takeThreadControl(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/take_thread_control';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid } };
  try {
    await axios.post(url, payload, { params, timeout: 10000 });
    console.log('🔁 Took thread control for', psid);
  } catch (err) {
    console.error('take_thread_control error:', err?.response?.data || err.message);
  }
}

/* =========================
   Admin helpers (subscribe & status)
   ========================= */
// Simple bearer auth for admin endpoints
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Subscribe the Page to all required fields (incl. feed) — run after deploy or token rotation
app.post('/admin/subscribe', requireAdmin, async (req, res) => {
  const subscribed_fields = [
    'messages',
    'messaging_postbacks',
    'messaging_optins',
    'message_deliveries',
    'message_reads',
    'feed'
  ];
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    // me/subscribed_apps accepts PAGE_ACCESS_TOKEN and applies to the Page behind the token
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const payload = { subscribed_fields };
    const { data } = await axios.post(url, payload, { params, timeout: 10000 });
    return res.json({ ok: true, data, subscribed_fields });
  } catch (e) {
    console.error('subscribe error:', e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

// Show current subscription + simple health
app.get('/admin/status', requireAdmin, async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN, fields: 'subscribed_fields' };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    return res.json({
      ok: true,
      subscribed_apps: data,
      env: {
        AUTO_REPLY_ENABLED,
        ALLOW_REPLY_IN_STANDBY,
        AUTO_TAKE_THREAD_CONTROL,
        OPENAI_ENABLED: Boolean(OPENAI_API_KEY)
      }
    });
  } catch (e) {
    console.error('status error:', e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
