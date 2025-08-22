// server.js — Roameo Resorts omni-channel bot
// FB DMs + FB comment replies + IG DMs + IG comment replies
// Unique GPT replies (EN/Urdu/Roman-Ur) + positivity + Weather (OpenWeather) + Distance/ETA (Geoapify)
// PRICES IN COMMENTS: FORBIDDEN (DM-only).
// Voice: never use first-person singular — always "we/us/our team".
// Pricing-in-comments: FB -> DM + public note (fail-open). IG -> public note only.
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
const VERIFY_TOKEN = process.envVERIFY_TOKEN || 'verify_dev';
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
const RESORT_REGION_NAME = process.env.RESORT_REGION_NAME || 'Kashmir'; // broader region mention

// Behavior toggles
const DISABLE_SOFT_CTAS = String(process.env.DISABLE_SOFT_CTAS || 'true').toLowerCase() === 'true';

// Geocoding bias
const GEO_COUNTRY_BIAS = process.env.GEO_COUNTRY_BIAS || 'pk';

// Contact routing (PRIMARY)
const PHONE_E164 = (process.env.PHONE_E164 || '923558000078').replace(/[^\d]/g, '');
const WHATSAPP_LINK = `https://wa.me/${PHONE_E164}`;
const PUBLIC_PHONE_DISPLAY = process.env.PUBLIC_PHONE_DISPLAY || '+92 355 8000078';

// Optional CTA rotation (kept empty by default)
const CTA_ROTATION = (process.env.CTA_ROTATION || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Checkin/out
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
const BRAND_NAME = 'Roameo Resorts';
const SITE_URL = 'https://www.roameoresorts.com/';
const MAPS_LINK = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const FACTS = {
  brand: BRAND_NAME,
  site: SITE_URL,
  map: MAPS_LINK,
  resort_coords: RESORT_COORDS,
  location_name: RESORT_LOCATION_NAME,
  region_name: RESORT_REGION_NAME,
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
    'Private riverfront huts facing the Neelam River',
    'Heaters, inverters and insulated huts',
    'In-house kitchen with local and desi meals',
    'Private internet access plus SCOM SIM support',
    'Spacious rooms, modern interiors, artistic decor',
    'Family friendly atmosphere',
    'Luggage assistance from private parking',
    'Free 4x4 jeep assist for elderly or water crossing',
    'Bonfire and outdoor seating on request'
  ],
  travel_tips: [
    'Roads in the valley are fully carpeted for a smooth, scenic drive',
    'Small water crossing near the resort; sedans can park at private parking (1 minute walk)',
    'Our team helps with luggage; free jeep transfer available for elderly guests'
  ],
  region_highlights: [
    'mountain views across the Kashmir ranges',
    'pleasant weather in season with crisp mornings',
    'scenic riversides and forested slopes',
    'photo spots along carpeted roads and viewpoints'
  ]
};

/* =========================
   CONTACT UTILITIES
   ========================= */
function contactLineByLang(lang = 'en') {
  if (lang === 'ur') {
    return `بکنگ یا معلومات کے لیے WhatsApp پر رابطہ کریں: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY})  
یا ہماری ویب سائٹ ملاحظہ کریں: ${SITE_URL}`;
  } else if (lang === 'roman-ur') {
    return `Booking ya info ke liye WhatsApp par rabta karein: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY})  
Ya hamari website par jayein: ${SITE_URL}`;
  }
  return `For bookings or info, WhatsApp us: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY})  
Or visit our website: ${SITE_URL}`;
}

/* =========================
   FALLBACK TEMPLATES
   ========================= */
const REPLY_TEMPLATES = {
  rates_short: `We have sent you the latest prices in a private message. Please check your inbox. 😊`,
  // NOTE: explicitly mark discounted prices in DMs
  rates_long: `
Discounted soft-launch rates (limited time):

Deluxe Hut — PKR 30,000/night
• 1st Night 10% → PKR 27,000
• 2nd Night 15% → PKR 25,500
• 3rd Night 20% → PKR 24,000

Executive Hut — PKR 50,000/night
• 1st Night 10% → PKR 45,000
• 2nd Night 15% → PKR 42,500
• 3rd Night 20% → PKR 40,000

Note: These are discounted prices.  
T&Cs: taxes included • breakfast for 4 • 50% advance to confirm.
Bookings/queries on WhatsApp: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY})  
Website: ${SITE_URL}`.trim(),
  loc_short: `Location pin: ${MAPS_LINK}
Roads are fully carpeted. Small water crossing near the resort; sedans can use our private parking (1 minute walk). Luggage help + free jeep for elderly guests.
${contactLineByLang('en')}`,
  loc_long: `
Here is our Google Maps pin:
> ${MAPS_LINK}

Good to know:
• Roads are fully carpeted for a smooth, scenic drive
• Small water crossing near the resort; sedans can park at our private parking (1 minute walk)
• Luggage assistance + free jeep transfer for elderly guests

${contactLineByLang('en')}`.trim(),
  fac_short: `Facilities: riverfront huts, heaters/inverters, in-house kitchen, internet + SCOM, spacious rooms, family-friendly vibe, luggage help, free jeep assist, bonfire on request.
${contactLineByLang('en')}`,
  fac_long: `
We are a boutique riverside escape with:
• Private riverfront huts facing the ${FACTS.river_name}
• Heaters, inverters and insulated huts
• In-house kitchen (local & desi)
• Private internet + SCOM support
• Spacious rooms, modern interiors
• Family-friendly atmosphere
• Luggage assistance from private parking
• Free 4x4 jeep assist (elderly / water crossing)
• Bonfire & outdoor seating on request

${contactLineByLang('en')}`.trim(),
  book_short: `Check-in ${FACTS.checkin} • Check-out ${FACTS.checkout}
50% advance to confirm. Breakfast for 4 included.
${contactLineByLang('en')}`,
  book_long: `
Check-in: ${FACTS.checkin} • Check-out: ${FACTS.checkout}
Bookings are confirmed with a 50% advance. Breakfast for 4 is included.

${contactLineByLang('en')}`.trim(),
  default_short: `Thanks for the love! Need directions, facilities, or timings?
${contactLineByLang('en')}`,
  default_long: `
Thanks for reaching out. We are ${FACTS.brand} — a boutique riverfront escape by the ${FACTS.river_name} in the scenic ${FACTS.region_name}.
We can help with facilities, directions and travel timings here.

${contactLineByLang('en')}`.trim()
};

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const tinyCache = new LRUCache({ max: 200, ttl: 1000 * 60 * 10 }); // 10m
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 }); // 30m per user

// Track comments we ourselves post so we can ignore their echo webhooks
const selfAuthoredComments = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h

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
            // pass pageId (entry.id) so we can detect our own page in handler
            await routePageChange(change, entry.id).catch(logErr);
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
        const pageId = entry.id; // required for IG
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
  console.error('💥 Handler error:', err?.where ? err : (err?.response?.data || err.message || err));
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
  return /\b(pric(?:e|ing)|rate|cost|charges?|tariff|per\s*night|room|rooms)\b/i.test(t);
}
function isQuestionLike(text = '') {
  const t = (text || '').toLowerCase();
  if (/\?/.test(t)) return true;
  return /\b(how|where|when|what|which|can|do|does|are|is|distance|weather|available|availability|book|booking|road|roads|condition|conditions|flood|cloud\s*burst|cloudburst)\b/i.test(t);
}

// Public FB reply (record our own comment ID to avoid echo loops)
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  const { data } = await axios.post(url, { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
  if (data?.id) selfAuthoredComments.set(`fb:${data.id}`, true);
  return data;
}

// FB private reply to a comment
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  await axios.post(url, { message }, { params, timeout: 10000 });
}

function pickLangAwarePublicLine(text = '') {
  const lang = detectLanguage(text);
  if (lang === 'ur') return 'ہم نے آپ کو قیمتیں پیغام میں بھیج دی ہیں، براہِ کرم اپنے میسجز چیک کریں۔ 😊';
  if (lang === 'roman-ur') return 'Hum ne aap ko prices DM kar di hain, meherbani karke apne messages check karein. 😊';
  return 'We have sent you the prices in a private message. Please check your inbox. 😊';
}
function pickLangAwarePromptDM(text = '') {
  const lang = detectLanguage(text);
  if (lang === 'ur') return `براہِ مہربانی ہمیں WhatsApp پر پیغام کریں: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}) — ہم فوراً قیمتیں شیئر کر دیں گے۔ 😊`;
  if (lang === 'roman-ur') return `Meherbani karke humein WhatsApp par msg karein: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}) — hum foran prices share kar denge. 😊`;
  return `Please WhatsApp us at ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}) and we will share the prices right away. 😊`;
}

async function routePageChange(change, pageId) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item === 'comment' && v.comment_id) {
    const text = (v.message || '').trim();

    // 1) Ignore the echo of a comment we just posted
    if (selfAuthoredComments.has(`fb:${v.comment_id}`)) return;

    // 2) Ignore comments authored by our own Page (entry.id == pageId)
    if (pageId && v.from?.id && String(v.from.id) === String(pageId)) return;

    console.log('💬 FB comment event:', { verb: v.verb, commentId: v.comment_id, text, post_id: v.post_id, from: v.from });
    if (v.verb !== 'add') return;

    // Pricing asked publicly -> try DM, then public note
    if (isPricingIntent(text)) {
      let dmOk = false;
      try {
        const privateReply = await decideReply(text, { surface: 'dm', platform: 'facebook' });
        await fbPrivateReplyToComment(v.comment_id, privateReply);
        dmOk = true;
      } catch (e) {
        logErr({ where: 'FB pricing DM', commentId: v.comment_id, err: e?.response?.data || e.message });
      }

      try {
        const publicMsg = dmOk ? pickLangAwarePublicLine(text) : pickLangAwarePromptDM(text);
        await replyToFacebookComment(v.comment_id, publicMsg);
      } catch (e) { logErr({ where: 'FB pricing public reply', commentId: v.comment_id, err: e?.response?.data || e.message }); }

      return;
    }

    // For question-like comments: DM + public (FB supports comment->DM)
    if (AUTO_REPLY_ENABLED && isQuestionLike(text)) {
      try {
        let dmReply = await decideReply(text, { surface: 'dm', platform: 'facebook' });
        dmReply = sanitizeBrand(dmReply);
        await fbPrivateReplyToComment(v.comment_id, dmReply);

        let publicReply = await decideReply(text, { surface: 'comment', platform: 'facebook' });
        publicReply = sanitizeComment(publicReply, detectLanguage(text));
        publicReply = sanitizeBrand(publicReply);
        await replyToFacebookComment(v.comment_id, publicReply);
      } catch (e) { logErr({ where: 'FB question-like dual reply', commentId: v.comment_id, err: e?.response?.data || e.message }); }
      return;
    }

    // Non-question comments -> public only
    if (!AUTO_REPLY_ENABLED) return console.log('🤖 Auto-reply disabled — would reply to FB comment.');
    let reply = await decideReply(text, { surface: 'comment', platform: 'facebook' });
    reply = sanitizeComment(sanitizeBrand(reply), detectLanguage(text));
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
// Public IG reply (record our own reply id to avoid echo loops)
async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  const { data } = await axios.post(url, { message }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
  if (data?.id) selfAuthoredComments.set(`ig:${data.id}`, true);
  return data;
}

// IG private reply to a comment — NOT USED (restricted capability)
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

    // 1) Ignore the echo of our own comment
    if (selfAuthoredComments.has(`ig:${commentId}`)) return;

    // 2) Ignore comments authored by our own IG account (entry.id == pageId)
    if (pageId && v.from?.id && String(v.from.id) === String(pageId)) return;

    console.log('💬 IG comment event:', { field: theField, verb: v.verb, commentId, text, media_id: v.media_id, from: v.from });
    if (v.verb && v.verb !== 'add') return;

    // IG: Pricing -> PUBLIC prompt to WhatsApp (do not attempt DM — capability errors)
    if (isPricingIntent(text)) {
      try {
        const publicMsg = pickLangAwarePromptDM(text);
        await replyToInstagramComment(commentId, publicMsg);
      } catch (e) { logErr({ where: 'IG pricing public reply', commentId, pageId, err: e?.response?.data || e.message }); }
      return;
    }

    // IG: Question-like -> PUBLIC reply only (avoid (#3) capability errors)
    if ( AUTO_REPLY_ENABLED && isQuestionLike(text)) {
      try {
        let publicReply = await decideReply(text, { surface: 'comment', platform: 'instagram' });
        publicReply = sanitizeComment(sanitizeBrand(publicReply), detectLanguage(text));
        await replyToInstagramComment(commentId, publicReply);
      } catch (e) { logErr({ where: 'IG question-like public reply', commentId, pageId, err: e?.response?.data || e.message }); }
      return;
    }

    if (!AUTO_REPLY_ENABLED) return console.log('🤖 Auto-reply disabled — would reply to IG comment.');
    let reply = await decideReply(text, { surface: 'comment', platform: 'instagram' });
    reply = sanitizeComment(sanitizeBrand(reply), detectLanguage(text));
    await replyToInstagramComment(commentId, reply);
  }
}

/* =========================
   SHARED DM HANDLER (with simple state)
   ========================= */
function isAffirmative(text = '') {
  const t = (text || '').trim().toLowerCase();
  const en = /\b(yes|yeah|yep|sure|ok(ay)?|please|go ahead|sounds good|alright|affirmative|y)\b/;
  const ru = /\b(haan|han|ji|jee|bilkul|theek(?:\s*hai)?|acha|accha|zaroor|krdo|kardo|kar do|kr den|krden)\b/;
  const ur = /(?:\u062C\u06CC|\u062C\u06CC\u06C1|\u06C1\u0627\u06BA|\u0628\u0644\u06A9\u0644|\u062A\u06BE\u06CC\u06A9\s?\u06C1\u06D2?)/;
  return en.test(t) || ru.test(t) || ur.test(t);
}

function askForDetailsByLang(lang = 'en') {
  const tail = '\n' + contactLineByLang(lang);
  if (lang === 'ur') {
    return `زبردست! براہِ کرم اپنی *تاریخیں* اور *مہمانوں کی تعداد* بتا دیں۔ اگر چاہیں تو *کس شہر سے آرہے ہیں* بھی بتا دیں تاکہ ہم سفر کا وقت بتا سکیں۔` + tail;
  } else if (lang === 'roman-ur') {
    return `Great! Barah-e-mehrbani apni *dates* aur *guests ki tadaad* bata dein. Agar chahein to *kis sheher se aa rahe hain* bhi likh dein taake hum route time bata saken.` + tail;
  }
  return `Awesome! Please share your *travel dates* and *number of guests*. If you like, also tell us *which city you’ll start from* so we can estimate drive time.` + tail;
}

function confirmAfterDetailsByLang(lang = 'en') {
  const tail = '\n' + contactLineByLang(lang);
  if (lang === 'ur') {
    return `شکریہ! معلومات مل گئیں۔ بکنگ کی تصدیق کے لیے براہِ راست WhatsApp/کال کریں یا ویب سائٹ استعمال کریں.` + tail;
  } else if (lang === 'roman-ur') {
    return `Shukriya! Maloomat mil gain. Booking ki tasdeeq ke liye WhatsApp/call karein ya website use karein.` + tail;
  }
  return `Thanks! Got your details. To confirm your booking, reach us on WhatsApp/call or use the website.` + tail;
}

async function handleTextMessage(psid, text, opts = { channel: 'messenger' }) {
  console.log('🧑 PSID:', psid, '✉️', text);
  const lang = detectLanguage(text);
  const state = convo.get(psid);

  // If user says YES to a prior ask, request details
  if (isAffirmative(text)) {
    convo.set(psid, 'awaiting_details');
    await sendText(psid, sanitizeBrand(askForDetailsByLang(lang)));
    return;
  }

  // If we recently asked for details, treat next message as details
  if (state === 'awaiting_details') {
    convo.delete(psid);
    await sendText(psid, sanitizeBrand(confirmAfterDetailsByLang(lang)));
    try {
      const follow = await decideReply(text, { surface: 'dm', platform: opts.channel === 'instagram' ? 'instagram' : 'facebook' });
      let cleaned = sanitizeVoice(sanitizeBrand(follow));
      if (DISABLE_SOFT_CTAS) {
        cleaned = cleaned.replace(/\s*(Would you like.*?|Shall we.*?|Want us to.*?|Can we pencil.*?|Pencil.*?in.*?)\s*$/i, '').trim();
      }
      await sendText(psid, cleaned);
    } catch (e) { logErr(e); }
    return;
  }

  // Normal path
  if (!AUTO_REPLY_ENABLED) {
    console.log('🤖 Auto-reply disabled — would send DM.');
    return;
  }
  const reply = await decideReply(text, { surface: 'dm', platform: opts.channel === 'instagram' ? 'instagram' : 'facebook' });
  let safeReply = sanitizeVoice(sanitizeBrand(reply));
  if (DISABLE_SOFT_CTAS) {
    safeReply = safeReply.replace(/\s*(Would you like.*?|Shall we.*?|Want us to.*?|Can we pencil.*?|Pencil.*?in.*?)\s*$/i, '').trim();
  }
  await sendText(psid, safeReply);
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

const ORIGIN_ALIASES = {
  'kahna kacha': 'Kahna Kacha, Lahore',
  'kahna kaacha': 'Kahna Kacha, Lahore',
  'kacha lahore': 'Kahna Kacha, Lahore',
  'kacha': 'Kahna Kacha, Lahore'
};

function extractOrigin(raw = '') {
  const t = (raw || '').trim();
  let m = t.match(/\bfrom\s+([a-z][a-z0-9\s\-']{2,40})/i);
  if (m) return m[1].trim();
  m = t.match(/\b([a-z][a-z0-9\s\-']{2,40})\s+s[ey]\b/i) || t.match(/\bs[ey]\s+([a-z][a-z0-9\s\-']{2,40})\b/i);
  if (m) return m[1].trim();
  m = t.match(/([\u0600-\u06FF\s]{2,40})\s*سے/);
  if (m) return m[1].trim();
  return null;
}

function normalizeOriginName(name = '') {
  const key = name.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\bkahna\b/i.test(key) && /\bkach/i.test(key)) return 'Kahna Kacha, Lahore';
  return ORIGIN_ALIASES[key] || name;
}

async function geocodePlace(place) {
  if (!GEOAPIFY_API_KEY || !place) return null;
  const norm = normalizeOriginName(place);
  const key = `geo:${norm.toLowerCase()}`;
  if (tinyCache.has(key)) return tinyCache.get(key);
  try {
    const url = 'https://api.geoapify.com/v1/geocode/search';
    const params = {
      text: norm,
      limit: 1,
      apiKey: GEOAPIFY_API_KEY,
      filter: `countrycode:${GEO_COUNTRY_BIAS}`,
      bias: FACTS.resort_coords && FACTS.resort_coords.includes(',')
        ? `proximity:${FACTS.resort_coords.split(',').reverse().join(',')}` // lon,lat
        : undefined
    };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    const feat = data?.features?.[0];
    if (!feat) return null;
    const [lon, lat] = feat.geometry.coordinates || [];
    const res = { lat, lon, label: feat.properties?.formatted || norm };
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
   REPLY LOGIC (GPT + rules)
   ========================= */
function isGreetingSmallTalk(raw = '') {
  const t = (raw || '').trim().toLowerCase();
  return /\b(hi|hello|hey|salaam|assalam[\s-]*o[\s-]*alaikum|how\s*are\s*you|whats? up|salam)\b/i.test(t)
      || /آپ کیسے ہیں|حال چال|سلام/iu.test(raw);
}
function isOffTopicScience(raw = '') {
  const t = (raw || '').toLowerCase();
  return /\b(earth).*(flat|round)\b/.test(t) || /\bflat\s*earth\b/.test(t);
}
function isInfluencerInquiry(raw = '') {
  const t = (raw || '').toLowerCase();
  return /\b(influencer|collab|collaboration|barter|pr|gift(?:ing)?|review|creator|blogger|vlogger|media|shoot|photoshoot|content\s*partnership)\b/.test(t);
}
// NEW: explicit road-conditions intent
function isRoadConditionIntent(text = '') {
  const t = (text || '').toLowerCase();
  const road = /\b(road|roads|highway|route|travel|rasta|raasta)\b/.test(t);
  const cond = /\b(condition|status|halaat|flood|floods|barish|rain|landslide|cloud\s*burst|cloudburst|washout|damage)\b/.test(t);
  return road && cond;
}

async function decideReply(text, ctx = { surface: 'dm', platform: 'facebook' }) {
  const t = (text || '').toLowerCase();
  const lang = detectLanguage(text);
  const asComment = ctx.surface === 'comment';

  // 0) Small talk
  if (isGreetingSmallTalk(text)) {
    return sanitizeVoice(`We are great—thanks for asking! How can ${FACTS.brand} help today?\n${contactLineByLang(lang)}`);
  }

  // 0.1) Off-topic short fact then pivot
  if (isOffTopicScience(text)) {
    const fact = lang === 'ur'
      ? 'زمین گول ہے.'
      : lang === 'roman-ur'
        ? 'Zameen gol hai.'
        : 'The Earth is round.';
    return sanitizeVoice(`${fact} If you are planning a peaceful riverside escape, ${FACTS.brand} is here to help.\n${contactLineByLang(lang)}`);
  }

  // 0.2) Influencers in DMs -> route to WhatsApp/phone
  if (!asComment && isInfluencerInquiry(text)) {
    return sanitizeVoice(
      lang === 'ur'
        ? `براہِ کرم تعاون/کولیب کے لیے WhatsApp پر رابطہ کریں: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}). ہماری ٹیم جلد جواب دے گی۔`
        : lang === 'roman-ur'
          ? `Please collab ke liye WhatsApp par rabta karein: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}). Hamari team jald respond karegi.`
          : `For collaborations/PR, please contact us on WhatsApp: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}). Our team will respond quickly.`
    );
  }

  // 0.3) NEW: Road condition intent (comment or DM)
  if (isRoadConditionIntent(text)) {
    const wxLine = (lat, lon) => `\n${lang === 'ur'
      ? 'حالیہ موسم جاننے کے لیے ہم مدد کر سکتے ہیں —'
      : lang === 'roman-ur'
        ? 'Latest mausam check karne mein madad kar sakte hain —'
        : 'We can also check recent weather —'} ${MAPS_LINK}`;
    const baseUR = `سڑکیں عموماً کارپٹڈ اور کھلی رہتی ہیں۔ ریزورٹ کے قریب ایک چھوٹا سا پانی کا کراسنگ ہے؛ بزرگ مہمانوں کے لیے ہماری 4×4 جیپ مفت مدد دیتی ہے۔ تیز بارش یا لینڈ سلائیڈز کی صورت میں بہترین ٹائمنگ اور تازہ صورتحال کے لیے WhatsApp کریں: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}).`;
    const baseRU = `Roads aam tor par carpeted aur open hoti hain. Resort ke qareeb chhota pani crossing hai; buzurg mehmaanon ke liye 4×4 jeep free assist available hai. Agar tez barish/landslide ho, best timing aur latest update ke liye WhatsApp karein: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}).`;
    const baseEN = `Roads are generally open and fully carpeted. Near the resort there’s a small water crossing; our team provides free 4×4 jeep assist for elderly guests. In case of heavy rain or landslides, message us on WhatsApp for the latest update and best travel timing: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}).`;
    const msg = lang === 'ur' ? baseUR : lang === 'roman-ur' ? baseRU : baseEN;
    return sanitizeVoice(`${msg}${wxLine()}`);
  }

  const intent = {
    rates: /\b(pric(?:e|ing)|rate|cost|charges?|tariff|per\s*night|room|rooms)\b/i.test(t),
    location: /\b(location|where|address|map|pin|directions?|google\s*maps|reach)\b/i.test(t),
    facilities: /\b(facilit(y|ies)|amenit(y|ies)|wifi|internet|kitchen|food|meal|heater|bonfire|family|kids|parking|jeep|inverter)\b/i.test(t),
    booking: /\b(book|booking|reserve|reservation|check[-\s]?in|checkin|check[-\s]?out|checkout|advance|payment)\b/i.test(t),
    availability: /\b(availability|available|dates?|calendar)\b/i.test(t),
    distance: /\b(distance|far|how\s*far|hours|drive|time\s*from|eta|route|rasta|raasta|road|roads|condition|conditions|flood|cloud\s*burst|cloudburst)\b/i.test(t),
    weather: /\b(weather|temperature|cold|hot|forecast|rain)\b/i.test(t)
  };

  // Extract origin for routing, if any
  const maybeOrigin = extractOrigin(text);

  const enrich = { wx: null, origin: maybeOrigin };

  let resortLat = null, resortLon = null;
  if (FACTS.resort_coords && FACTS.resort_coords.includes(',')) {
    const [lat, lon] = FACTS.resort_coords.split(',').map(s => s.trim());
    resortLat = parseFloat(lat); resortLon = parseFloat(lon);
  }

  if ((intent.weather || intent.location || intent.rates || intent.booking) && resortLat && resortLon) {
    enrich.wx = await currentWeather(resortLat, resortLon);
  }

  // Distance / road inquiries with origin
  if (intent.distance && resortLat && resortLon) {
    let originName = maybeOrigin ? normalizeOriginName(maybeOrigin) : null;
    let originGeo = originName ? await geocodePlace(originName) : null;

    // Safety ask if ambiguous
    if (!originGeo && originName) {
      const ask =
        lang === 'ur'
          ? `کیا آپ "کہنا کاچہ، لاہور" کی بات کر رہے ہیں؟ تصدیق کریں تو ہم فاصلے اور ڈرائیو ٹائم بتا دیں گے۔\n${contactLineByLang(lang)}`
          : lang === 'roman-ur'
            ? `Kya aap "Kahna Kacha, Lahore" ki baat kar rahe hain? Confirm kar dein to hum distance aur drive time bata denge.\n${contactLineByLang(lang)}`
            : `Do you mean "Kahna Kacha, Lahore"? Confirm and we’ll share distance and drive time.\n${contactLineByLang(lang)}`;
      return sanitizeVoice(ask);
    }

    if (originGeo) {
      const route = await routeDrive(originGeo.lat, originGeo.lon, resortLat, resortLon);
      if (route) {
        const line =
          lang === 'ur'
            ? `• فاصلہ: تقریباً ${km(route.meters)} کلومیٹر • وقت: تقریباً ${hhmm(route.seconds)}\nMaps pin: ${MAPS_LINK}\n${contactLineByLang(lang)}`
            : lang === 'roman-ur'
              ? `• Distance: taqreeban ${km(route.meters)} km • Time: taqreeban ${hhmm(route.seconds)}\nMaps pin: ${MAPS_LINK}\n${contactLineByLang(lang)}`
              : `• Distance: ~${km(route.meters)} km • Drive time: ~${hhmm(route.seconds)}\nMaps pin: ${MAPS_LINK}\n${contactLineByLang(lang)}`;
        return sanitizeVoice(line);
      }
    }
  }

  // Availability / booking — route to WhatsApp + website
  if (intent.availability || intent.booking) {
    return sanitizeVoice(contactLineByLang(lang));
  }

  // Fallback if GPT not configured
  if (!OPENAI_API_KEY) {
    if (intent.rates)      return asComment ? sanitizeComment(REPLY_TEMPLATES.rates_short, lang) : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.rates_long));
    if (intent.location)   return asComment ? sanitizeComment(REPLY_TEMPLATES.loc_short, lang)   : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.loc_long));
    if (intent.facilities) return asComment ? sanitizeComment(REPLY_TEMPLATES.fac_short, lang)   : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.fac_long));
    if (intent.booking)    return asComment ? sanitizeComment(REPLY_TEMPLATES.book_short, lang)  : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.book_long));
    return asComment ? sanitizeComment(REPLY_TEMPLATES.default_short, lang) : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.default_long));
  }

  // Build system prompt — brand-first, region as flavor only
  const langGuide = {
    'en': `Write in natural English.`,
    'ur': `Write in fluent Urdu using Urdu script. Avoid romanization.`,
    'roman-ur': `Write in natural Roman Urdu (Urdu in English letters) with familiar spellings.`
  }[lang];

  const asCommentNote = asComment
    ? `This is a public COMMENT reply. Keep it concise and scannable.`
    : `This is a DM. Be a bit more detailed and conversational.`;

  const cta = (!DISABLE_SOFT_CTAS && CTA_ROTATION.length)
    ? CTA_ROTATION[Math.floor(Math.random() * CTA_ROTATION.length)]
    : '';
  const maxChars = asComment ? 700 : 1000;

  const positivityRule = `
- Warm, positive, can-do tone.
- If rainy or cold, suggest practical tips and highlight cozy aspects (heated huts, in-house kitchen).
- Never discourage travel; offer a helpful plan or alternative.
- Avoid first-person singular (I, me, my); use we/us/our team.
`.trim();

  const ratesBlock = asComment ? `Prices are shared privately only.` : `
Discounted soft-launch rates (share in DMs only when relevant):
• Deluxe Hut: PKR 30,000/night; 1N 27,000; 2N 25,500; 3N 24,000
• Executive Hut: PKR 50,000/night; 1N 45,000; 2N 42,500; 3N 40,000
(Always note: these are discounted prices.)
`;

  const brandPhrasingRule = `
BRAND AND PHRASING:
- Brand-first: say "${FACTS.brand}" when expressing welcome or excitement (not "Tehjian Valley").
- If you would say "excited to see you at ${FACTS.location_name}", instead say "excited to see you at ${FACTS.brand}".
- Reference the broader region "${FACTS.region_name}" only to color the scenery (mountain views, pleasant weather, scenic drives).
- Primary contact: WhatsApp ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY}); secondary: ${SITE_URL}
`.trim();

  const systemPrompt = `
You are ${FACTS.brand}'s assistant. Produce a UNIQUE, positive, on-brand reply (no templates) faithful to these FACTS and matching the user's language.

OUTPUT LANGUAGE:
- ${langGuide}

SURFACE:
- ${asCommentNote}

ABSOLUTE VOICE RULE:
- Never use first-person singular (I, me, my). Always speak as we/us/our team.

${brandPhrasingRule}

CORE FACTS:
- Website: ${SITE_URL}
- WhatsApp: ${WHATSAPP_LINK} (${PUBLIC_PHONE_DISPLAY})
- Google Maps pin: ${MAPS_LINK}
- Location: by the ${FACTS.river_name} in ${FACTS.region_name}
- Check in ${FACTS.checkin}; Check out ${FACTS.checkout}
- ${ratesBlock.trim()}
- T&Cs: taxes included; breakfast for 4; 50% advance to confirm
- Facilities: ${FACTS.facilities.join('; ')}
- Travel tips: ${FACTS.travel_tips.join('; ')}
- Region highlights (optional): ${FACTS.region_highlights.join('; ')}

ENRICHMENT (add only if relevant):
${enrich.wx ? `• Current weather near resort: ${enrich.wx.temp}°C (feels ${enrich.wx.feels}°C), ${enrich.wx.desc}` : '• Weather: N/A'}
${maybeOrigin ? `• Origin provided by user: ${normalizeOriginName(maybeOrigin)}` : '• Origin: not provided'}

PUBLIC PRICE POLICY:
- Do NOT mention numeric prices in public comments. DM-only.

STYLE:
- Be helpful. If the user is just making small talk, keep it light; avoid pushy CTAs.
- Prefer short bullets for dense info; friendly, clear, specific.
- If a CTA is provided ("${cta}"), use it once; otherwise end naturally.
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
    let ai = data?.choices?.[0]?.message?.content?.trim();

    if (ai) {
      if (!cta || DISABLE_SOFT_CTAS) {
        ai = ai.replace(/\s*(Would you like.*?|Shall we.*?|Want us to.*?|Can we pencil.*?|Pencil.*?in.*?)\s*$/i, '').trim();
      }
      ai = sanitizeBrand(ai);
      if (asComment) return sanitizeComment(ai, lang);
      // Pricing in DMs: ensure "discounted" note present if the AI generated custom pricing text
      if (/\b(pkr|rs\.?|rupees|\d{2,3}(?:[, ]?\d{3}))/i.test(ai) && /price|rate/i.test(userMsg)) {
        if (!/discount(ed|)\b/i.test(ai)) ai = `Note: These are discounted prices.\n` + ai;
      }
      // Always attach contact line in DMs
      ai = ai + '\n\n' + contactLineByLang(lang);
      return sanitizeVoice(ai);
    }
  } catch (e) { console.error('🧠 OpenAI error:', e?.response?.data || e.message); }

  // Fallbacks
  if (intent.rates)      return asComment ? sanitizeComment(REPLY_TEMPLATES.rates_short, lang) : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.rates_long));
  if (intent.location)   return asComment ? sanitizeComment(REPLY_TEMPLATES.loc_short, lang)   : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.loc_long));
  if (intent.facilities) return asComment ? sanitizeComment(REPLY_TEMPLATES.fac_short, lang)   : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.fac_long));
  if (intent.booking)    return asComment ? sanitizeComment(REPLY_TEMPLATES.book_short, lang)  : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.book_long));
  return asComment ? sanitizeComment(REPLY_TEMPLATES.default_short, lang) : sanitizeVoice(sanitizeBrand(REPLY_TEMPLATES.default_long));
}

/* =========================
   SANITIZERS
   ========================= */
function sanitizeVoice(text = '') {
  return (text || '')
    .replace(/\bI['’]?m\b/gi, 'we are')
    .replace(/\bI am\b/gi, 'we are')
    .replace(/\bI['’]?ll\b/gi, 'we will')
    .replace(/\bI['’]?ve\b/gi, 'we have')
    .replace(/\bI['’]?d\b/gi, 'we would')
    .replace(/\bI\b/gi, 'we')
    .replace(/\bme\b/gi, 'us')
    .replace(/\bmy\b/gi, 'our')
    .replace(/\bmine\b/gi, 'ours');
}

function sanitizeComment(text = '', lang = 'en') {
  let out = sanitizeVoice(sanitizeBrand(text || ''));
  // Strip pricing from public comments
  const lines = out.split(/\r?\n/).filter(Boolean).filter(line => {
    const l = line.toLowerCase();
    const hasCurrency = /(?:pkr|rs\.?|rupees|price|rate|per\s*night)/i.test(l);
    const hasMoneyish = /\b\d{2,3}(?:[, ]?\d{3})\b/.test(l);
    return !(hasCurrency || hasMoneyish);
  });
  out = lines.join('\n');
  if (!out.trim()) {
    if (lang === 'ur') return 'محبت اور حمایت کا شکریہ۔ مزید معلومات یا رہنمائی کے لیے WhatsApp کریں: ' + WHATSAPP_LINK;
    if (lang === 'roman-ur') return 'Shukriya. Info ke liye WhatsApp karein: ' + WHATSAPP_LINK;
    return 'Thanks so much. For details, WhatsApp us: ' + WHATSAPP_LINK;
  }
  return out;
}

function sanitizeBrand(text = '') {
  if (!text) return text;
  let out = String(text);
  out = out.replace(/\bRoameo\s+Resort\b/gi, 'Roameo Resorts');
  out = out.replace(/\b(excit(?:ed|ing)\s*(?:to)?\s*(?:see|welcome).{0,40}?)(Tehjian\s+Valley)\b/gi, '$1Roameo Resorts');
  out = out.replace(/\b(see\s*(?:you)?\s*at|welcome\s*to)\s*Tehjian\s+Valley\b/gi, '$1 Roameo Resorts');
  return out;
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
        REGION: FACTS.region_name,
        RIVER: FACTS.river_name,
        BRAND: FACTS.brand,
        WHATSAPP_LINK,
        PUBLIC_PHONE_DISPLAY,
        DISABLE_SOFT_CTAS,
        CTA_ROTATION: CTA_ROTATION.length
      }
    });
  } catch (e) {
    console.error('status error:', e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
