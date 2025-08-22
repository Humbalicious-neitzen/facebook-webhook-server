// server.js — Roameo Resorts omni-channel bot (Facebook + Instagram)
// Rules enforced: always reply, price-in-comments forbidden, unique discount hook,
// language mirroring, brand-forward tone, DM prices, phone (no links) in comments,
// WA link in DMs only, self-reply guards, IG DM fallback, non-empty guards.

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

// Contacts (comments = number only; DMs = WA link)
const WA_LINK = 'https://wa.me/923558000078'; // DMs only
const PUBLIC_NUMBER = '03558000078';           // Use in ALL comments (FB + IG)

// Self-reply guards (extend if needed)
const SELF_IG_USERNAMES = ['roameoresorts'];
const SELF_FB_PAGE_IDS = []; // your FB page id(s) if you want

/* =========================
   MIDDLEWARE / CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });
const convo  = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });

app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));

/* =========================
   VERIFY
   ========================= */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

/* =========================
   SECURITY
   ========================= */
function verifySignature(req) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig || !req.rawBody || !APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    const a = Buffer.from(sig), b = Buffer.from(expected);
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
   LANGUAGE / INTENTS
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
  const englishHits = [/\b(the|and|is|are|you|we|from|how|where|price|rate|road|weather|distance)\b/i]
    .reduce((n, rx) => n + (rx.test(t) ? 1 : 0), 0);
  if (romanHits >= 1 && englishHits <= 3) return 'roman-ur';
  return 'en';
}

function isPricingIntent(text = '') {
  const t = text.toLowerCase();
  return /\b(price|prices|rate|rates|cost|charges?|tariff|per\s*night|room|rooms|kitna|kitni)\b/.test(t);
}
function isRoadIntent(text = '') {
  const t = text.toLowerCase();
  const road = /\b(road|roads|route|rasta|raasta|drive|travel\s*time)\b/.test(t);
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
   GPT HELPERS (hooks & replies)
   ========================= */
async function gptHook(lang) {
  // Generate a short unique discount hook (no numbers). Fallback if GPT disabled.
  if (!OPENAI_API_KEY) {
    const fallbacks = {
      en: [
        'Limited-time savings just went live!',
        'Exclusive resort discounts are active now!',
        'Special seasonal offers are on!',
        'Great deals running — don’t miss out!'
      ],
      ur: [
        'خصوصی رعایتی آفرز جاری ہیں!',
        'محدود مدت کے لئے شاندار ڈسکاؤنٹس!',
        'سیزنل آفرز اس وقت فعال ہیں!',
        'بہترین ڈیلز دستیاب — موقع ضائع نہ کریں!'
      ],
      'roman-ur': [
        'Limited-time discounts live hain!',
        'Exclusive resort offers active hain!',
        'Seasonal deals on hain!',
        'Great savings chal rahi hain!'
      ]
    };
    const list = fallbacks[lang] || fallbacks.en;
    return list[Math.floor(Math.random() * list.length)];
  }

  const prompts = {
    en: 'Give one short catchy line (max 12 words) implying resort discounts are active now. No numbers, no links.',
    ur: 'ایک مختصر اور پرکشش جملہ دیں (زیادہ سے زیادہ 12 الفاظ) جو بتائے کہ ریزورٹ پر ڈسکاؤنٹس جاری ہیں۔ نمبرز یا لنکس نہ ہوں۔',
    'roman-ur': 'Ek chhoti catchy line dein (max 12 words) jo bataye discounts active hain. Numbers/links na hon.'
  };
  const system = 'You create ultra-brief promotional hooks. Output one line only.';
  const user = prompts[lang] || prompts.en;

  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: OPENAI_MODEL,
      temperature: 0.95,
      max_tokens: 40,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    return (data?.choices?.[0]?.message?.content || '').trim();
  } catch (e) { logErr({ where: 'hook', err: e }); return ''; }
}

async function gptGeneric({ userText, lang, surface, platform }) {
  // Generic brand-forward reply for non-pricing threads.
  if (!OPENAI_API_KEY) {
    if (lang === 'ur') return `${BRAND} آپ کی رہنمائی کے لئے حاضر ہے — خوشگوار ماحول اور دریا کنارے قیام کے ساتھ۔ بتائیں کس بارے میں مدد چاہیے؟`;
    if (lang === 'roman-ur') return `${BRAND} yahan madad ke liye maujood hai — riverside stay aur cozy huts ke sath. Batayein kis cheez ki rehnumai chahiye?`;
    return `${BRAND} is here to help — cozy riverside huts and a warm team. What can we help you with?`;
  }
  const system = `You are ${BRAND}'s assistant. Keep replies short, positive, and brand-forward. Mirror language (${lang}).`;
  const user = `User message: "${String(userText).slice(0,500)}" | Surface: ${surface} | Platform: ${platform}`;
  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: OPENAI_MODEL, temperature: 0.8, max_tokens: 120,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
    return (data?.choices?.[0]?.message?.content || '').trim();
  } catch (e) { logErr({ where: 'generic', err: e }); return ''; }
}

/* =========================
   SANITIZERS / GUARDS
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

function stripPublicPrices(text='') {
  return text
    .split(/\r?\n/)
    .filter(line => !(PRICE_WORD.test(line) || CURRENCY_NUM.test(line)))
    .join('\n')
    .trim();
}

function ensureNonEmpty(text, lang, fallbackType = 'generic') {
  const t = (text || '').trim();
  if (t) return t;
  if (fallbackType === 'price_comment') {
    if (lang === 'ur') return `رعایتی قیمتیں جاری ہیں — براہِ کرم DM کریں۔ رابطہ: ${PUBLIC_NUMBER}`;
    if (lang === 'roman-ur') return `Discounted prices live hain — DM karein. Rabta: ${PUBLIC_NUMBER}`;
    return `Discounted prices are live — please DM us. Contact: ${PUBLIC_NUMBER}`;
  }
  if (lang === 'ur') return `مزید معلومات کے لیے رابطہ کریں: ${PUBLIC_NUMBER}`;
  if (lang === 'roman-ur') return `Mazeed maloomat ke liye rabta: ${PUBLIC_NUMBER}`;
  return `For details, please contact: ${PUBLIC_NUMBER}`;
}

/* =========================
   ENFORCER (rules → final copy)
   ========================= */
async function buildCommentForPricing(lang) {
  const hook = await gptHook(lang);
  const safeHook = stripPublicPrices(sanitizeVoice(hook || ''));
  if (lang === 'ur') {
    return ensureNonEmpty(
      `${safeHook}\nبراہِ کرم ہمیں DM کریں تاکہ رعایتی قیمتیں شیئر کر سکیں۔ رابطہ نمبر: ${PUBLIC_NUMBER}`,
      lang, 'price_comment'
    );
  }
  if (lang === 'roman-ur') {
    return ensureNonEmpty(
      `${safeHook}\nDM karein taa ke discounted prices share kar saken. Rabta number: ${PUBLIC_NUMBER}`,
      lang, 'price_comment'
    );
  }
  return ensureNonEmpty(
    `${safeHook}\nPlease DM us for the discounted prices. Contact: ${PUBLIC_NUMBER}`,
    lang, 'price_comment'
  );
}

function buildDMForPricing(lang) {
  // Always include WA link (DMs only) + discounted price table
  if (lang === 'ur') {
    return sanitizeVoice(
`یہ رعایتی قیمتیں ہیں:
• Deluxe Hut — PKR 30,000/night
  • 1st Night 10% → PKR 27,000
  • 2nd Night 15% → PKR 25,500
  • 3rd Night 20% → PKR 24,000
• Executive Hut — PKR 50,000/night
  • 1st Night 10% → PKR 45,000
  • 2nd Night 15% → PKR 42,500
  • 3rd Night 20% → PKR 40,000
بکنگ/مدد: ${WA_LINK}
Website: ${SITE_URL}`
    );
  }
  if (lang === 'roman-ur') {
    return sanitizeVoice(
`Yeh discounted prices hain:
• Deluxe Hut — PKR 30,000/night
  • 1st Night 10% → PKR 27,000
  • 2nd Night 15% → PKR 25,500
  • 3rd Night 20% → PKR 24,000
• Executive Hut — PKR 50,000/night
  • 1st Night 10% → PKR 45,000
  • 2nd Night 15% → PKR 42,500
  • 3rd Night 20% → PKR 40,000
Booking/help: ${WA_LINK}
Website: ${SITE_URL}`
    );
  }
  return sanitizeVoice(
`These are discounted prices:
• Deluxe Hut — PKR 30,000/night
  • 1st Night 10% → PKR 27,000
  • 2nd Night 15% → PKR 25,500
  • 3rd Night 20% → PKR 24,000
• Executive Hut — PKR 50,000/night
  • 1st Night 10% → PKR 45,000
  • 2nd Night 15% → PKR 42,500
  • 3rd Night 20% → PKR 40,000
For booking/help: ${WA_LINK}
Website: ${SITE_URL}`
  );
}

function buildRoadReply(lang) {
  if (lang === 'ur') {
    return `${BRAND} تک سڑکیں عمومی طور پر کارپٹڈ اور کھلی رہتی ہیں۔ ریزورٹ کے قریب ایک چھوٹا واٹر کراسنگ ہے؛ بزرگ مہمانوں کے لیے ہماری ٹیم 4×4 مدد فراہم کرتی ہے۔ اگر آپ شہر/آغاز مقام بتا دیں تو ہم راستہ اور ٹائم بہتر بتا دیں گے۔ رابطہ: ${PUBLIC_NUMBER}`;
  }
  if (lang === 'roman-ur') {
    return `Roads to ${BRAND} aam tor par carpeted aur open hoti hain. Resort ke qareeb chhota water crossing hai; barhay mezbanon ke liye 4×4 assist available hai. Aap apna shehar/start batadein to hum route/time better guide kar denge. Rabta: ${PUBLIC_NUMBER}`;
  }
  return `Roads to ${BRAND} are generally open and carpeted. Near the resort there’s a small water crossing; our team provides 4×4 assist for elderly guests. Tell us your starting city so we can confirm the best route/time. Contact: ${PUBLIC_NUMBER}`;
}

function buildInfluencerDM(lang) {
  if (lang === 'ur') return `کولیب/پارٹنرشپ کے لیے براہِ کرم WhatsApp پر رابطہ کریں: ${WA_LINK} — ہماری ٹیم جلد جواب دے گی۔`;
  if (lang === 'roman-ur') return `Collab/partnership ke liye barah-e-mehrbani WhatsApp par rabta karein: ${WA_LINK} — hamari team jald respond karegi.`;
  return `For collaborations/partnerships, please contact us on WhatsApp: ${WA_LINK} — our team will get back to you shortly.`;
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
  const msg = ensureNonEmpty(stripPublicPrices(sanitizeVoice(message || '')), 'en'); // language unknown here; already mirrored upstream
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message: msg }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const msg = ensureNonEmpty(sanitizeVoice(message || ''), 'en');
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(url, { message: msg }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
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
      // DM with discounted prices
      try {
        const dmText = buildDMForPricing(lang);
        await fbPrivateReplyToComment(v.comment_id, dmText);
      } catch (e) { logErr({ where:'FB price DM', err:e }); }
      // Public hook (no numbers) + DM prompt + phone number
      const pubText = await buildCommentForPricing(lang);
      return replyToFacebookComment(v.comment_id, pubText);
    }

    // Non-price → friendly brand-forward public reply (language-mirrored)
    const generic = await gptGeneric({ userText: text, lang, surface: 'comment', platform: 'facebook' });
    let out = sanitizeVoice(generic);
    if (intent.road) out = buildRoadReply(lang);
    out = stripPublicPrices(out);
    out = ensureNonEmpty(out, lang);
    return replyToFacebookComment(v.comment_id, out);
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
  const msg = ensureNonEmpty(stripPublicPrices(sanitizeVoice(message || '')), 'en');
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message: msg }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  const msg = ensureNonEmpty(sanitizeVoice(message || ''), 'en');
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const payload = { recipient: { comment_id: commentId }, message: { text: msg } };
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
      // Try DM with discounted prices (may fail due to IG capability)
      try {
        const dmText = buildDMForPricing(lang);
        await igPrivateReplyToComment(pageId, commentId, dmText);
      } catch (e) { logErr({ where:'IG price DM fail', err:e }); }
      // Public hook (no numbers) + DM prompt + phone number (no links in IG comments)
      const pubText = await buildCommentForPricing(lang);
      return replyToInstagramComment(commentId, pubText);
    }

    // Non-price → friendly public reply
    let out = await gptGeneric({ userText: text, lang, surface: 'comment', platform: 'instagram' });
    if (intent.road) out = buildRoadReply(lang);
    out = stripPublicPrices(sanitizeVoice(out));
    out = ensureNonEmpty(out, lang);
    return replyToInstagramComment(commentId, out);
  } catch (e) { logErr(e); }
}

/* =========================
   DMs (shared)
   ========================= */
async function handleTextMessage(psid, text, opts = { channel: 'facebook' }) {
  if (!AUTO_REPLY_ENABLED) return;

  const lang = detectLanguage(text);
  const intent = {
    pricing: isPricingIntent(text),
    road: isRoadIntent(text),
    influencer: isInfluencerIntent(text),
    question_like: isQuestionLike(text),
  };

  try {
    let out = '';
    if (intent.pricing) {
      out = buildDMForPricing(lang); // DM: discounted table + WA link
    } else if (intent.influencer) {
      out = buildInfluencerDM(lang);
    } else if (intent.road) {
      // Ask origin if unclear; keep it positive/brand-forward
      out = buildRoadReply(lang).replace(PUBLIC_NUMBER, WA_LINK);
    } else {
      out = await gptGeneric({
        userText: text,
        lang,
        surface: 'dm',
        platform: opts.channel === 'instagram' ? 'instagram' : 'facebook'
      });
      out = sanitizeVoice(out);
      // Add WA + site footer softly in DMs
      const footer = (lang === 'ur')
        ? `\nرابطہ/مدد: ${WA_LINK}\nWebsite: ${SITE_URL}`
        : (lang === 'roman-ur')
          ? `\nRabta/madad: ${WA_LINK}\nWebsite: ${SITE_URL}`
          : `\nContact/help: ${WA_LINK}\nWebsite: ${SITE_URL}`;
      out += footer;
    }

    out = ensureNonEmpty(out, lang);
    await sendText(psid, out);
  } catch (e) { logErr(e); }
}

async function sendText(psid, text) {
  const msg = ensureNonEmpty(text, 'en');
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text: msg } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* =========================
   HANDOVER + ADMIN
   ========================= */
async function takeThreadControl(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/take_thread_control';
  try {
    await axios.post(url, { recipient: { id: psid } }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
  } catch (e) { logErr(e); }
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
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.response?.data || e.message });
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
        OPENAI: Boolean(OPENAI_API_KEY),
        BRAND, SITE_URL, MAPS_LINK,
        CHECKIN_TIME, CHECKOUT_TIME,
        WA_LINK, PUBLIC_NUMBER
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
