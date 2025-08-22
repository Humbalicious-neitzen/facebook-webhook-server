// server.js — Roameo Resorts omni-channel bot (Facebook + Instagram)
// Rules enforced: language mirroring, no public prices, price-in-DM,
// unique discount hooks, informative road replies, platform-specific contacts,
// self-reply guards, and "never empty message" failsafe.

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
const APP_SECRET = process.env.APP_SECRET; // required for webhook signature
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN; // required for Graph API

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
const WA_LINK = 'https://wa.me/923558000078'; // Use in all DMs and FB comments private replies
const IG_PUBLIC_NUMBER = '03558000078';       // IG comments only (links not clickable)

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
   Utility: safe output & voice
   ========================= */
function safeOut(s, lang = 'en') {
  const t = (s || '').toString().trim();
  if (t.length) return t.slice(0, 1900);
  if (lang === 'ur') return 'براہِ کرم ہمیں DM کریں — ہم فوراً رہنمائی کریں گے۔';
  if (lang === 'roman-ur') return 'Meherbani karke humein DM karein — hum foran rehnumai karenge.';
  return 'Please DM us — we’ll help right away.';
}

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

// price scrub for public comments
const PRICE_WORD = /\b(price|prices|rate|rates|tariff|per\s*night|discount|PKR|rupees|rs\.?)\b/i;
const CURRENCY_NUM = /\b\d{1,3}(?:[ ,.]?\d{3})+\b/;

function stripPublicPricesKeepContact(text='') {
  return text
    .split(/\r?\n/)
    .filter(line => !(PRICE_WORD.test(line) || CURRENCY_NUM.test(line)))
    .join('\n')
    .trim();
}

/* =========================
   Unique discount hook generator
   ========================= */
const hooksEN = [
  'Escape today—exclusive resort discounts are live!',
  'Limited-time savings on your Roameo escape!',
  'Unlock special rates for your next stay.',
  'Your mountain retreat just got more affordable!',
  'Seasonal offers are on—don’t miss out!'
];
const hooksUR = [
  'خصوصی ڈسکاؤنٹس جاری ہیں—موقع ضائع نہ کریں!',
  'آپ کی رہائش پر شاندار رعایت—آج ہی معلوم کریں!',
  'رویمیو میں خاص آفرز—فائدہ اٹھائیں!',
  'پہاڑی قیام اب مزید مناسب قیمت میں!',
  'محدود مدت کی پیشکش—فوراً رابطہ کریں!'
];
const hooksRoman = [
  'Khaas discounts live hain—miss na karein!',
  'Roameo stay par zabardast savings!',
  'Limited-time offers—rates aur bhi behtareen!',
  'Mountain retreat ab aur affordable!',
  'Seasonal deals on—jaldi DM karein!'
];
function randomHook(lang='en') {
  const arr = lang === 'ur' ? hooksUR : lang === 'roman-ur' ? hooksRoman : hooksEN;
  return arr[Math.floor(Math.random() * arr.length)];
}

/* =========================
   GPT generator (with strict rules)
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
- Keep it short, friendly, brand-forward (always link back to ${BRAND}).
- SURFACE: ${surface} on ${platform}.

HARD RULES:
- If not a pricing query: DO NOT mention price, discount, PKR, rates, or "DM for prices".
- In public comments: NEVER include numeric prices.
- If pricing query in a public comment: open with a strong, unique discount hook (no numbers) and ask them to DM for discounted prices. Include this contact once: ${contactLine}.
- If pricing query in DM: you may share discounted price table below and add WhatsApp: ${WA_LINK}.
- For road/status queries: say roads are fully carpeted/smooth; small water crossing near resort; sedans can park in private parking (1-minute walk); luggage help by team; free 4×4 jeep assist for elderly. Invite user to contact at ${contactLine} for latest status.
- Influencer (DM): thank them and route to ${WA_LINK} / ${IG_PUBLIC_NUMBER}.
- When unsure about exact location for routes, ask for the starting point before suggesting time/directions.

DISCOUNTED PRICE TABLE (DM only):
• Deluxe Hut — PKR 30,000/night
  • 1st Night 10% → PKR 27,000
  • 2nd Night 15% → PKR 25,500
  • 3rd Night 20% → PKR 24,000
• Executive Hut — PKR 50,000/night
  • 1st Night 10% → PKR 45,000
  • 2nd Night 15% → PKR 42,500
  • 3rd Night 20% → PKR 40,000
T&Cs: taxes included • breakfast for 4 • 50% advance to confirm.

OUTPUT: one short paragraph (no markdown).`.trim();

  const user = `User message: "${String(userText).slice(0,800)}"
Intent: ${JSON.stringify(intent)} | Contact hint: ${contactLine}`;

  // Lightweight fallback when no API key is set
  if (!OPENAI_API_KEY) {
    if (intent.pricing && isComment) {
      return `${randomHook(lang)} ${lang==='ur'
        ? 'براہِ کرم قیمت کے لیے DM کریں۔'
        : lang==='roman-ur'
          ? 'Prices ke liye DM karein.'
          : 'Please DM us for rates.'}`;
    }
    if (intent.road) {
      return lang==='ur'
        ? `${BRAND} تک سڑکیں کارپٹڈ اور ہموار ہیں۔ ریزورٹ کے قریب ایک چھوٹا واٹر کراسنگ ہے؛ سیڈان پرائیویٹ پارکنگ (۱ منٹ واک) میں پارک ہو سکتی ہے۔ سامان میں ہماری ٹیم مدد کرتی ہے اور بزرگ مہمانوں کے لیے مفت 4×4 جیپ دستیاب ہے۔ تازہ صورتحال کے لیے رابطہ: ${contactLine}`
        : lang==='roman-ur'
          ? `Roads to ${BRAND} fully carpeted/smooth hain. Resort ke qareeb chhota water crossing hai; sedans private parking (1-min walk) mein park hoti hain. Luggage mein team madad karti hai, elderly ke liye free 4×4 jeep. Latest update ke liye rabta: ${contactLine}`
          : `Roads to ${BRAND} are fully carpeted and smooth. Near the resort there’s a small water crossing; sedans can park at our private parking (1-minute walk). Our team helps with luggage, and we provide free 4×4 jeep assist for elderly guests. For the latest status, contact: ${contactLine}`;
    }
    return lang==='ur'
      ? 'ہم مدد کے لیے موجود ہیں—بتائیں آپ کو کس بارے میں رہنمائی چاہیے؟'
      : lang==='roman-ur'
        ? 'Hum madad ke liye yahan hain—batayein kis cheez ki rehnumai chahiye?'
        : 'We’re here to help—how can we assist?';
  }

  try {
    const { data } = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_MODEL,
        temperature: 0.9,
        top_p: 0.9,
        max_tokens: 240,
        presence_penalty: 0.2,
        frequency_penalty: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ]
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    return data?.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) { logErr(e); return ''; }
}

/* =========================
   Intent enforcer (no recursion)
   ========================= */
function enforceIntent(text, intent, surface, platform, lang, contact) {
  // IG comments must show plain number (links not clickable)
  if (surface === 'comment' && platform === 'instagram') contact = IG_PUBLIC_NUMBER;

  // Pricing: comment => hook + DM; DM => prices OK
  if (intent?.pricing) {
    if (surface === 'comment') {
      const hook = randomHook(lang);
      if (lang === 'ur')   return `${hook} براہِ کرم قیمت جاننے کے لیے DM کریں۔ رابطہ: ${contact}`;
      if (lang === 'roman-ur') return `${hook} Rates ke liye DM karein. Rabta: ${contact}`;
      return `${hook} Please DM us for rates. Contact: ${contact}`;
    }
    // DM – keep it short, mention discounted prices and WA link
    if (lang === 'ur')   return `یہ رعایتی قیمتیں ہیں۔ ہم تاریخوں/ہٹ کے انتخاب میں بھی مدد کریں گے۔ رابطہ: ${contact}\nWebsite: ${SITE_URL}`;
    if (lang === 'roman-ur') return `Yeh discounted prices hain. Dates/hut selection mein bhi madad karenge. Rabta: ${contact}\nWebsite: ${SITE_URL}`;
    return `These are discounted prices. We can help with dates/hut selection too. Contact: ${contact}\nWebsite: ${SITE_URL}`;
  }

  // Road/status: fixed informative reply
  if (intent?.road) {
    if (lang === 'ur') return `راستے عام طور پر مکمل کارپٹڈ اور ہموار ہیں۔ ریزورٹ کے قریب ایک چھوٹا واٹر کراسنگ ہے؛ سیڈان پرائیویٹ پارکنگ (۱ منٹ واک) میں پارک ہو سکتی ہے۔ سامان میں ہماری ٹیم مدد کرتی ہے اور بزرگ مہمانوں کے لیے مفت 4×4 جیپ دستیاب ہے۔ تازہ صورتحال کے لیے براہِ کرم رابطہ کریں: ${contact}`;
    if (lang === 'roman-ur') return `Roads aam tor par fully carpeted/smooth hain. Resort ke qareeb chhota water crossing hai; sedans private parking (1-min walk) mein park hoti hain. Luggage mein team madad karti hai; elderly ke liye free 4×4 jeep available. Latest update ke liye rabta: ${contact}`;
    return `Roads are fully carpeted and smooth. Near the resort there’s a small water crossing; sedans can park at private parking (1-minute walk). Our team helps with luggage; free 4×4 jeep assist available for elderly guests. For the latest status, please contact: ${contact}`;
  }

  // Influencer in DM: route to contact
  if (intent?.influencer && surface === 'dm') {
    if (lang === 'ur') return `کولیب/پارٹنرشپ کے لیے اسی نمبر پر رابطہ کریں: ${contact} — ہماری ٹیم جلد جواب دے گی۔`;
    if (lang === 'roman-ur') return `Collab/partnership ke liye isi number par rabta karein: ${contact} — team jaldi respond karegi.`;
    return `For collaborations/partnerships, please contact: ${contact} — our team will respond shortly.`;
  }

  return null; // let GPT text pass through
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
  await axios.post(url, { message: safeOut(message) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(url, { message: safeOut(message) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
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
    if (intent.pricing) {
      // Private reply with prices
      try {
        const dm = await gptGenerate({ userText: text, lang, surface: 'dm', platform: 'facebook', intent });
        const forcedDM = enforceIntent(dm, intent, 'dm', 'facebook', lang, WA_LINK);
        await fbPrivateReplyToComment(v.comment_id, sanitizeVoice(forcedDM || dm));
      } catch (e) { logErr({ where:'FB price DM', err:e }); }
      // Public hook (no numbers)
      const hookLine = enforceIntent('', { pricing: true }, 'comment', 'facebook', lang, WA_LINK);
      return replyToFacebookComment(v.comment_id, stripPublicPricesKeepContact(sanitizeVoice(hookLine)));
    }

    // Non-price → public only (use GPT, but scrub & guard)
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
  await axios.post(url, { message: safeOut(message) }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const payload = { recipient: { comment_id: commentId }, message: { text: safeOut(message) } };
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
    if (intent.pricing) {
      // Try DM (may fail without permission; errors are logged but ignored)
      try {
        const dm = await gptGenerate({ userText:text, lang, surface:'dm', platform:'instagram', intent });
        const forcedDM = enforceIntent(dm, intent, 'dm', 'instagram', lang, WA_LINK);
        await igPrivateReplyToComment(pageId, commentId, sanitizeVoice(forcedDM || dm));
      } catch (e) { logErr({ where:'IG price DM fail', err:e }); }
      // Public hook (no numbers, IG phone only)
      const hookLine = enforceIntent('', { pricing: true }, 'comment', 'instagram', lang, IG_PUBLIC_NUMBER);
      return replyToInstagramComment(commentId, stripPublicPricesKeepContact(sanitizeVoice(hookLine)));
    }

    // Non-price → public
    const pub = await gptGenerate({ userText:text, lang, surface:'comment', platform:'instagram', intent });
    const forcedPub = enforceIntent(pub, intent, 'comment', 'instagram', lang, IG_PUBLIC_NUMBER);
    return replyToInstagramComment(commentId, stripPublicPricesKeepContact(sanitizeVoice(forcedPub || pub)));
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
    const ai = await gptGenerate({
      userText: text,
      lang,
      surface: 'dm',
      platform: opts.channel === 'instagram' ? 'instagram' : 'facebook',
      intent
    });

    const forced = enforceIntent(
      ai,
      intent,
      'dm',
      opts.channel === 'instagram' ? 'instagram' : 'facebook',
      lang,
      WA_LINK // DMs can use wa.me
    );

    const finalText = safeOut(sanitizeVoice(forced || ai), lang);
    await sendText(psid, finalText);
  } catch (e) { logErr(e); }
}

async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: safeOut(text) } };
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
