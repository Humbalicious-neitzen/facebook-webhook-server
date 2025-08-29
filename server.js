// server.js — Roameo Resorts omni-channel bot (v4 - structured, newline-safe)
// FB DMs + FB comments + IG DMs + IG comments
// Language-correct replies (EN/Urdu/Roman-Urdu) + price card (strict layout) + route (Geoapify) + manager/contact handling
// PUBLIC PRICES: FORBIDDEN in comments. Pricing → DM only.
// WhatsApp rules: IG comments = number only; FB comments & all DMs = wa.me link.

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

// IG token (can reuse PAGE token if scoped)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Enrichment (optional)
const GEOAPIFY_API_KEY = process.env.GEOAPIFY_API_KEY || '';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';
const RESORT_COORDS = (process.env.RESORT_COORDS || '').trim(); // "lat,lon"
const RESORT_LOCATION_NAME = process.env.RESORT_LOCATION_NAME || 'Roameo Resorts, Tehjian (Neelum)';

const INSTAGRAM_PROFILE = 'https://www.instagram.com/roameoresorts/';

// ==== Brand constants ====
const BRAND_USERNAME = 'roameoresorts';                // avoid self-replies
const WHATSAPP_NUMBER = '03558000078';                 // IG comments (number only)
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
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT structured replies disabled; fallbacks will be used.');
}

/* =======================================================
   40% OFF CAMPAIGN — valid till 6th September 2025
   ======================================================= */
const DISCOUNT = { percent: 40, validUntilText: '6th September 2025' };

/* =========================
   BUSINESS FACTS (Knowledge Base)
   ========================= */
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
  // Base prices are authoritative for discount math.
  rates: {
    deluxe:    { base: 30000, n1: 27000, n2: 25500, n3: 24000 },
    executive: { base: 50000, n1: 45000, n2: 42500, n3: 40000 }
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
  ],
  travel_tips: [
    'Roads in the valley are fully carpeted for a smooth, scenic drive',
    'Small water crossing near the resort; sedans can park at private parking (1-minute walk)',
    'Our team helps with luggage; free jeep transfer available for elderly guests'
  ]
};

/* =========================
   STYLE / EMOJI
   ========================= */
const EMOJI = {
  hello: ['💚','🌿','👋','😊'],
  bullet_ok: ['✅','☑️','🟢'],
  travel: ['🚙','🛣️','🌄'],
  tip: ['💡','✨','📍'],
  close: ['🏞️','🌲','🌊','⭐']
};
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const tinyCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 10 }); // 10m
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 }); // DM state

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
   HELPERS — sanitize, language, intent
   ========================= */
// 🔧 NEW: newline-safe sanitizer (preserves \n & blank lines)
function sanitizeVoice(text = '') {
  if (!text) return '';

  // Protect URLs first so we don't mangle them while normalizing whitespace
  const urls = [];
  let s = String(text).replace(/https?:\/\/\S+/gi, (m) => {
    urls.push(m);
    return `__URL${urls.length - 1}__`;
  });

  // Normalize line endings and trim line edges (but KEEP newlines)
  s = s
    .replace(/\r\n/g, '\n')         // Windows → Unix newlines
    .replace(/[ \t]+\n/g, '\n')     // strip trailing spaces before \n
    .replace(/\n[ \t]+/g, '\n');    // strip leading spaces after \n

  // Brand voice tweaks (don’t touch newlines)
  s = s
    .replace(/\bI\'m\b/gi, 'we’re')
    .replace(/\bI am\b/gi, 'we are')
    .replace(/\bI\'ll\b/gi, 'we’ll')
    .replace(/\bI\b/gi, 'we')
    .replace(/\bme\b/gi, 'us')
    .replace(/\bmy\b/gi, 'our')
    .replace(/\bmine\b/gi, 'ours');

  // Collapse ONLY spaces/tabs (NOT newlines)
  s = s.replace(/[ \t]{2,}/g, ' ');

  // Allow intentional blank lines but cap excessive ones to 2
  s = s.replace(/\n{3,}/g, '\n\n');

  s = s.trim();

   // NEW: normalize text for intent matching (kills emoji/punct, lowercases)
function normalizeForIntent(s='') {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

  // Restore URLs
  s = s.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)]);

  return s;
}

function stripPricesFromPublic(text = '') {
  const lines = (text || '').split(/\r?\n/).filter(Boolean).filter(l => {
    const s = l.toLowerCase();
    const hasCurrency = /(?:pkr|rs\.?|rupees|price|prices|rate|rates|tariff|per\s*night|rent|rental|kiraya)/i.test(s);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(s);
    return !(hasCurrency || hasMoneyish);
  });
  return lines.join(' ');
}
function detectLanguage(text = '') {
  const t = (text || '').trim();
  const hasUrduScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (hasUrduScript) return 'ur';
  // Include single-token roman Urdu (e.g., "btao")
  const romanUrduTokens = [
    'aap','ap','apka','apki','apke','tum','tm','bhai','plz','pls','krdo','kardo','krna','karna',
    'raha','rha','rhe','rahe','gi','ga','hain','hy','hai','mein','mai','mujhe','acha','accha',
    'bohat','bahut','kitna','kitni','kiraya','qeemat','keemat','kimat','rate','price','btao','bta','batao','btaye','btana',
    'room','booking','mausam','rasta','route','se','say'
  ];
  const hit = romanUrduTokens.some(w => new RegExp(`\\b${w}\\b`, 'i').test(t));
  return hit ? 'roman-ur' : 'en';
}
function isPricingIntent(text = '') {
  const t = String(text);
  const n = normalizeForIntent(t);

  // Fast regex hits (English + Roman-Urdu)
  const rxHit =
    /\b(price|prices|rate|rates|tariff|rent|rental|cost|costs|charge|charges)\b/i.test(t) ||
    /\b(per\s*(night|day))\b/i.test(t) ||
    /\b(kiraya|kiraye|qeemat|keemat|kimat|qeematein|btao|batao|btaye)\b/i.test(t) ||
    /\b(kitna|kitni|kitne|kitnay)\b/i.test(t);

  if (rxHit) return true;

  // Urdu-script keywords (RTL; avoid word boundaries)
  if (/(قیمت|کرایہ|کرائے|ریٹ|نرخ)/.test(t)) return true;

  // Normalized contains checks (handles emoji/punct/variants)
  const keywords = [
    'price','prices','rate','rates','tariff','rent','rental','cost','costs','charge','charges',
    'per night','per day','kiraya','kiraye','qeemat','keemat','kimat'
  ];
  if (keywords.some(w => n.includes(w))) return true;

  // Common phrasings
  if (n.includes('how much')) return true;
  if (/(kitne|kitnay)\s*(paise|paisay|ka|ki|ke)/i.test(n)) return true;

  return false;
}

function isRouteIntent(text='') {
  const t = (text||'').toLowerCase();
  return /\b(route|directions?|rasta|rastah|rahnumai|reach)\b/i.test(t);
}
function isPlayful(text='') {
  const t = text.toLowerCase();
  return /awesome|🔥|😂|😅|😜|😉|mausam.*awesome|weather.*awesome|party|vibes/.test(t);
}

/* =========================
   CHUNKING + SEND
   ========================= */
function splitToChunks(s, limit = MAX_OUT_CHAR) {
  const out = [];
  let str = (s || '').trim();
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
  for (const p of parts) {
    for (const chunk of splitToChunks(p, MAX_OUT_CHAR)) {
      await sendText(psid, chunk);
    }
  }
}
function trimForComment(s, limit = MAX_OUT_CHAR) {
  if ((s || '').length <= limit) return s;
  return s.slice(0, limit - 1).trim() + '…';
}

/* =========================
   HOOKS (price nudge) — updated for 40% OFF
   ========================= */
const HOOKS = {
  en: [
    `Flat ${DISCOUNT.percent}% OFF till ${DISCOUNT.validUntilText} — DM us for the full rate list & availability! ✨`,
    `Limited-time ${DISCOUNT.percent}% discount! DM now for rates & quick booking. 🌿`,
    `${DISCOUNT.percent}% OFF launch offer — message us for your deal & dates! 🛖`
  ],
  'roman-ur': [
    `Flat ${DISCOUNT.percent}% OFF ${DISCOUNT.validUntilText} tak — rates aur availability ke liye DM karein! ✨`,
    `Limited-time ${DISCOUNT.percent}% discount! Rates chahiye? DM now. 🌿`,
    `${DISCOUNT.percent}% OFF launch offer — apni dates ke sath DM karein! 🛖`
  ],
  ur: [
    `فلیٹ ${DISCOUNT.percent}% ڈسکاؤنٹ ${DISCOUNT.validUntilText} تک — مکمل ریٹ لسٹ اور دستیابی کے لیے DM کیجیے! ✨`,
    `محدود وقت کے لیے ${DISCOUNT.percent}% رعایت! ریٹس کے لیے DM کریں۔ 🌿`,
    `${DISCOUNT.percent}% ڈسکاؤنٹ آفر — اپنی تاریخوں کے ساتھ DM کریں! 🛖`
  ]
};
function priceNudgePublic(lang = 'en') {
  const arr = HOOKS[lang] || HOOKS.en;
  const hook = arr[Math.floor(Math.random() * arr.length)];
  return trimForComment(hook);
}

/* =========================
   ENRICHMENT (optional)
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
    const ft = data?.features?.[0]?.properties;
    if (!ft) return null;
    return { meters: ft.distance, seconds: ft.time };
  } catch (e) { console.error('geoapify routing error', e?.response?.data || e.message); return null; }
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
  } catch (e) { console.error('openweather error', e?.response?.data || e.message); return null; }
}

/* =========================
   LOCATION MESSAGE (static helper)
   ========================= */
function locationMessageByLang(lang = 'en') {
  if (lang === 'ur') {
    return `*Roameo Resorts کا لوکیشن لنک:*\n\n👉 ${MAPS_LINK}\n\n*اہم معلومات:*\n🚙 نیلم ویلی کی سڑکیں مکمل طور پر کارپیٹڈ ہیں — سفر ہموار اور دلکش رہتا ہے۔\n\n🅿️ ریزورٹ کے قریب ایک چھوٹا سا واٹر کراسنگ ہے؛ سیڈان/لو کلیرنس گاڑیاں ہماری پرائیویٹ پارکنگ میں کھڑی کی جا سکتی ہیں (صرف 1 منٹ واک)۔\n\n💼 ہمارا عملہ سامان میں مدد کرتا ہے، اور بزرگ مہمانوں کے لیے آخری حصے پر *مفت جیپ ٹرانسفر* بھی موجود ہے۔\n\nراستے یا پلاننگ میں مدد درکار ہو تو بتائیں—ہم آپ کی آمد کو آسان اور یادگار بناتے ہیں!`;
  }
  if (lang === 'roman-ur') {
    return `*Roameo Resorts location link:*\n\n👉 ${MAPS_LINK}\n\n*Good to know:*\n🚙 Neelum Valley ki roads fully carpeted hain—ride smooth aur scenic rehti hai.\n\n🅿️ Resort ke qareeb chhota sa water crossing hota hai; agar sedan/low-clearance car hai to private parking (sirf 1-minute walk) use kar sakte hain.\n\n💼 Team luggage mein madad karti hai, aur buzurg mehmanon ke liye last stretch par *free jeep transfer* available hai.\n\nDirections ya planning mein help chahiye ho to batayein—arrival smooth aur memorable banate hain!`;
  }
  return `*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\n*Good to know:*\n🚙 Roads are fully carpeted for a smooth, scenic drive.\n\n🅿️ There’s a small water crossing near the resort. Sedans/low-clearance cars can use our private parking (1-minute walk).\n\n💼 Our team helps with luggage, and we offer a *free jeep transfer* for elderly guests on the final stretch.\n\nNeed directions or trip planning help? We’ll make your arrival smooth and memorable!`;
}

/* =========================
   STRICT GPT (JSON) + RENDERER
   ========================= */
async function gptStructuredReply({ intent, lang, userText, facts, extras }) {
  if (!OPENAI_API_KEY) return null;

  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };

  const schema = {
    name: "roameo_reply",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        lang: { type: "string", enum: ["en","roman-ur","ur"] },
        kind: { type: "string", enum: ["prices","route","location","facilities","booking","availability","contact","general"] },
        header: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: ["string","null"] },
              lines: { type: "array", items: { type: "string" } }
            },
            required: ["title","lines"]
          }
        },
        footer: { type: "array", items: { type: "string" } },
        cta: {
          type: "object",
          additionalProperties: false,
          properties: { whatsapp: { type: "string" }, website: { type: "string" } },
          required: []
        }
      },
      required: ["lang","kind","header","sections","footer"]
    },
    strict: true
  };

  const sys = [
    `You are Roameo Resorts' assistant. Never invent facts.`,
    `Respect privacy: numeric prices are allowed only in DMs (here it's DM unless caller flags comment).`,
    `Use "lang" language; keep lines short, emoji-light. Return ONLY JSON per schema.`,
    `When kind="prices": format exactly as:`,
    `Header line → blank line → "Limited-Time Discounted Rate List:" line →`,
    `Deluxe line → discount line → blank line → Executive line → discount line →`,
    `blank line → "Terms & Conditions:" and bullet-style lines.`,
    `No extra chatter beyond footer.`
  ].join(' ');

  const payload = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: JSON.stringify({ intent, lang, userText, facts, extras })
      }
    ],
    response_format: { type: "json_schema", json_schema: schema },
    temperature: 0.3
  };

  try {
    const { data } = await axios.post("https://api.openai.com/v1/responses", payload, { headers, timeout: 15000 });
    const raw = data?.output_text || data?.choices?.[0]?.message?.content || "";
    return JSON.parse(raw);
  } catch (e) {
    console.error('🧠 OpenAI structured error:', e?.response?.data || e.message);
    return null;
  }
}

function renderCard(j, platform = 'dm') {
  const pad = platform === 'comment' ? '' : '  ';
  const sTitle = (t) => (t ? `\n${pad}${t.trim()}\n` : '\n');

  const header = j.header.trim();
  const sections = j.sections.map(s => {
    const title = sTitle(s.title);
    const lines = (s.lines || []).map(l => `${pad}${l}`).join('\n');
    return title + lines;
  }).join('\n');

  const footer = (j.footer || []).length ? '\n\n' + j.footer.map(l => `${pad}${l}`).join('\n') : '';
  return [header, sections, footer].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* =========================================================
   DM price message — HARD-CODED LAYOUT (EN / Roman-Urdu / Urdu)
   ========================================================= */
function discounted(n) { return Math.round(n * (1 - DISCOUNT.percent / 100)); }
function fm(n){ return Number(n).toLocaleString('en-PK'); }

async function dmPriceMessage(userText = '') {
  const lang = detectLanguage(userText);

  const dBase = FACTS.rates.deluxe.base;
  const eBase = FACTS.rates.executive.base;
  const dDisc = discounted(dBase);
  const eDisc = discounted(eBase);

  let msg;

  if (lang === 'ur') {
    // Urdu (locked spacing)
    msg = [
`ہم Roameo Resorts میں اس وقت ${DISCOUNT.percent}% محدود مدت کی رعایت پیش کر رہے ہیں — صرف ${DISCOUNT.validUntilText} تک!`,

`📍 رعایتی ریٹ فہرست:`,

`ڈیلکس ہٹ – PKR ${fm(dBase)} فی رات`,
`✨ فلیٹ ${DISCOUNT.percent}% آف → PKR ${fm(dDisc)} فی رات`,

`ایگزیکٹو ہٹ – PKR ${fm(eBase)} فی رات`,
`✨ فلیٹ ${DISCOUNT.percent}% آف → PKR ${fm(eDisc)} فی رات`,

`شرائط و ضوابط:`,
`• قیمتیں تمام ٹیکسز سمیت ہیں`,
`• فی بُکنگ 2 مہمانوں کے لیے ناشتہ مفت`,
`• اضافی ناشتہ: فی فرد PKR 500`,
`• ریزرویشن کنفرم کرنے کے لیے 50% ایڈوانس لازمی`,
`• آفر ${DISCOUNT.validUntilText} تک مؤثر`,

`اگر آپ بکنگ کرنا چاہیں یا کوئی مدد چاہیے ہو تو بتا دیجیے! 🌿✨`
    ].join('\n\n')
    .replace(/\n\nشرائط/,'\n\nشرائط و ضوابط:')
    .replace(/(فی رات)\n\nایگزیکٹو/,'$1\n\nایگزیکٹو');
  }

  else if (lang === 'roman-ur') {
    // Roman-Urdu (locked spacing; list kept in EN for clarity)
    msg = [
`Roameo Resorts par abhi ${DISCOUNT.percent}% limited-time discount chal raha hai — sirf ${DISCOUNT.validUntilText} tak!`,

`📍 Limited-Time Discounted Rate List:`,

`Deluxe Hut – PKR ${fm(dBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(dDisc)}/night`,

`Executive Hut – PKR ${fm(eBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(eDisc)}/night`,

`Terms & Conditions:`,
`• Rates are inclusive of all taxes`,
`• Complimentary breakfast for 2 guests per booking`,
`• Additional breakfast charges: PKR 500 per person`,
`• 50% advance payment required to confirm the reservation`,
`• Offer valid till ${DISCOUNT.validUntilText}`,

`Let us know if you’d like to book your stay or need any assistance! 🌿✨`
    ].join('\n\n')
    .replace(/(\/night)\n\nExecutive/,'$1\n\nExecutive');
  }

  else {
    // English (locked spacing)
    msg = [
`We’re currently offering an exclusive ${DISCOUNT.percent}% limited-time discount for our guests at Roameo Resorts — valid only till ${DISCOUNT.validUntilText}!`,

`📍 Limited-Time Discounted Rate List:`,

`Deluxe Hut – PKR ${fm(dBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(dDisc)}/night`,

`Executive Hut – PKR ${fm(eBase)}/night`,
`✨ Flat ${DISCOUNT.percent}% Off → PKR ${fm(eDisc)}/night`,

`Terms & Conditions:`,
`• Rates are inclusive of all taxes`,
`• Complimentary breakfast for 2 guests per booking`,
`• Additional breakfast charges: PKR 500 per person`,
`• 50% advance payment required to confirm the reservation`,
`• Offer valid till ${DISCOUNT.validUntilText}`,

`Let us know if you’d like to book your stay or need any assistance! 🌿✨`
    ].join('\n\n')
    .replace(/(\/night)\n\nExecutive/,'$1\n\nExecutive');
  }

  // Append CTAs with a blank line (kept outside the locked block)
  msg = `${msg}\n\nAvailability / book: ${SITE_URL}\nChat on WhatsApp: ${WHATSAPP_LINK}`;

  // Final sanitization (keeps our layout intact)
  return sanitizeVoice(msg);
}

/* =========================
   ROUTE MESSAGE (DM) — Geoapify + structured wording
   ========================= */
function extractOrigin(text='') {
  const t = text.trim();
  // "route from Lahore", "rasta from Karachi", "Lahore se rasta", "Islamabad say route"
  const rx = [
    /route\s+from\s+(.+)$/i,
    /rasta\s+from\s+(.+)$/i,
    /from\s+(.+)\s+(?:to|till|for)?\s*(?:roameo|resort|neelum|tehjian)?$/i,
    /(.+)\s+(?:se|say)\s+(?:rasta|route)/i
  ];
  for (const r of rx) {
    const m = t.match(r);
    if (m && m[1]) return m[1].replace(/[.?!]+$/,'').trim();
  }
  return null;
}

async function dmRouteMessage(userText = '') {
  const lang = detectLanguage(userText);
  let origin = extractOrigin(userText);

  if (!origin) {
    // try state
    origin = userText.trim();
    if (!origin || /^(route|rasta)\b/i.test(origin)) origin = null;
  }

  if (!origin) {
    const ask = lang === 'ur'
      ? 'براہِ کرم روانگی کا شہر بتائیں۔ مثال: "route from Lahore"'
      : lang === 'roman-ur'
        ? 'Apni rawangi ka shehar batayein. Example: "route from Lahore"'
        : 'Please tell us your departure city. Example: "route from Lahore".';
    return ask;
  }

  const destParts = (RESORT_COORDS || '').split(',').map(s => s.trim());
  if (destParts.length !== 2) {
    return 'Location temporarily unavailable. Please try later.';
  }
  const [dLat, dLon] = destParts.map(parseFloat);

  const originGeo = await geocodePlace(origin);
  let routeInfo = null;
  if (originGeo) {
    const r = await routeDrive(originGeo.lat, originGeo.lon, dLat, dLon);
    if (r) routeInfo = { origin, distance_km: Number(km(r.meters)), drive_time: hhmm(r.seconds) };
  }
  const facts = { map: MAPS_LINK, location_name: RESORT_LOCATION_NAME };
  const extras = { route: routeInfo };

  const j = await gptStructuredReply({
    intent: "route", lang, userText, facts, extras
  });

  if (!j) {
    const simple = routeInfo
      ? (lang === 'ur'
          ? `*${origin}* سے Roameo Resorts تک تقریباً ${routeInfo.distance_km} کلومیٹر — سفر وقت ${routeInfo.drive_time}۔ لوکیشن: ${MAPS_LINK}`
          : lang === 'roman-ur'
            ? `From *${origin}* to Roameo Resorts ~${routeInfo.distance_km} km, drive ~${routeInfo.drive_time}. Location: ${MAPS_LINK}`
            : `From *${origin}* to Roameo Resorts is ~${routeInfo.distance_km} km (~${routeInfo.drive_time}). Location: ${MAPS_LINK}`)
      : (lang === 'ur'
          ? `لوکیشن لنک: ${MAPS_LINK}`
          : (lang === 'roman-ur' ? `Location: ${MAPS_LINK}` : `Location: ${MAPS_LINK}`));
    return sanitizeVoice(`${simple}\n\nChat on WhatsApp: ${WHATSAPP_LINK}`);
  }

  const body = renderCard(j, 'dm');
  return sanitizeVoice(`${body}\n\nChat on WhatsApp: ${WHATSAPP_LINK}`);
}

/* =========================
   Decision helpers
   ========================= */
function shouldAttachCTA(intent, surface) {
  if (surface === 'comment' && intent === 'rates') return false;
  return true;
}
function attachCTA(body, intent, platform, surface) {
  if (!shouldAttachCTA(intent, surface)) return body;
  const compact = (body || '').trim();
  const already = /WhatsApp:|roameoresorts\.com|wa\.me|instagram\.com\/roameoresorts/i.test(compact);
  if (already) return compact;
  const cta = platform === 'instagram'
    ? `WhatsApp: ${WHATSAPP_NUMBER} • Website: ${SITE_SHORT}`
    : `WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`;
  return `${compact}\n${cta}`.trim();
}

/* =========================
   Price helpers (parsing)
   ========================= */
function formatMoney(n) { return Number(n).toLocaleString('en-PK'); }
function parseNightsAndType(text = '') {
  const t = (text || '').toLowerCase();
  let nights = null;
  const num = t.match(/(\d+)\s*(?:night|nights|din|day|days|رات(?:یں)?|raat(?:ein)?)/i);
  if (num) nights = parseInt(num[1], 10);
  if (!nights) {
    if (/weekend/i.test(t)) nights = 2;
    else if (/\bweek\b|ہفتہ|hafta/i.test(t)) nights = 7;
    else if (/\b3\s*day(?:s)?\b|3\s*din/i.test(t)) nights = 3;
  }
  if (nights && nights > 30) nights = 30;

  let type = null;
  if (/\bdeluxe|dlx/i.test(t)) type = 'deluxe';
  if (/\bexecutive|exec/i.test(t)) type = 'executive';
  if (/ایگزیکٹو/.test(t)) type = 'executive';
  if (/ڈیلکس/.test(t)) type = 'deluxe';

  return { nights, type };
}

/* =========================
   GPT general (now uses strict renderer too)
   ========================= */
async function generateReply({ intent, userText, lang, asComment, playful, enrich }) {
  const facts = {
    location_name: RESORT_LOCATION_NAME,
    map: MAPS_LINK,
    checkin: FACTS.checkin, checkout: FACTS.checkout,
    facilities: FACTS.facilities, tnc: FACTS.tnc
  };
  const extras = { weather: enrich?.wx || null };

  // Never let comments produce price numbers
  const safeIntent = (asComment && intent === 'rates') ? 'general' : intent;

  const j = await gptStructuredReply({
    intent: safeIntent, lang, userText, facts, extras
  });

  if (!j) {
    // tiny fallback
    if (lang === 'ur') return 'ہم حاضر ہیں—براہِ کرم دوبارہ لکھیے۔';
    if (lang === 'roman-ur') return 'Hum yahan hain—please dubara likhein.';
    return 'We’re here to help—please ask again.';
  }

  let out = renderCard(j, asComment ? 'comment' : 'dm');
  if (asComment) out = stripPricesFromPublic(out);
  return sanitizeVoice(out);
}

/* =========================
   Decision flow
   ========================= */
function intentFromText(text = '') {
  const t = (text || '').toLowerCase();
  const wantsLocation   = /\b(location|where|address|map|pin|directions?|google\s*maps|reach)\b/i.test(t);
  const wantsRates      = isPricingIntent(text);
  const wantsFacilities = /\b(facilit(y|ies)|amenit(y|ies)|wifi|internet|kitchen|food|meal|heater|bonfire|family|kids|children|parking|jeep|inverter)\b/i.test(t);
  const wantsBooking    = /\b(book|booking|reserve|reservation|check[-\s]?in|checkin|check[-\s]?out|checkout|advance|payment)\b/i.test(t);
  const wantsAvail      = /\b(availability|available|dates?|calendar)\b/i.test(t);
  const wantsDistance   = /\b(distance|far|how\s*far|hours|drive|time\s*from|eta)\b/i.test(t);
  const wantsWeather    = /\b(weather|temperature|cold|hot|forecast|rain|mausam|kaysa|kaisa)\b/i.test(t);
  const wantsRoute      = isRouteIntent(text);

  const wantsVideo      = /(video|live\s*video|current\s*video|exterior|outside|hotel\s*exterior|bahar|video\s*dekh)/i.test(t);
  const wantsContact    = /(contact|manager|owner|number|phone|whats\s*app|whatsapp|call\s*(you|me)?|speak\s*to|baat|raabta|raabta\s*number)/i.test(t);

  return {
    wantsLocation, wantsRates, wantsFacilities, wantsBooking, wantsAvail,
    wantsDistance, wantsWeather, wantsRoute, wantsVideo, wantsContact
  };
}

/* =========================
   Shared DM handler (stateful for route origin)
   ========================= */
function isAffirmative(text = '') {
  const t = (text || '').trim().toLowerCase();
  const en = /\b(yes|yeah|yep|sure|ok(ay)?|please|go ahead|sounds good|alright|affirmative|y)\b/;
  const ru = /\b(haan|han|ji|jee|bilkul|theek(?:\s*hai)?|acha|accha|zaroor|krdo|kardo|kar do|kr den|krden)\b/;
  const ur = /(?:\u062C\u06CC|\u062C\u06CC\u06C1|\u06C1\u0627\u06BA|\u0628\u0644\u06A9\u0644|\u062A\u06BE\u06CC\u06A9\s?\u06C1\u06D2?)/;
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

  // If user asks for contact/manager in DM → send number/link
  if (intents.wantsContact) {
    const msg = lang === 'ur'
      ? `ہمارے ساتھ رابطہ کرنے کے لیے WhatsApp کیجیے: ${WHATSAPP_LINK}\nیا کال/WhatsApp: ${WHATSAPP_NUMBER}`
      : lang === 'roman-ur'
        ? `Contact ke liye WhatsApp karein: ${WHATSAPP_LINK}\nCall/WhatsApp: ${WHATSAPP_NUMBER}`
        : `Message us on WhatsApp: ${WHATSAPP_LINK}\nCall/WhatsApp: ${WHATSAPP_NUMBER}`;
    return sendBatched(psid, msg);
  }

  if (state === 'awaiting_details') {
    convo.delete(psid);
    const msg = lang === 'ur'
      ? `شکریہ! بکنگ کی تصدیق کے لیے ویب سائٹ استعمال کریں: ${SITE_URL}`
      : lang === 'roman-ur'
        ? `Shukriya! Booking ki tasdeeq ke liye website use karein: ${SITE_URL}`
        : `Thanks! To confirm your booking, please use: ${SITE_URL}`;
    await sendBatched(psid, msg);
  }

  if (!AUTO_REPLY_ENABLED) return;

  // Quick DM branches
  if (intents.wantsLocation) {
    const blocks = sanitizeVoice(locationMessageByLang(lang)) + `\n\nChat on WhatsApp: ${WHATSAPP_LINK}`;
    return sendBatched(psid, blocks);
  }
  if (intents.wantsRates) {
    return sendBatched(psid, await dmPriceMessage(text));
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
  if (intents.wantsVideo) {
    const msg = lang === 'ur'
      ? `اس وقت لائیو ویڈیوز دستیاب نہیں، لیکن ہمارے تازہ *انٹیریئر/ایکسٹیریئر* کی جھلکیاں Instagram پر موجود ہیں:\n${INSTAGRAM_PROFILE}\n\nمزید سوالات؟ ہم حاضر ہیں! 😊\nChat on WhatsApp: ${WHATSAPP_LINK}`
      : lang === 'roman-ur'
        ? `Live video is not available abhi, lekin hamare *interior/exterior* ki recent reels & photos Instagram par hain:\n${INSTAGRAM_PROFILE}\n\nKoi sawaal? Hum yahan hain! 😊\nChat on WhatsApp: ${WHATSAPP_LINK}`
        : `We don’t have a live video at the moment, but you can see our latest *interior/exterior* reels & photos on Instagram:\n${INSTAGRAM_PROFILE}\n\nAny questions? We’re here to help! 😊\nChat on WhatsApp: ${WHATSAPP_LINK}`;
    return sendBatched(psid, sanitizeVoice(msg));
  }

  // Compose unique DM via structured GPT
  let wx = null;
  if ((intents.wantsWeather || intents.wantsLocation || intents.wantsBooking || intents.wantsRates) && FACTS.resort_coords.includes(',')) {
    const [lat, lon] = FACTS.resort_coords.split(',').map(s => s.trim());
    wx = await currentWeather(parseFloat(lat), parseFloat(lon));
  }

  const reply = await generateReply({
    intent: intents.wantsRates ? 'rates' : (intents.wantsRoute ? 'route' : 'general'),
    userText: text, lang, asComment: false, playful: isPlayful(text),
    enrich: { wx, needOriginConfirm: false }
  });

  await sendBatched(psid, `${reply}\n\nChat on WhatsApp: ${WHATSAPP_LINK}`);
}

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

function logErr(err) {
  const payload = err?.response?.data || err.message || err;
  if (payload?.error) {
    console.error('FB API error', payload);
  } else {
    console.error('💥 Handler error:', payload);
  }
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
      if (isPricingIntent(text)) {
        try { await fbPrivateReplyToComment(v.comment_id, await dmPriceMessage(text)); } catch (e) { logErr(e); }
        await replyToFacebookComment(v.comment_id, priceNudgePublic(detectLanguage(text)));
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
      if (isPricingIntent(text)) {
        try { await igPrivateReplyToComment(pageId, commentId, await dmPriceMessage(text)); } catch (e) { logErr(e); }
        await replyToInstagramComment(commentId, priceNudgePublic(detectLanguage(text)));
        return;
      }
      const reply = await decideReply(text, { surface: 'comment', platform: 'instagram' });
      await replyToInstagramComment(commentId, reply);
    }
  }
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
  const url = `https://graph.facebook.com/v19.0/me/take_thread_control`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  try { await axios.post(url, { recipient: { id: psid } }, { params, timeout: 10000 }); }
  catch (e) { console.error('take_thread_control error:', e?.response?.data || e.message); }
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
