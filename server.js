// server.js — Roameo Resorts omni-channel bot (v6 — dynamic-night totals, strong bridges, tighter price intent)

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
const OPENAI_MODEL   = process.env.OPENAI_MODEL   || 'gpt-4o-mini';

// Toggles
const AUTO_REPLY_ENABLED      = String(process.env.AUTO_REPLY_ENABLED      || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY  = String(process.env.ALLOW_REPLY_IN_STANDBY  || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL= String(process.env.AUTO_TAKE_THREAD_CONTROL|| 'false').toLowerCase() === 'true';

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
const BRAND_USERNAME = 'roameoresorts';
const WHATSAPP_NUMBER = '03558000078';
const WHATSAPP_LINK   = 'https://wa.me/923558000078';
const SITE_URL   = 'https://www.roameoresorts.com/';
const SITE_SHORT = 'roameoresorts.com';
const MAPS_LINK  = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Outgoing message limits
const MAX_OUT_CHAR = 800;

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT general replies disabled; local fallbacks will be used.');
}

/* =======================================================
   40% OFF CAMPAIGN — valid till 15th September 2025
   ======================================================= */
const DISCOUNT = { percent: 40, validUntilText: '15th September 2025' };

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
    'Complimentary breakfast for 2 guests per booking',
    'Additional breakfast charges: PKR 500 per person',
    '50% advance payment required to confirm the reservation',
    `Offer valid till ${DISCOUNT.validUntilText}`
  ],
  rates: {
    deluxe:    { base: 30000 },
    executive: { base: 50000 }
  },
  // Exact price card layout (DM-only). Keep spacing & newlines.
  PRICE_CARD_EN: (
`We’re currently offering an exclusive 40% limited-time discount for our guests at Roameo Resort valid only till 15th September 2025!

📍 Limited-Time Discounted Rate List:

Deluxe Hut – PKR 30,000/night
✨ Flat 40% Off → PKR 18,000/night

Executive Hut – PKR 50,000/night
✨ Flat 40% Off → PKR 30,000/night

Terms & Conditions:
• Rates are inclusive of all taxes
• Complimentary breakfast for 2 guests per booking
• Additional breakfast charges: PKR 500 per person
• 50% advance payment required to confirm the reservation
• Offer valid till 15th September 2025

Let us know if you’d like to book your stay or need any assistance! 🌿✨`).trim()
};

/* =========================
   STYLE / EMOJI
   ========================= */
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
function sanitizeVoice(text = '') {
  if (!text) return '';
  const urls = [];
  let s = String(text).replace(/https?:\/\/\S+/gi, (m) => { urls.push(m); return `__URL${urls.length - 1}__`; });
  s = s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n');
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)]);
}
function normalize(s='') {
  return String(s).normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function detectLanguage(text = '') {
  const t = (text || '').trim();
  const hasUrduScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (hasUrduScript) return 'ur';
  const romanUrduTokens = ['aap','ap','apka','apki','apke','kiraya','qeemat','rate','price','btao','batao','kitna','kitni','kitne','raha','hai','hain'];
  const hit = romanUrduTokens.some(w => new RegExp(`\\b${w}\\b`, 'i').test(t));
  return hit ? 'roman-ur' : 'en';
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

/* ===== Pricing: tighter trigger (no more “cv”) & nights extractor ===== */
function isPricingIntent(text = '') {
  const t = normalize(text);
  if (t.length <= 2) return false; // ignore tiny noise like "cv", "ok", etc.

  const kw = [
    'price','prices','pricing','rate','rates','tariff','cost','rent','rental','per night','night price',
    'kiraya','qeemat','kimat','keemat',
    'قیمت','کرایہ','ریٹ','نرخ'
  ];
  if (kw.some(x => t.includes(x))) return true;

  // Numeric with explicit nights
  if (/\b\d+\s*(night|nights|din|raat)\b/.test(t)) return true;

  // direct “how much”
  if (/\bhow much\b/.test(t)) return true;

  return false;
}
function extractNights(text='') {
  const t = normalize(text);
  // patterns: "for 4 nights", "4 nights", "5 night", "5 din/raat"
  const m = t.match(/\b(?:for\s*)?(\d{1,2})\s*(?:night|nights|din|raat)\b/);
  if (m) return Math.max(1, Math.min(30, parseInt(m[1],10)));
  // “for five nights” (basic words one–ten)
  const words = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
  const m2 = t.match(/\b(?:for\s*)?(one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:night|nights)\b/);
  if (m2) return words[m2[1]] || null;
  return null;
}

/* =========================
   GPT helpers
   ========================= */
async function gptGeneralReply({ userText, lang }) {
  if (!OPENAI_API_KEY) return null;

  const sys = [
    "You are the official concierge for Roameo Resorts.",
    "Rule 1: First, answer the user's actual question correctly and concisely (1–2 short lines).",
    "Rule 2: Immediately after, add a strong bridge that ties it to Roameo Resorts (river-front huts in Neelum Valley, cozy interiors, breakfast, easy getaway).",
    "Rule 3: Keep tone warm, simple, and brand-safe. No overpromises.",
    `Rule 4: End with: "WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}"`,
    "Rule 5: Reply in the same language the user used (English / Urdu / Roman Urdu)."
  ].join(' ');

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.4,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userText }
    ]
  };

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
    const out = data?.choices?.[0]?.message?.content || '';
    return sanitizeVoice(out);
  } catch (e) {
    console.error('🧠 OpenAI general error:', e?.response?.data || e.message);
    return null;
  }
}

/* =========================
   PRICE MESSAGE (DM) — exact layout + optional totals
   ========================= */
function discounted(n) { return Math.round(n * (1 - DISCOUNT.percent / 100)); }
function fm(n){ return Number(n).toLocaleString('en-PK'); }

async function dmPriceMessage(userText = '') {
  const nights = extractNights(userText); // may be null
  const card = FACTS.PRICE_CARD_EN; // we keep the exact text you provided

  if (!nights) {
    // No totals requested — return the exact card plus CTA links
    return sanitizeVoice(`${card}\n\nWhatsApp: ${WHATSAPP_LINK}\nAvailability / Book: ${SITE_URL}`);
  }

  // Add totals section (kept outside of the “exact” block)
  const dBase = FACTS.rates.deluxe.base;
  const eBase = FACTS.rates.executive.base;
  const dDisc = discounted(dBase);
  const eDisc = discounted(eBase);

  const totals =
`\n\nEstimated totals for ${nights} night${nights>1?'s':''}:
• Deluxe Hut — PKR ${fm(dBase*nights)} → PKR ${fm(dDisc*nights)} after ${DISCOUNT.percent}% off
• Executive Hut — PKR ${fm(eBase*nights)} → PKR ${fm(eDisc*nights)} after ${DISCOUNT.percent}% off`;

  return sanitizeVoice(`${card}${totals}\n\nWhatsApp: ${WHATSAPP_LINK}\nAvailability / Book: ${SITE_URL}`);
}

/* =========================
   ROUTE MESSAGE (DM)
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
function extractOrigin(text='') {
  const t = text.trim();
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

  const simple = routeInfo
    ? (lang === 'ur'
        ? `*${origin}* سے Roameo Resorts تک تقریباً ${routeInfo.distance_km} کلومیٹر — سفر وقت ${routeInfo.drive_time}.\n\nلوکیشن: ${MAPS_LINK}`
        : lang === 'roman-ur'
          ? `From *${origin}* to Roameo Resorts ~${routeInfo.distance_km} km, drive ~${routeInfo.drive_time}.\n\nLocation: ${MAPS_LINK}`
          : `From *${origin}* to Roameo Resorts is ~${routeInfo.distance_km} km (~${routeInfo.drive_time}).\n\nLocation: ${MAPS_LINK}`)
    : (lang === 'ur' ? `لوکیشن لنک: ${MAPS_LINK}` : `Location: ${MAPS_LINK}`);

  return sanitizeVoice(`${simple}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
}

/* =========================
   DECISION + GENERATION
   ========================= */
function intentFromText(text = '') {
  const t = normalize(text);
  return {
    wantsLocation   : /\blocation\b|\bwhere\b|\baddress\b|\bmap\b|\bpin\b|\bdirections?\b|\breach\b/.test(t),
    wantsRates      : isPricingIntent(text),
    wantsFacilities : /\bfaciliti(?:y|ies)\b|\bamenit(?:y|ies)\b|\bkitchen\b|\bfood\b|\bheater\b|\bbonfire\b|\bfamily\b|\bparking\b|\bjeep\b|\binverter\b/.test(t),
    wantsBooking    : /\bbook\b|\bbooking\b|\breserve\b|\breservation\b|\bcheck ?in\b|\bcheck ?out\b|\badvance\b|\bpayment\b/.test(t),
    wantsAvail      : /\bavailability\b|\bavailable\b|\bdates?\b|\bcalendar\b/.test(t),
    wantsDistance   : /\bdistance\b|\bhow far\b|\bhours\b|\bdrive\b|\btime from\b|\beta\b/.test(t),
    wantsWeather    : /\bweather\b|\btemperature\b|\bforecast\b/.test(t),
    wantsRoute      : /\broute\b|\brasta\b/.test(t),
    wantsContact    : /\bcontact\b|\bmanager\b|\bowner\b|\bnumber\b|\bwhats\s*app\b|\bwhatsapp\b|\bcall\b|\bspeak to\b|\braabta\b/.test(t)
  };
}

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

async function generateReply({ intent, userText, lang, asComment }) {
  if (intent === 'general') {
    const bridge = await gptGeneralReply({ userText, lang });
    const msg = bridge || `If you’re planning a trip around Neelum Valley, Roameo Resorts’ river-front huts and breakfast make for an easy, relaxing escape.\n\nWhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`;
    return asComment ? stripPricesFromPublic(msg) : msg;
  }
  return 'OK';
}

/* =========================
   DM handler
   ========================= */
function isAffirmative(text = '') {
  const t = normalize(text);
  const en = /\b(yes|yeah|yep|sure|okay|ok|please|go ahead|sounds good|alright)\b/;
  const ru = /\b(haan|han|ji|jee|bilkul|theek hai|acha|accha|zaroor)\b/;
  const ur = /(?:\u062C\u06CC|\u062C\u06CC\u06C1|\u06C1\u0627\u06BA|\u0628\u0644\u06A9\u0644|\u062A\u06BE\u06CC\u06A9)/;
  return en.test(t) || ru.test(t) || ur.test(t);
}

async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  const lang = detectLanguage(text);
  const intents = intentFromText(text);

  if (!AUTO_REPLY_ENABLED) return;

  if (intents.wantsContact) {
    const msg = `WhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`;
    return sendBatched(psid, msg);
  }

  if (intents.wantsLocation) {
    const msg = `*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`;
    return sendBatched(psid, msg);
  }

  if (intents.wantsRates) {
    return sendBatched(psid, await dmPriceMessage(text));
  }

  if (intents.wantsRoute || intents.wantsDistance) {
    return sendBatched(psid, await dmRouteMessage(text));
  }

  // General/other → factual answer + strong bridge via GPT
  const reply = await generateReply({ intent: 'general', userText: text, lang, asComment: false });
  return sendBatched(psid, reply);
}

/* =========================
   WEBHOOKS & ROUTERS (FB + IG)
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
  if (payload?.error) console.error('FB/IG API error', payload);
  else console.error('💥 Handler error:', payload);
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
  await axios.post(url, { message: message.slice(0, MAX_OUT_CHAR) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
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
      // Public comments: never post numeric prices — give nudge only
      const lang = detectLanguage(text);
      if (isPricingIntent(text)) {
        try { await fbPrivateReplyToComment(v.comment_id, await dmPriceMessage(text)); } catch (e) { logErr(e); }
        await replyToFacebookComment(v.comment_id, `Flat ${DISCOUNT.percent}% OFF till ${DISCOUNT.validUntilText} — DM us for the full rate list & availability! ✨`);
        return;
      }
      // Generic: short bridge
      const generic = await gptGeneralReply({ userText: text, lang });
      await replyToFacebookComment(v.comment_id, stripPricesFromPublic(generic || `Plan a calm river-side break at Roameo Resorts.\nWhatsApp: ${WHATSAPP_LINK}`));
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
  await axios.post(url, { message: message.slice(0, MAX_OUT_CHAR) }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
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
        await replyToInstagramComment(commentId, `Flat ${DISCOUNT.percent}% OFF till ${DISCOUNT.validUntilText} — DM for rates & availability ✨`);
        return;
      }
      const generic = await gptGeneralReply({ userText: text, lang: detectLanguage(text) });
      await replyToInstagramComment(commentId, stripPricesFromPublic(generic || `Plan a calm river-side break at Roameo Resorts. WhatsApp: ${WHATSAPP_LINK}`));
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
   ADMIN
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
        OPENAI_ENABLED: Boolean(OPENAI_API_KEY),
        RESORT_COORDS: FACTS.resort_coords,
        DISCOUNT: `${DISCOUNT.percent}% until ${DISCOUNT.validUntilText}`,
        BASE_PRICES: { deluxe: FACTS.rates.deluxe.base, executive: FACTS.rates.executive.base }
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
