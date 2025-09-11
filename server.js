// server.js — Roameo Resorts omni-channel bot (v11 → caption-to-summary for IG shares + convo memory on summary + travel-cost intent + image-proxy for uploads)

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');

const { askBrain, constructUserMessage } = require('./lib/brain');

const app = express();
const PORT = process.env.PORT || 10000;

app.set('trust proxy', true);

/* =========================
   ENV & CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

const GEOAPIFY_API_KEY   = process.env.GEOAPIFY_API_KEY   || '';
const OPENWEATHER_API_KEY= process.env.OPENWEATHER_API_KEY|| '';
const RESORT_COORDS      = (process.env.RESORT_COORDS || '').trim();
const RESORT_LOCATION_NAME = process.env.RESORT_LOCATION_NAME || 'Roameo Resorts, Tehjian (Neelum)';

const IG_USER_ID = process.env.IG_USER_ID || '';
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

const IG_DEBUG_LOG = String(process.env.IG_DEBUG_LOG || 'false').toLowerCase() === 'true';
const SEND_IMAGE_FOR_IG_SHARES = String(process.env.SEND_IMAGE_FOR_IG_SHARES || 'false').toLowerCase() === 'true';
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';

const AUTO_REPLY_ENABLED       = String(process.env.AUTO_REPLY_ENABLED       || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY   = String(process.env.ALLOW_REPLY_IN_STANDBY   || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const BRAND_USERNAME  = (process.env.BRAND_USERNAME  || 'roameoresorts').toLowerCase();
const BRAND_PAGE_NAME = (process.env.BRAND_PAGE_NAME || 'Roameo Resorts').toLowerCase();

const WHATSAPP_LINK   = process.env.ROAMEO_WHATSAPP_LINK || 'https://wa.me/923558000078';
const SITE_URL        = process.env.ROAMEO_WEBSITE_LINK  || 'https://www.roameoresorts.com/';
const SITE_SHORT      = SITE_URL.replace(/^https?:\/\//,'').replace(/\/$/,'');
const MAPS_LINK       = process.env.ROAMEO_MAPS_LINK || 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const CHECKIN_TIME  = process.env.CHECKIN_TIME  || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

const MAX_OUT_CHAR = 800;

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!IG_USER_ID) {
  console.warn('⚠️ IG_USER_ID not set — IG share recognition via asset_id will be disabled.');
}

/* =========================
   BASIC FACTS
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
const dedupe      = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });
const tinyCache   = new LRUCache({ max: 300,  ttl: 1000 * 60 * 15 });
const chatHistory = new LRUCache({ max: 2000, ttl: 1000 * 60 * 60 * 24 * 30 });

/* =========================
   BASIC ROUTES
   ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));

/* Image proxy (always HTTPS) */
app.get('/img', async (req, res) => {
  const remote = req.query.u;
  if (!remote) return res.status(400).send('missing u');
  try {
    const headers = {
      Referer: 'https://www.instagram.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const resp = await axios.get(remote, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers,
      maxRedirects: 3,
      validateStatus: s => s >= 200 && s < 400
    });
    const ct = resp.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(Buffer.from(resp.data, 'binary'));
  } catch (e) {
    console.error('img proxy error', e?.response?.status, e?.message);
    res.status(422).send('fetch error');
  }
});

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
   HELPERS
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
    const hasCurrency = /(?:pkr|rs\.?|rupees|₨|price|prices|pricing|rate|rates|tariff|per\s*night|rent|rental|kiraya|قیمت|کرایہ|ریٹ|نرخ)/i.test(s);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(s);
    return !(hasCurrency || hasMoneyish);
  });
  return lines.join(' ');
}
function isPricingIntent(text = '') {
  const t = normalize(text);
  if (t.length <= 2) return false;
  const kw = ['price','prices','pricing','rate','rates','tariff','cost','rent','rental','per night','night price','kiraya','qeemat','kimat','keemat','قیمت','کرایہ','ریٹ','نرخ'];
  if (kw.some(x => t.includes(x))) return true;
  if (/\b\d+\s*(night|nights|din|raat)\b/.test(t)) return true;
  if (/\bhow much\b/.test(t)) return true;
  return false;
}

/* --- NEW: travel cost intent separated from pricing --- */
function isTravelCostIntent(text = '') {
  const t = normalize(text);
  const a = /\b(travel|transport|transportation|bus|coach|hiace|coaster|jeep|car|taxi|uber|cab|fuel|petrol|diesel|fare|kiraya)\b.*\b(cost|price|prices|fare|rate|rates)\b/.test(t);
  const b = /\b(cost|price|prices|fare|rate|rates)\b.*\b(travel|transport|transportation|bus|coach|hiace|coaster|jeep|car|taxi|uber|cab|fuel|petrol|diesel|fare|kiraya)\b/.test(t);
  const c = /\btravel(?:ing)?\s+costs?\b/.test(t);
  const d = /\bfare\b/.test(t);
  const e = /\bkharcha\b/.test(t);
  return a || b || c || d || e;
}
function travelCostMessage(userText = '') {
  const lang = detectLanguage(userText);
  if (lang === 'ur') {
    return sanitizeVoice(
`سفر/ٹرانسپورٹ کا خرچہ ہمارے پیکج میں شامل نہیں ہوتا، اس لئے ہم اس کی قیمت نہیں بتاتے۔ زیادہ تر مہمان اپنی گاڑی سے آتے ہیں یا مقامی ٹرانسپورٹ لیتے ہیں۔ ہم راستہ اور فاصلہ بتا سکتے ہیں، مگر کرایہ/فیول الگ ہوگا۔

لوکیشن: ${MAPS_LINK}
راستہ معلوم کرنا ہو تو یوں لکھیں: "route from Lahore"

WhatsApp: ${WHATSAPP_LINK}
Website: ${SITE_SHORT}`
    );
  } else if (lang === 'roman-ur') {
    return sanitizeVoice(
`Travel/transport ka kharcha package mein shamil nahi hota, is liye hum uska rate nahi batate. Aksar mehmaan apni car se aate hain ya local transport lete hain. Hum rasta aur distance batadein ge, magar kiraya/fuel alag hoga.

Location: ${MAPS_LINK}
Route chahiye to aise likhein: "route from Lahore"

WhatsApp: ${WHATSAPP_LINK}
Website: ${SITE_SHORT}`
    );
  }
  return sanitizeVoice(
`Travel/transport costs aren’t included in our stay packages, so we don’t quote them. Most guests either drive themselves or use local transport. We can share directions and distance, but fares/fuel are separate.

Location: ${MAPS_LINK}
If you’d like directions, just send: "route from Lahore"

WhatsApp: ${WHATSAPP_LINK}
Website: ${SITE_SHORT}`
  );
}

/* helper used for batching */
function splitToChunks(s, limit = MAX_OUT_CHAR) {
  const out = [];
  let str = (s || '').trim();
  while (str.length > limit) {
    let cut = Math.max(str.lastIndexOf('\n', limit), str.lastIndexOf('. ', limit), str.lastIndexOf('•', limit), str.lastIndexOf('—', limit), str.lastIndexOf('!', limit), str.lastIndexOf('?', limit));
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
function toVisionableUrl(remoteUrl, req) {
  if (!remoteUrl) return null;
  const host = (req?.get && req.get('host')) || PUBLIC_HOST || 'facebook-webhook-server.onrender.com';
  const origin = `https://${host}`;
  return `${origin}/img?u=${encodeURIComponent(remoteUrl)}`;
}
function extractPostUrls(text='') {
  if (!text) return [];
  const rx = /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_\-]+)/ig;
  const out = [];
  let m; while ((m = rx.exec(text))) out.push(m[1]);
  return [...new Set(out)];
}

/* =========================
   IG Graph / OEmbed helpers
   ========================= */
async function fetchOEmbed(url) {
  try {
    const token = IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;
    const { data } = await axios.get('https://graph.facebook.com/v19.0/instagram_oembed', {
      params: { url, access_token: token, omitscript: true, hidecaption: false },
      timeout: 8000
    });
    return data; // { author_name, author_url, title, thumbnail_url, ... }
  } catch (e) {
    if (IG_DEBUG_LOG) console.log('oEmbed error', e?.response?.data || e.message);
    return null;
  }
}
function isFromBrand(metaOrString) {
  const s = (typeof metaOrString === 'string') ? metaOrString.toLowerCase() : `${metaOrString?.author_name || ''} ${metaOrString?.author_url || ''}`.toLowerCase();
  return s.includes(BRAND_USERNAME) || s.includes(BRAND_PAGE_NAME);
}

/* =========================
   IG brand lookup via asset_id (with carousel child support)
   ========================= */
async function igFetchRecentMediaMap(force = false) {
  const cacheKey = 'ig:recentMediaMapV2';
  if (!force) {
    const cached = tinyCache.get(cacheKey);
    if (cached) return cached;
  }
  if (!IG_USER_ID) return null;

  const token = IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;
  try {
    const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
    const params = {
      access_token: token,
      fields: 'id,permalink,caption,media_type,media_url,thumbnail_url,timestamp',
      limit: 100
    };
    const { data } = await axios.get(url, { params, timeout: 10000 });

    const map = {};
    const parents = data?.data || [];

    for (const m of parents) {
      const parentMeta = {
        id: m.id,
        permalink: m.permalink,
        caption: m.caption || '',
        media_type: m.media_type,
        media_url: m.media_url || m.thumbnail_url || '',
        thumbnail_url: m.thumbnail_url || m.media_url || ''
      };
      map[m.id] = parentMeta;

      if (m.media_type === 'CAROUSEL_ALBUM') {
        try {
          const { data: chResp } = await axios.get(`https://graph.facebook.com/v19.0/${m.id}/children`, {
            params: { access_token: token, fields: 'id,media_type,media_url,thumbnail_url' },
            timeout: 10000
          });
          for (const c of (chResp?.data || [])) {
            map[c.id] = {
              id: c.id,
              parent_id: m.id,
              permalink: m.permalink,
              caption: m.caption || '',
              media_type: c.media_type,
              media_url: c.media_url || c.thumbnail_url || '',
              thumbnail_url: c.thumbnail_url || c.media_url || ''
            };
          }
        } catch (e) {
          if (IG_DEBUG_LOG) console.log('ig children fetch error', e?.response?.data || e.message);
        }
      }
    }

    tinyCache.set(cacheKey, map, { ttl: 1000 * 60 * 10 });
    return map;
  } catch (e) {
    console.error('igFetchRecentMediaMap error', e?.response?.data || e.message);
    return null;
  }
}

async function igFetchMediaById(assetId) {
  const token = IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;
  if (!assetId || !token) return null;
  try {
    const url = `https://graph.facebook.com/v19.0/${assetId}`;
    const params = { access_token: token, fields: 'id,media_type,media_url,thumbnail_url' };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    return {
      id: data.id,
      permalink: '',
      caption: '',
      media_type: data.media_type,
      media_url: data.media_url || data.thumbnail_url || '',
      thumbnail_url: data.thumbnail_url || data.media_url || ''
    };
  } catch (e) {
    if (IG_DEBUG_LOG) console.log('igFetchMediaById error', e?.response?.data || e.message);
    return null;
  }
}

async function igLookupPostByAssetId(assetId) {
  if (!assetId) return { isBrand: false, post: null };
  let map = await igFetchRecentMediaMap();
  if (map && map[assetId]) return { isBrand: true, post: map[assetId] };
  map = await igFetchRecentMediaMap(true);
  if (map && map[assetId]) return { isBrand: true, post: map[assetId] };
  const direct = await igFetchMediaById(assetId);
  if (direct) return { isBrand: true, post: direct };
  return { isBrand: false, post: null };
}

/* =========================
   ENRICHMENT — route/drive-time
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
async function getRouteInfo(originLat, originLon, destLat, destLon) {
  if (!GEOAPIFY_API_KEY) return null;
  const key = `route:${originLat},${originLon}->${destLat},${destLon}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
    const url = 'https://api.geoapify.com/v1/routing';
    const modes = ['drive', 'walk', 'transit'];
    const routePromises = modes.map(async (mode) => {
      try {
        const { data } = await axios.get(url, { params: { waypoints, mode, apiKey: GEOAPIFY_API_KEY, traffic: mode === 'drive' ? 'approximated' : undefined }, timeout: 12000 });
        const ft = data?.features?.[0]?.properties;
        if (!ft) return null;
        return { mode, distance: ft.distance, duration: ft.time, distance_km: Number(km(ft.distance)), duration_formatted: hhmm(ft.time) };
      } catch (e) {
        if (IG_DEBUG_LOG) console.error(`geoapify routing error for ${mode}:`, e?.response?.data || e.message);
        return null;
      }
    });
    const routes = (await Promise.all(routePromises)).filter(Boolean);
    if (!routes.length) return null;
    const result = { routes, primary: routes.find(r => r.mode === 'drive') || routes[0] };
    tinyCache.set(key, result);
    return result;
  } catch (e) { console.error('geoapify routing error', e?.response?.data || e.message); return null; }
}

/* =========================
   INTENTS
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
   NEW: caption → structured summary (no raw paste)
   ========================= */
const RX_PRICE_PER_PERSON = /(rs\.?|pkr|₨)\s*([0-9][0-9,]*)\s*(?:\/?\s*(?:per\s*person|pp|per\s*head))?/i;
const RX_ANY_PRICE        = /(rs\.?|pkr|₨)\s*([0-9][0-9,]*)/i;
const RX_DURATION         = /\b(\d{1,2})\s*(?:din|day|days|night|nights|raat)\b/i;
const RX_GROUP_SIZE       = /\b(\d{1,2})\s*[–-]\s*(\d{1,2})\s*(?:people|persons|guests|pax)\b/i;
const RX_PHONE_PK         = /\b(?:\+?92|0)?3\d{9}\b/;

const INCLUSION_KEYS = [
  'breakfast','complimentary breakfast','free wifi','wifi','bbq','bonfire',
  'parking','jeep','guide','driver','tea','chai','coffee','heater',
  'river','waterfall','mountain','views','balcony','family','2–5 people','2-5 people'
];

function cleanLinesFromCaption(caption = '') {
  const raw = (caption || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return raw.filter(l => !/^#/.test(l) && !/^https?:\/\//i.test(l));
}

function extractInfoFromCaption(caption = '') {
  const info = {
    title: '',
    pricePerPerson: null,
    anyPrice: null,
    duration: null,
    groupSize: null,
    inclusions: new Set(),
    phone: null,
    keyPoints: []
  };

  const lines = cleanLinesFromCaption(caption);
  if (lines.length) info.title = lines[0].replace(/^[•\-–\*]+/, '').trim();

  const capLower = caption.toLowerCase();

  const mpp = caption.match(RX_PRICE_PER_PERSON);
  if (mpp) info.pricePerPerson = `PKR ${Number(mpp[2].replace(/,/g,'')).toLocaleString()}/person`;
  else {
    const mp = caption.match(RX_ANY_PRICE);
    if (mp) info.anyPrice = `PKR ${Number(mp[2].replace(/,/g,'')).toLocaleString()}`;
  }

  const md = caption.match(RX_DURATION);
  if (md) {
    const n = md[1];
    const unit = md[0].toLowerCase().includes('night') || md[0].toLowerCase().includes('raat')
      ? (Number(n) === 1 ? 'night' : 'nights')
      : (Number(n) === 1 ? 'day' : 'days');
    info.duration = `${n} ${unit}`;
  }

  const mg = caption.match(RX_GROUP_SIZE);
  if (mg) info.groupSize = `${mg[1]}–${mg[2]} people`;

  for (const key of INCLUSION_KEYS) {
    if (capLower.includes(key)) info.inclusions.add(key.replace(/complimentary /i,''));
  }

  const ph = caption.match(RX_PHONE_PK);
  if (ph) info.phone = ph[0];

  const pts = [];
  for (const l of lines.slice(1)) {
    if (pts.length >= 3) break;
    const ll = l.toLowerCase();
    const looksBullet = /[•\-–]|🍽|✨|⭐|👉|✅|📶|🏔|🔥|🧭|🚗|🚌|🏡|🌄|🌿|🍃|📍/.test(l);
    const hasKeyword = INCLUSION_KEYS.some(k => ll.includes(k));
    const isCallLine = /\bcall\b|\bwhatsapp\b/i.test(l);
    if (!isCallLine && (looksBullet || hasKeyword)) pts.push(l);
  }
  info.keyPoints = pts;

  return info;
}

function formatOfferSummary(caption = '', permalink = '') {
  const c = sanitizeVoice(caption || '');
  const info = extractInfoFromCaption(c);

  const out = [];
  out.push('Thanks for sharing the post! Here’s a quick summary of this offer:');

  if (info.title) out.push(`\n• **Package:** ${info.title}`);
  if (info.duration) out.push(`• **Duration:** ${info.duration}`);
  if (info.pricePerPerson) {
    out.push(`• **Price:** ${info.pricePerPerson}`);
  } else if (info.anyPrice) {
    out.push(`• **Price:** ${info.anyPrice}`);
  }
  if (info.groupSize) out.push(`• **Best for:** ${info.groupSize}`);

  if (info.inclusions.size) {
    const inc = Array.from(info.inclusions)
      .map(x => x.replace(/\b(wifi)\b/i,'Wi-Fi'))
      .map(s => s.replace(/\b(bbq)\b/i,'BBQ'))
      .join(', ');
    out.push(`• **Includes:** ${inc}`);
  }

  if (info.keyPoints.length) {
    out.push('\nHighlights:');
    info.keyPoints.forEach(p => out.push(`• ${p}`));
  }

  out.push('\nWant to book or have questions?');
  if (info.phone) out.push(`• Call: ${info.phone}`);
  out.push(`• WhatsApp: ${WHATSAPP_LINK}`);
  out.push(`• Website: ${SITE_SHORT}`);
  if (permalink) out.push(`• Post: ${permalink}`);

  return out.join('\n');
}

/* =========================
   DM HANDLER
   ========================= */
async function handleTextMessage(psid, text, imageUrl, ctx = { req: null, shareUrls: [], shareThumb: null, isShare: false, brandHint: false, captions: '', assetId: null }) {
  if (!AUTO_REPLY_ENABLED) return;

  const textUrls = extractPostUrls(text || '');
  const combinedUrls = [...new Set([...(ctx.shareUrls || []), ...textUrls])];

  const intents = intentFromText(text || '');
  const travelCostIntent = isTravelCostIntent(text || '');

  // contact / location fast-paths
  if (intents.wantsContact) return sendBatched(psid, `WhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
  if (intents.wantsLocation) return sendBatched(psid, `*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);

  // travel-cost overrides pricing conversations
  if (travelCostIntent) return sendBatched(psid, travelCostMessage(text));

  // Route/distance helper
  if (intents.wantsRoute || intents.wantsDistance) {
    const msg = await dmRouteMessage(text);
    return sendBatched(psid, msg);
  }

  // 1) Brand-owned via asset_id
  if (ctx.assetId) {
    const lookup = await igLookupPostByAssetId(ctx.assetId);
    if (lookup && lookup.isBrand && lookup.post) {
      const meta = lookup.post;
      const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
      const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;
      const imgForVision = SEND_IMAGE_FOR_IG_SHARES ? thumb : null;

      if (IG_DEBUG_LOG) console.log('[IG share] sending image to Vision:', imgForVision);

      // travel-cost question after share
      if (travelCostIntent) {
        const reply = travelCostMessage(text);
        // remember context even on non-brain replies
        const postNote = [
          'postMeta:',
          `source: ig`,
          `author_name: Roameo Resorts`,
          `author_url: https://www.instagram.com/${BRAND_USERNAME}/`,
          `permalink: ${meta.permalink || ''}`,
          `caption: ${meta.caption || ''}`
        ].join('\n');
        const history = chatHistory.get(psid) || [];
        const surface = 'dm';
        const newHistory = [...history,
          constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface }),
          { role: 'assistant', content: reply }
        ].slice(-20);
        chatHistory.set(psid, newHistory);
        return sendBatched(psid, reply);
      }

      // If user didn't ask "rates", send structured caption summary and **remember**
      if (!isPricingIntent(text || '')) {
        const reply = formatOfferSummary(meta.caption || ctx.captions || '', meta.permalink || '');
        const postNote = [
          'postMeta:',
          `source: ig`,
          `author_name: Roameo Resorts`,
          `author_url: https://www.instagram.com/${BRAND_USERNAME}/`,
          `permalink: ${meta.permalink || ''}`,
          `caption: ${meta.caption || ''}`
        ].join('\n');
        const history = chatHistory.get(psid) || [];
        const surface = 'dm';
        const newHistory = [...history,
          constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface }),
          { role: 'assistant', content: reply }
        ].slice(-20);
        chatHistory.set(psid, newHistory);
        return sendBatched(psid, reply);
      }

      // Pricing asked → brain
      const postNote = [
        'postMeta:',
        `source: ig`,
        `author_name: Roameo Resorts`,
        `author_url: https://www.instagram.com/${BRAND_USERNAME}/`,
        `permalink: ${meta.permalink || ''}`,
        `caption: ${meta.caption || ''}`
      ].join('\n');

      const history = chatHistory.get(psid) || [];
      const surface = 'dm';
      const response = await askBrain({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface, history });
      const { message } = response;
      const newHistory = [...history, constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface }), { role: 'assistant', content: message }].slice(-20);
      chatHistory.set(psid, newHistory);
      return sendBatched(psid, message);
    }
  }

  // 2) Brand via oEmbed URL
  if (combinedUrls.length) {
    for (const url of combinedUrls) {
      const meta = await fetchOEmbed(url);
      if (meta && isFromBrand(meta)) {
        const caption = (meta.title || '').trim();
        const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
        const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;
        const imgForVision = SEND_IMAGE_FOR_IG_SHARES ? thumb : null;

        if (IG_DEBUG_LOG) console.log('[IG share] sending image to Vision:', imgForVision);

        if (travelCostIntent) {
          const reply = travelCostMessage(text);
          const postNote = [
            'postMeta:',
            `source: ig`,
            `author_name: ${meta.author_name || 'Roameo Resorts'}`,
            `author_url: ${meta.author_url || `https://www.instagram.com/${BRAND_USERNAME}/`}`,
            `permalink: ${url}`,
            `caption: ${caption}`
          ].join('\n');
          const history = chatHistory.get(psid) || [];
          const surface = 'dm';
          const newHistory = [...history,
            constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface }),
            { role: 'assistant', content: reply }
          ].slice(-20);
          chatHistory.set(psid, newHistory);
          return sendBatched(psid, reply);
        }

        if (!isPricingIntent(text || '')) {
          const reply = formatOfferSummary(caption, url);
          const postNote = [
            'postMeta:',
            `source: ig`,
            `author_name: ${meta.author_name || 'Roameo Resorts'}`,
            `author_url: ${meta.author_url || `https://www.instagram.com/${BRAND_USERNAME}/`}`,
            `permalink: ${url}`,
            `caption: ${caption}`
          ].join('\n');
          const history = chatHistory.get(psid) || [];
          const surface = 'dm';
          const newHistory = [...history,
            constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface }),
            { role: 'assistant', content: reply }
          ].slice(-20);
          chatHistory.set(psid, newHistory);
          return sendBatched(psid, reply);
        }

        const postNote = [
          'postMeta:',
          `source: ig`,
          `author_name: ${meta.author_name || 'Roameo Resorts'}`,
          `author_url: ${meta.author_url || `https://www.instagram.com/${BRAND_USERNAME}/`}`,
          `permalink: ${url}`,
          `caption: ${caption}`
        ].join('\n');

        const history = chatHistory.get(psid) || [];
        const surface = 'dm';
        const response = await askBrain({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface, history });
        const { message } = response;
        const newHistory = [...history, constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: imgForVision, surface }), { role: 'assistant', content: message }].slice(-20);
        chatHistory.set(psid, newHistory);
        return sendBatched(psid, message);
      }
    }

    // Not our post
    const lang = detectLanguage(text || '');
    const reply = lang === 'ur'
      ? 'آپ نے جو پوسٹ شیئر کی ہے وہ ہماری نہیں لگتی۔ براہِ کرم اس کا اسکرین شاٹ بھیج دیں تاکہ رہنمائی کر سکیں۔'
      : lang === 'roman-ur'
        ? 'Jo post share ki hai wo hamari nahi lagti. Behtar rehnumai ke liye uska screenshot send karein.'
        : 'It looks like the shared post isn’t from our page. Please send a screenshot and I’ll help with details.';
    return sendBatched(psid, `${reply}\n\nWhatsApp: ${WHATSAPP_LINK}`);
  }

  // 3) Everything else → brain (with history)
  const history = chatHistory.get(psid) || [];
  const surface = 'dm';

  // NEW: proxify user-upload images so Vision can fetch lookaside URLs
  const proxiedImage = imageUrl ? toVisionableUrl(imageUrl, ctx.req) : null;

  const response = await askBrain({ text, imageUrl: proxiedImage, surface, history });
  const { message } = response;
  const newHistory = [...history, constructUserMessage({ text, imageUrl: proxiedImage, surface }), { role: 'assistant', content: message }].slice(-20);
  chatHistory.set(psid, newHistory);
  return sendBatched(psid, message);
}

/* =========================
   FB DM + IG DM / COMMENTS
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging', req: null }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    if (ctx.source === 'standby' && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === 'standby' && AUTO_TAKE_THREAD_CONTROL) await takeThreadControl(event.sender.id).catch(() => {});

    if (IG_DEBUG_LOG && event.message?.attachments) {
      console.log('[FB DM attachments]', JSON.stringify(event.message.attachments, null, 2));
    }

    const text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url || null;

    const { urls: shareUrls, thumb: shareThumb, isShare, brandHint, captions, assetId } = extractSharedPostDataFromAttachments(event);
    if (!text && !imageUrl && !(isShare || shareUrls.length || assetId)) return;

    return handleTextMessage(event.sender.id, text, imageUrl, { req: ctx.req, shareUrls, shareThumb, isShare, brandHint, captions, assetId });
  }

  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, 'help', null, { req: ctx.req });
  }
}

async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message: message.slice(0, MAX_OUT_CHAR) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
function isSelfComment(v = {}, platform = 'facebook') {
  const from = v.from || {};
  if (platform === 'instagram') return from.username && from.username.toLowerCase() === BRAND_USERNAME;
  return (from.name || '').toLowerCase().includes('roameo');
}
async function routePageChange(change) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item === 'comment' && v.comment_id) {
    const text = (v.message || '').trim();
    if (v.verb && v.verb !== 'add') return;
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

    if (IG_DEBUG_LOG && event.message?.attachments) {
      console.log('[IG DM attachments]', JSON.stringify(event.message.attachments, null, 2));
    }

    const text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url || null;

    const { urls: shareUrls, thumb: shareThumb, isShare, brandHint, captions, assetId } = extractSharedPostDataFromAttachments(event);

    if (!text && !imageUrl && !(isShare || shareUrls.length || assetId)) return;

    return handleTextMessage(igUserId, text, imageUrl, { req: ctx.req, shareUrls, shareThumb, isShare, brandHint, captions, assetId });
  }
}

async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message: message.slice(0, MAX_OUT_CHAR) }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
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
   Attachment extractor
   ========================= */
function extractSharedPostDataFromAttachments(event) {
  const atts = event?.message?.attachments || [];
  const urls = new Set();
  let thumb = null;
  let isShare = false;
  let brandHint = false;
  const captions = [];
  let assetId = null;

  function unwrapRedirect(u) {
    try {
      const url = new URL(u);
      const host = url.hostname.toLowerCase();
      if (host.endsWith('l.facebook.com') || host.endsWith('lm.facebook.com') || host.endsWith('l.instagram.com')) {
        const real = url.searchParams.get('u') || url.searchParams.get('l');
        if (real) return decodeURIComponent(real);
      }
      return u;
    } catch { return u; }
  }
  const looksLikePostUrl = (u) => /(https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[A-Za-z0-9_-]+)/i.test(u || '');

  function collect(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) continue;
        if (/^https?:\/\//i.test(s)) {
          const u = unwrapRedirect(s);
          try {
            const uo = new URL(u);
            const host = uo.hostname.toLowerCase();
            if (host.includes('lookaside.fbsbx.com') && uo.pathname.includes('/ig_messaging_cdn/')) {
              if (!thumb) thumb = u;
              const aid = uo.searchParams.get('asset_id');
              if (aid) assetId = aid;
            }
          } catch {}
          if (looksLikePostUrl(u)) urls.add(u);
        }
        if (['title','name','label','caption','description','subtitle','author','byline','text'].includes(k) && s) {
          captions.push(s);
          const low = s.toLowerCase();
          if (low.includes(BRAND_USERNAME) || low.includes(BRAND_PAGE_NAME)) brandHint = true;
        }
        if (!thumb && ['image_url','thumbnail_url','preview_url','picture','media_url','image'].includes(k) && /^https?:\/\//i.test(s)) {
          thumb = s;
        }
      } else if (typeof v === 'object') {
        collect(v);
      }
    }
  }

  for (const a of atts) {
    if (a?.type && a.type !== 'image') isShare = true;

    if (a?.url && /^https?:\/\//i.test(a.url)) {
      const u = unwrapRedirect(a.url);
      try {
        const uo = new URL(u);
        const host = uo.hostname.toLowerCase();
        if (host.includes('lookaside.fbsbx.com') && uo.pathname.includes('/ig_messaging_cdn/')) {
          if (!thumb) thumb = u;
          const aid = uo.searchParams.get('asset_id');
          if (aid) assetId = aid;
        }
      } catch {}
      if (looksLikePostUrl(u)) urls.add(u);
    }
    if (a?.payload) collect(a.payload);
  }

  return { urls: [...urls], thumb, isShare, brandHint, captions: captions.filter(Boolean).join(' • '), assetId };
}

/* =========================
   ROUTING WEBHOOK
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
      env: { IG_USER_ID, RESORT_COORDS, LINKS: { maps: MAPS_LINK, site: SITE_URL, whatsapp: WHATSAPP_LINK } }
    });
  } catch (e) { res.status(500).json({ ok: false, error: e?.response?.data || e.message }); }
});

/* =========================
   START
   ========================= */
app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));

/* =========================
   ROUTE MESSAGE HELPERS
   ========================= */
function extractOrigin(text='') {
  const t = text.trim();
  const rx = [
    /route\s+from\s+(.+)$/i,
    /rasta\s+from\s+(.+)$/i,
    /directions?\s+from\s+(.+)$/i,
    /how\s+to\s+reach\s+from\s+(.+)$/i,
    /how\s+to\s+get\s+there\s+from\s+(.+)$/i,
    /(?:i\s+am\s+)?coming\s+from\s+(.+)$/i,
    /(?:i\s+am\s+)?travelling\s+from\s+(.+)$/i,
    /(?:i\s+am\s+)?traveling\s+from\s+(.+)$/i,
    /from\s+(.+)\s+(?:to|till|for)?\s*(?:roameo|resort|neelum|tehjian|here)?$/i,
    /(.+)\s+(?:se|say)\s+(?:rasta|route|directions?)/i,
    /(.+)\s+to\s+(?:roameo|resort|neelum|tehjian)/i,
    /how\s+far\s+is\s+(.+)\s+(?:from|to)/i,
    /distance\s+from\s+(.+)$/i,
    /how\s+long\s+to\s+reach\s+from\s+(.+)$/i,
    /travel\s+time\s+from\s+(.+)$/i,
    /(.+)\s+سے\s+(?:راستہ|فاصلہ|دور|کتنے|کتنا)/i,
    /(.+)\s+سے\s+(?:کتنے|کتنا)\s+(?:کلومیٹر|گھنٹے)/i,
    /(.+)\s+سے\s+(?:روامو|ریسورٹ)/i,
    /(.+)\s+se\s+(?:rasta|distance|far|kitna|kitne)/i,
    /(.+)\s+se\s+(?:kitna|kitne)\s+(?:km|kilometer|ghante)/i,
    /(.+)\s+se\s+(?:roameo|resort)/i
  ];
  for (const r of rx) {
    const m = t.match(r);
    if (m && m[1]) {
      let origin = m[1].replace(/[.?!]+$/,'').trim();
      origin = origin.replace(/\b(?:the|a|an|from|to|is|are|was|were|will|would|can|could|should|may|might)\b/gi, '').trim();
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

  const additionalInfo = lang === 'ur'
    ? `\n\n💡 ٹپ: گاڑی سے آنا بہترین ہے۔ راستہ خوبصورت ہے!`
    : lang === 'roman-ur'
      ? `\n\n💡 Tip: Car se ana best hai. Rasta khoobsurat hai!`
      : `\n\n💡 Tip: Driving is the best option. The route is beautiful!`;

  return sanitizeVoice(`${response}${additionalInfo}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
}
