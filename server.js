// server.js — Roameo Resorts omni-channel bot (FB + IG)
// Deterministic intents for public replies; optional GPT for DMs only.
// Public: no numeric prices (policy). DM: send discounted prices.
// Brand-first voice (we/us/our). WhatsApp-first contact routing.
// Self-reply guard so the bot never replies to its own comments.

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

// OpenAI (optional; used only for general DMs)
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

// BUSINESS FACTS (edit here)
const BRAND_NAME = 'Roameo Resorts';
const SITE_URL = 'https://www.roameoresorts.com/';
const MAPS_LINK = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';
const CHECKIN_TIME = process.env.CHECKIN_TIME || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Contact (NO new envs required, hard-coded as requested)
const WHATSAPP_LINK = 'https://wa.me/923558000078';

// To avoid self-replies on IG/FB comments (adjust if needed)
const SELF_IG_USERNAMES = ['roameoresorts']; // your IG handle(s)
const SELF_FB_PAGE_IDS = []; // optional: your FB page IDs (string)

// Guards
if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}

/* =========================
   REPLY TEMPLATES
   ========================= */
const REPLY_TEMPLATES = {
  // DMs only (include discounted prices)
  dm_prices_en: `
Here are our **discounted** soft-launch prices:

• Deluxe Hut — PKR 30,000/night  
  • 1st Night 10% → PKR 27,000  
  • 2nd Night 15% → PKR 25,500  
  • 3rd Night 20% → PKR 24,000

• Executive Hut — PKR 50,000/night  
  • 1st Night 10% → PKR 45,000  
  • 2nd Night 15% → PKR 42,500  
  • 3rd Night 20% → PKR 40,000

T&Cs: taxes included • breakfast for 4 • 50% advance to confirm.

For the fastest help, please WhatsApp us: ${WHATSAPP_LINK}  
Or you can visit: ${SITE_URL}
`.trim(),

  // Public comments: never include numeric prices
  public_prices_note_en: `We’ve sent you our **discounted prices** via DM. For quick help, please WhatsApp us: ${WHATSAPP_LINK}`,

  // Road condition (public or DM)
  road_en: `
Roads to ${BRAND_NAME} are generally open and fully carpeted. Near the resort there’s a small water crossing; our team provides free 4×4 jeep assist for elderly guests. After heavy rain or landslides, please ping us on WhatsApp for a quick status update before you travel: ${WHATSAPP_LINK}
`.trim(),

  // Contact line
  contact_en: `For details, please WhatsApp our team: ${WHATSAPP_LINK}`,

  // General fallback (public)
  public_default_en: `Thanks! If you have any questions about ${BRAND_NAME}, just ask. For quick assistance: ${WHATSAPP_LINK}`,

  // General fallback (DM)
  dm_default_en: `
Thanks for reaching out to ${BRAND_NAME}! We’re a boutique riverside escape with cozy riverfront huts, warm hospitality, and beautiful mountain scenery.  
If you’d like help with dates, routes, or choosing a hut, just tell us how we can help.  
Quickest support: ${WHATSAPP_LINK} • More info: ${SITE_URL}
`.trim(),

  // Influencer (DM)
  influencer_dm_en: `
Thanks for reaching out! For collaborations, PR, or shoots, please contact our team on WhatsApp: ${WHATSAPP_LINK}
`.trim()
};

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });   // 30m/session

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
    // Facebook Page (Messenger + feed)
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

    // Instagram (DMs + comments)
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        const pageId = entry.id; // needed to private-reply to IG comments
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
  const payload = err?.response?.data || err?.message || err;
  console.error('💥 Handler error:', payload);
}

/* =========================
   INTENT DETECTORS
   ========================= */
function isPricingIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(rate|price|prices|cost|charges?|tariff|per\s*night|room|rooms|kitna|kitni)\b/i.test(t);
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
   SANITIZERS / HELPERS
   ========================= */
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
    .replace(/\bmine\b/gi, 'ours');
}
function sanitizeBrand(text = '') {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/\bRoameo\s+Resort\b/gi, BRAND_NAME);
  out = out.replace(/\b(see\s*(?:you)?\s*at|welcome\s*to)\s*Tehjian\s+Valley\b/gi, '$1 ' + BRAND_NAME);
  return out;
}
// Public: keep WhatsApp/phone lines, strip pricing lines only
function sanitizeCommentNoPrices(text = '', lang = 'en') {
  let out = sanitizeVoice(sanitizeBrand(text || ''));

  const hasCurrencyWord = (s) => /(pkr|rs\.?|rupees|price|prices|rate|rates|tariff|per\s*night|\/night\b)/i.test(s);
  const looksLikeMoney = (s) => /\b\d{1,3}(?:[ ,.]?\d{3})+\b/.test(s); // 30,000 / 30000
  const isWhatsAppLine = (s) => /wa\.me|whatsapp/.test(s);
  const isPhoneLine   = (s) => /(\+?\d[\d\s\-()]{6,})/.test(s);

  const safe = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const l = line.toLowerCase();

    // Keep contact lines unless they explicitly mention price keywords
    if ((isWhatsAppLine(l) || isPhoneLine(l)) && !hasCurrencyWord(l)) {
      safe.push(line);
      continue;
    }
    // Drop explicit price/currency context
    if (hasCurrencyWord(l)) continue;

    // Big numbers without currency context are fine
    if (looksLikeMoney(l)) {
      safe.push(line);
      continue;
    }

    safe.push(line);
  }

  out = safe.join('\n').trim();
  if (!out) return `Thanks! For details, please WhatsApp us: ${WHATSAPP_LINK}`;
  return out;
}

/* =========================
   FB MESSENGER (DMs)
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging' }) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) await takeThreadControl(event.sender.id).catch(() => {});
    return handleTextMessage(event.sender.id, event.message.text || '', { channel: 'messenger' });
  }
  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', { channel: 'messenger' });
  }
}

/* =========================
   FB PAGE COMMENTS (feed)
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

  // Self-reply guard (FB): skip if commenter is page itself
  if (v.from?.id && SELF_FB_PAGE_IDS.includes(String(v.from.id))) return;

  const text = (v.message || '').trim();
  if (v.verb && v.verb !== 'add') return;

  try {
    // Pricing asked publicly → DM + public note w/ WhatsApp
    if (isPricingIntent(text)) {
      let dmOk = false;
      try {
        await fbPrivateReplyToComment(v.comment_id, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.dm_prices_en)));
        dmOk = true;
      } catch (e) { logErr(e); }
      const publicMsg = dmOk
        ? REPLY_TEMPLATES.public_prices_note_en
        : `Please DM or WhatsApp us for **discounted** prices: ${WHATSAPP_LINK}`;
      return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(publicMsg));
    }

    // Road conditions → deterministic helpful line
    if (isRoadConditionIntent(text)) {
      return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(REPLY_TEMPLATES.road_en));
    }

    // Contact intent → always show WhatsApp
    if (isContactIntent(text)) {
      return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(REPLY_TEMPLATES.contact_en));
    }

    // Generic question-like → safe helpful fallback (no prices)
    if (AUTO_REPLY_ENABLED && isQuestionLike(text)) {
      return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(REPLY_TEMPLATES.public_default_en));
    }

    // Non-question chatter → brief brand-safe line
    if (AUTO_REPLY_ENABLED) {
      return replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(REPLY_TEMPLATES.public_default_en));
    }
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

  // Self-reply guard (IG): skip if our own account posted the comment
  const fromUsername = (v.from && (v.from.username || v.from.name)) || '';
  if (fromUsername && SELF_IG_USERNAMES.map(s => s.toLowerCase()).includes(fromUsername.toLowerCase())) return;

  const text = (v.text || v.message || '').trim();
  if (v.verb && v.verb !== 'add') return;

  try {
    if (isPricingIntent(text)) {
      let dmOk = false;
      try {
        await igPrivateReplyToComment(pageId, commentId, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.dm_prices_en)));
        dmOk = true;
      } catch (e) {
        // Capability error → fallback to public WhatsApp
        logErr({ where: 'IG private reply failed; falling back to public', err: e?.response?.data || e.message });
      }
      const publicMsg = dmOk
        ? REPLY_TEMPLATES.public_prices_note_en
        : `Please DM or WhatsApp us for **discounted** prices: ${WHATSAPP_LINK}`;
      return replyToInstagramComment(commentId, sanitizeCommentNoPrices(publicMsg));
    }

    if (isRoadConditionIntent(text)) {
      return replyToInstagramComment(commentId, sanitizeCommentNoPrices(REPLY_TEMPLATES.road_en));
    }

    if (isContactIntent(text)) {
      return replyToInstagramComment(commentId, sanitizeCommentNoPrices(REPLY_TEMPLATES.contact_en));
    }

    if (AUTO_REPLY_ENABLED && isQuestionLike(text)) {
      return replyToInstagramComment(commentId, sanitizeCommentNoPrices(REPLY_TEMPLATES.public_default_en));
    }

    if (AUTO_REPLY_ENABLED) {
      return replyToInstagramComment(commentId, sanitizeCommentNoPrices(REPLY_TEMPLATES.public_default_en));
    }
  } catch (e) { logErr(e); }
}

/* =========================
   SHARED DM HANDLER
   ========================= */
async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  if (!AUTO_REPLY_ENABLED) {
    console.log('🤖 Auto-reply disabled — would send DM.');
    return;
  }

  try {
    // Influencer / Collab
    if (isInfluencerIntent(text)) {
      return sendText(psid, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.influencer_dm_en)));
    }
    // Pricing (DM allowed)
    if (isPricingIntent(text)) {
      return sendText(psid, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.dm_prices_en)));
    }
    // Road
    if (isRoadConditionIntent(text)) {
      return sendText(psid, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.road_en)));
    }
    // Contact
    if (isContactIntent(text)) {
      return sendText(psid, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.contact_en)));
    }

    // General DM → optional GPT with guardrails; else deterministic fallback
    if (OPENAI_API_KEY) {
      const reply = await gptGuardedDM(text);
      return sendText(psid, sanitizeVoice(sanitizeBrand(reply)));
    }

    // Fallback deterministic DM
    return sendText(psid, sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.dm_default_en)));
  } catch (e) { logErr(e); }
}

/* =========================
   GPT (optional, DMs only)
   ========================= */
async function gptGuardedDM(userText = '') {
  try {
    const systemPrompt = `
You are ${BRAND_NAME}'s assistant.
- Always speak as "we/us/our team" (never I/me/my).
- Do NOT mention numeric prices or currency in public; in DMs it's allowed, but this function is DM-only.
- Focus on ${BRAND_NAME} (brand-first). Mention Kashmir's scenic beauty when relevant.
- Helpful, specific, concise. If user asks off-topic (e.g., "Is Earth flat?"), give a short factual answer and softly pivot back to the brand.
- If user asks how to contact, include the WhatsApp line.
Return JSON: {"text": string, "requires_whatsapp_cta": boolean}.
    `.trim();

    const payload = {
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: String(userText).slice(0, 800) }
      ],
      temperature: 0.6,
      max_tokens: 220
    };

    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 12000
    });

    let obj = {};
    try { obj = JSON.parse(data?.choices?.[0]?.message?.content || '{}'); } catch {}
    let txt = (obj.text || '').trim() || REPLY_TEMPLATES.dm_default_en;
    if (obj.requires_whatsapp_cta) {
      txt += (txt.endsWith('\n') ? '' : '\n') + `WhatsApp (fastest): ${WHATSAPP_LINK}`;
    }
    return txt;
  } catch (e) {
    logErr(e);
    return REPLY_TEMPLATES.dm_default_en;
  }
}

/* =========================
   SEND API (Messenger + IG DMs)
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
        CHECKIN: CHECKIN_TIME,
        CHECKOUT: CHECKOUT_TIME,
        BRAND: BRAND_NAME,
        SITE_URL,
        MAPS_LINK,
        WHATSAPP_LINK
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
