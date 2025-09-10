// server.js — Roameo Resorts omni-channel bot (v8 — IG share via asset_id)

const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const axios = require('axios');
const { LRUCache } = require('lru-cache');
const qs = require('querystring');

const { askBrain, constructUserMessage } = require('./lib/brain');

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV & CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || 'verify_dev';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// Optional enrichment keys
const GEOAPIFY_API_KEY   = process.env.GEOAPIFY_API_KEY   || '';
const OPENWEATHER_API_KEY= process.env.OPENWEATHER_API_KEY|| '';
const RESORT_COORDS      = (process.env.RESORT_COORDS || '').trim(); // "lat,lon"
const RESORT_LOCATION_NAME = process.env.RESORT_LOCATION_NAME || 'Roameo Resorts, Tehjian (Neelum)';

const IG_USER_ID = process.env.IG_USER_ID || ''; // << REQUIRED for brand-owned media lookup

// Toggles
const AUTO_REPLY_ENABLED       = String(process.env.AUTO_REPLY_ENABLED       || 'true').toLowerCase() === 'true';
const ALLOW_REPLY_IN_STANDBY   = String(process.env.ALLOW_REPLY_IN_STANDBY   || 'true').toLowerCase() === 'true';
const AUTO_TAKE_THREAD_CONTROL = String(process.env.AUTO_TAKE_THREAD_CONTROL || 'false').toLowerCase() === 'true';

const IG_DEBUG_LOG = String(process.env.IG_DEBUG_LOG || 'false').toLowerCase() === 'true';

// IG token (can reuse PAGE token if scoped)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ==== Brand constants ====
const BRAND_USERNAME = (process.env.BRAND_USERNAME || 'roameoresorts').toLowerCase();
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
const dedupe      = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });              // 1h
const tinyCache   = new LRUCache({ max: 300,  ttl: 1000 * 60 * 15 });              // 15m
const chatHistory = new LRUCache({ max: 2000, ttl: 1000 * 60 * 60 * 24 * 30 });    // 30d

/* =========================
   BASIC ROUTES
   ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot running'));

/* Image proxy for Vision (handles lookaside/fb referers) */
app.get('/img', async (req, res) => {
  const remote = req.query.u;
  if (!remote) return res.status(400).send('missing u');
  try {
    const headers = { Referer: 'https://www.facebook.com/', 'User-Agent': 'Mozilla/5.0' };
    const resp = await axios.get(remote, { responseType: 'arraybuffer', timeout: 10000, headers });
    const ct = resp.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', ct);
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
  const origin = `${req?.protocol || 'https'}://${req?.get ? req.get('host') : ''}`;
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
   IG brand lookup via asset_id
   ========================= */
async function igFetchRecentMediaMap() {
  const cacheKey = 'ig:recentMediaMap';
  const cached = tinyCache.get(cacheKey);
  if (cached) return cached;
  if (!IG_USER_ID) return null;

  const token = IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;
  try {
    const url = `https://graph.facebook.com/v19.0/${IG_USER_ID}/media`;
    const params = { access_token: token, fields: 'id,permalink,caption,media_type,media_url,thumbnail_url,timestamp', limit: 50 };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    const map = {};
    for (const m of (data?.data || [])) {
      map[m.id] = {
        id: m.id,
        permalink: m.permalink,
        caption: m.caption || '',
        media_type: m.media_type,
        media_url: m.media_url || m.thumbnail_url || '',
        thumbnail_url: m.thumbnail_url || m.media_url || ''
      };
    }
    tinyCache.set(cacheKey, map, { ttl: 1000 * 60 * 10 }); // 10 min
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
    const params = { access_token: token, fields: 'id,permalink,caption,media_type,media_url,thumbnail_url' };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    return {
      id: data.id,
      permalink: data.permalink,
      caption: data.caption || '',
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
  const recent = await igFetchRecentMediaMap();
  if (recent && recent[assetId]) return { isBrand: true, post: recent[assetId] };
  const direct = await igFetchMediaById(assetId);
  if (direct) return { isBrand: true, post: direct };
  return { isBrand: false, post: null };
}

/* =========================
   ENRICHMENT — route/drive-time (kept)
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
   DM HANDLER
   ========================= */
async function handleTextMessage(psid, text, imageUrl, ctx = { req: null, shareUrls: [], shareThumb: null, isShare: false, brandHint: false, captions: '', assetId: null }) {
  if (!AUTO_REPLY_ENABLED) return;

  // If text contains an instagram permalink, collect it too
  const textUrls = extractPostUrls(text || '');
  const combinedUrls = [...new Set([...(ctx.shareUrls || []), ...textUrls])];

  // Quick branches kept local (no history roundtrip)
  const intents = intentFromText(text || '');
  if (intents.wantsContact) return sendBatched(psid, `WhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);
  if (intents.wantsLocation) return sendBatched(psid, `*Roameo Resorts — location link:*\n\n👉 ${MAPS_LINK}\n\nWhatsApp: ${WHATSAPP_LINK}\nWebsite: ${SITE_SHORT}`);

  // Route/distance helper
  if (intents.wantsRoute || intents.wantsDistance) {
    const msg = await dmRouteMessage(text);
    return sendBatched(psid, msg);
  }

  // 1) *** Brand-owned IG media via asset_id (best path) ***
  if (ctx.assetId) {
    const lookup = await igLookupPostByAssetId(ctx.assetId);
    if (lookup && lookup.isBrand && lookup.post) {
      const meta = lookup.post;
      const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
      const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;

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
      const response = await askBrain({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface, history });
      const { message } = response;
      const newHistory = [...history, constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface }), { role: 'assistant', content: message }].slice(-20);
      chatHistory.set(psid, newHistory);
      return sendBatched(psid, message);
    }
  }

  // 2) If explicit URLs present → try oEmbed brand verify
  if (combinedUrls.length) {
    for (const url of combinedUrls) {
      const meta = await fetchOEmbed(url);
      if (meta && isFromBrand(meta)) {
        const caption = (meta.title || '').trim();
        const thumbRemote = meta.thumbnail_url || ctx.shareThumb || null;
        const thumb = thumbRemote ? toVisionableUrl(thumbRemote, ctx.req) : imageUrl;

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
        const response = await askBrain({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface, history });
        const { message } = response;
        const newHistory = [...history, constructUserMessage({ text: `${text || ''}\n\n${postNote}`, imageUrl: thumb, surface }), { role: 'assistant', content: message }].slice(-20);
        chatHistory.set(psid, newHistory);
        return sendBatched(psid, message);
      }
    }

    // No brand match via oEmbed
    const lang = detectLanguage(text || '');
    const reply = lang === 'ur'
      ? 'آپ نے جو پوسٹ شیئر کی ہے وہ ہماری نہیں لگتی۔ براہِ کرم اس کا اسکرین شاٹ بھیج دیں تاکہ رہنمائی کر سکیں۔'
      : lang === 'roman-ur'
        ? 'Jo post share ki hai wo hamari nahi lagti. Behtar rehnumai ke liye uska screenshot send karein.'
        : 'It looks like the shared post isn’t from our page. Please send a screenshot and I’ll help with details.';
    return sendBatched(psid, `${reply}\n\nWhatsApp: ${WHATSAPP_LINK}`);
  }

  // 3) Fallback to brain for everything else (with history)
  const history = chatHistory.get(psid) || [];
  const surface = 'dm';
  const response = await askBrain({ text, imageUrl, surface, history });
  const { message } = response;
  const newHistory = [...history, constructUserMessage({ text, imageUrl, surface }), { role: 'assistant', content: message }].slice(-20);
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

    // Do not drop — acknowledge shares too
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
