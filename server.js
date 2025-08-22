// server.js — Roameo Resorts omni-channel bot (AI-first, intent-aware)
// FB DMs + FB comments + IG DMs + IG comments
// Unique GPT replies (EN/Urdu/Roman-Ur) + humor + Weather (OpenWeather) + ETA (Geoapify)
// PUBLIC PRICES: FORBIDDEN. Pricing → DM with numbers (+ fresh hook).
// WhatsApp rules: IG comments = number only; FB comments = link OK; DMs = link OK.
// CTAs are intent-aware (not always). Never say “Shall we pencil you in?”.

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
const RESORT_LOCATION_NAME = process.env.RESORT_LOCATION_NAME || 'Tehjian Valley';

// ==== Brand constants (not env-scoped; safe for multi-page) ====
const BRAND_USERNAME = 'roameoresorts';                // used to avoid self-replies
const WHATSAPP_NUMBER = '03558000078';                 // show in IG comments
const WHATSAPP_LINK   = 'https://wa.me/923558000078';  // OK in FB comments & DMs
const SITE_URL   = 'https://www.roameoresorts.com/';
const SITE_SHORT = 'roameoresorts.com';
const MAPS_LINK  = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT replies disabled; fallbacks will be used.');
}

/* =========================
   BUSINESS FACTS
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
    'Complimentary breakfast for 4 guests per booking',
    '50% advance payment required to confirm the reservation'
  ],
  rates: {
    deluxe:    { base: 30000, n1: 27000, n2: 25500, n3: 24000 },
    executive: { base: 50000, n1: 45000, n2: 42500, n3: 40000 }
  },
  facilities: [
    `Private riverfront huts facing the Neelam River`,
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
   UTILITIES
   ========================= */
function isSelfComment(v = {}, platform = 'facebook') {
  const from = v.from || {};
  if (platform === 'instagram') {
    if (from.username && from.username.toLowerCase() === BRAND_USERNAME.toLowerCase()) return true;
  } else {
    if (from.name && from.name.toLowerCase().includes('roameo')) return true;
  }
  return false;
}

function charLen(s) { return Array.from((s || '')).length; }

// IG truncates quickly; clamp so body (and CTA if any) always fits
function clampForPlatform(text = '', platform = 'instagram') {
  const MAX = platform === 'instagram' ? 220 : 320; // conservative to avoid “see more…”
  let s = (text || '').replace(/\s{2,}/g, ' ').trim();
  if (charLen(s) > MAX) s = Array.from(s).slice(0, MAX - 1).join('') + '…';
  return s;
}

// CTA policy — DO NOT add CTA for price comments (per your rule)
function shouldAttachCTA(intent, surface) {
  if (surface === 'comment' && intent === 'rates') return false; // << no CTA for price comments
  return ['booking','availability','location','facilities','distance','weather','rates'].includes(intent);
}

function attachCTA(body, intent, platform, surface) {
  if (!shouldAttachCTA(intent, surface)) return clampForPlatform(body, platform);

  const compact = (body || '').replace(/\s*\n+\s*/g, ' ').trim();
  const already = /WhatsApp:|roameoresorts\.com/i.test(compact);
  if (already) return clampForPlatform(compact, platform);

  const cta = platform === 'instagram'
    ? `WhatsApp: ${WHATSAPP_NUMBER} • Website: ${SITE_SHORT}`
    : `WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`;

  // Keep body short so CTA doesn't get cut off
  const MAX = platform === 'instagram' ? 220 : 320;
  const sep = compact ? '\n' : '';
  const roomForBody = MAX - charLen(cta) - charLen(sep) - 2; // extra buffer
  const trimmedBody = charLen(compact) > roomForBody
    ? Array.from(compact).slice(0, Math.max(0, roomForBody - 1)).join('') + '…'
    : compact;

  const finalMsg = `${trimmedBody}${sep}${cta}`.trim();
  return clampForPlatform(finalMsg, platform); // final safety clamp
}

function sanitizeVoice(text = '') {
  return (text || '')
    .replace(/Shall we pencil you in\??/gi, '')
    .replace(/\bI\'m\b/gi, 'we’re')
    .replace(/\bI am\b/gi, 'we are')
    .replace(/\bI\'ll\b/gi, 'we’ll')
    .replace(/\bI\b/gi, 'we')
    .replace(/\bme\b/gi, 'us')
    .replace(/\bmy\b/gi, 'our')
    .replace(/\bmine\b/gi, 'ours')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripPricesFromPublic(text = '') {
  const lines = (text || '').split(/\r?\n/).filter(Boolean).filter(l => {
    const s = l.toLowerCase();
    const hasCurrency = /(?:pkr|rs\.?|rupees|price|prices|rate|rates|tariff|per\s*night)/i.test(s);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(s);
    return !(hasCurrency || hasMoneyish);
  });
  return lines.join(' ');
}

// Language detection (Urdu script vs Roman-Urdu vs English)
function detectLanguage(text = '') {
  const t = (text || '').trim();
  const hasUrduScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (hasUrduScript) return 'ur';

  const romanUrduHits = [
    /\b(aap|ap|apka|apki|apke|tum|tm|bhai|plz|pls)\b/i,
    /\b(kia|kya|kyun|kyon|kaise|kese|krna|karna|krdo|kardo|raha|rha|rhe|rahe|gi|ga|hain|hy|hai)\b/i,
    /\b(mein|mai|mujhe|yahan|wahan|acha|accha|bohat|bahut)\b/i,
    /\b(kitna|kitni|din|rat|room|booking|rate|price|mausam|weather)\b/i
  ].reduce((a, rx) => a + (rx.test(t) ? 1 : 0), 0);

  const englishHits = [/\b(the|and|is|are|you|we|from|how|where|price|rate|book|available|distance|weather)\b/i]
    .reduce((a, rx) => a + (rx.test(t) ? 1 : 0), 0);

  if (romanUrduHits >= 1 && englishHits <= 3) return 'roman-ur';
  return 'en';
}

// Pricing intent (English + Roman-Urdu)
function isPricingIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(price|prices|rate|rates|cost|costs|charge|charges|tariff|per\s*night)\b/i.test(t)
      || /\b(qeemat|keemat|kimat|kimatain|qeematein|rate\s*kya|price\s*kya|rates\s*kya)\b/i.test(t)
      || /\b(kitna|kitni)\s*(per\s*night|room|hut|d\b)/i.test(t);
}

// Distance helpers
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
    const res = { meters: ft.distance, seconds: ft.time };
    tinyCache.set(key, res);
    return res;
  } catch (e) { console.error('geoapify routing error', e?.response?.data || e.message); return null; }
}

async function currentWeather(lat, lon) {
  if (!OPENWEATHER_API_KEY || !lat || !lon) return null;
  const key = `wx:${lat},${lon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.openweathermap.org/data/2.5/weather';
    const { data } = await axios.get(url, { params: { lat, lon, units: 'metric', appid: OPENWEATHER_API_KEY }, timeout: 10000 });
    const res = {
      temp: Math.round(data?.main?.temp ?? 0),
      feels: Math.round(data?.main?.feels_like ?? 0),
      desc: (data?.weather?.[0]?.description || '').replace(/\b\w/g, c => c.toUpperCase())
    };
    tinyCache.set(key, res);
    return res;
  } catch (e) { console.error('openweather error', e?.response?.data || e.message); return null; }
}

/* =========================
   PRICE NUDGE (comments only, NO CTA)
   ========================= */
const HOOKS = {
  en: [
    'discounted prices inside!',
    'special launch discounts await!',
    'exclusive DM-only deals!',
    'limited-time savings available!',
    'bundle discounts for 2+ nights!'
  ],
  'roman-ur': [
    'discounted prices andar!',
    'launch discounts ready!',
    'DM-only deals tayyar!',
    'limited-time bachat!',
    '2+ nights par extra off!'
  ],
  ur: [
    'ڈسکاؤنٹڈ قیمتیں دستیاب!',
    'لانچ ڈسکاؤنٹس آپ کے لیے!',
    'DM پر خصوصی آفرز!',
    'محدود وقت کی بچت!',
    'دو راتوں سے زائد پر مزید رعایت!'
  ]
};

function priceNudgePublic(lang = 'en') {
  const arr = HOOKS[lang] || HOOKS.en;
  const hook = arr[Math.floor(Math.random() * arr.length)];
  if (lang === 'ur') return `براہِ کرم ریٹس کے لیے DM کریں — ${hook}`;
  if (lang === 'roman-ur') return `Rates ke liye DM karein — ${hook}`;
  return `Please DM us for rates — ${hook}`;
}

/* =========================
   OPENAI — UNIQUE REPLIES
   ========================= */
function systemRules(asComment, lang) {
  const surface = asComment ? 'COMMENT (public)' : 'DM (private)';
  const langGuide = lang === 'ur'
    ? 'Write in fluent Urdu script. No romanization.'
    : lang === 'roman-ur'
      ? 'Write in natural Roman Urdu (ASCII letters only).'
      : 'Write in natural English.';
  return `
You are Roameo Resorts' assistant in Tehjian Valley (by the Neelam River).
- Match the user's language. ${langGuide}
- Answer-first (even if general science), then bridge naturally to Roameo Resorts if appropriate.
- Humor-aware: if the user is playful, use light wit; otherwise be clear and warm.
- Voice: never use first-person singular. Use “we/us/our team”.
- Public price policy: NEVER post numeric prices/discounts in comments.
- Availability: never claim availability; direct users to the website.
- Keep ${surface} replies concise (<=1 short paragraph).
- Do NOT include links or phone numbers; system adds CTA when appropriate.
- BAN the phrase “Shall we pencil you in?”.
`.trim();
}

async function generateReply({ intent, userText, lang, asComment, enrich }) {
  const rulesByIntent = {
    rates: `
- Public: say prices are shared privately (DM), no numbers. Keep it short with a subtle hook. (System will override with a fixed nudge if needed.)
- DM: you may share numbers.
`.trim(),
    weather: `
- Give a short, informative answer; add a playful twist if user is playful.
- If weather data provided, weave it in naturally.
`.trim(),
    location: `
- Provide clear directions info; mention Google Maps pin generally.
`.trim(),
    distance: `
- DO NOT quote drive time unless origin is confirmed. Ask to confirm the city if unclear.
`.trim(),
    general: `
- Directly answer the question first (even if it's not about travel).
- Then, only if relevant, connect to Roameo Resorts naturally.
`.trim()
  };

  const wx = enrich?.wx ? (lang === 'ur'
    ? `درجۂ حرارت ${enrich.wx.temp}°C (محسوس ${enrich.wx.feels}°C) — ${enrich.wx.desc}`
    : lang === 'roman-ur'
      ? `~${enrich.wx.temp}°C (feels ${enrich.wx.feels}°C) — ${enrich.wx.desc}`
      : `~${enrich.wx.temp}°C (feels ${enrich.wx.feels}°C) — ${enrich.wx.desc}`) : '';

  const originNote = enrich?.needOriginConfirm ? (
    lang === 'ur' ? 'کیا آپ اپنی روانگی کا شہر بتا سکتے ہیں؟ پھر ہم روٹ/ڈرائیو ٹائم بتا دیں گے۔'
    : lang === 'roman-ur' ? 'Ap apni rawangi ka shehar confirm kar dein? Phir hum route/drive time de dein ge.'
    : 'Could you confirm your departure city? Then we’ll share route/drive time.') : '';

  const system = systemRules(asComment, lang);
  const intentRules = rulesByIntent[intent] || rulesByIntent.general;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content:
`User text: "${userText}"

Intent: ${intent}
Extra context:
- Weather: ${wx || 'N/A'}
- Origin confirmation needed: ${enrich?.needOriginConfirm ? 'Yes' : 'No'}

Write a unique reply within ~180 chars if public, ~420 if DM.
Make it feel human and local to Roameo Resorts in Tehjian Valley, by the Neelam River.
${originNote ? `If origin not confirmed, politely ask: "${originNote}".` : ''}
Rules for this intent:
${intentRules}`}
  ];

  const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.95,
    top_p: 0.95,
    presence_penalty: 0.4,
    frequency_penalty: 0.2,
    max_tokens: asComment ? 160 : 320,
    messages
  };

  try {
    const { data } = await axios.post('https://api.openai.com/v1/chat/completions', payload, { headers, timeout: 12000 });
    let out = data?.choices?.[0]?.message?.content?.trim() || '';
    if (asComment) out = out.replace(/\s*\n+\s*/g, ' ').trim();
    if (lang === 'roman-ur') out = out.replace(/[\u0600-\u06FF\u0750-\u077F]+/g, '').replace(/\s{2,}/g, ' ').trim();
    out = sanitizeVoice(out);
    if (asComment) out = stripPricesFromPublic(out);
    return out;
  } catch (e) {
    console.error('🧠 OpenAI error:', e?.response?.data || e.message);
    if (intent === 'rates') {
      return lang === 'ur'
        ? 'ریٹس DM میں شیئر کرتے ہیں—تفصیل انباکس میں ملے گی۔'
        : lang === 'roman-ur'
          ? 'Rates DM mein share karte hain—details inbox mein milengi.'
          : 'We’ll share rates in DM—details are on the way.';
    }
    return lang === 'ur'
      ? 'ہم مدد کے لیے حاضر ہیں—براہِ کرم دوبارہ لکھیں۔'
      : lang === 'roman-ur'
        ? 'Hum madad ke liye hazir hain—please dubara likhein.'
        : 'We’re here to help—feel free to ask again.';
  }
}

/* =========================
   CORE DECISION FLOW
   ========================= */
async function decideReply(text, ctx = { surface: 'dm', platform: 'facebook' }) {
  const t = (text || '').toLowerCase();
  const lang = detectLanguage(text);
  const asComment = ctx.surface === 'comment';

  const intent = (() => {
    if (/\b(location|where|address|map|pin|directions?|google\s*maps|reach)\b/i.test(t)) return 'location';
    if (isPricingIntent(text)) return 'rates';
    if (/\b(facilit(y|ies)|amenit(y|ies)|wifi|internet|kitchen|food|meal|heater|bonfire|family|kids|parking|jeep|inverter)\b/i.test(t)) return 'facilities';
    if (/\b(book|booking|reserve|reservation|check[-\s]?in|checkin|check[-\s]?out|checkout|advance|payment)\b/i.test(t)) return 'booking';
    if (/\b(availability|available|dates?|calendar)\b/i.test(t)) return 'availability';
    if (/\b(distance|far|how\s*far|hours|drive|time\s*from|eta)\b/i.test(t)) return 'distance';
    if (/\b(weather|temperature|cold|hot|forecast|rain|mausam|kaysa|kaisa)\b/i.test(t)) return 'weather';
    return 'general';
  })();

  // If DM + rates → send full DM price message (numbers allowed)
  if (!asComment && intent === 'rates') {
    return await dmPriceMessage(text);
  }

  // Distance: require origin confirmation
  let needOriginConfirm = false;
  if (intent === 'distance') {
    const placeMatch = t.match(/\bfrom\s+([a-z][a-z\s\-']{2,})/i);
    if (!placeMatch) needOriginConfirm = true;
  }

  // Enrichment (weather for weather/location/booking/rates)
  let wx = null;
  if ((intent === 'weather' || intent === 'location' || intent === 'booking' || intent === 'rates') && FACTS.resort_coords.includes(',')) {
    const [lat, lon] = FACTS.resort_coords.split(',').map(s => s.trim());
    wx = await currentWeather(parseFloat(lat), parseFloat(lon));
  }

  // If COMMENT + rates → fixed short nudge (no CTA)
  if (asComment && intent === 'rates') {
    return priceNudgePublic(lang); // super short, strong hook, NO CTA
  }

  // Otherwise generate a unique reply
  const body = await generateReply({
    intent, userText: text, lang, asComment,
    enrich: { wx, needOriginConfirm }
  });

  if (asComment) {
    // Public reply with platform-specific CTA logic (skips for price comments)
    const withCTA = attachCTA(body, intent, ctx.platform === 'instagram' ? 'instagram' : 'facebook', 'comment');
    return withCTA;
  }

  // DM — gentle WA link if helpful (not needed for rates; handled above)
  let dm = sanitizeVoice(body);
  if (WHATSAPP_LINK && shouldAttachCTA(intent, 'dm')) dm += `\n\nChat on WhatsApp: ${WHATSAPP_LINK}`;
  return dm;
}

/* =========================
   WEBHOOKS
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
        const pageId = entry.id; // needed for private replies
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
  await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
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
        try {
          const dm = await dmPriceMessage(text);
          await fbPrivateReplyToComment(v.comment_id, dm);
        } catch (e) { logErr(e); }
        const pub = clampForPlatform(priceNudgePublic(detectLanguage(text)), 'facebook'); // NO CTA
        await replyToFacebookComment(v.comment_id, pub);
        return;
      }

      const reply = attachCTA(await decideReply(text, { surface: 'comment', platform: 'facebook' }), 'general', 'facebook', 'comment');
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
  const theField = change.field || '';
  const isComment = theField === 'comments' || theField.toLowerCase().includes('comment') || (v.item === 'comment');
  if (isComment && (v.comment_id || v.id)) {
    const commentId = v.comment_id || v.id;
    const text = (v.text || v.message || '').trim();
    if (v.verb && v.verb !== 'add') return;
    if (isSelfComment(v, 'instagram')) return;

    if (AUTO_REPLY_ENABLED) {
      if (isPricingIntent(text)) {
        try {
          const dm = await dmPriceMessage(text);
          await igPrivateReplyToComment(pageId, commentId, dm);
        } catch (e) { logErr(e); }
        const pub = clampForPlatform(priceNudgePublic(detectLanguage(text)), 'instagram'); // NO CTA
        await replyToInstagramComment(commentId, pub);
        return;
      }

      const reply = attachCTA(await decideReply(text, { surface: 'comment', platform: 'instagram' }), 'general', 'instagram', 'comment');
      await replyToInstagramComment(commentId, reply);
    }
  }
}

/* =========================
   Shared DM handler
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

  if (isAffirmative(text)) {
    convo.set(psid, 'awaiting_details');
    const msg = lang === 'ur'
      ? `زبردست! براہِ کرم اپنی *تاریخیں* اور *مہمانوں کی تعداد* بتا دیں۔ اگر چاہیں تو *کس شہر سے آرہے ہیں* بھی بتا دیں۔`
      : lang === 'roman-ur'
        ? `Great! Apni *dates* aur *guests ki tadaad* bata dein. Chahein to *kis shehar se aa rahe hain* bhi likh dein.`
        : `Awesome! Please share your *travel dates* and *number of guests*. Also tell us *which city you’ll start from*.`;
    await sendText(psid, msg);
    return;
  }

  if (state === 'awaiting_details') {
    convo.delete(psid);
    const msg = lang === 'ur'
      ? `شکریہ! بکنگ کی تصدیق کے لیے ویب سائٹ استعمال کریں: ${SITE_URL}`
      : lang === 'roman-ur'
        ? `Shukriya! Booking ki tasdeeq ke liye website use karein: ${SITE_URL}`
        : `Thanks! To confirm your booking, please use: ${SITE_URL}`;
    await sendText(psid, msg);
  }

  if (!AUTO_REPLY_ENABLED) return;
  const reply = await decideReply(text, { surface: 'dm', platform: opts.channel === 'instagram' ? 'instagram' : 'facebook' });
  await sendText(psid, reply);
}

/* =========================
   DM Price message (numbers allowed)
   ========================= */
function formatRates() {
  const r = FACTS.rates;
  return `Deluxe Hut — PKR ${r.deluxe.base.toLocaleString()}
• 1st Night 10% → PKR ${r.deluxe.n1.toLocaleString()}
• 2nd Night 15% → PKR ${r.deluxe.n2.toLocaleString()}
• 3rd Night 20% → PKR ${r.deluxe.n3.toLocaleString()}

Executive Hut — PKR ${r.executive.base.toLocaleString()}
• 1st Night 10% → PKR ${r.executive.n1.toLocaleString()}
• 2nd Night 15% → PKR ${r.executive.n2.toLocaleString()}
• 3rd Night 20% → PKR ${r.executive.n3.toLocaleString()}`;
}

async function dmPriceMessage(userText = '') {
  const lang = detectLanguage(userText);
  const hook = lang === 'ur'
    ? 'خوشخبری—ڈسکاؤنٹڈ قیمتیں آپ کے لیے!'
    : lang === 'roman-ur'
      ? 'Good news—discounted prices for you!'
      : 'Good news—discounted prices for you!';

  const body = `${hook}\n\n${formatRates()}

T&Cs: taxes included • breakfast for 4 • 50% advance to confirm.
Availability/book: ${SITE_URL}`;

  const wa = `\n\nChat on WhatsApp: ${WHATSAPP_LINK}`;
  return sanitizeVoice(body + wa);
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
        RIVER: FACTS.river_name
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
