// server.js — Roameo Resorts omni-channel bot
// v4: GPT + facts-only KB, strict language mirroring, deterministic intents,
// IG/FB CTA rules, media/contact handlers, public price guard, robust logging.
//
// Channels: FB DMs + FB comments + IG DMs + IG comments
// PUBLIC PRICES: FORBIDDEN (only DM). IG comments → WhatsApp NUMBER only.
// FB comments + ALL DMs → wa.me link.
//
// Env you MUST set on Render:
// APP_SECRET, VERIFY_TOKEN (or verify_token), PAGE_ACCESS_TOKEN
// Optional: IG_MANAGE_TOKEN (can be same as PAGE token but must have IG scopes)
// Optional: OPENAI_API_KEY, GEOAPIFY_API_KEY, OPENWEATHER_API_KEY
//
// Required FB/IG permissions on PAGE token (scopes) if you want IG private replies:
// instagram_manage_messages, instagram_manage_comments, instagram_basic,
// pages_manage_engagement, pages_read_engagement, pages_manage_metadata
// (and pages_messaging if you DM on Facebook)

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV & CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Toggles
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY = String(process.env.ALLOW_REPLY_IN_STANDBY || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';
const IG_PRIVATE_REPLY_ENABLED = String(process.env.IG_PRIVATE_REPLY_ENABLED || 'false').toLowerCase() === 'true';

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
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT replies fallback to short non-AI responses.');
}

/* =========================
   ROAMEO KNOWLEDGE BASE (facts only)
   ========================= */
const KB = {
  brand: 'Roameo Resorts',
  location: 'Roameo Resorts, Tehjian (Tehjian) Valley by the Neelam River',
  maps_link: MAPS_LINK,
  insta: INSTA_LINK,
  site: SITE_URL,
  whatsapp_link: WHATSAPP_LINK,
  whatsapp_num: WHATSAPP_NUMBER,
  checkin: CHECKIN_TIME,
  checkout: CHECKOUT_TIME,
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
  tnc: [
    'Rates are inclusive of all taxes',
    'Complimentary breakfast for 4 guests per booking',
    '50% advance payment required to confirm the reservation'
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
app.get('/', (_req, res) => res.send('Roameo Omni Bot running (v4 GPT+KB)'));

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
   HELPERS — sanitize, chunking, language
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
const rxAny = (r) => (s='') => r.test((s||'').toLowerCase());
const isPricingIntent    = rxAny(/\b(price|prices|rate|rates|cost|charge|tariff|per\s*night|rent|rental)\b|(?:\b(kiraya|qeemat|keemat|kimat)\b)/i);
const isMediaIntent      = rxAny(/\b(video|reel|footage|clip|live|exterior|interior|outside|hotel\s*exterior|pictures?|photos?)\b/i);
const isContactIntent    = rxAny(/\b(manager|owner|contact|number|phone|call|whatsapp|wa\s?number)\b/i);
const isLocationIntent   = rxAny(/\b(location|where|address|map|pin|directions?|google\s*maps|reach)\b/i);
const isFacilitiesIntent = rxAny(/\b(facilit(y|ies)|amenit(y|ies)|wifi|internet|kitchen|food|meal|heater|bonfire|family|kids|children|parking|jeep|inverter)\b/i);
const isBookingIntent    = rxAny(/\b(book|booking|reserve|reservation|check[-\s]?in|checkin|check[-\s]?out|checkout|advance|payment)\b/i);
const isAvailIntent      = rxAny(/\b(availability|available|dates?|calendar)\b/i);
const isDistanceIntent   = rxAny(/\b(distance|far|how\s*far|hours|drive|time\s*from|eta)\b/i);
const isWeatherIntent    = rxAny(/\b(weather|temperature|cold|hot|forecast|rain|mausam)\b/i);

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
    const feat = data?.features?.[0]; if (!feat) return null;
    const [lon, lat] = feat.geometry.coordinates || [];
    const res = { lat, lon }; tinyCache.set(key, res); return res;
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
    const ft = data?.features?.[0]?.properties; if (!ft) return null;
    return { meters: ft.distance, seconds: ft.time };
  } catch (e) { logAxiosError(e); return null; }
}
async function currentWeather(lat, lon) {
  if (!OPENWEATHER_API_KEY || !lat || !lon) return null;
  const key = `wx:${lat},${lon}`; if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.openweathermap.org/data/2.5/weather';
    const { data } = await axios.get(url, { params: { lat, lon, units: 'metric', appid: OPENWEATHER_API_KEY }, timeout: 10000 });
    const out = { temp: Math.round(data?.main?.temp ?? 0), feels: Math.round(data?.main?.feels_like ?? 0), desc: (data?.weather?.[0]?.description || '').replace(/\b\w/g, c => c.toUpperCase()) };
    tinyCache.set(key, out); return out;
  } catch (e) { logAxiosError(e); return null; }
}

/* =========================
   TEMPLATES (deterministic for key intents)
   ========================= */
function L(lang, en, roman, ur) { if (lang === 'ur') return ur; if (lang === 'roman-ur') return roman; return en; }

function msgLocation(lang) {
  const tips = [
    'Roads to the resort are fully carpeted for a smooth, scenic drive.',
    'A small water crossing is near the resort; sedans can park at private parking (1-minute walk).',
    'Team helps with luggage; free jeep transfer for elderly guests.'
  ].map(t => `• ${t}`).join('\n');
  return sanitizeVoice(L(lang,
`*Roameo Resorts location link:*\n👉 ${KB.maps_link}\n\n*Good to know:*\n${tips}`,
`*Location link:*\n👉 ${KB.maps_link}\n\n*Good to know:*\n${tips}`,
`*لوکیشن لنک:*\n👉 ${KB.maps_link}\n\n*اہم معلومات:*\n${tips}`
  ));
}
function msgMedia(lang) {
  return sanitizeVoice(L(lang,
`You can see our latest exterior & interior photos and videos here:\n${KB.insta}\nIf you want something specific, tell us and we’ll share more. 😊`,
`Exterior & interior ki latest photos/videos yahan dekhein:\n${KB.insta}\nKuch specific chahiye to batayein. 😊`,
`ہمارے بیرونی اور اندرونی ویڈیوز/تصاویر یہاں دیکھیں:\n${KB.insta}\nاگر کچھ خاص درکار ہو تو بتائیں۔ 😊`
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
  const list = KB.facilities.map(t => `• ${t}`).join('\n');
  return sanitizeVoice(L(lang,
`Here’s what guests love at Roameo Resorts:\n${list}`,
`Roameo Resorts ki yeh cheezen mehmanon ko pasand aati hain:\n${list}`,
`رو میو ریزورٹس کی نمایاں خصوصیات:\n${list}`
  ));
}

/* =========================
   GPT — facts-only composer
   ========================= */
function kbText() {
  const r = KB.rates;
  return `
Facts (authoritative):
- Brand: ${KB.brand}
- Focus on "${KB.brand}" (avoid over-focusing on valley name)
- Location: ${KB.location}
- Check-in: ${KB.checkin}, Check-out: ${KB.checkout}
- Rates (PKR):
  • Deluxe Hut: base ${r.deluxe.base}; 1st night ${r.deluxe.n1}; 2nd ${r.deluxe.n2}; 3rd ${r.deluxe.n3}
  • Executive Hut: base ${r.executive.base}; 1st night ${r.executive.n1}; 2nd ${r.executive.n2}; 3rd ${r.executive.n3}
- Facilities: ${KB.facilities.join('; ')}
- Terms: ${KB.tnc.join('; ')}
- Instagram: ${KB.insta}
- Website: ${KB.site}
- WhatsApp: ${KB.whatsapp_link} (DM) / ${KB.whatsapp_num} (IG comments number)
`.trim();
}
function gptSystem(asComment, lang) {
  const surface = asComment ? 'COMMENT' : 'DM';
  const langGuide = lang === 'ur'
    ? 'Write in fluent Urdu script.'
    : lang === 'roman-ur'
      ? 'Write in natural Roman Urdu (ASCII letters).'
      : 'Write in natural English.';
  return `
You are ${KB.brand}'s assistant.
${langGuide}
Use ONLY the facts provided. Do NOT invent prices or facilities.
If the user asks for videos, photos, exterior/interior — direct them to Instagram: ${KB.insta}.
If the user asks for manager/contact — provide WhatsApp (DM: ${KB.whatsapp_link}; IG comment: ${KB.whatsapp_num}).
If the user asks location — include the map link: ${KB.maps_link}.
If the user asks about prices in a DM, include numeric prices and may compute totals (e.g., 7 nights). In COMMENTS, NEVER include numeric prices; nudge to DM for rates.
Match the user's language exactly. Keep replies concise (2–5 short lines). Prefer "Roameo Resorts" over valley name.
Avoid URLs or phone numbers in the body UNLESS explicitly noted above; the app may append CTAs.
Surface: ${surface}.
Facts:
${kbText()}
`.trim();
}
async function gptReply(userText, { asComment=false, lang='en' } = {}) {
  if (!openai) {
    return sanitizeVoice(L(lang,
      `Thanks! We’re here to help at ${KB.brand}. Tell us what you’re looking for.`,
      `Shukriya! ${KB.brand} par hum madad ko tayyar hain—batayein kya chahiye.`,
      `شکریہ! ${KB.brand} میں ہم مدد کے لیے حاضر ہیں—بتائیں آپ کیا جاننا چاہتے ہیں۔`
    ));
  }
  const messages = [
    { role: 'system', content: gptSystem(asComment, lang) },
    { role: 'user', content: userText }
  ];
  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.6,
    top_p: 0.9,
    max_tokens: asComment ? 260 : 520,
    messages
  });
  let out = res?.choices?.[0]?.message?.content?.trim() || '';
  out = sanitizeVoice(out);
  if (asComment) out = stripPricesFromPublic(out);
  if (lang === 'roman-ur') out = out.replace(/[\u0600-\u06FF\u0750-\u077F]+/g, '').replace(/\s{2,}/g, ' ').trim();
  return out;
}

/* =========================
   PRICE DM (GPT-powered)
   ========================= */
async function dmPriceMessage(userText='') {
  const lang = detectLanguage(userText);
  // Ask GPT to tailor (handles "7 nights", "weekly", language, etc.)
  const body = await gptReply(userText, { asComment: false, lang });
  // CTA appended at send-time for DMs (below)
  return body;
}

/* =========================
   DECISION FLOW
   ========================= */
function shouldAttachCTA(intent, surface) {
  if (surface === 'comment' && intent === 'rates') return false; // public price policy
  return true;
}
function attachCTA(body, intent, platform, surface) {
  if (!shouldAttachCTA(intent, surface)) return body;
  const compact = (body || '').trim();
  const already = /WhatsApp:|roameoresorts\.com|wa\.me|https?:\/\/\S+/i.test(compact);
  if (already) return compact;
  if (platform === 'instagram' && surface === 'comment') {
    // IG comment: number only
    return `${compact}\nWhatsApp: ${WHATSAPP_NUMBER}`.trim();
    }
  // FB comments + all DMs
  return `${compact}\nChat on WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`.trim();
}

async function decideReply(text, ctx = { surface: 'dm', platform: 'facebook' }) {
  const lang = detectLanguage(text);
  const asComment = ctx.surface === 'comment';

  // Deterministic intents FIRST (no vagueness)
  if (!asComment && isPricingIntent(text)) return attachCTA(await dmPriceMessage(text), 'rates', ctx.platform, 'dm');
  if (asComment && isPricingIntent(text)) {
    return L(lang,
      'Please DM us for rates — exclusive DM-only deals! 🔒',
      'Rates ke liye DM karein — sirf DM mein deals! 🔒',
      'براہِ کرم ریٹس کے لیے DM کریں — خصوصی آفرز صرف DM میں! 🔒'
    );
  }
  if (isMediaIntent(text))    return attachCTA(msgMedia(lang), 'media', ctx.platform, ctx.surface);
  if (isContactIntent(text))  return attachCTA(msgContact(lang), 'contact', ctx.platform, ctx.surface);
  if (isLocationIntent(text)) return attachCTA(msgLocation(lang), 'location', ctx.platform, ctx.surface);
  if (isFacilitiesIntent(text)) return attachCTA(msgFacilities(lang), 'facilities', ctx.platform, ctx.surface);

  // Enrichment for distance/weather if useful
  let wx = null;
  if ((isWeatherIntent(text) || isLocationIntent(text) || isBookingIntent(text) || isPricingIntent(text)) && RESORT_COORDS.includes(',')) {
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
          const ans = L(lang,
            `Approx drive from ${city}: ~${km(drive.meters)} km, ~${hhmm(drive.seconds)}.\nMap: ${KB.maps_link}`,
            `${city} se taqriban drive: ~${km(drive.meters)} km, ~${hhmm(drive.seconds)}.\nMap: ${KB.maps_link}`,
            `${city} سے اندازاً ڈرائیو: ~${km(drive.meters)} کلو میٹر، ~${hhmm(drive.seconds)}۔\nنقشہ: ${KB.maps_link}`
          );
          return attachCTA(sanitizeVoice(ans), 'distance', ctx.platform, ctx.surface);
        }
      }
    }
  }

  // General/irrelevant → GPT short + Roameo tie-back
  const gpt = await gptReply(text, { asComment, lang });
  return attachCTA(gpt, 'general', ctx.platform, ctx.surface);
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
        try { await fbPrivateReplyToComment(v.comment_id, await dmPriceMessage(text)); } catch (e) {}
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
  } catch (e) { logAxiosError(e); throw e; }
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
        if (IG_PRIVATE_REPLY_ENABLED) {
          try { await igPrivateReplyToComment(pageId, commentId, await dmPriceMessage(text)); }
          catch (e) { const code = e?.response?.data?.error?.code; if (code !== 3) logErr(e); /* silence capability (#3) */ }
        }
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
  // DO NOT match "please" (so "charges please" doesn’t trigger)
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
    return sendBatched(psid, attachCTA(msg, 'general', opts.channel === 'instagram' ? 'instagram' : 'facebook', 'dm'));
  }

  if (state === 'awaiting_details' && !isPricingIntent(text)) {
    convo.delete(psid);
    const msg = L(lang,
      `Thanks! To confirm your booking, please use: ${KB.site}`,
      `Shukriya! Booking confirm karne ke liye ye link use karein: ${KB.site}`,
      `شکریہ! بکنگ کنفرم کرنے کے لیے یہ لنک استعمال کریں: ${KB.site}`
    );
    await sendBatched(psid, attachCTA(msg, 'general', opts.channel === 'instagram' ? 'instagram' : 'facebook', 'dm'));
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
  try { await axios.post(url, payload, { params, timeout: 10000 }); }
  catch (e) { logAxiosError(e); }
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
        RESORT_COORDS: RESORT_COORDS,
        CHECKIN: KB.checkin,
        CHECKOUT: KB.checkout
      }
    });
  } catch (e) {
    logAxiosError(e);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
