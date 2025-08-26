// server.js — Roameo Resorts omni-channel bot
// v3.1: deterministic intents, strict language mirroring, IG/FB CTA rules,
// media/contact handlers, public price guard, improved error logging
//
// Channels: FB DMs + FB comments + IG DMs + IG comments
// PUBLIC PRICES: FORBIDDEN (only DM). IG comments → WhatsApp NUMBER only.
// FB comments + ALL DMs → wa.me link.
//
// Env you MUST set on Render:
// APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN
// Optional: IG_MANAGE_TOKEN (can be same as PAGE token but must have IG scopes)
// Optional: OPENAI_API_KEY, GEOAPIFY_API_KEY, OPENWEATHER_API_KEY
//
// Required FB/IG permissions on PAGE token (scopes):
// pages_messaging, pages_manage_engagement, pages_read_engagement, pages_manage_metadata
// instagram_manage_comments, instagram_manage_messages (if using IG)

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
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Toggles
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY = String(process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

// IG token (can reuse PAGE token if it carries IG scopes)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Enrichment (optional)
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
const RESORT_COORDS = (process.env.RESORT_COORDS || '').trim(); // "lat,lon"

// ==== Brand constants ====
const BRAND_USERNAME = 'roameoresorts';                // avoid self-replies
const WHATSAPP_NUMBER = '03558000078';                 // IG comments only
const WHATSAPP_LINK   = 'https://wa.me/923558000078';  // FB comments & all DMs
const SITE_URL        = 'https://www.roameoresorts.com/';
const SITE_SHORT      = 'roameoresorts.com';
const MAPS_LINK       = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';
const INSTA_LINK      = 'https://www.instagram.com/roameoresorts/';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Outgoing message limits (Messenger hard cap ~1000)
const MAX_OUT_CHAR = 800;

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT replies will use short fallbacks.');
}

/* =========================
   ROAMEO KNOWLEDGE BASE
   ========================= */
const KB = {
  brand: 'Roameo Resorts',
  river_name: 'Neelam River',
  checkin: CHECKIN_TIME,
  checkout: CHECKOUT_TIME,
  maps: MAPS_LINK,
  site: SITE_URL,
  insta: INSTA_LINK,
  whatsapp_link: WHATSAPP_LINK,
  whatsapp_num: WHATSAPP_NUMBER,
  facts: [
    'Private riverfront huts facing the Neelam River',
    'Heaters, inverters & insulated huts (cozy even in winters)',
    'In-house kitchen (local & desi meals available)',
    'Private internet access + SCOM SIM support',
    'Spacious rooms, modern interiors, artistic decor',
    'Family-friendly atmosphere',
    'Luggage assistance from private parking',
    'Free 4×4 jeep assist for elderly / water crossing',
    'Bonfire & outdoor seating on request'
  ],
  travel_tips: [
    'Roads to the resort are fully carpeted for a smooth, scenic drive.',
    'A small water crossing is near the resort; sedans can park at private parking (1-minute walk).',
    'Team helps with luggage; free jeep transfer for elderly guests.'
  ],
  rates: {
    deluxe:    { base: 30000, n1: 27000, n2: 25500, n3: 24000 },
    executive: { base: 50000, n1: 45000, n2: 42500, n3: 40000 }
  },
  tnc: [
    'Rates are inclusive of all taxes.',
    'Complimentary breakfast for 4 guests per booking.',
    '50% advance payment required to confirm the reservation.'
  ]
};

/* =========================
   STYLE / EMOJI
   ========================= */
const EMOJI = { hello: ['💚','🌿','👋','😊'], travel: ['🚙','🛣️','🌄'], tip: ['💡','✨','📍'] };
const pick = arr => arr[Math.floor(Math.random()*arr.length)];

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });   // 1h
const tinyCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 10 }); // 10m
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });    // 30m

/* =========================
   BASIC ROUTES
   ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));

/* =========================
   VERIFY
   ========================= */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'] || req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && (token === VERIFY_TOKEN)) return res.status(200).send(challenge);
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
   HELPERS — language, sanitize, chunking
   ========================= */
function sanitizeVoice(text = '') {
  const urls = [];
  let s = (text || '').replace(/https?:\/\/\S+/gi, (m) => { urls.push(m); return `__URL${urls.length - 1}__`; });
  s = s
    .replace(/\bI\'m\b/gi, 'we’re')
    .replace(/\bI am\b/gi, 'we are')
    .replace(/\bI\'ll\b/gi, 'we’ll')
    .replace(/\bI\b/gi, 'we')
    .replace(/\bme\b/gi, 'us')
    .replace(/\bmy\b/gi, 'our')
    .replace(/\bmine\b/gi, 'ours')
    .replace(/\s{2,}/g, ' ')
    .trim();
  s = s.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)]);
  return s;
}
function stripPricesFromPublic(text = '') {
  const lines = (text || '').split(/\r?\n/).filter(Boolean).filter(l => {
    const s = l.toLowerCase();
    const hasCurrency = /(pkr|rs\.?|rupees|price|prices|rate|rates|tariff|per\s*night|rent|rental|charges?)/i.test(s);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(s);
    return !(hasCurrency || hasMoneyish);
  });
  return lines.join('\n').trim();
}
function detectLanguage(text = '') {
  const t = (text || '').trim();
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(t)) return 'ur'; // Urdu script
  const romanHits = [
    /\b(aap|ap|apka|apki|apke|tum|plz|pls)\b/i,
    /\b(kia|kya|kyun|kaise|krna|karna|krdo|kardo|raha|rha|rhe|rahe|gi|ga|hain|hai|hy)\b/i,
    /\b(mein|mai|mujhe|yahan|wahan|acha|accha|bohat|bahut)\b/i,
    /\b(kitna|kitni|kiraya|qeemat|rate|mausam|shehar)\b/i
  ].reduce((a, rx) => a + (rx.test(t) ? 1 : 0), 0);
  if (romanHits >= 1 && !/[\u0600-\u06FF]/.test(t)) return 'roman-ur';
  return 'en';
}
function splitToChunks(s, limit = MAX_OUT_CHAR) {
  const out = [];
  let str = (s || '').trim();
  while (str.length > limit) {
    let cut = Math.max(
      str.lastIndexOf('\n', limit),
      str.lastIndexOf('. ', limit),
      str.lastIndexOf('•', limit),
      str.lastIndexOf('!', limit),
      str.lastIndexOf('?', limit)
    );
    if (cut <= 0) cut = limit;
    out.push(str.slice(0, cut).trim());
    str = str.slice(cut).trim();
  }
  if (str) out.push(str);
  return out;
}
async function sendBatched(psid, textOrArray) {
  const parts = Array.isArray(textOrArray) ? textOrArray : [textOrArray];
  for (const p of parts) {
    for (const chunk of splitToChunks(p, MAX_OUT_CHAR)) {
      await sendText(psid, chunk);
    }
  }
}

/* =========================
   INTENT DETECTION
   ========================= */
function isPricingIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(price|prices|rate|rates|cost|costs|charge|charges|tariff|per\s*night|rent|rental)\b/i.test(t)
      || /\b(kiraya|qeemat|keemat|kimat|rate\s*kya|price\s*kya)\b/i.test(t)
      || /\b(kitna|kitni)\s*(per\s*night|room|hut|d)\b/i.test(t);
}
function isMediaIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(video|reel|footage|clip|live|exterior|interior|outside|hotel\s*exterior|pictures?|photos?)\b/i.test(t);
}
function isContactIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(manager|owner|contact|number|phone|call|whatsapp|wa\s?number)\b/i.test(t);
}
function isLocationIntent(text='') {
  const t = text.toLowerCase();
  return /\b(location|where|address|map|pin|directions?|google\s*maps|reach)\b/i.test(t);
}
function isFacilitiesIntent(text='') {
  const t = text.toLowerCase();
  return /\b(facilit(y|ies)|amenit(y|ies)|wifi|internet|kitchen|food|meal|heater|bonfire|family|kids|children|parking|jeep|inverter)\b/i.test(t);
}
function isBookingIntent(text='') {
  const t = text.toLowerCase();
  return /\b(book|booking|reserve|reservation|check[-\s]?in|checkin|check[-\s]?out|checkout|advance|payment)\b/i.test(t);
}
function isAvailIntent(text='') {
  const t = text.toLowerCase();
  return /\b(availability|available|dates?|calendar)\b/i.test(t);
}
function isDistanceIntent(text='') {
  const t = text.toLowerCase();
  return /\b(distance|far|how\s*far|hours|drive|time\s*from|eta)\b/i.test(t);
}
function isWeatherIntent(text='') {
  const t = text.toLowerCase();
  return /\b(weather|temperature|cold|hot|forecast|rain|mausam)\b/i.test(t);
}

/* =========================
   ENRICHMENT
   ========================= */
function km(meters) { return (meters / 1000).toFixed(0); }
function hhmm(seconds) { const h = Math.floor(seconds/3600); const m = Math.round((seconds%3600)/60); return `${h}h ${m}m`; }

async function geocodePlace(place) {
  if (!GEOAPIFY_API_KEY || !place) return null;
  const key = `geo:${place.toLowerCase()}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.geoapify.com/v1/geocode/search';
    const { data } = await axios.get(url, { params: { text: place, limit: 1, apiKey: GEOAPIFY_API_KEY }, timeout: 10000 });
    const feat = data?.features?.[0];
    if (!feat) return null;
    const [lon, lat] = feat.geometry.coordinates || [];
    const res = { lat, lon };
    tinyCache.set(key, res);
    return res;
  } catch (e) { logAxiosError(e); return null; }
}
async function routeDrive(originLat, originLon, destLat, destLon) {
  if (!GEOAPIFY_API_KEY) return null;
  const key = `route:${originLat},${originLon}->${destLat},${destLon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.geoapify.com/v1/routing';
    const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
    const { data } = await axios.get(url, { params: { waypoints, mode: 'drive', apiKey: GEOAPIFY_API_KEY }, timeout: 12000 });
    const ft = data?.features?.[0]?.properties;
    if (!ft) return null;
    return { meters: ft.distance, seconds: ft.time };
  } catch (e) { logAxiosError(e); return null; }
}
async function currentWeather(lat, lon) {
  if (!OPENWEATHER_API_KEY || !lat || !lon) return null;
  const key = `wx:${lat},${lon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.openweathermap.org/data/2.5/weather';
    const { data } = await axios.get(url, { params: { lat, lon, units: 'metric', appid: OPENWEATHER_API_KEY }, timeout: 10000 });
    return {
      temp: Math.round(data?.main?.temp ?? 0),
      feels: Math.round(data?.main?.feels_like ?? 0),
      desc: (data?.weather?.[0]?.description || '').replace(/\b\w/g, c => c.toUpperCase())
    };
  } catch (e) { logAxiosError(e); return null; }
}

/* =========================
   PRE-BUILT MESSAGE TEMPLATES (by language)
   ========================= */
function L(lang, en, roman, ur) {
  if (lang === 'ur') return ur;
  if (lang === 'roman-ur') return roman;
  return en;
}

function msgPrices(lang) {
  const r = KB.rates;
  const block = (lang==='ur') ? (
`ڈیلکس ہٹ — PKR ${r.deluxe.base.toLocaleString()}
• پہلی رات 10% → PKR ${r.deluxe.n1.toLocaleString()}
• دوسری رات 15% → PKR ${r.deluxe.n2.toLocaleString()}
• تیسری رات 20% → PKR ${r.deluxe.n3.toLocaleString()}

ایگزیکٹو ہٹ — PKR ${r.executive.base.toLocaleString()}
• پہلی رات 10% → PKR ${r.executive.n1.toLocaleString()}
• دوسری رات 15% → PKR ${r.executive.n2.toLocaleString()}
• تیسری رات 20% → PKR ${r.executive.n3.toLocaleString()}`
  ) : (
`Deluxe Hut — PKR ${r.deluxe.base.toLocaleString()}
• 1st Night 10% → PKR ${r.deluxe.n1.toLocaleString()}
• 2nd Night 15% → PKR ${r.deluxe.n2.toLocaleString()}
• 3rd Night 20% → PKR ${r.deluxe.n3.toLocaleString()}

Executive Hut — PKR ${r.executive.base.toLocaleString()}
• 1st Night 10% → PKR ${r.executive.n1.toLocaleString()}
• 2nd Night 15% → PKR ${r.executive.n2.toLocaleString()}
• 3rd Night 20% → PKR ${r.executive.n3.toLocaleString()}`
  );

  const tnc = (lang==='ur')
    ? 'شرائط: تمام ٹیکس شامل • چار مہمانوں کے لیے ناشتہ شامل • کنفرمیشن کے لیے 50% ایڈوانس'
    : 'T&Cs: taxes included • breakfast for 4 • 50% advance to confirm';

  return sanitizeVoice(
    L(lang,
      `💚 Good news — discounted prices for you! ✨\n\n${block}\n\n${tnc}\nAvailability / book: ${KB.site}\n\nChat on WhatsApp: ${KB.whatsapp_link}`,
      `💚 Good news — discounted prices for you! ✨\n\n${block}\n\n${tnc}\nAvailability / book: ${KB.site}\n\nChat on WhatsApp: ${KB.whatsapp_link}`,
      `💚 خوشخبری — ڈسکاؤنٹڈ قیمتیں آپ کے لیے! ✨\n\n${block}\n\n${tnc}\nدستیابی/بکنگ: ${KB.site}\n\nواٹس ایپ پر بات کریں: ${KB.whatsapp_link}`
    )
  );
}

function msgLocation(lang) {
  const tips = KB.travel_tips.map(t => `• ${t}`).join('\n');
  return sanitizeVoice(L(lang,
`*Roameo Resorts location link:*\n👉 ${KB.maps}\n\n*Good to know:*\n${tips}\n\nNeed directions or planning help? We’ll make your arrival smooth and memorable!\n\nChat on WhatsApp: ${KB.whatsapp_link}`,
`*Location link:*\n👉 ${KB.maps}\n\n*Good to know:*\n${tips}\n\nDirections ya planning mein help chahiye? Hum arrival smooth aur memorable banate hain!\n\nWhatsApp: ${KB.whatsapp_link}`,
`*لوکیشن لنک:*\n👉 ${KB.maps}\n\n*اہم معلومات:*\n${tips}\n\nمزید رہنمائی درکار ہو تو بتائیں—ہم آپ کی آمد آسان بناتے ہیں!\n\nواٹس ایپ: ${KB.whatsapp_link}`
  ));
}

function msgMedia(lang) {
  return sanitizeVoice(L(lang,
`You can see our latest exterior & interior photos and videos on Instagram:\n${KB.insta}\n\nFor anything specific, just ask and we’ll share more. 😊`,
`Exterior & interior ki latest photos/videos Instagram par dekh sakte hain:\n${KB.insta}\n\nKuch specific chahiye to batayein. 😊`,
`ہمارے تازہ ترین بیرونی اور اندرونی ویڈیوز/تصاویر Instagram پر دیکھیں:\n${KB.insta}\n\nاگر کچھ خاص درکار ہو تو بتائیں۔ 😊`
  ));
}

function msgContact(lang) {
  return sanitizeVoice(L(lang,
`You can reach our team on WhatsApp: ${KB.whatsapp_link}`,
`Hamari team se WhatsApp par rabta karein: ${KB.whatsapp_link}`,
`ہماری ٹیم سے واٹس ایپ پر رابطہ کریں: ${KB.whatsapp_link}`
  ));
}

function msgFacilities(lang) {
  const list = KB.facts.map(t => `• ${t}`).join('\n');
  return sanitizeVoice(L(lang,
`Here’s what guests love at Roameo Resorts:\n${list}\n\nQuestions? We’re here to help.\n\nChat on WhatsApp: ${KB.whatsapp_link}`,
`Roameo Resorts ki yeh cheezen mehmanon ko pasand aati hain:\n${list}\n\nSawal? Hum madad ke liye yahan hain.\n\nWhatsApp: ${KB.whatsapp_link}`,
`رو میو ریزورٹس کی نمایاں خصوصیات:\n${list}\n\nکوئی سوال ہو تو ضرور پوچھیں۔\n\nواٹس ایپ: ${KB.whatsapp_link}`
  ));
}

/* =========================
   GPT reply composer (for general/irrelevant Qs)
   ========================= */
function systemRules(asComment, lang) {
  const langGuide = lang === 'ur'
    ? 'Write in fluent Urdu script.'
    : lang === 'roman-ur'
      ? 'Write in natural Roman Urdu (ASCII letters).'
      : 'Write in natural English.';
  const surface = asComment ? 'COMMENT' : 'DM';
  return `
You are Roameo Resorts' assistant (riverfront huts by the Neelam River).
Surface: ${surface}.
- Match the user's language. ${langGuide}
- Answer the user’s question BRIEFLY (even if off-topic), then connect it back to Roameo Resorts in one short line.
- Always use “we/us/our team”; never “I/me”.
- NEVER post numeric prices/discounts in comments (public). Prices allowed in DMs.
- Don’t include URLs; caller may append CTA/links.
- Keep replies concise (2–5 short lines); friendly, clear, non-vague.
- Prefer saying "Roameo Resorts" rather than the valley name.
`.trim();
}

async function generateGPTReply({ userText, lang, asComment }) {
  if (!OPENAI_API_KEY) {
    return sanitizeVoice(L(lang,
      `Thanks! We’re here to help at Roameo Resorts. Tell us what you’re looking for.`,
      `Shukriya! Roameo Resorts par hum madad ko tayyar hain—batayein ki kis cheez ki talash hai.`,
      `شکریہ! رو میو ریزورٹس میں ہم مدد کے لیے حاضر ہیں—بتائیں آپ کیا جاننا چاہتے ہیں۔`
    ));
  }
  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.6, top_p: 0.9,
    presence_penalty: 0.2, frequency_penalty: 0.2,
    max_tokens: asComment ? 250 : 500,
    messages: [
      { role: 'system', content: systemRules(asComment, lang) },
      { role: 'user', content: `User: "${userText}"` }
    ]
  };
  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers, timeout: 12000 });
    let out = data?.choices?.[0]?.message?.content?.trim() || '';
    out = sanitizeVoice(out);
    if (asComment) out = stripPricesFromPublic(out);
    if (lang === 'roman-ur') out = out.replace(/[\u0600-\u06FF\u0750-\u077F]+/g, '').replace(/\s{2,}/g, ' ').trim();
    return out;
  } catch (e) {
    logAxiosError(e);
    return sanitizeVoice(L(lang,
      `We’re here to help—could you rephrase that?`,
      `Hum yahan madad ko hain—zara dobara samjha dein?`,
      `ہم مدد کے لیے حاضر ہیں—براہِ کرم دوبارہ لکھیں۔`
    ));
  }
}

/* =========================
   DECISION FLOW
   ========================= */
function shouldAttachCTA(intent, surface) {
  if (surface === 'comment' && intent === 'rates') return false;
  return true;
}
function attachCTA(body, intent, platform, surface) {
  if (!shouldAttachCTA(intent, surface)) return body;
  const compact = (body || '').trim();
  const already = /WhatsApp:|roameoresorts\.com|wa\.me/i.test(compact);
  if (already) return compact;
  if (platform === 'instagram' && surface === 'comment') {
    // IG comment: number only
    return `${compact}\nWhatsApp: ${WHATSAPP_NUMBER}`.trim();
  }
  // FB comments + all DMs
  return `${compact}\nChat on WhatsApp: ${WHATSAPP_LINK}`.trim();
}

async function decideReply(text, ctx = { surface: 'dm', platform: 'facebook' }) {
  const lang = detectLanguage(text);
  const asComment = ctx.surface === 'comment';

  // Deterministic intents FIRST
  if (!asComment && isPricingIntent(text)) return msgPrices(lang);
  if (asComment && isPricingIntent(text)) {
    return L(lang,
      'Please DM us for rates — exclusive DM-only deals! 🔒',
      'Rates ke liye DM karein — sirf DM mein deals! 🔒',
      'براہِ کرم ریٹس کے لیے DM کریں — خصوصی آفرز صرف DM میں! 🔒'
    );
  }
  if (isMediaIntent(text)) {
    const ans = msgMedia(lang);
    return attachCTA(ans, 'media', ctx.platform === 'instagram' ? 'instagram' : 'facebook', ctx.surface);
  }
  if (isContactIntent(text)) {
    const ans = msgContact(lang);
    return attachCTA(ans, 'contact', ctx.platform === 'instagram' ? 'instagram' : 'facebook', ctx.surface);
  }
  if (isLocationIntent(text)) return msgLocation(lang);
  if (isFacilitiesIntent(text)) return msgFacilities(lang);

  // Enrichment for distance/weather
  let wx = null;
  if ((isWeatherIntent(text) || isLocationIntent(text) || isBookingIntent(text)) && RESORT_COORDS.includes(',')) {
    const [lat, lon] = RESORT_COORDS.split(',').map(s => s.trim()).map(parseFloat);
    wx = await currentWeather(lat, lon);
  }

  if (isDistanceIntent(text) && /\bfrom\s+[a-z][a-z\s\-']{2,}/i.test((text||'').toLowerCase())) {
    const m = (text||'').toLowerCase().match(/\bfrom\s+([a-z][a-z\s\-']{2,})/i);
    const city = m ? m[1].trim() : null;
    if (city && RESORT_COORDS.includes(',')) {
      const origin = await geocodePlace(city);
      if (origin) {
        const [destLat, destLon] = RESORT_COORDS.split(',').map(s => s.trim()).map(parseFloat);
        const drive = await routeDrive(origin.lat, origin.lon, destLat, destLon);
        if (drive) {
          const ans = L(detectLanguage(text),
            `Approx drive from ${city}: ~${km(drive.meters)} km, ~${hhmm(drive.seconds)}.\nNeed directions? Map: ${KB.maps}\n\nChat on WhatsApp: ${KB.whatsapp_link}`,
            `${city} se taqriban drive: ~${km(drive.meters)} km, ~${hhmm(drive.seconds)}.\nDirections chahiye? Map: ${KB.maps}\n\nWhatsApp: ${KB.whatsapp_link}`,
            `${city} سے اندازاً ڈرائیو: ~${km(drive.meters)} کلو میٹر، ~${hhmm(drive.seconds)}۔\nرہنمائی درکار؟ نقشہ: ${KB.maps}\n\nواٹس ایپ: ${KB.whatsapp_link}`
          );
          return sanitizeVoice(ans);
        }
      }
    }
  }

  if (isWeatherIntent(text) && wx) {
    return sanitizeVoice(L(lang,
      `Weather at Roameo Resorts: ~${wx.temp}°C (feels ${wx.feels}°C) — ${wx.desc}.\nQuestions about dates or rooms? We’re happy to help.\n\nChat on WhatsApp: ${KB.whatsapp_link}`,
      `Roameo Resorts ka mausam: ~${wx.temp}°C (mehsoos ${wx.feels}°C) — ${wx.desc}.\nDates/rooms ke bare mein sawal? Hum madad ko tayyar hain.\n\nWhatsApp: ${KB.whatsapp_link}`,
      `رو میو ریزورٹس کا موسم: ~${wx.temp}°C (محسوس ${wx.feels}°C) — ${wx.desc}۔\nتاریخوں یا کمروں سے متعلق سوال ہو تو بتائیں۔\n\nواٹس ایپ: ${KB.whatsapp_link}`
    ));
  }

  // General/irrelevant → GPT short + Roameo tie-back
  const gpt = await generateGPTReply({ userText: text, lang, asComment });
  const withCTA = attachCTA(gpt, 'general', ctx.platform === 'instagram' ? 'instagram' : 'facebook', ctx.surface);
  return withCTA;
}

/* =========================
   DM price message (exported helper)
   ========================= */
const dmPriceMessage = (userText='') => msgPrices(detectLanguage(userText));

/* =========================
   WEBHOOKS & ROUTERS
   ========================= */
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  const body = req.body || {};
  try {
    if (body.object === 'page') {
      for (const entry of (body.entry || [])) {
        const key = `page:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) await routeMessengerEvent(ev, { source: 'messaging' }).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routePageChange(change).catch(logErr);
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            if (!ALLOW_REPLY_IN_STANDBY) continue;
            if (AUTO_TAKE_THREAD_CONTROL && ev.sender?.id) await takeThreadControl(ev.sender.id).catch(()=>{});
            await routeMessengerEvent(ev, { source: 'standby' }).catch(logErr);
          }
        }
      }
      return;
    }

    if (body.object === 'instagram') {
      for (const entry of (body.entry || [])) {
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
  } catch (e) { logErr(e); }
});

function logAxiosError(e) {
  if (e?.response) {
    console.error('FB API error', {
      url: e.config?.url,
      method: e.config?.method,
      params: e.config?.params,
      data: e.config?.data,
      status: e.response.status,
      fb: e.response.data
    });
  } else {
    console.error('FB API error (no response)', e?.message);
  }
}
function logErr(err) {
  if (err?.response) return logAxiosError(err);
  console.error('💥 Handler error:', err?.response?.data || err.message || err);
}

/* =========================
   FB Messenger (DMs)
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
   FB Page Comments
   ========================= */
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  try {
    await axios.post(url, { message: (message || '').slice(0, MAX_OUT_CHAR) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
  } catch (e) { logAxiosError(e); }
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  try {
    await axios.post(url, { message: splitToChunks(message)[0] }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
  } catch (e) { logAxiosError(e); }
}
function isSelfComment(v = {}, platform = 'facebook') {
  const from = v.from || {};
  if (platform === 'instagram') return from.username && from.username.toLowerCase() === BRAND_USERNAME.toLowerCase();
  return (from.name || '').toLowerCase().includes('roameo');
}
async function routePageChange(change) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item === 'comment' && v.comment_id) {
    const text = (v.message || '').trim();
    if (v.verb !== 'add') return;
    if (isSelfComment(v, 'facebook')) return;

    if (AUTO_REPLY_ENABLED) {
      if (isPricingIntent(text)) {
        try { await fbPrivateReplyToComment(v.comment_id, dmPriceMessage(text)); } catch (e) {}
        await replyToFacebookComment(v.comment_id, L(detectLanguage(text),
          'Please DM us for rates — exclusive DM-only deals! 🔒',
          'Rates ke liye DM karein — sirf DM mein deals! 🔒',
          'براہِ کرم ریٹس کے لیے DM کریں — خصوصی آفرز صرف DM میں! 🔒'
        ));
        return;
      }
      const reply = await decideReply(text, { surface: 'comment', platform: 'facebook' });
      await replyToFacebookComment(v.comment_id, reply);
    }
  }
}

/* =========================
   Instagram (DMs + Comments)
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
  try {
    await axios.post(url, { message: (message || '').slice(0, MAX_OUT_CHAR) }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
  } catch (e) { logAxiosError(e); }
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
  const payload = { recipient: { comment_id: commentId }, message: { text: splitToChunks(message)[0] } };
  try {
    await axios.post(url, payload, { params, timeout: 10000 });
  } catch (e) { logAxiosError(e); }
}
async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const isComment = (change.field || '').toLowerCase().includes('comment') || (v.item === 'comment');
  if (isComment && (v.comment_id || v.id)) {
    const commentId = v.comment_id || v.id;
    const text = (v.text || v.message || '').trim();
    if (v.verb && v.verb !== 'add') return;
    if (isSelfComment(v, 'instagram')) return;

    if (AUTO_REPLY_ENABLED) {
      if (isPricingIntent(text)) {
        try { await igPrivateReplyToComment(pageId, commentId, dmPriceMessage(text)); } catch (e) {}
        await replyToInstagramComment(commentId, L(detectLanguage(text),
          'Please DM us for rates — exclusive DM-only deals! 🔒',
          'Rates ke liye DM karein — sirf DM mein deals! 🔒',
          'براہِ کرم ریٹس کے لیے DM کریں — خصوصی آفرز صرف DM میں! 🔒'
        ));
        return;
      }
      const reply = await decideReply(text, { surface: 'comment', platform: 'instagram' });
      await replyToInstagramComment(commentId, reply);
    }
  }
}

/* =========================
   Shared DM handler
   ========================= */
function isAffirmative(text = '') {
  const t = (text || '').trim().toLowerCase();
  // DO NOT match "please" (bug that hijacked "Charges please")
  const en = /\b(yes|yeah|yep|sure|ok(ay)?|go ahead|sounds good|alright|affirmative|y)\b/;
  const ru = /\b(haan|han|ji|jee|bilkul|theek(?:\s*hai)?|acha|accha|zaroor|krdo|kardo|kar do|kr den|krden)\b/;
  const ur = /(?:\u062C\u06CC|\u062C\u06CC\u06C1|\u06C1\u0627\u06BA|\u0628\u0644\u06A9\u0644|\u062A\u06BE\u06CC\u06A9\s?\u06C1\u06D2?)/;
  return en.test(t) || ru.test(t) || ur.test(t);
}

async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  const lang = detectLanguage(text);
  const state = convo.get(psid);

  if (isAffirmative(text)) {
    convo.set(psid, 'awaiting_details');
    const msg = L(lang,
      `Awesome! Please share your *travel dates* and *number of guests*. Also tell us *which city you’ll start from*.`,
      `Great! Apni *dates* aur *guests ki tadaad* bata dein. Saath *kis shehar se aa rahe hain* bhi likh dein.`,
      `زبردست! براہِ کرم اپنی *تاریخیں* اور *مہمانوں کی تعداد* بتا دیں۔ ساتھ *کس شہر سے آرہے ہیں* بھی بتا دیں۔`
    );
    return sendBatched(psid, msg);
  }

  // If they were giving details, thank + link (but don’t derail rates intent)
  if (state === 'awaiting_details' && !isPricingIntent(text)) {
    convo.delete(psid);
    const msg = L(lang,
      `Thanks! To confirm your booking, please use: ${KB.site}`,
      `Shukriya! Booking confirm karne ke liye ye link use karein: ${KB.site}`,
      `شکریہ! بکنگ کنفرم کرنے کے لیے یہ لنک استعمال کریں: ${KB.site}`
    );
    await sendBatched(psid, msg);
  }

  if (!AUTO_REPLY_ENABLED) return;
  const reply = await decideReply(text, { surface: 'dm', platform: opts.channel === 'instagram' ? 'instagram' : 'facebook' });
  await sendBatched(psid, reply);
}

/* =========================
   SEND API
   ========================= */
async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } };
  try {
    await axios.post(url, payload, { params, timeout: 10000 });
  } catch (e) { logAxiosError(e); }
}

/* =========================
   HANDOVER (optional)
   ========================= */
async function takeThreadControl(psid) {
  const url = 'https://graph.facebook.com/v19.0/me/take_thread_control';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  try { await axios.post(url, { recipient: { id: psid } }, { params, timeout: 10000 }); }
  catch (e) { logAxiosError(e); }
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
  const subscribed_fields = ['messages','messaging_postbacks','messaging_optins','message_deliveries','message_reads','feed'];
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const { data } = await axios.post(url, { subscribed_fields }, { params, timeout: 10000 });
    res.json({ ok: true, data, subscribed_fields });
  } catch (e) {
    logAxiosError(e);
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
        GEOAPIFY: Boolean(GEOAPIFY_API_KEY),
        OPENWEATHER: Boolean(OPENWEATHER_API_KEY),
        RESORT_COORDS,
        CHECKIN: KB.checkin,
        CHECKOUT: KB.checkout,
        RIVER: KB.river_name
      }
    });
  } catch (e) {
    logAxiosError(e);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
