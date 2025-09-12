// server.js — Roameo Resorts omni-channel bot (v12  |  9000-campaign + multi-intent + STT + nights quote)

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
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

/* Voice / STT */
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || '';
const ENABLE_VOICE_STT    = String(process.env.ENABLE_VOICE_STT || 'true').toLowerCase() === 'true';
const STT_MODEL           = process.env.STT_MODEL || 'gpt-4o-mini-transcribe'; // whisper-1 works too
const MAX_AUDIO_MB        = Number(process.env.MAX_AUDIO_MB || 20);

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!IG_USER_ID) {
  console.warn('⚠️ IG_USER_ID not set — IG share recognition via asset_id will be disabled.');
}
if (ENABLE_VOICE_STT && !OPENAI_API_KEY) {
  console.warn('⚠️ ENABLE_VOICE_STT is true but OPENAI_API_KEY is missing — voice notes will be ignored.');
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
const dedupe        = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });
const tinyCache     = new LRUCache({ max: 600,  ttl: 1000 * 60 * 15 });
const chatHistory   = new LRUCache({ max: 2000, ttl: 1000 * 60 * 60 * 24 * 30 });
const campaignState = new LRUCache({ max: 3000, ttl: 1000 * 60 * 60 * 24 * 7 });      // per-user sticky campaign
const lastShareMeta = new LRUCache({ max: 3000, ttl: 1000 * 60 * 60 * 24 * 3 });      // remember last brand post seen

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
  const romanUrduTokens = ['aap','ap','apka','apki','apke','kiraya','qeemat','rate','price','btao','batao','kitna','kitni','kitne','raha','hai','hain','kahan','kidhar','map','location'];
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
    const params = {
      access_token: token,
      fields: 'id,caption,permalink,media_type,media_url,thumbnail_url'
    };

    const { data } = await axios.get(url, { params, timeout: 10000 });

    return {
      id: data.id,
      caption: data.caption || '',
      permalink: data.permalink || '',
      media_type: data.media_type,
      media_url: data.media_url || data.thumbnail_url || '',
      thumbnail_url: data.thumbnail_url || data.media_url || ''
    };
  } catch (e) {
    if (IG_DEBUG_LOG) {
      console.log('igFetchMediaById error', e?.response?.data || e.message);
    }
    return null;
  }
}


async function igLookupPostByAssetId(assetId) {
  if (!assetId) return { isBrand: false, post: null };

  let map = await igFetchRecentMediaMap();
  if (map && map[assetId]) return { isBrand: true, post: map[assetId] };

  map = await igFetchRecentMediaMap(true);
  if (map && map[assetId]) return { isBrand: true, post: map[assetId] };

  // Fallback: fetch the media directly by ID
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
   INTENTS / DETECTORS
   ========================= */
function intentFromText(text = '') {
  const t = normalize(text);

  const wantsLocation =
    /\b(location|where|address|map|pin|directions?|reach)\b/.test(t) ||
    /کہاں|لوکیشن|پتہ|ایڈریس|نقشہ/.test(text); // Urdu

  const wantsRates =
    isPricingIntent(text);

  const wantsFacilities =
    /\bfaciliti(?:y|ies)\b|\bamenit(?:y|ies)\b|\bkitchen\b|\bfood\b|\bheater\b|\bbonfire\b|\bfamily\b|\bparking\b|\bjeep\b|\binverter\b/.test(t);

  const wantsBooking =
    /\bbook\b|\bbooking\b|\breserve\b|\breservation\b|\bcheck ?in\b|\bcheck ?out\b|\badvance\b|\bpayment\b/.test(t);

  const wantsAvail =
    /\bavailability\b|\bavailable\b|\bdates?\b|\bcalendar\b/.test(t);

  const wantsDistance =
    /\bdistance\b|\bhow far\b|\bhours\b|\bdrive\b|\btime from\b|\beta\b/.test(t);

  const wantsWeather =
    /\bweather\b|\btemperature\b|\bforecast\b/.test(t);

  const wantsRoute =
    /\broute\b|\brasta\b|\bhow\s+to\s+(?:reach|get|come)\b|\bfrom\s+\w+\s+(?:to|till|for)\b|\b(?:travel|journey)\s+time\b|\b(?:travel|journey)\s+from\b/.test(t);

  const wantsContact =
    /\bcontact\b|\bmanager\b|\bowner\b|\bnumber\b|\bwhats\s*app\b|\bwhatsapp\b|\bcall\b|\bspeak to\b|\braabta\b/.test(t);

  // Nights / days ask
  const nightsAsk =
    /\b(\d{1,2})\s*(?:night|nights|raat|din|day|days)\b/i.exec(text);

  return {
    wantsLocation, wantsRates, wantsFacilities, wantsBooking, wantsAvail,
    wantsDistance, wantsWeather, wantsRoute, wantsContact,
    nightsAsk
  };
}

/* === campaign detector (9000 staycation) === */
function maybeCampaignFromText(text = '') {
  const s = (text || '').toLowerCase();

  // ===== 9000 campaign =====
  const mentions9000 =
    /\b9\s*0\s*0\s*0\b/.test(s) ||
    /\b9\s*k\b/.test(s) ||
    /(?:^|[^a-z0-9])(rs|pkr|₨)\s*9\s*0\s*0\s*0(?:[^a-z0-9]|$)/.test(s) ||
    /\b9\s*0\s*0\s*0\s*(rs|pkr|₨)\b/.test(s) ||
    /\b9\s*0\s*0\s*0\s*\/-\b/.test(s);

  const mentionsThreeDayChill =
    /3\s*(din|day|days)\s*(?:just)?\s*ch(?:i)?ll/.test(s) ||
    /3\s*din\s*wali\s*post/.test(s) ||
    /3[-\s]*day\s*(?:chill|package)/.test(s) ||
    /staycation\s*for\s*friends/.test(s);

  if (mentions9000 || mentionsThreeDayChill) return 'staycation9000';

  // ===== Honeymoon campaign =====
  const mentionsHoneymoon =
    /\bhone[\s-]?moon\b/.test(s) ||            // honeymoon, honey moon, honey-moon
    /\bhoneymoon[a-z]*/.test(s) ||             // honeymoonprice, honeymoonpackage, etc.
    /\bhoneemoon\b/.test(s) ||                 // typo
    /\bhoneymon\b/.test(s) ||                  // typo
    /\b70\s*[kK]\b/.test(s) ||                 // 70k
    /\b70\s*[,\.]?\s*0{3,}\b/.test(s) ||       // 70000 / 70,000
    /(?:^|[^a-z0-9])(rs|pkr|₨)\s*70\s*[,\.]?\s*0{3,}/.test(s); // Rs70000 etc.

  if (mentionsHoneymoon) return 'honeymoon70k';

  return null;
}
function maybeCampaignFromCaption(caption='') {
  return maybeCampaignFromText(caption || '');
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
   9000-PKR Staycation campaign content
   ========================= */
const CAMPAIGNS = {
  staycation9000: {
    longMsg:
`Roameo Staycation for Friends 🌲

This trip plan is designed especially for groups of friends who want to escape together...
WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_URL}`,

    priceReply:
`For the *3-day chill* staycation, the headline price is **PKR 9,000 per person**.

**What’s included**
• Daily complimentary **breakfast** + **one free dinner**  
• **Flexible dates** (your choice)  
• Stay at Roameo (**travel not included**)  
• **Best for:** 2–5 people

Tell me your **group size** and **dates**, and I’ll help you proceed.
WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_URL}`
  },

  honeymoon70k: {
    longMsg:
`💍 Roameo Honeymoon Package 💕

Celebrate your love in the heart of Kashmir 🌲✨.  
Starting from **Rs. 70,000 per couple** for 3 nights or more.

**Includes:**
• Breakfast in bed each morning 🥐☕  
• Dreamy candlelight dinner under the stars 🌙  
• Experiences: lantern night, canvas painting, mini hike to Bantal, bonfire, stargazing, photo walk & a private picnic 🍃📸  

Mark the dates that work for you, arrive hand-in-hand, and we’ll create the warmth and magic for unforgettable moments.  

WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_URL}`,

    priceReply:
`Our *Honeymoon Package* starts from **Rs. 70,000 per couple** (for 3 nights or more). 💕

**Includes:**
• Breakfast in bed every morning  
• A candlelight dinner under the stars  
• Romantic & fun experiences: lantern night, canvas painting, mini hike to Bantal, bonfire, stargazing, photo walk, private picnic  

This package is designed for couples to create unforgettable memories.  
WhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_URL}`
  }
};


/* =========================
   Pricing helpers (soft launch card + nights quote)
   ========================= */
function currentRateCard() {
  return `Right now, we’re offering exclusive soft launch discounts for our guests at Roameo Resort.

Soft Launch  Rate List:

Deluxe Hut – PKR 30,000/night
• 1st Night: 10% Off → PKR 27,000
• 2nd Night: 15% Off → PKR 25,500
• 3rd Night: 20% Off → PKR 24,000

Executive Hut – PKR 50,000/night
• 1st Night: 10% Off → PKR 45,000
• 2nd Night: 15% Off → PKR 42,500
• 3rd Night: 20% Off → PKR 40,000

Terms & Conditions:
• Rates are inclusive of all taxes.
• Complimentary breakfast for 4 guests per booking.
• 50% advance payment is required to confirm the reservation.

Let us know if you’d like to book your stay or need any assistance! 🌿✨

WhatsApp: ${WHATSAPP_LINK}
Availability / Book: ${SITE_URL}`;
}

// discount table (night no. → % off). Nights 4+ keep 20% off.
function discountPctForNight(n) {
  if (n === 1) return 10;
  if (n === 2) return 15;
  return 20;
}
function quoteForNights(n) {
  const baseDeluxe = 30000;
  const baseExec   = 50000;

  let deluxeTotal = 0, execTotal = 0;
  let linesDeluxe = [], linesExec = [];

  for (let i=1; i<=n; i++) {
    const pct = discountPctForNight(i);
    const dNight = Math.round(baseDeluxe * (100 - pct) / 100);
    const eNight = Math.round(baseExec   * (100 - pct) / 100);
    deluxeTotal += dNight; execTotal += eNight;
    linesDeluxe.push(`• Night ${i}: PKR ${dNight.toLocaleString()} (${pct}% off)`);
    linesExec  .push(`• Night ${i}: PKR ${eNight.toLocaleString()} (${pct}% off)`);
  }

  return `Here’s the quote for *${n} ${n===1?'night':'nights'}* (soft-launch discounts applied):

Deluxe Hut — Base PKR 30,000/night
${linesDeluxe.join('\n')} 
→ **Total: PKR ${deluxeTotal.toLocaleString()}**

Executive Hut — Base PKR 50,000/night
${linesExec.join('\n')}
→ **Total: PKR ${execTotal.toLocaleString()}**

Rates include all taxes and complimentary breakfast for 4 guests.
50% advance confirms booking.

WhatsApp: ${WHATSAPP_LINK}
Availability / Book: ${SITE_URL}`;
}

/* =========================
   VOICE: transcribe IG audio/voice
   ========================= */
async function transcribeFromUrl(url) {
  if (!ENABLE_VOICE_STT || !OPENAI_API_KEY || !url) return null;
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    const buf = Buffer.from(resp.data);
    const mb = buf.length / (1024*1024);
    if (mb > MAX_AUDIO_MB) { console.warn('STT skipped (size)', mb); return null; }

    const form = new FormData();
    form.append('file', buf, { filename: 'note.m4a', contentType: resp.headers['content-type'] || 'audio/mpeg' });
    form.append('model', STT_MODEL);

    const stt = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
      timeout: 30000
    });
    const text = (stt?.data?.text || '').trim();
    return text || null;
  } catch (e) {
    console.error('STT error', e?.response?.data || e.message);
    return null;
  }
}

/* =========================
   INTENT HELPERS
   ========================= */
function isPricingIntent(text = '') {
  const t = normalize(text);
  if (t.length <= 2) return false;

  const kw = [
    'price','prices','pricing','rate','rates','tariff','cost','rent','rental','per night',
    'night price','kiraya','qeemat','kimat','keemat','قیمت','کرایہ','ریٹ','نرخ','offer','pkg','package','charges','charo'
  ];
  if (kw.some(x => t.includes(x))) return true;

  if (/\b9\s*k\b/.test(t) || /\b9\s*0\s*0\s*0\b/.test(t)) return true;
  if (/(rs|pkr|₨)\s*9\s*0\s*0\s*0/i.test(text) || /\b9\s*0\s*0\s*0\s*(rs|pkr|₨)\b/i.test(text)) return true;

  if (/\bhow much\b/i.test(text)) return true;
  if (/\b\d+\s*(night|nights|din|raat|days?)\b/i.test(text)) return true;

  return false;
}

/* =========================
   DM HANDLER
   ========================= */
async function handleTextMessage(psid, text, imageUrl, ctx = { req: null, shareUrls: [], shareThumb: null, isShare: false, brandHint: false, captions: '', assetId: null }) {
  if (!AUTO_REPLY_ENABLED) return;

  const textUrls = extractPostUrls(text || '');
  const combinedUrls = [...new Set([...(ctx.shareUrls || []), ...textUrls])];

  const intents = intentFromText(text || '');
  const lang = detectLanguage(text || '');

  // ==== Sticky campaign (if any) ====
  let stickyCampaign = campaignState.get(psid) || null;

  // === Multi-intent bundle reply container ===
  const sections = [];

  // Contact shortcut
  if (intents.wantsContact) {
    sections.push(`WhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
  }

  // Location shortcut (any language)
  if (intents.wantsLocation) {
    sections.push(`*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
  }

  // Nights quote (if asked explicitly like "price for 4 nights")
  if (intents.nightsAsk && intents.wantsRates) {
    const n = Math.max(1, Math.min(21, parseInt(intents.nightsAsk[1], 10)));
    sections.push(quoteForNights(n));
  }

  // If user asked for rates / charges without explicit nights:
  if (intents.wantsRates && !intents.nightsAsk) {
    const campaignFromText = maybeCampaignFromText(text || '');
    const activeCampaign = campaignFromText || stickyCampaign;
    if (activeCampaign === 'staycation9000') {
      sections.push(CAMPAIGNS.staycation9000.priceReply);
      stickyCampaign = 'staycation9000';
      campaignState.set(psid, stickyCampaign);
    } else {
      // fallback to current rate card
      sections.push(currentRateCard());
    }
  }

  // Route / distance (handled after rates so both can be returned)
  if (intents.wantsRoute || intents.wantsDistance) {
    const msg = await dmRouteMessage(text);
    sections.push(msg);
  }

  // If we already have sections (multi-intent), send and return
  if (sections.length) {
    return sendBatched(psid, sections);
  }

  // ====== IG SHARE HANDLING ======

  // 1) Brand-owned via asset_id
  if (ctx.assetId) {
    const lookup = await igLookupPostByAssetId(ctx.assetId);
    if (lookup && lookup.isBrand && lookup.post) {
      const meta = lookup.post;
      const caption = meta.caption || ctx.captions || '';
      const camp = maybeCampaignFromCaption(caption);

      const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
      const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;
      const imgForVision = SEND_IMAGE_FOR_IG_SHARES ? thumb : null;

      if (IG_DEBUG_LOG) console.log('[IG share] sending image to Vision:', imgForVision);

      // Special case: our 9000 campaign
      if (camp === 'staycation9000') {
        campaignState.set(psid, 'staycation9000');
        lastShareMeta.set(psid, { caption, permalink: meta.permalink || '' });
        return sendBatched(psid, CAMPAIGNS.staycation9000.longMsg);
      }

      // Generic branded share → caption summary except explicit pricing ask
      lastShareMeta.set(psid, { caption, permalink: meta.permalink || '' });

      if (!isPricingIntent(text || '')) {
        const reply = formatOfferSummary(caption, meta.permalink || '');
        return sendBatched(psid, reply);
      }

      // Pricing asked → brain (with post note)
      const postNote = [
        'postMeta:',
        `source: ig`,
        `author_name: Roameo Resorts`,
        `author_url: https://www.instagram.com/${BRAND_USERNAME}/`,
        `permalink: ${meta.permalink || ''}`,
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

  // 2) Brand via oEmbed URL
  if (combinedUrls.length) {
    for (const url of combinedUrls) {
      const meta = await fetchOEmbed(url);
      if (meta && isFromBrand(meta)) {
        const caption = (meta.title || '').trim();
        const camp = maybeCampaignFromCaption(caption);

        const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
        const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;
        const imgForVision = SEND_IMAGE_FOR_IG_SHARES ? thumb : null;

        if (IG_DEBUG_LOG) console.log('[IG share] sending image to Vision:', imgForVision);

        // 9000 campaign
        if (camp === 'staycation9000') {
          campaignState.set(psid, 'staycation9000');
          lastShareMeta.set(psid, { caption, permalink: url });
          return sendBatched(psid, CAMPAIGNS.staycation9000.longMsg);
        }

        // Generic branded post
        lastShareMeta.set(psid, { caption, permalink: url });

        if (!isPricingIntent(text || '')) {
          const reply = formatOfferSummary(caption, url);
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
    const reply = lang === 'ur'
      ? 'آپ نے جو پوسٹ شیئر کی ہے وہ ہماری نہیں لگتی۔ براہِ کرم اس کا اسکرین شاٹ بھیج دیں تاکہ رہنمائی کر سکیں۔'
      : lang === 'roman-ur'
        ? 'Jo post share ki hai wo hamari nahi lagti. Behtar rehnumai ke liye uska screenshot send karein.'
        : 'It looks like the shared post isn’t from our page. Please send a screenshot and I’ll help with details.';
    return sendBatched(psid, `${reply}\n\nWhatsApp: ${WHATSAPP_LINK}`);
  }

  // 3) Fallbacks:
  //    If user refers to "that post / that offer" and we have lastShareMeta or sticky campaign
const campFromText = maybeCampaignFromText(text || '');
if (campFromText === 'staycation9000' || stickyCampaign === 'staycation9000') {
  campaignState.set(psid, 'staycation9000');

  // Dates / availability
  if (intents.wantsAvail) {
    return sendBatched(psid,
      `The 9000 package has **flexible dates** — you can book anytime in advance. Just tell us your group size and preferred dates.\n\nWhatsApp: ${WHATSAPP_LINK}`
    );
  }

  // Facilities
  if (intents.wantsFacilities) {
    return sendBatched(psid,
      `This package includes **daily complimentary breakfast + one free dinner**. Other meals/add-ons are billed separately. Best for 2–5 people.\n\nWhatsApp: ${WHATSAPP_LINK}`
    );
  }

  // Price
  if (isPricingIntent(text)) {
    return sendBatched(psid, CAMPAIGNS.staycation9000.priceReply);
  }

  // First trigger → show long card (only once, when detected from text)
  if (campFromText === 'staycation9000' && !stickyCampaign) {
    return sendBatched(psid, CAMPAIGNS.staycation9000.longMsg);
  }

  // Otherwise → let brain handle it (no card repeat!)
  const history = chatHistory.get(psid) || [];
  const surface = 'dm';
  const response = await askBrain({ text, imageUrl, surface, history });
  const { message } = response;
  const newHistory = [...history, constructUserMessage({ text, imageUrl, surface }), { role: 'assistant', content: message }].slice(-20);
  chatHistory.set(psid, newHistory);
  return sendBatched(psid, message);
}
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

    let text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url || null;

    // Messenger voice notes (if any)
    const audioUrl = event.message.attachments?.find(a => a.type === 'audio')?.payload?.url || null;
    if (!text && audioUrl) {
      const transcript = await transcribeFromUrl(audioUrl);
      if (transcript) text = transcript;
    }

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

    let text = event.message.text || '';
    const imageUrl = event.message.attachments?.find(a => a.type === 'image')?.payload?.url || null;

    // IG voice / audio
    const audioUrl = event.message.attachments?.find(a => a.type === 'audio')?.payload?.url || null;
    if (!text && audioUrl) {
      const transcript = await transcribeFromUrl(audioUrl);
      if (transcript) text = transcript;
    }

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
    // NOTE: don't mark audio as "share"
    if (a?.type && a.type !== 'image' && a.type !== 'audio') isShare = true;

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
    return ask + `\n\n*Roameo Resorts — location link:*\n👉 ${MAPS_LINK}`;
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
