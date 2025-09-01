// server.js — Roameo Resorts omni-channel bot (v6)
// FB DMs + FB comments + IG DMs + IG comments
// Languages: EN / Urdu / Roman-Urdu
// Fixes: reliable DM pricing, IG/FB video/exterior → Instagram profile, contact → WhatsApp,
//       natural brand pivot (no forced “At Roameo…”), tight/public-safe replies.

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');

const app = express();
const PORT = process.env.PORT || 10000;

/* ========================= ENV & CONSTANTS ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// OpenAI (optional)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Toggles
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY = String(process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

// IG token (can reuse PAGE token if scoped)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Enrichment (optional)
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
const RESORT_COORDS = (process.env.RESORT_COORDS || '').trim(); // "lat,lon"
const RESORT_LOCATION_NAME = process.env.RESORT_LOCATION_NAME || 'Roameo Resorts, Tehjian (Neelum)';

// Links
const INSTAGRAM_PROFILE = 'https://www.instagram.com/roameoresorts/';
const BRAND_USERNAME = 'roameoresorts';
const WHATSAPP_NUMBER = '03558000078';                 // IG public comments show number
const WHATSAPP_LINK   = 'https://wa.me/923558000078';  // FB comments & all DMs
const SITE_URL   = 'https://www.roameoresorts.com/';
const SITE_SHORT = 'roameoresorts.com';
const MAPS_LINK  = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Outgoing message limits (Messenger hard cap ~1000)
const MAX_OUT_CHAR = 800;

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT fallbacks will be used only where possible.');
}

/* ========================= PROMO / PRICES ========================= */
const DISCOUNT = { percent: 40, validUntilText: '6th September 2025' };

const FACTS = {
  site: SITE_URL,
  map: MAPS_LINK,
  resort_coords: RESORT_COORDS,
  location_name: RESORT_LOCATION_NAME,
  river_name: 'Neelam River',
  checkin: CHECKIN_TIME,
  checkout: CHECKOUT_TIME,
  tnc: [
    'Rates are inclusive of all taxes',
    'Complimentary breakfast for 2 guests per booking',
    'Additional breakfast charges: PKR 500 per person',
    '50% advance payment required to confirm the reservation',
    `Offer valid till ${DISCOUNT.validUntilText}`
  ],
  rates: {
    deluxe:    { base: 30000 },
    executive: { base: 50000 }
  },
  facilities: [
    'Private riverfront huts facing the Neelam River',
    'Heaters, inverters & insulated huts (cozy even in winters)',
    'In-house kitchen (local & desi meals)',
    'Private internet access + SCOM SIM support',
    'Spacious rooms, modern interiors, artistic decor',
    'Family-friendly atmosphere',
    'Luggage assistance from private parking',
    'Free 4×4 jeep assist for elderly / water crossing',
    'Bonfire & outdoor seating on request'
  ]
};

/* ========================= MIDDLEWARE & CACHES ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const tinyCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 10 }); // 10m
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });    // DM state

/* ========================= BASIC ROUTES ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));

/* ========================= VERIFY ========================= */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'] || req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && (token === VERIFY_TOKEN)) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ========================= SECURITY ========================= */
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

/* ========================= HELPERS: sanitize, language, intents ========================= */
function sanitizeVoice(text = '') {
  if (!text) return '';
  const urls = [];
  let s = String(text).replace(/https?:\/\/\S+/gi, (m) => { urls.push(m); return `__URL${urls.length - 1}__`; });

  s = s.replace(/\r\n/g, '\n')
       .replace(/[ \t]+\n/g, '\n')
       .replace(/\n[ \t]+/g, '\n')
       .replace(/\s{2,}/g, ' ')
       .replace(/\n{3,}/g, '\n\n');

  s = s
    .replace(/\bI\'m\b/gi, 'we’re')
    .replace(/\bI am\b/gi, 'we are')
    .replace(/\bI\'ll\b/gi, 'we’ll')
    .replace(/\bI\b/gi, 'we')
    .replace(/\bme\b/gi, 'us')
    .replace(/\bmy\b/gi, 'our')
    .replace(/\bmine\b/gi, 'ours');

  s = s.trim().replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)]);
  return s;
}
function normalizeForIntent(s='') {
  return String(s).normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function stripPricesFromPublic(text = '') {
  const lines = (text || '').split(/\r?\n/).filter(Boolean).filter(l => {
    const s = l.toLowerCase();
    const hasCurrency = /(?:pkr|rs\.?|rupees|price|prices|pricing|rate|rates|tariff|per\s*night|rent|rental|kiraya|قیمت|کرایہ|ریٹ|نرخ)/i.test(s);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(s);
    return !(hasCurrency || hasMoneyish);
  });
  return lines.join(' ');
}
function detectLanguage(text = '') {
  const t = (text || '').trim();
  const hasUrduScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (hasUrduScript) return 'ur';
  const romanUrduTokens = [
    'aap','ap','apka','apki','apke','tum','bhai','plz','pls','krdo','kardo','krna','karna',
    'raha','rha','rhe','rahe','gi','ga','hain','hy','hai','mein','mai','mujhe','acha','accha',
    'bohat','bahut','kitna','kitni','kitne','kitnay','kiraya','qeemat','keemat','kimat','rate','price','pricing',
    'room','booking','mausam','rasta','route','se','say'
  ];
  const hit = romanUrduTokens.some(w => new RegExp(`\\b${w}\\b`, 'i').test(t));
  return hit ? 'roman-ur' : 'en';
}

/* ======= INTENTS (inclusive) ======= */
function isPricingIntent(text = '') {
  const t = normalizeForIntent(text);
  if (/\bhow much\b/.test(t)) return true;
  if (/\bkitna\b|\bkitni\b|\bkitne\b|\bkitnay\b/.test(t)) return true;
  if (/\bper night\b|\bpernight\b|\bnight price\b|\broom price\b|\bhut price\b/.test(t)) return true;
  const en = ['price','prices','pricing','quote','rate','rates','tariff','cost','costs','fee','fees','charge','charges','rent','rental'];
  const ru = ['kiraya','kiraye','qeemat','keemat','kimat','qeematein','rate kya','price kya'];
  const ur = ['قیمت','قیمتیں','کرایہ','کرائے','نرخ','ریٹ','کتنا','کتنی'];
  for (const w of [...en, ...ru, ...ur]) if (t.includes(w)) return true;
  if (/\b\d+\s*(price|prices|rate|rates|rent|rental|fee|fees)\b/.test(t)) return true;
  return false;
}
function isVideoIntent(text='') {
  const t = normalizeForIntent(text);
  return /\bvideo\b|\bcurrent video\b|\bfootage\b|\bexterior\b|\boutside\b|\bhotel exterior\b|\bphotos?\b|\bpictures?\b/.test(t);
}
function isRouteIntent(text='') {
  const t = normalizeForIntent(text);
  return /\broute\b|\bdirections?\b|\brasta\b|\brahnumai\b|\breach\b/.test(t);
}

/* ========================= CHUNK + SEND ========================= */
function splitToChunks(s, limit = MAX_OUT_CHAR) {
  const out = []; let str = (s || '').trim();
  while (str.length > limit) {
    let cut = Math.max(
      str.lastIndexOf('\n', limit),
      str.lastIndexOf('. ', limit),
      str.lastIndexOf('•', limit),
      str.lastIndexOf('—', limit),
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
  for (const p of parts) for (const chunk of splitToChunks(p, MAX_OUT_CHAR)) await sendText(psid, chunk);
}
function trimForComment(s, limit = MAX_OUT_CHAR) { return (s || '').length <= limit ? s : s.slice(0, limit - 1).trim() + '…'; }

/* ========================= PUBLIC HOOKS (no prices) ========================= */
const HOOKS = {
  en: [
    `Flat ${DISCOUNT.percent}% OFF till ${DISCOUNT.validUntilText} — DM us for the full rate list & availability! ✨`,
    `Limited-time ${DISCOUNT.percent}% discount! DM now for rates & quick booking. 🌿`
  ],
  'roman-ur': [
    `Flat ${DISCOUNT.percent}% OFF ${DISCOUNT.validUntilText} tak — rates aur availability ke liye DM karein! ✨`,
    `Limited-time ${DISCOUNT.percent}% discount! Rates chahiye? DM now. 🌿`
  ],
  ur: [
    `فلیٹ ${DISCOUNT.percent}% ڈسکاؤنٹ ${DISCOUNT.validUntilText} تک — مکمل ریٹ لسٹ اور دستیابی کے لیے DM کیجیے! ✨`,
    `محدود وقت کے لیے ${DISCOUNT.percent}% رعایت! ریٹس کے لیے DM کریں۔ 🌿`
  ]
};
function priceNudgePublic(lang = 'en') {
  const arr = HOOKS[lang] || HOOKS.en;
  return trimForComment(arr[Math.floor(Math.random() * arr.length)]);
}

/* ========================= ENRICHMENT (optional) ========================= */
function km(meters) { return (meters / 1000).toFixed(0); }
function hhmm(seconds) { const h = Math.floor(seconds/3600); const m = Math.round((seconds%3600)/60); return `${h}h ${m}m`; }
async function geocodePlace(place) {
  if (!GEOAPIFY_API_KEY || !place) return null;
  const key = `geo:${place.toLowerCase()}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.geoapify.com/v1/geocode/search';
    const { data } = await axios.get(url, { params: { text: place, limit: 1, apiKey: GEOAPIFY_API_KEY }, timeout: 10000 });
    const feat = data?.features?.[0]; if (!feat) return null;
    const [lon, lat] = feat.geometry.coordinates || [];
    const res = { lat, lon }; tinyCache.set(key, res); return res;
  } catch (e) { console.error('geoapify geocode error', e?.response?.data || e.message); return null; }
}
async function routeDrive(originLat, originLon, destLat, destLon) {
  if (!GEOAPIFY_API_KEY) return null;
  const key = `route:${originLat},${originLon}->${destLat},${destLon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.geoapify.com/v1/routing';
    const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
    const { data } = await axios.get(url, { params: { waypoints, mode: 'drive', apiKey: GEOAPIFY_API_KEY }, timeout: 12000 });
    const ft = data?.features?.[0]?.properties; if (!ft) return null;
    return { meters: ft.distance, seconds: ft.time };
  } catch (e) { console.error('geoapify routing error', e?.response?.data || e.message); return null; }
}

/* ========================= STATIC MESSAGE HELPERS ========================= */
function locationMessageByLang(lang = 'en') {
  if (lang === 'ur') {
    return `*Roameo Resorts کا لوکیشن لنک:*\n\n👉 ${MAPS_LINK}\n\n*اہم معلومات:*\n🚙 نیلم ویلی کی سڑکیں مکمل طور پر کارپیٹڈ ہیں — سفر ہموار اور دلکش رہتا ہے۔\n\n🅿️ ریزورٹ کے قریب ایک چھوٹا سا واٹر کراسنگ ہے؛ سیڈان/لو کلیرنس گاڑیاں ہماری پرائیویٹ پارکنگ میں پارک کی جا سکتی ہیں (صرف 1 منٹ واک)۔\n\n💼 ہمارا عملہ سامان میں مدد کرتا ہے، اور بزرگ مہمانوں کے لیے آخری حصے پر *مفت جیپ ٹرانسفر* بھی موجود ہے۔`;
  }
  if (lang === 'roman-ur') {
    return `*Roameo Resorts location link:*\n\n👉 ${MAPS_LINK}\n\n*Good to know:*\n🚙 Neelum Valley ki roads fully carpeted hain—ride smooth aur scenic rehti hai.\n\n🅿️ Resort ke qareeb chhota sa water crossing hota hai; sedan/low-clearance cars private parking (sirf 1-minute walk) use kar sakti hain.\n\n💼 Team luggage mein madad karti hai; buzurg mehmanon ke liye last stretch par *free jeep transfer* available hai.`;
  }
  return `*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\n*Good to know:*\n🚙 Roads are fully carpeted for a smooth, scenic drive.\n\n🅿️ There’s a small water crossing near the resort; sedans use our private parking (1-minute walk).\n\n💼 Our team helps with luggage and offers a *free jeep transfer* for elderly guests on the final stretch.`;
}

function instagramMediaMessage(lang='en') {
  if (lang === 'ur') return `ہم Roameo Resorts کی تازہ *ویڈیوز اور تصاویر* انسٹاگرام پر شیئر کرتے ہیں:\n${INSTAGRAM_PROFILE}\n\nمزید معلومات یا بکنگ کے لیے WhatsApp پر رابطہ کریں: ${WHATSAPP_LINK}`;
  if (lang === 'roman-ur') return `Roameo Resorts ki fresh *videos aur photos* dekhne ke liye hamara Instagram profile check karein:\n${INSTAGRAM_PROFILE}\n\nDetails/booking: WhatsApp ${WHATSAPP_LINK}`;
  return `You can see fresh *videos and photos* of Roameo Resorts on Instagram:\n${INSTAGRAM_PROFILE}\n\nFor details or booking: WhatsApp ${WHATSAPP_LINK}`;
}

/* ========================= DM PRICE MESSAGE (tight, discounted) ========================= */
function discounted(n) { return Math.round(n * (1 - DISCOUNT.percent / 100)); }
function fm(n){ return Number(n).toLocaleString('en-PK'); }

async function dmPriceMessage(userText = '') {
  const lang = detectLanguage(userText);
  const dBase = FACTS.rates.deluxe.base, eBase = FACTS.rates.executive.base;
  const dDisc = discounted(dBase), eDisc = discounted(eBase);

  let msg;
  if (lang === 'ur') {
    msg = [
`ہم Roameo Resorts میں اس وقت ${DISCOUNT.percent}% محدود مدت کی رعایت پیش کر رہے ہیں — صرف ${DISCOUNT.validUntilText} تک!`,
`📍 Discounted Rates:`,
`ڈیلکس ہٹ – PKR ${fm(dBase)} فی رات`,
`✨ فلیٹ ${DISCOUNT.percent}% آف → PKR ${fm(dDisc)} فی رات`,
`ایگزیکٹو ہٹ – PKR ${fm(eBase)} فی رات`,
`✨ فلیٹ ${DISCOUNT.percent}% آف → PKR ${fm(eDisc)} فی رات`,
`Terms & Conditions:`,
`• ٹیکس شامل  • 2 مہمانوں کے لیے ناشتہ شامل  • اضافی ناشتہ PKR 500  • 50% ایڈوانس  • آفر ${DISCOUNT.validUntilText} تک`,
`WhatsApp: ${WHATSAPP_LINK}\nAvailability / Book: ${SITE_URL}`
    ].join('\n');
  } else if (lang === 'roman-ur') {
    msg = [
`Roameo Resorts par ${DISCOUNT.percent}% limited-time discount — till ${DISCOUNT.validUntilText}!`,
`📍 Discounted Rates:`,
`Deluxe Hut – PKR ${fm(dBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(dDisc)}/night`,
`Executive Hut – PKR ${fm(eBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(eDisc)}/night`,
`Terms & Conditions:`,
`• Taxes included  • Breakfast for 2  • Extra breakfast PKR 500  • 50% advance  • Offer till ${DISCOUNT.validUntilText}`,
`WhatsApp: ${WHATSAPP_LINK}\nAvailability / Book: ${SITE_URL}`
    ].join('\n');
  } else {
    msg = [
`We’re offering a ${DISCOUNT.percent}% limited-time discount at Roameo Resorts — valid till ${DISCOUNT.validUntilText}!`,
`📍 Discounted Rates:`,
`Deluxe Hut – PKR ${fm(dBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(dDisc)}/night`,
`Executive Hut – PKR ${fm(eBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(eDisc)}/night`,
`Terms & Conditions:`,
`• Taxes included  • Breakfast for 2  • Extra breakfast PKR 500  • 50% advance  • Offer till ${DISCOUNT.validUntilText}`,
`WhatsApp: ${WHATSAPP_LINK}\nAvailability / Book: ${SITE_URL}`
    ].join('\n');
  }
  return sanitizeVoice(msg);
}

/* ========================= ROUTE MESSAGE (DM) ========================= */
function extractOrigin(text='') {
  const t = text.trim();
  const rx = [
    /route\s+from\s+(.+)$/i,
    /from\s+(.+)\s+(?:to|till|for)?\s*(?:roameo|resort|neelum|tehjian)?$/i,
    /(.+)\s+(?:se|say)\s+(?:rasta|route)/i
  ];
  for (const r of rx) { const m = t.match(r); if (m && m[1]) return m[1].replace(/[.?!]+$/,'').trim(); }
  return null;
}
async function dmRouteMessage(userText = '') {
  const lang = detectLanguage(userText);
  let origin = extractOrigin(userText);
  if (!origin) {
    const ask = lang === 'ur'
      ? 'براہِ کرم روانگی کا شہر بتائیں۔ مثال: "route from Lahore"'
      : lang === 'roman-ur'
        ? 'Apni rawangi ka shehar batayein. Example: "route from Lahore"'
        : 'Please tell us your departure city. Example: "route from Lahore".';
    return ask;
  }
  const destParts = (RESORT_COORDS || '').split(',').map(s => s.trim());
  if (destParts.length !== 2) return 'Location temporarily unavailable. Please try later.';
  const [dLat, dLon] = destParts.map(parseFloat);
  const originGeo = await geocodePlace(origin);
  let routeInfo = null;
  if (originGeo) {
    const r = await routeDrive(originGeo.lat, originGeo.lon, dLat, dLon);
    if (r) routeInfo = { origin, distance_km: Number(km(r.meters)), drive_time: hhmm(r.seconds) };
  }
  const simple = routeInfo
    ? (lang === 'ur'
        ? `*${origin}* سے Roameo Resorts تک تقریباً ${routeInfo.distance_km} کلو میٹر — ڈرائیو ${routeInfo.drive_time}.\n\nلوکیشن: ${MAPS_LINK}`
        : lang === 'roman-ur'
          ? `From *${origin}* to Roameo Resorts ~${routeInfo.distance_km} km (~${routeInfo.drive_time}).\n\nLocation: ${MAPS_LINK}`
          : `From *${origin}* to Roameo Resorts is ~${routeInfo.distance_km} km (~${routeInfo.drive_time}).\n\nLocation: ${MAPS_LINK}`)
    : (lang === 'ur' ? `لوکیشن لنک: ${MAPS_LINK}` : `Location: ${MAPS_LINK}`);
  return sanitizeVoice(`${simple}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
}

/* ========================= GENERIC FALLBACK (answer + Roameo pivot) ========================= */
function fallbackGeneral(lang = 'en', userText = '') {
  const t = normalizeForIntent(userText);
  let lead;

  if (/earth.*flat|flat.*earth/.test(t)) {
    lead = (lang === 'ur') ? 'زمین چپٹی نہیں، بلکہ ایک oblate spheroid ہے۔'
      : (lang === 'roman-ur') ? 'Earth flat nahi—oblate spheroid hoti hai.'
      : 'The earth is not flat; it’s an oblate spheroid.';
  } else if (/what is\b/.test(t)) {
    const term = userText.replace(/^.*what is/i, '').replace(/[?!.]+$/,'').trim() || 'this';
    lead = (lang === 'ur') ? `عمومی طور پر “${term}” کی تعریف سیاق پر منحصر ہوتی ہے۔`
      : (lang === 'roman-ur') ? `"${term}" ki definition context par depend karti hai.`
      : `“${term}” depends on context.`;
  } else {
    lead = (lang === 'ur') ? 'اچھا سوال! مختصر جواب سیاق پر منحصر ہے۔'
      : (lang === 'roman-ur') ? 'Achha sawaal—short answer context par depend karta hai.'
      : 'Good question—the short answer depends on context.';
  }

  const pivot = (lang === 'ur')
    ? 'ویسے Roameo Resorts میں دریا کے سامنے ہٹس، ناشتہ اور گرم، آرام دہ رہائش آپ کے قیام کو خاص بنا دیتی ہے۔'
    : (lang === 'roman-ur')
      ? 'Waise Roameo Resorts ki riverfront huts, breakfast aur cozy stay aap ka break aur behtar bana dete hain.'
      : 'By the way, at Roameo Resorts our river-front huts, cozy interiors, and breakfast make an easy, relaxing escape.';

  return sanitizeVoice(`${lead}\n${pivot}\n\nWhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`);
}

/* ========================= INTENT BUNDLE ========================= */
function intentFromText(text = '') {
  const t = normalizeForIntent(text);
  const wantsLocation   = /\blocation\b|\bwhere\b|\baddress\b|\bmap\b|\bpin\b|\bdirections?\b|\bgoogle maps\b|\breach\b/.test(t);
  const wantsRates      = isPricingIntent(text);
  const wantsFacilities = /\bfaciliti(?:y|ies)\b|\bamenit(?:y|ies)\b|\bwifi\b|\binternet\b|\bkitchen\b|\bfood\b|\bmeal\b|\bheater\b|\bbonfire\b|\bfamily\b|\bkids?\b|\bparking\b|\bjeep\b|\binverter\b/.test(t);
  const wantsBooking    = /\bbook\b|\bbooking\b|\breserve\b|\breservation\b|\bcheck ?in\b|\bcheck ?out\b|\badvance\b|\bpayment\b/.test(t);
  const wantsAvail      = /\bavailability\b|\bavailable\b|\bdates?\b|\bcalendar\b/.test(t);
  const wantsDistance   = /\bdistance\b|\bhow far\b|\bhours\b|\bdrive\b|\btime from\b|\beta\b/.test(t);
  const wantsWeather    = /\bweather\b|\btemperature\b|\bcold\b|\bhot\b|\bforecast\b|\brain\b|\bmausam\b/.test(t);
  const wantsRoute      = isRouteIntent(text);
  const wantsContact    = /\bcontact\b|\bmanager\b|\bowner\b|\bnumber\b|\bphone\b|\bwhats\s*app\b|\bwhatsapp\b|\bcall\b|\bspeak to\b|\braabta\b/.test(t);
  const wantsVideo      = isVideoIntent(text);
  return { wantsLocation, wantsRates, wantsFacilities, wantsBooking, wantsAvail,
           wantsDistance, wantsWeather, wantsRoute, wantsContact, wantsVideo };
}

/* ========================= DM FLOW ========================= */
function isAffirmative(text = '') {
  const t = normalizeForIntent(text);
  const en = /\b(yes|yeah|yep|sure|okay|ok|please|go ahead|sounds good|alright|y)\b/;
  const ru = /\b(haan|han|ji|jee|bilkul|theek hai|acha|accha|zaroor|krdo|kardo|kar do|kr den|krden)\b/;
  const ur = /(?:\u062C\u06CC|\u062C\u06CC\u06C1|\u06C1\u0627\u06BA|\u0628\u0644\u06A9\u0644|\u062A\u06BE\u06CC\u06A9)/;
  return en.test(t) || ru.test(t) || ur.test(t);
}

async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  const lang = detectLanguage(text);
  const state = convo.get(psid);
  const intents = intentFromText(text);

  // Route origin follow-up
  if (state === 'awaiting_route_origin') {
    convo.delete(psid);
    return sendBatched(psid, await dmRouteMessage(text));
  }

  if (isAffirmative(text)) {
    convo.set(psid, 'awaiting_details');
    const msg = lang === 'ur'
      ? `زبردست! براہِ کرم اپنی *تاریخیں* اور *مہمانوں کی تعداد* بتا دیں۔ اگر چاہیں تو *کس شہر سے آرہے ہیں* بھی بتا دیں۔`
      : lang === 'roman-ur'
        ? `Great! Apni *dates* aur *guests ki tadaad* bata dein. Chahein to *kis shehar se aa rahe hain* bhi likh dein.`
        : `Awesome! Please share your *travel dates* and *number of guests*. Also tell us *which city you’ll start from*.`;
    return sendBatched(psid, msg);
  }

  // Contact / manager / phone → WhatsApp (no extra questions)
  if (intents.wantsContact) {
    const msg = (lang === 'ur')
      ? `ہماری ٹیم WhatsApp پر فوری جواب دیتی ہے:\n${WHATSAPP_LINK}`
      : (lang === 'roman-ur')
        ? `Fast response ke liye WhatsApp par message karein:\n${WHATSAPP_LINK}`
        : `For a quick response, reach us on WhatsApp:\n${WHATSAPP_LINK}`;
    return sendBatched(psid, msg);
  }

  if (state === 'awaiting_details') {
    convo.delete(psid);
    const msg = lang === 'ur'
      ? `شکریہ! بکنگ کی تصدیق کے لیے ویب سائٹ استعمال کریں: ${SITE_URL}`
      : lang === 'roman-ur'
        ? `Shukriya! Booking confirm karne ke liye: ${SITE_URL}`
        : `Thanks! To confirm your booking, please use: ${SITE_URL}`;
    await sendBatched(psid, msg);
  }

  if (!AUTO_REPLY_ENABLED) return;

  // Fast DM branches
  if (intents.wantsVideo) {
    return sendBatched(psid, instagramMediaMessage(lang));
  }
  if (intents.wantsLocation) {
    const blocks = sanitizeVoice(locationMessageByLang(lang)) + `\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`;
    return sendBatched(psid, blocks);
  }
  if (intents.wantsRates) {
    return sendBatched(psid, await dmPriceMessage(text)); // <-- always send prices in DMs
  }
  if (intents.wantsRoute || intents.wantsDistance) {
    const origin = extractOrigin(text);
    if (!origin) {
      convo.set(psid, 'awaiting_route_origin');
      const ask = lang === 'ur'
        ? 'براہِ کرم روانگی کا شہر بتائیں۔ مثال: "route from Lahore"'
        : lang === 'roman-ur'
          ? 'Apni rawangi ka shehar batayein. Example: "route from Lahore"'
          : 'Please tell us your departure city. Example: "route from Lahore".';
      return sendBatched(psid, ask);
    }
    return sendBatched(psid, await dmRouteMessage(text));
  }

  // Generic answer + brand pivot
  const reply = fallbackGeneral(lang, text);
  await sendBatched(psid, reply);
}

/* ========================= WEBHOOKS & ROUTERS ========================= */
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

function logErr(err) {
  const payload = err?.response?.data || err.message || err;
  if (payload?.error) console.error('FB API error', payload);
  else console.error('💥 Handler error:', payload);
}

/* ========================= FB Messenger (DMs) ========================= */
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

/* ========================= FB Page Comments ========================= */
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message: trimForComment(message) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(url, { message: splitToChunks(message)[0] }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
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
      const lang = detectLanguage(text);
      if (isPricingIntent(text)) {
        try { await fbPrivateReplyToComment(v.comment_id, await dmPriceMessage(text)); } catch (e) { logErr(e); }
        await replyToFacebookComment(v.comment_id, priceNudgePublic(lang));
        return;
      }
      if (isVideoIntent(text)) {
        const msg = (lang === 'ur')
          ? `Roameo Resorts کی تازہ ویڈیوز/تصاویر یہاں دیکھیں: ${INSTAGRAM_PROFILE}`
          : (lang === 'roman-ur')
            ? `Roameo Resorts ki videos/photos ke liye: ${INSTAGRAM_PROFILE}`
            : `See Roameo Resorts videos/photos here: ${INSTAGRAM_PROFILE}`;
        await replyToFacebookComment(v.comment_id, trimForComment(`${msg}\nWhatsApp: ${WHATSAPP_LINK}`));
        return;
      }
      const reply = await decideReply(text, { surface: 'comment', platform: 'facebook' });
      await replyToFacebookComment(v.comment_id, reply);
    }
  }
}

/* ========================= Instagram (DMs + Comments) ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    return handleTextMessage(igUserId, event.message.text || '', { channel: 'instagram' });
  }
}
async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message: trimForComment(message) }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
  const payload = { recipient: { comment_id: commentId }, message: { text: splitToChunks(message)[0] } };
  await axios.post(url, payload, { params, timeout: 10000 });
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
      const lang = detectLanguage(text);
      if (isPricingIntent(text)) {
        try { await igPrivateReplyToComment(pageId, commentId, await dmPriceMessage(text)); } catch (e) { logErr(e); }
        await replyToInstagramComment(commentId, priceNudgePublic(lang));
        return;
      }
      if (isVideoIntent(text)) {
        const msg = (lang === 'ur')
          ? `Roameo Resorts کی ویڈیوز/تصاویر: ${INSTAGRAM_PROFILE}\n\nWhatsApp: ${WHATSAPP_NUMBER}`
          : (lang === 'roman-ur')
            ? `Roameo Resorts videos/photos: ${INSTAGRAM_PROFILE}\n\nWhatsApp: ${WHATSAPP_NUMBER}`
            : `Roameo Resorts videos/photos: ${INSTAGRAM_PROFILE}\n\nWhatsApp: ${WHATSAPP_NUMBER}`;
        await replyToInstagramComment(commentId, trimForComment(msg));
        return;
      }
      const reply = await decideReply(text, { surface: 'comment', platform: 'instagram' });
      await replyToInstagramComment(commentId, reply);
    }
  }
}

/* ========================= Decide reply for comments ========================= */
async function decideReply(text, { surface, platform }) {
  const lang = detectLanguage(text);
  const intents = intentFromText(text);

  if (intents.wantsLocation) {
    return attachCTA(stripPricesFromPublic(locationMessageByLang(lang)), 'location', platform, surface);
  }
  if (intents.wantsVideo) {
    const msg = (lang === 'ur')
      ? `Roameo Resorts کی تازہ ویڈیوز/تصاویر: ${INSTAGRAM_PROFILE}`
      : (lang === 'roman-ur')
        ? `Roameo Resorts videos/photos: ${INSTAGRAM_PROFILE}`
        : `See videos/photos: ${INSTAGRAM_PROFILE}`;
    return attachCTA(msg, 'media', platform, surface);
  }

  // Vague → brand-bridged generic (with prices stripped just in case)
  const out = stripPricesFromPublic(fallbackGeneral(lang, text));
  return attachCTA(out, 'general', platform, surface);
}

/* ========================= CTA helpers ========================= */
function shouldAttachCTA() { return true; }
function attachCTA(body, _intent, platform, _surface) {
  const compact = (body || '').trim();
  const already = /WhatsApp:|wa\.me|roameoresorts\.com/i.test(compact);
  if (already) return compact;
  const cta = platform === 'instagram'
    ? `WhatsApp: ${WHATSAPP_NUMBER} • Website: ${SITE_SHORT}`
    : `WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`;
  return `${compact}\n${cta}`.trim();
}

/* ========================= SEND API ========================= */
async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

/* ========================= HANDOVER (optional) ========================= */
async function takeThreadControl(psid) {
  const url = `https://graph.facebook.com/v19.0/me/take_thread_control`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  try { await axios.post(url, { recipient: { id: psid } }, { params, timeout: 10000 }); }
  catch (e) { console.error('take_thread_control error:', e?.response?.data || e.message); }
}

/* ========================= ADMIN HELPERS ========================= */
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
        RESORT_COORDS: FACTS.resort_coords,
        CHECKIN: FACTS.checkin,
        CHECKOUT: FACTS.checkout,
        LOCATION: FACTS.location_name,
        RIVER: FACTS.river_name,
        DISCOUNT: `${DISCOUNT.percent}% until ${DISCOUNT.validUntilText}`,
        BASE_PRICES: { deluxe: FACTS.rates.deluxe.base, executive: FACTS.rates.executive.base }
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
