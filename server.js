// server.js — Roameo Resorts omni-channel bot (v12)
// IG post shares in DMs: detect *all* share-type attachments, unwrap links, deep-scan payloads,
// brand-hint when no permalink, proxy thumbnail to Vision, always acknowledge share.

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');
const URL = require('url').URL;

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
const RESORT_COORDS       = (process.env.RESORT_COORDS || '').trim();
const RESORT_LOCATION_NAME= process.env.RESORT_LOCATION_NAME || 'Roameo Resorts, Tehjian (Neelum)';

const AUTO_REPLY_ENABLED       = String(process.env.AUTO_REPLY_ENABLED       || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY   = String(process.env.ALLOW_REPLY_IN_STANDBY   || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const BRAND_USERNAME   = (process.env.BRAND_USERNAME || 'roameoresorts').toLowerCase();
const BRAND_PAGE_NAME  = (process.env.BRAND_PAGE_NAME || 'Roameo Resorts').toLowerCase();

const WHATSAPP_LINK   = process.env.ROAMEO_WHATSAPP_LINK || 'https://wa.me/923558000078';
const SITE_URL        = process.env.ROAMEO_WEBSITE_LINK  || 'https://www.roameoresorts.com/';
const SITE_SHORT      = SITE_URL.replace(/^https?:\/\//,'').replace(/\/$/,'');
const MAPS_LINK       = process.env.ROAMEO_MAPS_LINK     || 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

const MAX_OUT_CHAR = 800;
const PRICES_TXT = String(process.env.ROAMEO_PRICES_TEXT || "").replaceAll("\\n","\n");

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}

/* =========================
   CACHES & MIDDLEWARE
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe      = new LRUCache({ max: 8000, ttl: 1000 * 60 * 60 * 24 * 30 });
const tinyCache   = new LRUCache({ max: 1200, ttl: 1000 * 60 * 30 });
const chatHistory = new LRUCache({ max: 4000, ttl: 1000 * 60 * 60 * 24 * 30 });

/* =========================
   BASIC + VERIFY
   ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));
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
   UTILS
   ========================= */
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
function isPricingIntent(text = '') {
  const t = normalize(text);
  if (t.length <= 2) return false;
  const kw = ['price','prices','pricing','rate','rates','tariff','cost','rent','rental','per night','night price','kiraya','qeemat','kimat','keemat','قیمت','کرایہ','ریٹ','نرخ'];
  if (kw.some(x => t.includes(x))) return true;
  if (/\b\d+\s*(night|nights|din|raat|day|days)\b/.test(t)) return true;
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
async function sendText(psid, text) {
  const url = 'https://graph.facebook.com/v19.0/me/messages';
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: 'RESPONSE', message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
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
   IMAGE PROXY (Vision-friendly)
   ========================= */
function cleanIncomingUrl(u = '') {
  let s = String(u || '').trim();
  s = s.replace(/[.)"'?,]+$/g, '');
  return s;
}
function isSafeRemote(u) {
  try { const url = new URL(u); return ['http:', 'https:'].includes(url.protocol); } catch { return false; }
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

    const resp = await axios.get(target, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
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
function toVisionableUrl(imageUrl, req) {
  if (!imageUrl) return null;
  const cleaned = cleanIncomingUrl(imageUrl);
  try {
    const u = new URL(cleaned);
    const host = (req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${PORT}`).toString();
    const proto = (req?.headers?.['x-forwarded-proto'] || req?.protocol || 'http').toString();
    return `${proto}://${host}/img?u=${encodeURIComponent(u.toString())}`;
  } catch { return null; }
}

/* =========================
   ROUTING HELPERS
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
      out.push({ mode, distance: ft.distance, time: ft.time, distance_km: Number(km(ft.distance)), duration_formatted: hhmm(ft.time) });
    } catch (e) {
      const msg = e?.response?.data?.message || e?.message || '';
      if (!String(msg).includes('Too long distance')) console.error(`routing ${mode} error`, e?.response?.data || e.message);
    }
  }
  return out;
}
async function getRouteInfo(originLat, originLon, destLat, destLon) {
  if (!GEOAPIFY_API_KEY) return null;
  const key = `route:${originLat},${originLon}->${destLat},${destLon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);

  const approxKm = (() => {
    try {
      const R = 6371, toRad = d => d * Math.PI / 180;
      const dLat = toRad(destLat - originLat), dLon = toRad(destLon - originLon);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(originLat))*Math.cos(toRad(destLat))*Math.sin(dLon/2)**2;
      return 2*R*Math.asin(Math.sqrt(a));
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
   RATE CALC (PKR)
   ========================= */
function toNumberPKR(str) {
  return Number(String(str).replace(/[^\d]/g, '')) || 0;
}
function parsePriceCard(card) {
  const lines = (card || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const huts = {};
  let current = null;

  for (const line of lines) {
    const header = line.match(/^(Deluxe|Executive)\s*Hut.*?PKR\s*([\d,]+)/i);
    if (header) {
      const key = header[1].toLowerCase();
      huts[key] = huts[key] || {};
      huts[key].base = toNumberPKR(header[2]);
      current = key;
      continue;
    }
    if (current) {
      const m1 = line.match(/1st\s*Night.*?PKR\s*([\d,]+)/i);
      const m2 = line.match(/2nd\s*Night.*?PKR\s*([\d,]+)/i);
      const m3 = line.match(/3rd\s*Night.*?PKR\s*([\d,]+)/i);
      if (m1) huts[current].n1 = toNumberPKR(m1[1]);
      if (m2) huts[current].n2 = toNumberPKR(m2[1]);
      if (m3) huts[current].n3 = toNumberPKR(m3[1]);
    }
  }
  return huts;
}
function formatPKR(n) { return 'PKR ' + n.toLocaleString('en-PK'); }
function computeTotal(hutInfo, nights) {
  const n = Math.max(1, Number(nights) || 1);
  const n1 = hutInfo.n1 || hutInfo.base || 0;
  const n2 = hutInfo.n2 || hutInfo.base || n1;
  const n3 = hutInfo.n3 || hutInfo.base || n2;
  if (n === 1) return { total: n1, breakdown: [n1] };
  if (n === 2) return { total: n1 + n2, breakdown: [n1, n2] };
  const extraNights = Math.max(0, n - 2);
  const total = n1 + n2 + extraNights * n3;
  const breakdown = [n1, n2, ...Array(extraNights).fill(n3)];
  return { total, breakdown };
}
function buildCalcMessage(hutName, result) {
  return `• ${hutName}: ${result.breakdown.map(v => formatPKR(v)).join(' + ')} = **${formatPKR(result.total)}**`;
}

/* =========================
   WIRE BRAIN TOOLS
   ========================= */
const brain = require('./lib/brain');

brain.getWeatherForecast = async function() {
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
  } catch (e) { return { error: "Could not fetch weather." }; }
};

brain.findNearbyPlaces = async function({ categories, radius = 5000, limit = 10 }) {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  if (!GEOAPIFY_API_KEY || !latLon) return { error: "Geo API not configured" };
  const [lat, lon] = latLon.split(',').map(s => s.trim());
  try {
    const params = { categories, filter: `circle:${lon},${lat},${radius}`, bias: `proximity:${lon},${lat}`, limit, apiKey: GEOAPIFY_API_KEY };
    const { data } = await axios.get('https://api.geoapify.com/v2/places', { params, timeout: 8000 });
    const places = (data.features || []).map(f => ({ name: f.properties.name, category: f.properties.categories?.[0], distance_m: f.properties.distance }));
    return { places };
  } catch (e) { return { error: "Could not fetch places." }; }
};

brain.getRouteInfo = async function({ origin }) {
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
  } catch (e) { return { error: "Could not fetch route information" }; }
};

brain.calculateRates = async function({ nights, days, hut }) {
  const huts = parsePriceCard(PRICES_TXT);
  const n = Number(nights || days) || 1;
  const safeN = Math.max(1, Math.floor(n));

  const want = (hut || 'both').toLowerCase();
  const blocks = [];

  if (want === 'deluxe' || want === 'both') {
    if (huts.deluxe) {
      const r = computeTotal(huts.deluxe, safeN);
      blocks.push(buildCalcMessage('Deluxe Hut', r));
    }
  }
  if (want === 'executive' || want === 'both') {
    if (huts.executive) {
      const r = computeTotal(huts.executive, safeN);
      blocks.push(buildCalcMessage('Executive Hut', r));
    }
  }

  if (!blocks.length) return { error: "Rate card not found or malformed in environment." };

  const msg = `Estimated total for ${safeN} night${safeN>1?'s':''} (PKR):\n` + blocks.join('\n') +
              `\n\nBreakfast for up to 4 guests is included.\n50% advance reserves your booking.`;

  return { text: msg, nights: safeN };
};

/* =========================
   PUBLIC PRICE-SCRUB
   ========================= */
function stripPricesFromPublic(text = '') {
  const lines = (text || '').split(/\r?\n/).filter(Boolean).filter(l => {
    const s = l.toLowerCase();
    const hasCurrency = /(?:pkr|rs\.?|rupees|price|prices|pricing|rate|rates|tariff|per\s*night|rent|rental|kiraya|قیمت|کرایہ|ریٹ|نرخ)/i.test(s);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(s);
    return !(hasCurrency || hasMoneyish);
  });
  return lines.join(' ');
}

/* =========================
   POST UNFURLING HELPERS
   ========================= */
const POST_URL_RX = /(https?:\/\/(?:www\.)?(?:instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+|facebook\.com\/[^\/]+\/posts\/[0-9]+|fb\.watch\/[A-Za-z0-9_-]+))/i;

function unwrapRedirect(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();
    if (host.endsWith('l.facebook.com') || host.endsWith('lm.facebook.com')) {
      const real = url.searchParams.get('u') || url.searchParams.get('l');
      if (real) return decodeURIComponent(real);
    }
    return u;
  } catch { return u; }
}
function looksLikePostUrl(u) {
  return POST_URL_RX.test(u || '');
}
function collectUrlsFromObject(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) out.add(unwrapRedirect(v));
    else if (typeof v === 'object') collectUrlsFromObject(v, out);
  }
  return out;
}
function extractPostUrls(text='') {
  const out = [];
  const rxg = new RegExp(POST_URL_RX.source, 'ig');
  let m;
  while ((m = rxg.exec(text || '')) !== null) out.push(unwrapRedirect(m[1]));
  return [...new Set(out)];
}
async function fetchOEmbed(url) {
  try {
    const u = new URL(url);
    const token = IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;
    const base = 'https://graph.facebook.com/v19.0';
    if (/instagram\.com/i.test(u.hostname)) {
      const { data } = await axios.get(`${base}/instagram_oembed`, { params: { url, omitscript: true, access_token: token }, timeout: 9000 });
      return { source: 'ig', ...data };
    } else {
      const { data } = await axios.get(`${base}/oembed_post`, { params: { url, omitscript: true, access_token: token }, timeout: 9000 });
      return { source: 'fb', ...data };
    }
  } catch (e) {
    console.error('oEmbed error', e?.response?.data || e.message);
    return null;
  }
}
function isFromBrand(metaOrText) {
  if (!metaOrText) return false;
  if (typeof metaOrText === 'string') {
    const s = metaOrText.toLowerCase();
    return s.includes(BRAND_PAGE_NAME) || s.includes(`/${BRAND_USERNAME}`) || s.includes(BRAND_USERNAME);
  }
  const meta = metaOrText;
  const aName = (meta.author_name || '').toLowerCase();
  const aUrl  = (meta.author_url  || '').toLowerCase();
  return aName.includes(BRAND_PAGE_NAME) || aUrl.includes(`/${BRAND_USERNAME}`);
}
function extractSharedPostDataFromAttachments(event) {
   const atts = event?.message?.attachments || [];
  const urls = new Set();
  let thumb = null;
  let isShare = false;
  let brandHint = false;
  const captions = [];

  // helper: gather all URLs & strings from nested payloads
  function collect(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) continue;

        // URLs
        if (/^https?:\/\//i.test(s)) {
          const u = unwrapRedirect(s);
          if (looksLikePostUrl(u)) urls.add(u);
        }

        // captions / brand hints
        if (['title','name','label','caption','description','subtitle','author','byline','text'].includes(k) && s) {
          captions.push(s);
          if (isFromBrand(s)) brandHint = true;
        }

        // thumbnail-ish direct values sometimes sit under these keys as strings
        if (!thumb && ['image_url','thumbnail_url','preview_url','picture','og_image','media_url','image'].includes(k) && /^https?:\/\//i.test(s)) {
          thumb = s;
        }
      } else if (typeof v === 'object') {
        collect(v);
      }
    }
  }

  for (const a of atts) {
    // Any non-image attachment is likely a share/fallback/template
    if (a?.type && a.type !== 'image') isShare = true;

    // Top-level direct URL
    if (a?.url && looksLikePostUrl(a.url)) urls.add(unwrapRedirect(a.url));

    // Payload deep-scan
    if (a?.payload) collect(a.payload);
  }

  return {
    urls: [...urls],
    thumb,
    isShare,
    brandHint,
    captions: captions.filter(Boolean).join(' • ')
  };
}

/* =========================
   DM HANDLER
   ========================= */
function extractNightsAndHut(text='') {
  const t = normalize(text);
  let nights = null;
  const m = t.match(/(\d+)\s*(night|nights|din|raat|day|days)\b/i);
  if (m) nights = parseInt(m[1], 10);

  let hut = 'both';
  if (/deluxe/i.test(text)) hut = 'deluxe';
  else if (/executive/i.test(text)) hut = 'executive';

  return { nights, hut };
}

async function handleTextMessage(psid, text, rawImageUrl, ctx = { req: null, shareUrls: [], shareThumb: null, isShare: false, brandHint: false, captions: '' }) {
  if (!AUTO_REPLY_ENABLED) return;

  const imageUrl = rawImageUrl ? toVisionableUrl(rawImageUrl, ctx.req) : null;

  // Combine URLs from text + attachments
  const textUrls = extractPostUrls(text || '');
  const combinedUrls = [...new Set([...(ctx.shareUrls || []), ...textUrls])];

  // (A) Post shares present? Unfurl & answer if from our brand
if (combinedUrls.length) {
  let handled = false;

  for (const url of combinedUrls) {
    const meta = await fetchOEmbed(url);
    if (meta && isFromBrand(meta)) {
      const caption = (meta.title || '').trim();
      const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
      const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;

      const postNote = [
        'postMeta:',
        `source: ${meta.source}`,
        `author_name: ${meta.author_name || ''}`,
        `author_url: ${meta.author_url || ''}`,
        `permalink: ${url}`,
        `caption: ${caption}`
      ].join('\n');

      const history = chatHistory.get(psid) || [];
      const surface = 'dm';

      const response = await askBrain({
        text: `${text || ''}\n\n${postNote}`,
        imageUrl: thumb,
        surface,
        history
      });

      const { message } = response;
      const newHistory = [
        ...history,
        constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface }),
        { role: 'assistant', content: message }
      ].slice(-20);

      chatHistory.set(psid, newHistory);
      await sendBatched(psid, message);
      handled = true;
      break;
    }
  }

  // 🔁 NEW: brand-hint fallback when URLs exist but oEmbed fails / no brand meta returned
  if (!handled && (ctx.brandHint || ctx.isShare) && (ctx.shareThumb || imageUrl)) {
    const thumb = toVisionableUrl(ctx.shareThumb || imageUrl, ctx.req);
    const postNote = [
      'postMeta:',
      `source: ig`,
      `author_name: Roameo Resorts`,
      `author_url: https://www.instagram.com/${BRAND_USERNAME}/`,
      `permalink: `,
      `caption: ${ctx.captions || ''}`
    ].join('\n');

    const history = chatHistory.get(psid) || [];
    const surface = 'dm';

    const response = await askBrain({
      text: `${text || ''}\n\n${postNote}`,
      imageUrl: thumb,
      surface,
      history
    });

    const { message } = response;
    const newHistory = [
      ...history,
      constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface }),
      { role: 'assistant', content: message }
    ].slice(-20);

    chatHistory.set(psid, newHistory);
    return sendBatched(psid, message);
  }

  // Final fallback: acknowledge politely
  const lang = detectLanguage(text || '');
  const reply = lang === 'ur'
    ? 'آپ نے پوسٹ شیئر کی ہے۔ بہتر رہنمائی کے لیے براہِ کرم اس کا اسکرین شاٹ بھیج دیں۔'
    : lang === 'roman-ur'
      ? 'Aap ne post share ki hai. Behtar rehnumai ke liye screenshot bhej dein.'
      : 'Thanks for sharing the post! Please send a screenshot so I can help with the details.';
  return sendBatched(psid, `${reply}\n\nWhatsApp: ${WHATSAPP_LINK}`);
}

  // (A2) No URLs, but an IG share attachment detected with brand hints + thumbnail
  if ((ctx.isShare || ctx.brandHint) && (ctx.shareThumb || imageUrl)) {
    const thumb = toVisionableUrl(ctx.shareThumb || imageUrl, ctx.req);
    const postNote = [
      'postMeta:',
      `source: ig`,
      `author_name: Roameo Resorts`,
      `author_url: https://www.instagram.com/${BRAND_USERNAME}/`,
      `permalink: `,
      `caption: ${ctx.captions || ''}`
    ].join('\n');

    const history = chatHistory.get(psid) || [];
    const surface = 'dm';

    const response = await askBrain({
      text: `${text || ''}\n\n${postNote}`,
      imageUrl: thumb,
      surface,
      history
    });

    const { message } = response;
    const newHistory = [
      ...history,
      constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface }),
      { role: 'assistant', content: message }
    ].slice(-20);

    chatHistory.set(psid, newHistory);
    return sendBatched(psid, message);
  }

  // (A3) Pure share with no detectable media: at least acknowledge
  if (ctx.isShare && !text && !imageUrl) {
    const lang = detectLanguage('');
    const reply = lang === 'ur'
      ? 'آپ نے پوسٹ شیئر کی ہے۔ براہِ کرم اپنا سوال لکھ دیں یا اسکرین شاٹ شیئر کریں۔'
      : lang === 'roman-ur'
        ? 'Aap ne post share ki hai. Bara-e-mehrbani apna sawal likh dein ya screenshot share karein.'
        : 'I see you shared a post. Please type your question or share a screenshot so I can help.';
    return sendBatched(psid, `${reply}\n\nWhatsApp: ${WHATSAPP_LINK}`);
  }

  // (B) If it's clearly a pricing + nights question, use calculator
  if (isPricingIntent(text || '')) {
    const { nights, hut } = extractNightsAndHut(text || '');
    if (nights) {
      const calc = await brain.calculateRates({ nights, hut });
      if (!calc.error) {
        const reply = `${calc.text}\n\nNeed help booking? WhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}\n\nFull rate card:\n${PRICES_TXT}`;
        return sendBatched(psid, reply);
      }
    }
  }

  // (C) Normal flow to brain
  const history = chatHistory.get(psid) || [];
  const surface = 'dm';
  const response = await askBrain({ text, imageUrl, surface, history });
  const { message } = response;

  const newHistory = [
    ...history,
    constructUserMessage({ text, imageUrl, surface }),
    { role: 'assistant', content: message }
  ].slice(-20);
  chatHistory.set(psid, newHistory);

  return sendBatched(psid, message);
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
          for (const ev of entry.messaging) await routeMessengerEvent(ev, { source: 'messaging', req }).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routePageChange(change).catch(logErr);
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
   FB DM + IG DM / COMMENTS
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging', req: null }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) await takeThreadControl(event.sender.id).catch(() => {});

    const text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url || null;

    // Detect shared posts from attachments
    const { urls: shareUrls, thumb: shareThumb, isShare, brandHint, captions } = extractSharedPostDataFromAttachments(event);

    if (!text && !imageUrl && !(isShare || shareUrls.length)) return;

    return handleTextMessage(event.sender.id, text, imageUrl, { req: ctx.req, shareUrls, shareThumb, isShare, brandHint, captions });
  }

  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', null, { req: ctx.req });
  }
}

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
      const dm = await askBrain({ text, surface: 'comment' });
      await replyToFacebookComment(v.comment_id, stripPricesFromPublic(dm.message));
    }
  }
}

async function routeInstagramMessage(event, ctx = { req: null }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
  if (process.env.IG_DEBUG_LOG === 'true' && event.message?.attachments) {
    console.log('[IG DM attachments]', JSON.stringify(event.message.attachments, null, 2));
  }
     
    const text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url || null;

    // Detect shared posts from attachments
    const { urls: shareUrls, thumb: shareThumb, isShare, brandHint, captions } = extractSharedPostDataFromAttachments(event);

    // IMPORTANT: do not drop just because there is no text/image/urls — acknowledge shares
    if (!text && !imageUrl && !(isShare || shareUrls.length)) return;

    return handleTextMessage(igUserId, text, imageUrl, { req: ctx.req, shareUrls, shareThumb, isShare, brandHint, captions });
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
      const dm = await askBrain({ text, surface: 'comment' });
      await replyToInstagramComment(commentId, stripPricesFromPublic(dm.message));
    }
  }
}

/* =========================
   HANDOVER & ADMIN
   ========================= */
async function takeThreadControl(psid) {
  const url = `https://graph.facebook.com/v19.0/me/take_thread_control`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  try { await axios.post(url, { recipient: { id: psid } }, { params, timeout: 10000 }); }
  catch (e) { console.error('take_thread_control error:', e?.response?.data || e.message); }
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
  } catch (e) { res.status(500).json({ ok: false, error: e?.response?.data || e.message }); }
});
app.get('/admin/status', requireAdmin, async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN, fields: 'subscribed_fields' };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    res.json({
      ok: true,
      subscribed_apps: data,
      env: { RESORT_COORDS, LINKS: { maps: MAPS_LINK, site: SITE_URL, whatsapp: WHATSAPP_LINK } }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e?.response?.data || e.message }); }
});

/* =========================
   START
   ========================= */
app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
