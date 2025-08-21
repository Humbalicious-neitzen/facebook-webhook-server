// server.js — Roameo Resorts omni-channel bot
// FB DMs + FB comment replies + IG DMs + IG comment replies
// Unique GPT replies (EN/Urdu/Roman-Ur) + positivity + Weather (OpenWeather) + Distance/ETA (Geoapify)
// Pricing-in-comments -> private reply + public "check inbox" note
// Lightweight conversation state for CTA follow-up (dates/guests)
// Admin helpers (subscribe/status)

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
const AUTO_REPLY_ENABLED = String(process.env.AUTO_REPLY_ENABLED || 'false').toLowerCase() === 'true';
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

// Optional CTA rotation
const CTA_ROTATION = (process.env.CTA_ROTATION || 'Shall I pencil you in?,Want me to check dates?,Would you like the fastest route?,Need help choosing a hut?')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Checkin/out via env (defaults per your request)
const CHECKIN_TIME = process.env.CHECKIN_TIME || '3:00 pm';
const CHECKOUT_TIME = process.env.CHECKOUT_TIME || '12:00 pm';

// Guards
if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}
if (!OPENAI_API_KEY) {
  console.warn('ℹ️ OPENAI_API_KEY not set. GPT replies disabled; fallbacks will be used.');
}

/* =========================
   BUSINESS FACTS (GROUND TRUTH)
   ========================= */
const SITE_URL = 'https://www.roameoresorts.com/';
const MAPS_LINK = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const FACTS = {
  site: SITE_URL,
  map: MAPS_LINK,
  resort_coords: RESORT_COORDS, // "lat,lon"
  location_name: RESORT_LOCATION_NAME, // Tehjian Valley
  river_name: 'Krishenganga River',
  checkin: CHECKIN_TIME,     // 3:00 pm
  checkout: CHECKOUT_TIME,   // 12:00 pm
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
    `Private riverfront huts facing the Krishenganga River`,
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
    'Team assists with luggage; free jeep transfer available for elderly guests'
  ]
};

// Fallback templates (short = comments, long = DMs)
const REPLY_TEMPLATES = {
  rates_short: `We’ve DM’d you the latest prices. Please check your inbox. 😊`,
  rates_long: `
Soft-launch rates:

Deluxe Hut — PKR 30,000/night
• 1st Night 10% → PKR 27,000
• 2nd Night 15% → PKR 25,500
• 3rd Night 20% → PKR 24,000

Executive Hut — PKR 50,000/night
• 1st Night 10% → PKR 45,000
• 2nd Night 15% → PKR 42,500
• 3rd Night 20% → PKR 40,000

T&Cs: taxes included • breakfast for 4 • 50% advance to confirm.
Availability/book: ${SITE_URL}`.trim(),
  loc_short: `Location pin: ${MAPS_LINK}
Roads carpeted; small water crossing near resort. Sedans can use private parking (1-min walk). Luggage help + free jeep for elderly.`,
  loc_long: `
Here’s our Google Maps pin:
👉 ${MAPS_LINK}

Good to know:
• Roads are fully carpeted for a smooth, scenic drive
• Small water crossing near the resort; sedans can park at our private parking (1-minute walk)
• Luggage assistance + free jeep transfer for elderly

We’ll make your arrival easy and comfortable!`.trim(),
  fac_short: `Facilities: riverfront huts, heaters/inverters, in-house kitchen, internet + SCOM, spacious rooms, family-friendly, luggage help, free jeep assist, bonfire on request.`,
  fac_long: `
We’re a peaceful, boutique riverside resort with:
• Private riverfront huts facing the ${FACTS.river_name}
• Heaters, inverters & insulated huts
• In-house kitchen (local & desi)
• Private internet + SCOM support
• Spacious rooms, modern interiors
• Family-friendly atmosphere
• Luggage assistance from private parking
• Free 4×4 jeep assist (elderly / water crossing)
• Bonfire & outdoor seating on request`.trim(),
  book_short: `Check-in ${FACTS.checkin} • Check-out ${FACTS.checkout}
50% advance to confirm. Breakfast for 4 included.
Availability/booking: ${SITE_URL}`,
  book_long: `
Check-in: ${FACTS.checkin} • Check-out: ${FACTS.checkout}
Bookings are confirmed with a 50% advance. Breakfast for 4 is included.
See live availability & book: ${SITE_URL}`.trim(),
  default_short: `Thanks for reaching out! Ask about facilities or directions. For availability: ${SITE_URL}`,
  default_long: `
Thanks for reaching out 🌿 We’re Roameo Resort — a boutique riverfront escape in ${FACTS.location_name}, by the ${FACTS.river_name}.
We can help with rates, facilities, directions and travel timings here. For live availability, please use: ${SITE_URL}`.trim()
};

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const tinyCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 10 }); // 10m (weather/geo)
// Conversation state (30 minutes per user)
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 });

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
   WEBHOOK RECEIVE
   ========================= */
app.post('/webhook', async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  const body = req.body || {};
  try {
    // Facebook Page (Messenger + feed)
    if (body.object === 'page') {
      for (const entry of body.entry || []) {
        const key = `page:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            console.log('📨 MESSAGING EVENT:', JSON.stringify(ev));
            await routeMessengerEvent(ev, { source: 'messaging' }).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            console.log('📰 FEED CHANGE:', JSON.stringify(change));
            await routePageChange(change).catch(logErr);
          }
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            console.log('⏸️ STANDBY EVENT:', JSON.stringify(ev));
            await routeMessengerEvent(ev, { source: 'standby' }).catch(logErr);
          }
        }
      }
      return;
    }

    // Instagram (DMs + comments)
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        const pageId = entry.id; // required for IG private replies
        const key = `ig:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            console.log('📨 IG MESSAGING EVENT:', JSON.stringify(ev));
            await routeInstagramMessage(ev).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            console.log('🖼️ IG CHANGE:', JSON.stringify(change));
            await routeInstagramChange(change, pageId).catch(logErr);
          }
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
   FB MESSENGER (DMs)
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
  console.log('ℹ️ Messenger event (unhandled):', JSON.stringify(event));
}

/* =========================
   FB PAGE COMMENTS (feed)
   ========================= */
function isPricingIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(rate|price|cost|charges?|tariff|per\s*night|room|rooms|rates?)\b/i.test(t);
}

// Public FB reply
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}

// FB private reply to a comment
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  await axios.post(url, { message }, { params, timeout: 10000 });
}

function pickLangAwarePublicLine(text = '') {
  const lang = detectLanguage(text);
  if (lang === 'ur') return 'ہم نے آپ کو قیمتیں پیغام میں بھیج دی ہیں۔ براہِ کرم اپنے میسجز چیک کریں۔ 😊';
  if (lang === 'roman-ur') return 'Hum ne aap ko prices DM kar di hain. Meherbani karke apne messages check karein. 😊';
  return 'We’ve sent you the prices in your inbox. Please check your messages. 😊';
}

async function routePageChange(change) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item === 'comment' && v.comment_id) {
    const text = (v.message || '').trim();
    console.log('💬 FB comment event:', { verb: v.verb, commentId: v.comment_id, text, post_id: v.post_id, from: v.from });
    if (v.verb !== 'add') return;

    // Pricing asked publicly → private reply + short public note
    if (isPricingIntent(text)) {
      try {
        const privateReply = await decideReply(text, { surface: 'dm', platform: 'facebook' });
        await fbPrivateReplyToComment(v.comment_id, privateReply);
        await replyToFacebookComment(v.comment_id, pickLangAwarePublicLine(text));
      } catch (e) { logErr(e); }
      return;
    }

    // Non-pricing comments → usual flow
    if (!AUTO_REPLY_ENABLED) return console.log('🤖 Auto-reply disabled — would reply to FB comment.');
    const reply = await decideReply(text, { surface: 'comment', platform: 'facebook' });
    await replyToFacebookComment(v.comment_id, reply);
  }
}

/* =========================
   INSTAGRAM (DMs)
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    return handleTextMessage(igUserId, event.message.text || '', { channel: 'instagram' });
  }
  console.log('ℹ️ IG messaging event (unhandled):', JSON.stringify(event));
}

/* =========================
   INSTAGRAM COMMENTS
   ========================= */
// Public IG reply
async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}

// IG private reply to a comment (Messenger API for Instagram)
async function igPrivateReplyToComment(pageId, commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
  const payload = { recipient: { comment_id: commentId }, message: { text: message } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  theField = change.field || '';
  const isComment = theField === 'comments' || theField.toLowerCase().includes('comment') || (v.item === 'comment');
  if (isComment && (v.comment_id || v.id)) {
    const commentId = v.comment_id || v.id;
    const text = (v.text || v.message || '').trim();
    console.log('💬 IG comment event:', { field: theField, verb: v.verb, commentId, text, media_id: v.media_id, from: v.from });
    if (v.verb && v.verb !== 'add') return;

    if (isPricingIntent(text)) {
      try {
        const privateReply = await decideReply(text, { surface: 'dm', platform: 'instagram' });
        await igPrivateReplyToComment(pageId, commentId, privateReply);
        await replyToInstagramComment(commentId, pickLangAwarePublicLine(text));
      } catch (e) { logErr(e); }
      return;
    }

    if (!AUTO_REPLY_ENABLED) return console.log('🤖 Auto-reply disabled — would reply to IG comment.');
    const reply = await decideReply(text, { surface: 'comment', platform: 'instagram' });
    await replyToInstagramComment(commentId, reply);
  }
}

/* =========================
   SHARED DM HANDLER (with simple state)
   ========================= */
function isAffirmative(text = '') {
  const t = (text || '').trim().toLowerCase();

  // English
  const en = /\b(yes|yeah|yep|sure|ok(ay)?|please|go ahead|sounds good|alright|affirmative|y)\b/;

  // Roman-Urdu
  const ru = /\b(haan|han|ji|jee|bilkul|theek(?:\s*hai)?|acha|accha|zaroor|krdo|kardo|kar do|kr den|krden)\b/;

  // Urdu script (جی، جی ہاں، ہاں، بالکل، ٹھیک ہے)
  const ur = /(?:\u062C\u06CC|\u062C\u06CC\u06C1|\u06C1\u0627\u06BA|\u0628\u0644\u06A9\u0644|\u062A\u06BE\u06CC\u06A9\s?\u06C1\u06D2?)/;

  return en.test(t) || ru.test(t) || ur.test(t);
}

function askForDetailsByLang(lang = 'en') {
  if (lang === 'ur') {
    return `زبردست! براہِ کرم اپنی *تاریخیں* اور *مہمانوں کی تعداد* بتا دیں۔ اگر آپ چاہیں تو *کس شہر سے روانہ ہوں گے* بھی بتا دیں تاکہ ہم راستے کا وقت بتا سکیں۔  
بکنگ کی تصدیق ہمیشہ ویب سائٹ سے ہوتی ہے: ${SITE_URL}`;
  } else if (lang === 'roman-ur') {
    return `Great! Barah-e-meherbani apni *dates* aur *guests ki tadaad* bata dein. Agar chahein to *kis sheher se aa rahe hain* bhi likh dein taake hum route time bata saken.  
Booking ki tasdeeq website se hoti hai: ${SITE_URL}`;
  }
  return `Awesome! Please share your *travel dates* and *number of guests*. If you like, also tell me *which city you’ll start from* so I can estimate drive time.  
To confirm the booking, please use the website: ${SITE_URL}`;
}

function confirmAfterDetailsByLang(lang = 'en') {
  if (lang === 'ur') {
    return `شکریہ! آپ کی معلومات مل گئیں۔ بکنگ کی تصدیق کے لیے براہِ راست ویب سائٹ استعمال کریں: ${SITE_URL}  
راستے کے بارے میں مدد یا ہٹ منتخب کرنے میں رہنمائی چاہیے ہو تو بتائیں—ہم موجود ہیں۔`;
  } else if (lang === 'roman-ur') {
    return `Shukriya! Aap ki maloomat mil gayi. Booking ki tasdeeq ke liye seedha website use karein: ${SITE_URL}  
Route help ya hut choose karne mein rehnumai chahiye ho to batayein—hum yahin hain.`;
  }
  return `Thanks! Got your details. To confirm your booking, please use the website: ${SITE_URL}  
If you’d like route help or hut suggestions, just say the word—I’m here.`;
}

async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  console.log('🧑 PSID:', psid, '✉️', text);
  const lang = detectLanguage(text);
  const state = convo.get(psid);

  // If user says YES to the CTA (or general consent), ask for dates/guests
  if (isAffirmative(text)) {
    convo.set(psid, 'awaiting_details');
    await sendText(psid, askForDetailsByLang(lang));
    return;
  }

  // If we recently asked for details, treat next message as details
  if (state === 'awaiting_details') {
    convo.delete(psid); // clear the simple state
    await sendText(psid, confirmAfterDetailsByLang(lang));
    try {
      // One helpful follow-up using GPT (e.g., if they mentioned origin city, distance/ETA, etc.)
      const follow = await decideReply(text, { surface: 'dm', platform: opts.channel === 'instagram' ? 'instagram' : 'facebook' });
      await sendText(psid, follow);
    } catch (e) { logErr(e); }
    return;
  }

  // Normal path
  if (!AUTO_REPLY_ENABLED) {
    console.log('🤖 Auto-reply disabled — would send DM.');
    return;
  }
  const reply = await decideReply(text, { surface: 'dm', platform: opts.channel === 'instagram' ? 'instagram' : 'facebook' });
  await sendText(psid, reply);
}

/* =========================
   ENRICHMENT HELPERS
   ========================= */
function km(meters) { return (meters / 1000).toFixed(0); }
function hhmm(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

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
   LANGUAGE DETECTION
   ========================= */
// Urdu script spans Arabic block (0600–06FF, 0750–077F)
function detectLanguage(text = '') {
  const t = (text || '').trim();
  const hasUrduScript = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (hasUrduScript) return 'ur';

  const romanUrduHits = [
    /\b(aap|ap|apka|apki|apke|tum|tm|mer[ai]|hum|ham|bhai|plz|pls)\b/i,
    /\b(kia|kya|kyun|kyon|kaise|kese|krna|karna|krdo|kardo|raha|rha|rhe|rahe|gi|ga|hain|hy|hai)\b/i,
    /\b(mein|mai|mujhe|mujhy|yahan|wahan|acha|accha|bohat|bahut)\b/i,
    /\b(kitna|kitni|din|rat|khana|khany|room|booking|rate|price)\b/i
  ].reduce((acc, rx) => acc + (rx.test(t) ? 1 : 0), 0);

  const englishHits = [
    /\b(the|and|is|are|you|we|from|how|where|price|rate|book|available|distance|weather)\b/i
  ].reduce((acc, rx) => acc + (rx.test(t) ? 1 : 0), 0);

  if (romanUrduHits >= 1 && englishHits <= 3) return 'roman-ur';
  return 'en';
}

/* =========================
   GPT REPLY LOGIC (language-aware + positivity)
   ========================= */
async function decideReply(text, ctx = { surface: 'dm', platform: 'facebook' }) {
  const t = (text || '').toLowerCase();
  const lang = detectLanguage(text);
  const asComment = ctx.surface === 'comment';

  const intent = {
    rates: /\b(rate|price|cost|charges?|tariff|per\s*night|room|rooms|rates?)\b/i.test(t),
    location: /\b(location|where|address|map|pin|directions?|google\s*maps|reach)\b/i.test(t),
    facilities: /\b(facilit(y|ies)|amenit(y|ies)|wifi|internet|kitchen|food|meal|heater|bonfire|family|kids|parking|jeep|inverter)\b/i.test(t),
    booking: /\b(book|booking|reserve|reservation|check[-\s]?in|checkin|check[-\s]?out|checkout|advance|payment)\b/i.test(t),
    availability: /\b(availability|available|dates?|calendar)\b/i.test(t),
    distance: /\b(distance|far|how\s*far|hours|drive|time\s*from|eta)\b/i.test(t),
    weather: /\b(weather|temperature|cold|hot|forecast|rain)\b/i.test(t)
  };

  // Extract origin ("from lahore")
  const placeMatch = t.match(/\bfrom\s+([a-z][a-z\s\-']{2,})/i);
  const maybeOrigin = placeMatch ? placeMatch[1].trim() : null;

  const enrich = { wx: null, eta: null, origin: maybeOrigin };

  // Resort coords
  let resortLat = null, resortLon = null;
  if (FACTS.resort_coords && FACTS.resort_coords.includes(',')) {
    const [lat, lon] = FACTS.resort_coords.split(',').map(s => s.trim());
    resortLat = parseFloat(lat); resortLon = parseFloat(lon);
  }

  // Weather if relevant
  if ((intent.weather || intent.location || intent.rates || intent.booking) && resortLat && resortLon) {
    enrich.wx = await currentWeather(resortLat, resortLon);
  }

  // Distance/ETA if asked or "from X"
  if ((intent.distance || maybeOrigin) && GEOAPIFY_API_KEY && resortLat && resortLon) {
    const originGeo = maybeOrigin ? await geocodePlace(maybeOrigin) : null;
    if (originGeo) {
      const route = await routeDrive(originGeo.lat, originGeo.lon, resortLat, resortLon);
      if (route) enrich.eta = { km: km(route.meters), dur: hhmm(route.seconds) };
    }
  }

  // Availability ALWAYS to website
  if (intent.availability) {
    if (lang === 'ur') {
      const msg = `کمرے کی دستیابی اور بکنگ کی تصدیق کے لیے براہِ راست ہماری ویب سائٹ ملاحظہ کریں: ${SITE_URL}`;
      return asComment ? msg : `${msg}\nاپنی تاریخیں بتائیں تو ہم ہٹ کی اقسام، سفر کے اوقات اور رہنمائی فوراً دے دیں گے۔`;
    } else if (lang === 'roman-ur') {
      const msg = `Rooms ki availability aur booking ki tasdeeq ke liye hamari website par jayein: ${SITE_URL}`;
      return asComment ? msg : `${msg}\nAgar aap dates share karein to main hut type, travel timing aur tips turant bata sakta/sakti hoon.`;
    }
    const msg = `To check live room availability and confirm your dates, please visit: ${SITE_URL}`;
    return asComment ? msg : `${msg}\nShare your dates here if you’d like hut suggestions, travel timings and tips.`;
  }

  // Fallback if GPT not configured
  if (!OPENAI_API_KEY) {
    if (intent.rates)      return asComment ? REPLY_TEMPLATES.rates_short : REPLY_TEMPLATES.rates_long;
    if (intent.location)   return asComment ? REPLY_TEMPLATES.loc_short   : REPLY_TEMPLATES.loc_long;
    if (intent.facilities) return asComment ? REPLY_TEMPLATES.fac_short   : REPLY_TEMPLATES.fac_long;
    if (intent.booking)    return asComment ? REPLY_TEMPLATES.book_short  : REPLY_TEMPLATES.book_long;
    return asComment ? REPLY_TEMPLATES.default_short : REPLY_TEMPLATES.default_long;
  }

  // Language guidance
  const langGuide = {
    'en': `Write in natural English.`,
    'ur': `Write in fluent Urdu using Urdu script. Avoid romanization.`,
    'roman-ur': `Write in natural Roman Urdu (Urdu in English letters) with familiar spellings.`
  }[lang];

  const asCommentNote = asComment
    ? `This is a public COMMENT reply—keep it concise and scannable.`
    : `This is a DM—be a bit more detailed and conversational.`;

  const cta = CTA_ROTATION[Math.floor(Math.random() * CTA_ROTATION.length)] || 'Can I help with dates?';
  const maxChars = asComment ? 700 : 1000;

  const positivityRule = `
- Maintain a warm, positive, can-do tone—especially for weather/road queries.
- If rainy or cold, suggest practical tips (best timing, warm layers, jeep assist) and highlight cozy aspects (heated huts, in-house kitchen).
- Never discourage travel or say "don’t come"; always provide a helpful plan or alternative.
`.trim();

  const systemPrompt = `
You are Roameo Resorts' assistant. Produce a UNIQUE, positive, on-brand reply (no templates) that is faithful to these FACTS and matches the user's language.

OUTPUT LANGUAGE:
- ${langGuide}

SURFACE:
- ${asCommentNote}

CORE FACTS (do not alter numbers/policies):
- Website (availability/booking only): ${SITE_URL}
- Google Maps pin: ${MAPS_LINK}
- Location: ${FACTS.location_name} (by the ${FACTS.river_name})
- Check-in ${FACTS.checkin}; Check-out ${FACTS.checkout}
- Soft launch rates:
  • Deluxe Hut: PKR 30,000/night; 1N 27,000; 2N 25,500; 3N 24,000
  • Executive Hut: PKR 50,000/night; 1N 45,000; 2N 42,500; 3N 40,000
- T&Cs: taxes included; breakfast for 4; 50% advance to confirm
- Facilities: ${FACTS.facilities.join('; ')}
- Travel tips: ${FACTS.travel_tips.join('; ')}

ENRICHMENT (add only if relevant to the user's message):
${enrich.wx ? `• Current weather near resort: ${enrich.wx.temp}°C (feels ${enrich.wx.feels}°C), ${enrich.wx.desc}` : '• Weather: N/A'}
${enrich.eta ? `• From ${enrich.origin}: ~${enrich.eta.km} km, ~${enrich.eta.dur} by road` : (enrich.origin ? `• From ${enrich.origin}: route not available` : '• Distance/ETA: not requested')}

AVAILABILITY POLICY:
- Never claim availability in chat; ALWAYS direct availability to ${SITE_URL}.

TONE & POSITIVITY:
${positivityRule}

STYLE:
- Prefer short bullets for dense info; friendly, clear, specific.
- End with a soft CTA like: "${cta}" when appropriate.
- Hard limit ~${maxChars} characters.
`.trim();

  const userMsg = (text || '').slice(0, 1000);

  try {
    const url = 'https://api.openai.com/v1/chat/completions';
    const headers = { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
    const payload = {
      model: OPENAI_MODEL,
      temperature: 0.7, top_p: 0.9,
      presence_penalty: 0.3, frequency_penalty: 0.2,
      max_tokens: 350,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ]
    };
    const { data } = await axios.post(url, payload, { headers, timeout: 12000 });
    const ai = data?.choices?.[0]?.message?.content?.trim();
    if (ai) return ai;
  } catch (e) { console.error('🧠 OpenAI error:', e?.response?.data || e.message); }

  // Fallbacks
  if (intent.rates)      return asComment ? REPLY_TEMPLATES.rates_short : REPLY_TEMPLATES.rates_long;
  if (intent.location)   return asComment ? REPLY_TEMPLATES.loc_short   : REPLY_TEMPLATES.loc_long;
  if (intent.facilities) return asComment ? REPLY_TEMPLATES.fac_short   : REPLY_TEMPLATES.fac_long;
  if (intent.booking)    return asComment ? REPLY_TEMPLATES.book_short  : REPLY_TEMPLATES.book_long;
  return asComment ? REPLY_TEMPLATES.default_short : REPLY_TEMPLATES.default_long;
}

/* =========================
   SEND API (Messenger + IG DMs)
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
  const subscribed_fields = [
    'messages',
    'messaging_postbacks',
    'messaging_optins',
    'message_deliveries',
    'message_reads',
    'feed'
  ];
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const { data } = await axios.post(url, { subscribed_fields }, { params, timeout: 10000 });
    res.json({ ok: true, data, subscribed_fields });
  } catch (e) {
    console.error('subscribe error:', e?.response?.data || e.message);
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
    console.error('status error:', e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
