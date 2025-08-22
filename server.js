// server.js — Roameo Resorts omni-channel bot (FB + IG)
// GPT generates EVERY reply (comments + DMs) in the user's language.
// Public comments: never post numeric prices. Price comments must push DM with a strong discount hook.
// IG comments: show phone number 03558000078 (no WA link).
// FB comments + all DMs: use WhatsApp link https://wa.me/923558000078.
// DMs: include discounted prices. Influencers: route to WhatsApp/number.
// Voice: we/us/our. Self-reply guards included.

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV & CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// OpenAI (required for GPT replies)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// IG token (re-uses PAGE token if not set)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Feature toggles
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY = String(process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

// Brand & business facts
const BRAND = 'Roameo Resorts';
const SITE_URL = 'https://www.roameoresorts.com/';
const MAPS_LINK = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';
const CHECKIN_TIME = process.env.CHECKIN_TIME || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Contact policy
const WA_LINK = 'https://wa.me/923558000078'; // FB comments + all DMs
const IG_PUBLIC_NUMBER = '03558000078';       // IG comments only

// Self-reply guard (fill as needed)
const SELF_IG_USERNAMES = ['roameoresorts']; // IG username(s) to ignore
const SELF_FB_PAGE_IDS = [];                  // FB Page IDs to ignore (strings)

// Guards
if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY not set. GPT replies require it.');
}

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });   // 30m

/* =========================
   BASIC / VERIFY
   ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* =========================
   SECURITY
   ========================= */
function verifySignature(req) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody || !APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

/* =========================
   WEBHOOK RECEIVE
   ========================= */
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  const body = req.body || {};
  try {
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        const key = `page:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            await routeMessengerEvent(ev, { source: 'messaging' }).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            await routePageChange(change).catch(logErr);
          }
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            await routeMessengerEvent(ev, { source: 'standby' }).catch(logErr);
          }
        }
      }
      return;
    }

    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        const pageId = entry.id;
        const key = `ig:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            await routeInstagramMessage(ev).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            await routeInstagramChange(change, pageId).catch(logErr);
          }
        }
      }
      return;
    }

    console.log('📦 UNKNOWN OBJECT:', JSON.stringify(body));
  } catch (e) { logErr(e); }
});

function logErr(err) {
  console.error('💥 Handler error:', err?.response?.data || err.message || err);
}

/* =========================
   LANGUAGE DETECTION
   ========================= */
function detectLanguage(text = '') {
  const t = (text || '').trim();
  if (!t) return 'en';

  // Urdu script (Arabic block)
  const hasUrduScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (hasUrduScript) return 'ur';

  // Roman-Urdu heuristics
  const romanHits = [
    /\b(aap|ap|apka|apki|apke|tum|bhai|plz|pls)\b/i,
    /\b(kia|kya|kyun|kaise|krna|karna|krdo|kardo|raha|rha|rhe|rahe|gi|ga|hain|hy|hai)\b/i,
    /\b(mein|mai|mujhe|yahan|wahan|acha|accha|bohat|bahut|kitna|kitni|din|rat)\b/i,
  ].reduce((c, rx) => c + (rx.test(t) ? 1 : 0), 0);

  const englishHits = [
    /\b(the|and|is|are|you|we|from|how|where|price|rate|book|available|distance|road|flood|weather)\b/i
  ].reduce((c, rx) => c + (rx.test(t) ? 1 : 0), 0);

  if (romanHits >= 1 && englishHits <= 3) return 'roman-ur';
  return 'en';
}

/* =========================
   INTENTS
   ========================= */
function isPricingIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(price|prices|rate|rates|cost|charges?|tariff|per\s*night|room|rooms|kitna|kitni)\b/.test(t);
}
function isRoadConditionIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(road|roads|route|rasta|raasta)\b/.test(t) &&
         /\b(condition|status|flood|barish|rain|landslide|cloud\s*burst|cloudburst|cloud\s*brust|cloudbrust)\b/.test(t);
}
function isInfluencerIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(influencer|creator|blogger|vlogger|collab|barter|pr|sponsor|ambassador|review|shoot)\b/.test(t);
}
function isContactIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(whatsapp|contact|number|phone|ping|reach|call|dm|inbox|message)\b/.test(t) ||
         /واٹس\s*ایپ|رابطہ|نمبر|کال/i.test(text);
}
function isQuestionLike(text = '') {
  const t = text.toLowerCase();
  if (/\?/.test(t)) return true;
  return /\b(how|where|when|what|which|can|do|does|are|is|distance|weather|available|availability|book|booking)\b/i.test(t);
}

/* =========================
   GPT HELPERS
   ========================= */
async function gptGenerate({ userText, lang, surface, platform, intent }) {
  const isComment = surface === 'comment';
  const isDM = surface === 'dm';
  const onIG = platform === 'instagram';
  const onFB = platform === 'facebook';

  const langGuide = {
    en: 'Write natural, clear English.',
    ur: 'براہِ کرم رواں اردو میں لکھیں۔',
    'roman-ur': 'Roman Urdu (Urdu in English letters) mein likhein.'
  }[lang] || 'Write natural, clear English.';

  // Hard business rules injected into system
  const system = `
You are ${BRAND}'s assistant. ${langGuide}

ALWAYS:
- Mirror the user's language (${lang}).
- Use "we/us/our", never "I/me/my".
- Keep replies concise, friendly, brand-focused on ${BRAND} (not generic tourism).
- Mention we're a boutique riverside stay with cozy riverfront huts and great mountain scenery.

SURFACE:
- Surface: ${surface} (${isComment ? 'public comment' : 'direct message'})
- Platform: ${platform}

PUBLIC PRICE POLICY (comments only):
- ${isComment ? 'NEVER include numeric prices, currency, or discounts with numbers in public.' : 'DM is private — you MAY include prices if requested.'}

CONTACT LINES (must include ONE relevant line when appropriate):
- Instagram comments: use phone number only: ${IG_PUBLIC_NUMBER} (no WhatsApp link).
- Facebook comments and ALL DMs: use WhatsApp link: ${WA_LINK}.

PRICE QUERIES:
- If the user asks about price in a PUBLIC COMMENT:
  - Start with a strong hook that discounts are live (unique phrasing).
  - Tell them to DM for **discounted prices**.
  - Include the correct contact line (per platform).
  - Do NOT include numeric prices publicly.
- If it’s a DM price query:
  - State clearly that these are **discounted prices** and list the table below (verbatim numbers allowed in DM).
  - Include WhatsApp link at the end.

DISCOUNTED PRICE TABLE (DM only — include only in DMs when relevant):
• Deluxe Hut — PKR 30,000/night
  • 1st Night 10% → PKR 27,000
  • 2nd Night 15% → PKR 25,500
  • 3rd Night 20% → PKR 24,000
• Executive Hut — PKR 50,000/night
  • 1st Night 10% → PKR 45,000
  • 2nd Night 15% → PKR 42,500
  • 3rd Night 20% → PKR 40,000
T&Cs: taxes included • breakfast for 4 • 50% advance to confirm.

ROAD CONDITION QUERIES:
- Acknowledge weather/landslide concern, say roads are generally carpeted/open, mention small water crossing near resort and free 4×4 assist for elderly. Invite user to contact (proper line by platform) for the latest status.

INFLUENCER QUERIES (DM):
- Thank them and route to WhatsApp/number for collaborations.

OUTPUT:
- ONE short paragraph (or a couple of short lines). Keep it social-friendly.
- NO markdown formatting.
- STRICTLY follow the contact/price rules above.
`.trim();

  const user = `
User message (language=${lang}, surface=${surface}, platform=${platform}):
"${String(userText).slice(0, 800)}"

Intent flags:
${JSON.stringify(intent)}
`.trim();

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.8,
    top_p: 0.9,
    presence_penalty: 0.2,
    frequency_penalty: 0.2,
    max_tokens: 260,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers, timeout: 12000 });
    const txt = data?.choices?.[0]?.message?.content?.trim();
    return txt || '';
  } catch (e) {
    logErr(e);
    return '';
  }
}

function sanitizeVoice(text = '') {
  return (text || '')
    .replace(/\bI['’]?m\b/gi, 'we are')
    .replace(/\bI am\b/gi, 'we are')
    .replace(/\bI['’]?ll\b/gi, 'we will')
    .replace(/\bI['’]?ve\b/gi, 'we have')
    .replace(/\bI['’]?d\b/gi, 'we would')
    .replace(/\bI\b/gi, 'we')
    .replace(/\bme\b/gi, 'us')
    .replace(/\bmy\b/gi, 'our')
    .replace(/\bmine\b/gi, 'ours')
    .replace(/\bRoameo\s+Resort\b/gi, BRAND);
}

// Public: drop explicit price/currency lines. Keep contact lines.
function sanitizeCommentNoPrices(text = '') {
  const hasCurrency = (s) => /(pkr|rs\.?|rupees|price|prices|rate|rates|tariff|per\s*night|\/night|\b\d{1,3}(?:[ ,.]?\d{3})+\b)/i.test(s);
  const isPhone = (s) => /(\b0?\d[\d\s\-()]{6,}\b)/.test(s);
  const isWa = (s) => /wa\.me|whatsapp/i.test(s);

  const lines = (text || '').split(/\r?\n/);
  const kept = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (hasCurrency(l)) continue;
    if (isPhone(l) || isWa(l)) { kept.push(l); continue; }
    kept.push(l);
  }
  return kept.join('\n').trim() || 'Please DM us for discounted prices.';
}

/* =========================
   FB MESSENGER (DMs)
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging' }) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) await takeThreadControl(event.sender.id).catch(() => {});
    return handleTextMessage(event.sender.id, event.message.text || '', { channel: 'facebook' });
  }
  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', { channel: 'facebook' });
  }
}

/* =========================
   FB PAGE COMMENTS
   ========================= */
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  await axios.post(url, { message }, { params, timeout: 10000 });
}

async function routePageChange(change) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item !== 'comment' || !v.comment_id) return;

  // self-reply guard
  if (v.from?.id && SELF_FB_PAGE_IDS.includes(String(v.from.id))) return;

  const text = (v.message || '').trim();
  const lang = detectLanguage(text);
  if (v.verb && v.verb !== 'add') return;

  const intent = {
    pricing: isPricingIntent(text),
    road: isRoadConditionIntent(text),
    influencer: isInfluencerIntent(text),
    contact: isContactIntent(text),
    question_like: isQuestionLike(text)
  };

  try {
    if (intent.pricing) {
      // DM with prices
      try {
        const dm = await gptGenerate({ userText: text, lang, surface: 'dm', platform: 'facebook', intent });
        await fbPrivateReplyToComment(v.comment_id, sanitizeVoice(dm) || 'Please check your inbox for discounted prices.');
      } catch (e) { logErr(e); }
      // Public hook (no numbers)
      const pub = await gptGenerate({ userText: text, lang, surface: 'comment', platform: 'facebook', intent });
      return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(sanitizeVoice(pub)));
    }

    // Non-price comments → GPT public reply (no numbers)
    const pub = await gptGenerate({ userText: text, lang, surface: 'comment', platform: 'facebook', intent });
    return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(sanitizeVoice(pub)));
  } catch (e) { logErr(e); }
}

/* =========================
   INSTAGRAM (DMs + comments)
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    return handleTextMessage(igUserId, event.message.text || '', { channel: 'instagram' });
  }
}

async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
  const payload = { recipient: { comment_id: commentId }, message: { text: message } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const field = change.field || '';
  const isComment = field === 'comments' || field.toLowerCase().includes('comment') || (v.item === 'comment');
  if (!isComment) return;

  const commentId = v.comment_id || v.id;
  if (!commentId) return;

  // self-reply guard (by username)
  const fromUsername = (v.from && (v.from.username || v.from.name)) || '';
  if (fromUsername && SELF_IG_USERNAMES.map(s => s.toLowerCase()).includes(fromUsername.toLowerCase())) return;

  const text = (v.text || v.message || '').trim();
  const lang = detectLanguage(text);
  if (v.verb && v.verb !== 'add') return;

  const intent = {
    pricing: isPricingIntent(text),
    road: isRoadConditionIntent(text),
    influencer: isInfluencerIntent(text),
    contact: isContactIntent(text),
    question_like: isQuestionLike(text)
  };

  try {
    if (intent.pricing) {
      // Try DM with prices (capability/permission may fail)
      try {
        const dm = await gptGenerate({ userText: text, lang, surface: 'dm', platform: 'instagram', intent });
        await igPrivateReplyToComment(pageId, commentId, sanitizeVoice(dm) || 'Please check your inbox for discounted prices.');
      } catch (e) {
        logErr({ where: 'IG private reply failed; public only', err: e?.response?.data || e.message });
      }
      // Public hook (no numbers; include IG number instead of WA link)
      const pub = await gptGenerate({ userText: text, lang, surface: 'comment', platform: 'instagram', intent });
      return replyToInstagramComment(commentId, sanitizeCommentNoPrices(sanitizeVoice(pub)));
    }

    // Non-price comments → GPT public reply (no numbers)
    const pub = await gptGenerate({ userText: text, lang, surface: 'comment', platform: 'instagram', intent });
    return replyToInstagramComment(commentId, sanitizeCommentNoPrices(sanitizeVoice(pub)));
  } catch (e) { logErr(e); }
}

/* =========================
   SHARED DM HANDLER
   ========================= */
async function handleTextMessage(psid, text, opts = { channel: 'facebook' }) {
  if (!AUTO_REPLY_ENABLED) return;

  const lang = detectLanguage(text);
  const intent = {
    pricing: isPricingIntent(text),
    road: isRoadConditionIntent(text),
    influencer: isInfluencerIntent(text),
    contact: isContactIntent(text),
    question_like: isQuestionLike(text)
  };

  try {
    const reply = await gptGenerate({ userText: text, lang, surface: 'dm', platform: opts.channel, intent });
    const safe = sanitizeVoice(reply) || (opts.channel === 'instagram'
      ? `For details please contact us at ${IG_PUBLIC_NUMBER}.`
      : `For details please WhatsApp us: ${WA_LINK}`);

    await sendText(psid, safe);
  } catch (e) { logErr(e); }
}

/* =========================
   SEND API
   ========================= */
async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* =========================
   HANDOVER (optional)
   ========================= */
async function takeThreadControl(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/take_thread_control';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  try { await axios.post(url, { recipient: { id: psid } }, { params, timeout: 10000 }); }
  catch (e) { logErr(e); }
}

/* =========================
   ADMIN HELPERS
   ========================= */
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/admin/subscribe', requireAdmin, async (_req, res) => {
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
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const { data } = await axios.post(url, { subscribed_fields }, { params, timeout: 10000 });
    res.json({ ok: true, data, subscribed_fields });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.get('/admin/status', requireAdmin, async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN, fields: 'subscribed_fields' };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    res.json({
      ok: true,
      subscribed_apps: data,
      env: {
        AUTO_REPLY_ENABLED,
        ALLOW_REPLY_IN_STANDBY,
        AUTO_TAKE_THREAD_CONTROL,
        OPENAI_ENABLED: Boolean(OPENAI_API_KEY),
        BRAND,
        SITE_URL,
        MAPS_LINK,
        CHECKIN_TIME,
        CHECKOUT_TIME,
        WA_LINK,
        IG_PUBLIC_NUMBER
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
