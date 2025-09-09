// server.js — Roameo Resorts omni-channel bot (v8)
// Fixes: image proxy for OpenAI Vision, robust routing, retries, fewer 4xx logs.

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');
const URL = require('url').URL;
const path = require('path');

// Brain
const { askBrain, constructUserMessage } = require('./lib/brain');

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV & CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const GEOAPIFY_API_KEY    = process.env.GEOAPIFY_API_KEY   || '';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY|| '';
const RESORT_COORDS       = (process.env.RESORT_COORDS || '').trim(); // "lat,lon"
const RESORT_LOCATION_NAME= process.env.RESORT_LOCATION_NAME || 'Roameo Resorts, Tehjian (Neelum)';

const AUTO_REPLY_ENABLED       = String(process.env.AUTO_REPLY_ENABLED       || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY   = String(process.env.ALLOW_REPLY_IN_STANDBY   || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Brand constants
const BRAND_USERNAME  = 'roameoresorts';
const WHATSAPP_LINK   = 'https://wa.me/923558000078';
const SITE_URL        = 'https://www.roameoresorts.com/';
const SITE_SHORT      = 'roameoresorts.com';
const MAPS_LINK       = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

const MAX_OUT_CHAR = 800;

// Sanity check
if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}

/* =========================
   FACTS
   ========================= */
const FACTS = {
  site: SITE_URL,
  map: MAPS_LINK,
  resort_coords: RESORT_COORDS,
  location_name: RESORT_LOCATION_NAME,
  river_name: 'Neelam River',
  checkin: CHECKIN_TIME,
  checkout: CHECKOUT_TIME
};

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const dedupe      = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });       // 1h
const tinyCache   = new LRUCache({ max: 300,  ttl: 1000 * 60 * 15 });       // 15m
const chatHistory = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 * 24 });  // 24h

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
  const romanUrduTokens = [
    'aap','ap','apka','apki','apke','kiraya','qeemat','rate','price','btao','batao',
    'kitna','kitni','kitne','raha','hai','hain'
  ];
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
function isPricingIntent(text = '') {
  const t = normalize(text);
  if (t.length <= 2) return false;
  const kw = [
    'price','prices','pricing','rate','rates','tariff','cost','rent','rental','per night','night price',
    'kiraya','qeemat','kimat','keemat','قیمت','کرایہ','ریٹ','نرخ'
  ];
  if (kw.some(x => t.includes(x))) return true;
  if (/\b\d+\s*(night|nights|din|raat)\b/.test(t)) return true;
  if (/\bhow much\b/.test(t)) return true;
  return false;
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
   IMAGE PROXY for Vision (fix invalid_image_url)
   ========================= */
function cleanIncomingUrl(u = '') {
  let s = String(u || '').trim();
  // remove trailing punctuation (common when users paste)
  s = s.replace(/[.)"'?,]+$/g, '');
  return s;
}
// Allow only http/https and common CDNs (but also allow any https since lookaside is public)
function isSafeRemote(u) {
  try {
    const url = new URL(u);
    return ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}

app.get('/img', async (req, res) => {
  try {
    const raw = req.query.u || '';
    const target = cleanIncomingUrl(raw);
    if (!target || !isSafeRemote(target)) return res.status(400).send('Bad image URL');

    const cached = tinyCache.get(`img:${target}`);
    if (cached) {
      res.setHeader('Content-Type', cached.type || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=600');
      return res.end(cached.buf, 'binary');
    }

    // fetch remote image and stream to client
    const resp = await axios.get(target, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        // Helps with some CDNs
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'User-Agent': 'RoameoBot/1.0 (+https://www.roameoresorts.com/)',
        'Referer': 'https://www.facebook.com/'
      }
    });

    const ctype = resp.headers['content-type'] || 'image/jpeg';
    const buf = Buffer.from(resp.data);
    tinyCache.set(`img:${target}`, { buf, type: ctype });
    res.setHeader('Content-Type', ctype);
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.end(buf, 'binary');
  } catch (e) {
    console.error('image proxy error', e?.response?.status, e?.message);
    return res.status(502).send('Upstream image fetch failed');
  }
});

// Transform any fbcdn/lookaside/etc. URL to our proxy so OpenAI can fetch it.
function toVisionableUrl(imageUrl, req) {
  if (!imageUrl) return null;
  const cleaned = cleanIncomingUrl(imageUrl);
  try {
    const u = new URL(cleaned);
    const host = (req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${PORT}`).toString();
    const proto = (req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').toString();
    // Always proxy — those CDNs often fail with signed URLs/headers.
    const proxied = `${proto}://${host}/img?u=${encodeURIComponent(u.toString())}`;
    return proxied;
  } catch {
    return null;
  }
}

/* =========================
   ENRICHMENT — Geocoding & Routes
   ========================= */
function km(meters)    { return (meters / 1000).toFixed(0); }
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

// Skip walk/transit if distance likely huge to avoid 400 "too long distance"
async function routingForModes(waypoints, modes) {
  const url = 'https://api.geoapify.com/v1/routing';
  const out = [];
  for (const mode of modes) {
    try {
      const { data } = await axios.get(url, {
        params: { waypoints, mode, apiKey: GEOAPIFY_API_KEY, traffic: mode === 'drive' ? 'approximated' : undefined },
        timeout: 12000
      });
      const ft = data?.features?.[0]?.properties;
      if (!ft) continue;
      out.push({
        mode,
        distance: ft.distance,
        time: ft.time,
        distance_km: Number(km(ft.distance)),
        duration_formatted: hhmm(ft.time)
      });
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || '';
      if (String(msg).includes('Too long distance')) {
        // silent skip
      } else {
        console.error(`routing ${mode} error`, e?.response?.data || e.message);
      }
    }
  }
  return out;
}

async function getRouteInfo(originLat, originLon, destLat, destLon) {
  if (!GEOAPIFY_API_KEY) return null;
  const key = `route:${originLat},${originLon}->${destLat},${destLon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);

  // If crow-fly distance is > 200km, skip walk/transit
  const approxKm = (() => {
    try {
      const R = 6371;
      const toRad = d => d * Math.PI / 180;
      const dLat = toRad(destLat - originLat);
      const dLon = toRad(destLon - originLon);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(originLat)) * Math.cos(toRad(destLat)) * Math.sin(dLon/2)**2;
      return 2 * R * Math.asin(Math.sqrt(a));
    } catch { return 999; }
  })();

  const modes = approxKm > 200 ? ['drive'] : ['drive','walk','transit'];
  const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
  const routes = await routingForModes(waypoints, modes);
  if (!routes.length) return null;

  const result = { routes, primary: routes.find(r => r.mode === 'drive') || routes[0] };
  tinyCache.set(key, result);
  return result;
}

/* =========================
   TEXT INTENT / ROUTE DM
   ========================= */
function extractOrigin(text='') {
  const t = text.trim();
  const rx = [
    /route\s+from\s+(.+)$/i,
    /rasta\s+from\s+(.+)$/i,
    /directions?\s+from\s+(.+)$/i,
    /how\s+to\s+reach\s+from\s+(.+)$/i,
    /coming\s+from\s+(.+)$/i,
    /travel(?:ling|ing)?\s+from\s+(.+)$/i,
    /from\s+(.+)\s+(?:to|till)\s+(?:roameo|resort|neelum|tehjian)/i,
    /how\s+far\s+is\s+(.+)\s+(?:from|to)/i,
    /distance\s+from\s+(.+)$/i,
    /(.+)\s+سے\s+(?:راستہ|فاصلہ|دور|کتنے|کتنا)/i,
    /(.+)\s+se\s+(?:rasta|distance|far|kitna|kitne)/i
  ];
  for (const r of rx) {
    const m = t.match(r);
    if (m && m[1]) {
      let origin = m[1].replace(/[.?!]+$/,'').trim();
      origin = origin.replace(/\b(the|a|an|from|to|is|are|was|were|will|would|can|could|should|may|might)\b/gi, '').trim();
      if (origin.length > 2) return origin;
    }
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
  if (destParts.length !== 2) return 'Location temporarily unavailable. Please try later.';
  const [dLat, dLon] = destParts.map(parseFloat);

  const originGeo = await geocodePlace(origin);
  if (!originGeo) {
    return lang === 'ur'
      ? `"${origin}" کا مقام نہیں مل سکا۔ براہِ کرم شہر کا صحیح نام استعمال کریں۔\n\nلوکیشن: ${MAPS_LINK}`
      : lang === 'roman-ur'
        ? `"${origin}" ka location nahi mila. Sahi shehar ka naam use karein.\n\nLocation: ${MAPS_LINK}`
        : `Could not find location for "${origin}". Please use the correct city name.\n\nLocation: ${MAPS_LINK}`;
  }

  const routeInfo = await getRouteInfo(originGeo.lat, originGeo.lon, dLat, dLon);
  if (!routeInfo) {
    return lang === 'ur'
      ? `راستہ معلومات دستیاب نہیں۔ براہِ کرم بعد میں کوشش کریں۔\n\nلوکیشن: ${MAPS_LINK}`
      : lang === 'roman-ur'
        ? `Route info nahi mila. Baad mein try karein.\n\nLocation: ${MAPS_LINK}`
        : `Route information not available. Please try again later.\n\nLocation: ${MAPS_LINK}`;
  }

  let response = '';
  if (lang === 'ur') {
    response = `*${origin}* سے Roameo Resorts تک:\n\n`;
    routeInfo.routes.forEach(route => {
      const modeName = route.mode === 'drive' ? 'گاڑی' : route.mode === 'walk' ? 'پیدل' : 'پبلک ٹرانسپورٹ';
      response += `• ${modeName}: ${route.distance_km} کلومیٹر (${route.duration_formatted})\n`;
    });
    response += `\nلوکیشن: ${MAPS_LINK}`;
  } else if (lang === 'roman-ur') {
    response = `*${origin}* se Roameo Resorts:\n\n`;
    routeInfo.routes.forEach(route => {
      const modeName = route.mode === 'drive' ? 'Car' : route.mode === 'walk' ? 'Walking' : 'Public Transport';
      response += `• ${modeName}: ${route.distance_km} km (${route.duration_formatted})\n`;
    });
    response += `\nLocation: ${MAPS_LINK}`;
  } else {
    response = `From *${origin}* to Roameo Resorts:\n\n`;
    routeInfo.routes.forEach(route => {
      const modeName = route.mode === 'drive' ? 'By Car' : route.mode === 'walk' ? 'Walking' : 'Public Transport';
      response += `• ${modeName}: ${route.distance_km} km (${route.duration_formatted})\n`;
    });
    response += `\nLocation: ${MAPS_LINK}`;
  }

  const tip = lang === 'ur'
    ? `\n\n💡 ٹپ: گاڑی سے آنا بہترین ہے۔ راستہ خوبصورت ہے!`
    : lang === 'roman-ur'
      ? `\n\n💡 Tip: Car se ana best hai. Rasta khoobsurat hai!`
      : `\n\n💡 Tip: Driving is the best option. The route is beautiful!`;

  return sanitizeVoice(`${response}${tip}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
}

/* =========================
   INTENT ROUTER
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
    wantsRoute      : /\broute\b|\brasta\b|\bhow\s+to\s+(?:reach|get|come)\b|\bfrom\s+\w+\s+(?:to|till|for)\b|\b(?:travel|journey)\s+time\b|\b(?:travel|journey)\s+from\b/.test(t),
    wantsContact    : /\bcontact\b|\bmanager\b|\bowner\b|\bnumber\b|\bwhats\s*app\b|\bwhatsapp\b|\bcall\b|\bspeak to\b|\braabta\b/.test(t)
  };
}

/* =========================
   DM HANDLER
   ========================= */
async function handleTextMessage(psid, text, rawImageUrl, reqCtx = {}) {
  if (!AUTO_REPLY_ENABLED) return;

  const imageUrl = rawImageUrl ? toVisionableUrl(rawImageUrl, reqCtx.req) : null;

  // IG post link detector — we still prefer screenshot for context
  const igPostRegex = /(https?:\/\/(www\.)?instagram\.com\/(p|reel)\/[a-zA-Z0-9_-]+)/;
  const igMatch = text && text.match(igPostRegex);

  if (igMatch && !imageUrl) {
    const lang = detectLanguage(text);
    const reply = lang === 'ur'
      ? 'اس پوسٹ کے بارے میں سوالات کے لیے، براہِ مہربانی اسکرین شاٹ بھیجیں۔'
      : lang === 'roman-ur'
        ? 'Is post ke baare mein sawalat ke liye, please screenshot send karein.'
        : 'For questions about this post, please send a screenshot.';
    const finalMessage = `${reply}\n\nAt Roameo Resorts, we're always ready to help you plan the perfect getaway!`;
    return sendBatched(psid, finalMessage);
  }

  const intents = intentFromText(text || '');

  if (intents.wantsContact) {
    const msg = `WhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`;
    return sendBatched(psid, msg);
  }
  if (intents.wantsLocation) {
    const msg = `*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`;
    return sendBatched(psid, msg);
  }
  if (intents.wantsRoute || intents.wantsDistance) {
    return sendBatched(psid, await dmRouteMessage(text || ''));
  }

  // Brain flow (with short rolling history)
  const history = chatHistory.get(psid) || [];
  const surface = 'dm';

  const response = await askBrain({ text, imageUrl, surface, history });
  const { message } = response;

  // Update history
  const newHistory = [
    ...history,
    constructUserMessage({ text, imageUrl, surface }),
    { role: 'assistant', content: message }
  ].slice(-10);

  chatHistory.set(psid, newHistory);

  return sendBatched(psid, message);
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
          for (const ev of entry.messaging) await routeMessengerEvent(ev, { source: 'messaging', req }).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routePageChange(change, { req }).catch(logErr);
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            if (!ALLOW_REPLY_IN_STANDBY) continue;
            if (AUTO_TAKE_THREAD_CONTROL && ev.sender?.id) await takeThreadControl(ev.sender.id).catch(()=>{});
            await routeMessengerEvent(ev, { source: 'standby', req }).catch(logErr);
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
          for (const ev of entry.messaging) await routeInstagramMessage(ev, { req }).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routeInstagramChange(change, pageId, { req }).catch(logErr);
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
async function routeMessengerEvent(event, ctx = { source: 'messaging', req: null }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) await takeThreadControl(event.sender.id).catch(() => {});

    const text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url;

    if (!text && !imageUrl) return;

    return handleTextMessage(event.sender.id, text, imageUrl, ctx);
  }

  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', null, ctx);
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

async function routePageChange(change, ctx = { req: null }) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item === 'comment' && v.comment_id) {
    const text = (v.message || '').trim();
    if (v.verb !== 'add') return;
    if (isSelfComment(v, 'facebook')) return;

    if (AUTO_REPLY_ENABLED) {
      const lang = detectLanguage(text);
      if (isPricingIntent(text)) {
        try {
          const dm = await askBrain({ text, surface: 'dm' });
          await fbPrivateReplyToComment(v.comment_id, dm.message);
        } catch (e) { logErr(e); }
        await replyToFacebookComment(v.comment_id, 'DM us for today’s rates, availability, and a quick booking link. ✨');
        return;
      }
      const dm = await askBrain({ text, surface: 'comment' });
      await replyToFacebookComment(v.comment_id, stripPricesFromPublic(dm.message));
    }
  }
}

/* =========================
   Instagram (DMs + Comments)
   ========================= */
async function routeInstagramMessage(event, ctx = { req: null }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    const text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url;

    if (!text && !imageUrl) return;

    return handleTextMessage(igUserId, text, imageUrl, ctx);
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

async function routeInstagramChange(change, pageId, ctx = { req: null }) {
  const v = change.value || {};
  const isComment = (change.field || '').toLowerCase().includes('comment') || (v.item === 'comment');
  if (isComment && (v.comment_id || v.id)) {
    const commentId = v.comment_id || v.id;
    const text = (v.text || v.message || '').trim();
    if (v.verb && v.verb !== 'add') return;
    if (isSelfComment(v, 'instagram')) return;

    if (AUTO_REPLY_ENABLED) {
      if (isPricingIntent(text)) {
        try {
          const dm = await askBrain({ text, surface: 'dm' });
          await igPrivateReplyToComment(pageId, commentId, dm.message);
        } catch (e) { logErr(e); }
        await replyToInstagramComment(commentId, 'DM for today’s rates and availability. ✨');
        return;
      }
      const dm = await askBrain({ text, surface: 'comment' });
      await replyToInstagramComment(commentId, stripPricesFromPublic(dm.message));
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
   HANDOVER
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
        RESORT_COORDS: FACTS.resort_coords,
        LINKS: { maps: MAPS_LINK, site: SITE_URL, whatsapp: WHATSAPP_LINK }
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =========================
   WIRE BRAIN TOOLS
   ========================= */
const { getWeatherForecast, findNearbyPlaces, getRouteInfo: brainRoute } = require('./lib/brain');

// Implement actual tool functions (OpenAI tool calls hit these via brain)
async function tool_getWeatherForecast() {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  if (!OPENWEATHER_API_KEY || !latLon) return { error: "Weather API not configured" };

  const [lat, lon] = latLon.split(',').map(s => s.trim());
  try {
    const { data } = await axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: { lat, lon, appid: OPENWEATHER_API_KEY, units: 'metric' },
      timeout: 8000
    });

    const daily = {};
    for (const p of (data.list || [])) {
      const day = p.dt_txt.split(' ')[0];
      if (!daily[day]) daily[day] = { temps: [], conditions: {} };
      daily[day].temps.push(p.main.temp);
      const cond = p.weather[0]?.main || 'Clear';
      daily[day].conditions[cond] = (daily[day].conditions[cond] || 0) + 1;
    }
    const forecast = Object.entries(daily).map(([date, v]) => ({
      date,
      temp_min: Math.min(...v.temps).toFixed(0),
      temp_max: Math.max(...v.temps).toFixed(0),
      condition: Object.keys(v.conditions).reduce((a,b)=> v.conditions[a] > v.conditions[b] ? a : b)
    }));
    return { forecast };
  } catch (e) {
    console.error("weather error", e.message);
    return { error: "Could not fetch weather." };
  }
}
async function tool_findNearbyPlaces({ categories, radius = 5000, limit = 10 }) {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  if (!GEOAPIFY_API_KEY || !latLon) return { error: "Geo API not configured" };
  const [lat, lon] = latLon.split(',').map(s => s.trim());
  try {
    const params = {
      categories,
      filter: `circle:${lon},${lat},${radius}`,
      bias: `proximity:${lon},${lat}`,
      limit,
      apiKey: GEOAPIFY_API_KEY
    };
    const { data } = await axios.get('https://api.geoapify.com/v2/places', { params, timeout: 8000 });
    const places = (data.features || []).map(f => ({
      name: f.properties.name,
      category: f.properties.categories?.[0],
      distance_m: f.properties.distance
    }));
    return { places };
  } catch (e) {
    console.error("places error", e.message);
    return { error: "Could not fetch places." };
  }
}
async function tool_getRouteInfo({ origin }) {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  if (!GEOAPIFY_API_KEY || !latLon) return { error: "Route API not configured" };

  const [destLat, destLon] = latLon.split(',').map(s => parseFloat(s.trim()));
  try {
    const geocodeUrl = 'https://api.geoapify.com/v1/geocode/search';
    const geo = await axios.get(geocodeUrl, { params: { text: origin, limit: 1, apiKey: GEOAPIFY_API_KEY }, timeout: 8000 });
    const feat = geo.data?.features?.[0];
    if (!feat) return { error: `Could not find location: ${origin}` };
    const [originLon, originLat] = feat.geometry.coordinates;

    const routes = await getRouteInfo(originLat, originLon, destLat, destLon);
    if (!routes) return { error: "Could not calculate routes" };
    return { origin, destination: "Roameo Resorts", ...routes, maps_link: MAPS_LINK };
  } catch (e) {
    console.error('Route info error', e?.response?.data || e.message);
    return { error: "Could not fetch route information" };
  }
}

// Monkey-patch brain tool exports so brain.askBrain() tool calls work
require('./lib/brain').getWeatherForecast = tool_getWeatherForecast;
require('./lib/brain').findNearbyPlaces   = tool_findNearbyPlaces;
require('./lib/brain').getRouteInfo       = tool_getRouteInfo;

/* =========================
   START
   ========================= */
app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
