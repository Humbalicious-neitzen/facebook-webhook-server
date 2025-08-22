// server.js — Roameo Resorts omni-channel bot (Facebook + Instagram)
// Policy-locked replies for prices & roads, dynamic discount hooks, language
// mirroring, IG-number vs DM-link routing, and safe fallbacks.

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV / CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY = String(process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

// Brand / business
const BRAND = 'Roameo Resorts';
const SITE_URL = 'https://www.roameoresorts.com/';
const MAPS_LINK = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';
const CHECKIN_TIME = process.env.CHECKIN_TIME || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Contacts
const WA_LINK = 'https://wa.me/923558000078'; // FB comments + all DMs
const IG_PUBLIC_NUMBER = '03558000078';       // IG comments only

// Self-reply guards
const SELF_IG_USERNAMES = ['roameoresorts']; // add more if needed
const SELF_FB_PAGE_IDS = [];                  // string ids

/* ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });
const convo  = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });

app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

function verifySignature(req) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody || !APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

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
          for (const ev of entry.messaging) await routeMessengerEvent(ev, { source: 'messaging' }).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routePageChange(change).catch(logErr);
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) await routeMessengerEvent(ev, { source: 'standby' }).catch(logErr);
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
          for (const ev of entry.messaging) await routeInstagramMessage(ev).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routeInstagramChange(change, pageId).catch(logErr);
        }
      }
      return;
    }
    console.log('📦 UNKNOWN OBJECT:', JSON.stringify(body));
  } catch (e) { logErr(e); }
});

function logErr(err) {
  console.error('💥', err?.where || 'error', err?.response?.data || err.message || err);
}

/* =========================
   Language detection
   ========================= */
function detectLanguage(text = '') {
  const t = (text || '').trim();
  if (!t) return 'en';
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(t)) return 'ur'; // Urdu script
  const romanHits = [
    /\b(aap|ap|apka|apki|apke|tum|bhai|plz|pls)\b/i,
    /\b(kia|kya|kyun|kaise|krna|karna|krdo|kardo|raha|rha|rhe|rahe|gi|ga|hain|hy|hai)\b/i,
    /\b(mein|mai|mujhe|acha|accha|bohat|bahut|kitna|kitni|din|rat)\b/i
  ].reduce((n, rx) => n + (rx.test(t) ? 1 : 0), 0);
  const englishHits = [/\b(the|and|is|are|you|we|from|how|where|price|rate|road|weather)\b/i]
    .reduce((n, rx) => n + (rx.test(t) ? 1 : 0), 0);
  if (romanHits >= 1 && englishHits <= 3) return 'roman-ur';
  return 'en';
}

/* =========================
   Intents
   ========================= */
function isPricingIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(price|prices|rate|rates|cost|charges?|tariff|per\s*night|room|rooms|kitna|kitni)\b/.test(t);
}
function isRoadIntent(text = '') {
  const t = text.toLowerCase();
  const road = /\b(road|roads|route|rasta|raasta)\b/.test(t);
  const cond = /\b(condition|status|flood|barish|rain|landslide|cloud\s*burst|cloudburst|cloud\s*brust|cloudbrust)\b/.test(t);
  return road || cond;
}
function isInfluencerIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(influencer|creator|blogger|vlogger|collab|barter|pr|sponsor|ambassador|review|shoot)\b/.test(t);
}
function isQuestionLike(text = '') {
  const t = text.toLowerCase();
  if (/\?/.test(t)) return true;
  return /\b(how|where|when|what|which|can|do|does|are|is|distance|weather|available|availability|book|booking)\b/i.test(t);
}

/* =========================
   Hooks (unique each time)
   ========================= */
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function pickDiscountHook(lang) {
  if (lang === 'ur') {
    return pick([
      'آج ہی بک کریں—خصوصی ڈسکاؤنٹس محدود مدت کے لیے!',
      'خواب جیسی رہائش، قیمتیں مزید پرکشش!',
      'کشمیر کا لطف اب مزید مناسب قیمت پر!',
      'خوبصورت قیام، بجٹ فرینڈلی آفر کے ساتھ!',
      'ابھی میسج کریں—زبردست رعایتیں جاری ہیں!'
    ]);
  }
  if (lang === 'roman-ur') {
    return pick([
      'Aaj hi book karein — khaas discounts limited time ke liye!',
      'Dream stay, pocket-friendly offers!',
      'Kashmir ka safar, ab aur behtar rates par!',
      'Beautiful stay with budget-friendly deal!',
      'Abhi DM karein — zabardast discounts live!'
    ]);
  }
  return pick([
    'Escape now—limited-time resort discounts!',
    'Your mountain break just got more affordable!',
    'Premium huts, special rates running now!',
    'Unlock a scenic stay with live discounts!',
    'Book today—exclusive offers for your getaway!'
  ]);
}

/* =========================
   GPT generator (policy guided)
   ========================= */
async function gptGenerate({ userText, lang, surface, platform, intent }) {
  const isComment = surface === 'comment';
  const contactLine = (platform === 'instagram' && isComment) ? IG_PUBLIC_NUMBER : WA_LINK;

  const langGuide = {
    en: 'Write in natural English.',
    ur: 'رواں اور شائستہ اردو میں جواب دیں۔',
    'roman-ur': 'Roman Urdu (Urdu in English letters) mein likhein.'
  }[lang] || 'Write in natural English.';

  const system = `
You are ${BRAND}'s assistant. ${langGuide}
- Mirror the user's language (${lang}). Use "we/us/our", never "I/me/my".
- Keep it short, friendly, brand-forward.
SURFACE: ${surface} on ${platform}.

HARD RULES:
- If not a pricing query: DO NOT mention price, discount, PKR, rates, or "DM for prices".
- In public comments: NEVER include numeric prices.
- For routes/roads: keep it relevant to ${BRAND}.
- Always keep tone positive and helpful.
`.trim();

  const user = `User message: "${String(userText).slice(0,800)}"
Intent: ${JSON.stringify(intent)} | Contact hint: ${contactLine}
`;

  if (!OPENAI_API_KEY) {
    // Small, safe fallback if OpenAI is off.
    return (lang === 'ur')
      ? 'ہم مدد کے لیے دستیاب ہیں—براہِ کرم بتائیں کس بارے میں رہنمائی چاہیے۔'
      : (lang === 'roman-ur'
        ? 'Hum madad ke liye yahan hain — batayein kis cheez mein help chahiye.'
        : 'We’re here to help—what can we share for you?');
  }

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.9,
    top_p: 0.9,
    max_tokens: 220,
    presence_penalty: 0.2,
    frequency_penalty: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };

  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', payload, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 12000
    });
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) { logErr(e); return ''; }
}

/* =========================
   Post-filters
   ========================= */
function sanitizeVoice(text='') {
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
const PRICE_WORD = /\b(price|prices|rate|rates|tariff|per\s*night|discount|PKR|rupees|rs\.?)\b/i;
const CURRENCY_NUM = /\b\d{1,3}(?:[ ,.]?\d{3})+\b/;
function stripPublicPricesKeepContact(text='') {
  return text.split(/\r?\n/).filter(l => !(PRICE_WORD.test(l) || CURRENCY_NUM.test(l))).join('\n').trim();
}

/* =========================
   Intent enforcer (deterministic)
   ========================= */
function enforceIntent(text, intent, surface, platform, lang, contact) {
  // IG comments must show a plain number (links aren't clickable)
  if (surface === 'comment' && platform === 'instagram') contact = IG_PUBLIC_NUMBER;

  const hook = pickDiscountHook(lang);

  // Pricing
  if (intent?.pricing) {
    if (surface === 'comment') {
      if (lang === 'ur') return `${hook} براہِ کرم قیمت کے لیے ہمیں DM کریں۔`;
      if (lang === 'roman-ur') return `${hook} Prices ke liye humein DM karein, please.`;
      return `${hook} Please DM us for rates—discounted prices available.`;
    } else {
      if (lang === 'ur') return `یہ رعایتی قیمتیں ہیں۔ مزید مدد یا بکنگ کے لیے WhatsApp کریں: ${WA_LINK}\nWebsite: ${SITE_URL}`;
      if (lang === 'roman-ur') return `Yeh discounted prices hain. Madad/booking ke liye WhatsApp karein: ${WA_LINK}\nWebsite: ${SITE_URL}`;
      return `These are discounted prices. For help/booking, WhatsApp us: ${WA_LINK}\nWebsite: ${SITE_URL}`;
    }
  }

  // Roads (single, informative paragraph)
  if (intent?.road) {
    if (lang === 'ur') {
      return `وادی تک سڑکیں عموماً مکمل کارپٹڈ اور کھلی رہتی ہیں۔ ریزورٹ کے قریب ایک چھوٹا سا واٹر کراسنگ ہے؛ سیڈان پرائیویٹ پارکنگ (۱ منٹ واک) پر پارک کر سکتے ہیں۔ ہمارا عملہ سامان میں مدد کرتا ہے اور بزرگ مہمانوں کے لیے مفت 4×4 ٹرانسفر موجود ہے۔ تازہ صورتحال کے لیے رابطہ کریں: ${contact}`;
    }
    if (lang === 'roman-ur') {
      return `Valley tak roads aam tor par fully carpeted aur open hoti hain. Resort ke qareeb chhota water crossing hai; sedans private parking (1-minute walk) par park kar sakti hain. Team saman mein help karti hai aur elderly guests ke liye free 4×4 transfer available hai. Latest status ke liye rabta: ${contact}`;
    }
    return `Roads to the valley are generally fully carpeted for a smooth, scenic drive. Near the resort there’s a small water crossing; sedans can park at our private parking (1-minute walk). Our team helps with luggage and a free 4×4 transfer is available for elderly guests. For the latest status, please contact: ${contact}`;
  }

  // Influencer (in DMs)
  if (intent?.influencer && surface === 'dm') {
    if (lang === 'ur') return `کولیب/پارٹنرشپ کے لیے براہِ کرم اسی نمبر پر رابطہ کریں: ${WA_LINK} — ہماری ٹیم جلد جواب دے گی۔`;
    if (lang === 'roman-ur') return `Collab/partnership ke liye barah-e-mehrbani yahan rabta karein: ${WA_LINK} — team jald respond karegi.`;
    return `For collaborations/partnerships, please contact us here: ${WA_LINK} — our team will get back to you shortly.`;
  }

  // No hard rule matched → return null to allow GPT text.
  return null;
}

/* =========================
   FB DMs
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging' }) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) await takeThreadControl(event.sender.id).catch(()=>{});
    return handleTextMessage(event.sender.id, event.message.text || '', { channel: 'facebook' });
  }
  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', { channel: 'facebook' });
  }
}

/* =========================
   FB COMMENTS
   ========================= */
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}

async function routePageChange(change) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item !== 'comment' || !v.comment_id) return;
  if (v.from?.id && SELF_FB_PAGE_IDS.includes(String(v.from.id))) return; // self-guard
  if (v.verb && v.verb !== 'add') return;

  const text = (v.message || '').trim();
  const lang = detectLanguage(text);

  const intent = {
    pricing: isPricingIntent(text),
    road: isRoadIntent(text),
    influencer: isInfluencerIntent(text),
    question_like: isQuestionLike(text)
  };

  try {
    // For price & road: deterministic reply (no GPT drift)
    if (intent.pricing || intent.road) {
      const forcedComment = enforceIntent('', intent, 'comment', 'facebook', lang, WA_LINK);
      await replyToFacebookComment(v.comment_id, stripPublicPricesKeepContact(sanitizeVoice(forcedComment)));
      if (intent.pricing) {
        // Also send a private reply with the DM price note
        const dmLine = enforceIntent('', { pricing: true }, 'dm', 'facebook', lang, WA_LINK);
        await fbPrivateReplyToComment(v.comment_id, sanitizeVoice(dmLine));
      }
      return;
    }

    // Otherwise: GPT + enforcement
    const pub = await gptGenerate({ userText: text, lang, surface: 'comment', platform: 'facebook', intent });
    const forcedPub = enforceIntent(pub, intent, 'comment', 'facebook', lang, WA_LINK);
    return replyToFacebookComment(v.comment_id, stripPublicPricesKeepContact(sanitizeVoice(forcedPub || pub)));
  } catch (e) { logErr(e); }
}

/* =========================
   IG DMs + COMMENTS
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    return handleTextMessage(event.sender.id, event.message.text || '', { channel: 'instagram' });
  }
}

async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  // IG API requires the business to have permission; when it fails we just log and continue.
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const payload = { recipient: { comment_id: commentId }, message: { text: message } };
  await axios.post(url, payload, { params: { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN }, timeout: 10000 });
}

async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const isComment = (change.field === 'comments') || (v.item === 'comment') || (String(change.field||'').toLowerCase().includes('comment'));
  if (!isComment) return;

  const commentId = v.comment_id || v.id; if (!commentId) return;
  const fromUsername = (v.from && (v.from.username || v.from.name)) || '';
  if (fromUsername && SELF_IG_USERNAMES.some(u => u.toLowerCase() === fromUsername.toLowerCase())) return; // self-guard
  if (v.verb && v.verb !== 'add') return;

  const text = (v.text || v.message || '').trim();
  const lang = detectLanguage(text);

  const intent = {
    pricing: isPricingIntent(text),
    road: isRoadIntent(text),
    influencer: isInfluencerIntent(text),
    question_like: isQuestionLike(text)
  };

  try {
    if (intent.pricing || intent.road) {
      // Public deterministic reply
      const forcedPub = enforceIntent('', intent, 'comment', 'instagram', lang, IG_PUBLIC_NUMBER);
      await replyToInstagramComment(commentId, stripPublicPricesKeepContact(sanitizeVoice(forcedPub)));

      // Try DM (if permitted) for pricing only
      if (intent.pricing) {
        try {
          const dmLine = enforceIntent('', { pricing: true }, 'dm', 'instagram', lang, WA_LINK);
          await igPrivateReplyToComment(pageId, commentId, sanitizeVoice(dmLine));
        } catch (e) { logErr({ where:'IG price DM fail', err:e }); }
      }
      return;
    }

    // Otherwise GPT + enforcement
    const pub = await gptGenerate({ userText:text, lang, surface:'comment', platform:'instagram', intent });
    const forced = enforceIntent(pub, intent, 'comment', 'instagram', lang, IG_PUBLIC_NUMBER);
    return replyToInstagramComment(commentId, stripPublicPricesKeepContact(sanitizeVoice(forced || pub)));
  } catch (e) { logErr(e); }
}

/* =========================
   DMs (shared)
   ========================= */
async function handleTextMessage(psid, text, opts = { channel: 'facebook' }) {
  if (!AUTO_REPLY_ENABLED) return;

  const lang = detectLanguage(text);
  const intent = {
    pricing:    isPricingIntent(text),
    road:       isRoadIntent(text),
    influencer: isInfluencerIntent(text),
    question_like: isQuestionLike(text),
  };

  try {
    // For pricing/road in DM we still let GPT compose, then lock it with policy.
    const ai = await gptGenerate({
      userText: text,
      lang,
      surface: 'dm',
      platform: opts.channel === 'instagram' ? 'instagram' : 'facebook',
      intent
    });

    const contact = WA_LINK; // DMs can use clickable wa.me link
    const forced = enforceIntent(ai, intent, 'dm', opts.channel === 'instagram' ? 'instagram' : 'facebook', lang, contact);
    const finalText = sanitizeVoice(forced || ai) || (lang === 'ur'
      ? `مزید معلومات کے لیے WhatsApp کریں: ${WA_LINK}`
      : (lang === 'roman-ur'
        ? `Mazeed maloomat ke liye WhatsApp karein: ${WA_LINK}`
        : `For details, WhatsApp us here: ${WA_LINK}`));
    await sendText(psid, finalText);
  } catch (e) { logErr(e); }
}

async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* =========================
   HANDOVER + ADMIN
   ========================= */
async function takeThreadControl(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/take_thread_control';
  try { await axios.post(url, { recipient: { id: psid } }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 }); }
  catch (e) { logErr(e); }
}

function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.post('/admin/subscribe', requireAdmin, async (_req, res) => {
  const subscribed_fields = ['messages','messaging_postbacks','messaging_optins','message_deliveries','message_reads','feed'];
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const { data } = await axios.post(url, { subscribed_fields }, { params, timeout: 10000 });
    res.json({ ok: true, data, subscribed_fields });
  } catch (e) { res.status(500).json({ ok:false, error: e?.response?.data || e.message }); }
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
        OPENAI: Boolean(OPENAI_API_KEY),
        BRAND, SITE_URL, MAPS_LINK,
        CHECKIN_TIME, CHECKOUT_TIME,
        WA_LINK, IG_PUBLIC_NUMBER
      }
    });
  } catch (e) { res.status(500).json({ ok:false, error: e?.response?.data || e.message }); }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
