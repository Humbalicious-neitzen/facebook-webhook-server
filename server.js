// server.js — Roameo Resorts omni-channel bot (deterministic)
// FB DMs + FB comments + IG DMs + IG comments
// No GPT. Brand-first. WhatsApp-first. Prices only in DMs (as discounted).
// Self-reply guards (IG/FB). Road conditions: fixed text (handles "cloud brust").
// Language-aware (EN / Urdu / Roman-Ur).

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

// IG token (can reuse PAGE token if scoped)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin (optional)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Optional enrichment (kept minimal)
const RESORT_COORDS = (process.env.RESORT_COORDS || '').trim(); // "lat,lon"

// Guards
if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn('⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN');
}

/* =========================
   BUSINESS FACTS
   ========================= */
const BRAND = 'Roameo Resorts';
const SITE_URL = 'https://www.roameoresorts.com/';
const WHATSAPP_LINK = 'https://wa.me/923558000078';
const MAPS_LINK = 'https://maps.app.goo.gl/Y49pQPd541p1tvUf6';

const FACTS = {
  brand: BRAND,
  site: SITE_URL,
  whatsapp: WHATSAPP_LINK,
  map: MAPS_LINK,
  region: 'Kashmir',
  river: 'Neelam River',
  location_label: 'our riverfront resort in Kashmir',
  // Pricing (DM only)
  rates: {
    deluxe:    { base: 30000, n1: 27000, n2: 25500, n3: 24000 },
    executive: { base: 50000, n1: 45000, n2: 42500, n3: 40000 }
  },
  checkin:  '3:00 pm',
  checkout: '12:00 pm',
  facilities: [
    'Private riverfront huts',
    'Heaters, inverters & insulated huts',
    'In-house kitchen (local & desi)',
    'Private internet + SCOM',
    'Spacious rooms, artistic interiors',
    'Family-friendly atmosphere',
    'Luggage assistance from private parking',
    'Free 4×4 jeep assist (elderly / water crossing)',
    'Bonfire & outdoor seating on request'
  ],
  travel_tips: [
    'Carpeted roads for a smooth, scenic drive',
    'Small water crossing near the resort; sedans can use private parking (1-minute walk)',
    'Free jeep transfer for elderly guests'
  ]
};

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h
const igAccountCache = new LRUCache({ max: 100, ttl: 1000 * 60 * 60 }); // username per pageId
const convo = new LRUCache({ max: 5000, ttl: 1000 * 60 * 30 }); // 30m per user

/* =========================
   BASIC ROUTES
   ========================= */
app.get('/', (_req, res) => res.send('Roameo Omni Bot (deterministic) running'));

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
            console.log('📨 FB MESSAGING:', JSON.stringify(ev));
            await routeMessengerEvent(ev, { source: 'messaging', pageId: entry.id }).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            console.log('📰 FB FEED CHANGE:', JSON.stringify(change));
            await routePageChange(change, entry.id).catch(logErr);
          }
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            console.log('⏸️ FB STANDBY:', JSON.stringify(ev));
            await routeMessengerEvent(ev, { source: 'standby', pageId: entry.id }).catch(logErr);
          }
        }
      }
      return;
    }

    // Instagram (DMs + comments)
    if (body.object === 'instagram') {
      for (const entry of body.entry || []) {
        const pageId = entry.id; // IG user id
        const key = `ig:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            console.log('📨 IG DM:', JSON.stringify(ev));
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
  console.error('💥 Handler error:', err?.response?.data || err.where || err.message || err);
}

/* =========================
   HELPERS: LANGUAGE
   ========================= */
function detectLanguage(text = '') {
  const t = (text || '').trim();
  const urdu = /[\u0600-\u06FF\u0750-\u077F]/.test(t);
  if (urdu) return 'ur';
  const roman = [
    /\b(aap|ap|apka|apki|apke|tum|tm|bhai|plz|pls)\b/i,
    /\b(kia|kya|kyun|kaise|krna|karna|raha|rha|rhe|rahe|gi|ga|hain|hy|hai)\b/i,
    /\b(mein|mai|mujhe|yahan|wahan|acha|accha|bohat|bahut)\b/i
  ].some(rx => rx.test(t));
  if (roman) return 'roman-ur';
  return 'en';
}

/* =========================
   HELPERS: INTENTS
   ========================= */
function isPricingIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(rate|price|prices|cost|charges?|tariff|per\s*night|room|rooms|how much|kitna|kitni)\b/i.test(t);
}
function isInfluencerIntent(text = '') {
  const t = (text || '').toLowerCase();
  return /\b(influencer|creator|content\s*creator|blogger|vlogger|collab|collaboration|barter|pr|sponsor|ambassador|review|shoot)\b/i.test(t);
}
function isRoadConditionIntent(text = '') {
  const t = (text || '').toLowerCase();
  const road = /\b(road|roads|highway|route|rasta|raasta|travel)\b/.test(t);
  const cond = /\b(condition|status|halaat|flood|floods|barish|rain|landslide|cloud\s*burst|cloudburst|cloud\s*brust|cloudbrust|washout|damage)\b/.test(t);
  return road && cond;
}
function isQuestionLike(text = '') {
  const t = (text || '').toLowerCase();
  if (/\?/.test(t)) return true;
  return /\b(how|where|when|what|which|can|do|does|are|is|distance|weather|available|availability|book|booking|road|roads|condition|conditions|flood|cloud\s*burst|cloudburst|cloud\s*brust|cloudbrust)\b/i.test(t);
}
function isGreetingSmallTalk(raw = '') {
  const t = (raw || '').trim().toLowerCase();
  return /\b(hi|hello|hey|salaam|assalam[\s-]*o[\s-]*alaikum|how\s*are\s*you|salam)\b/i.test(t)
      || /آپ کیسے ہیں|حال چال|سلام/iu.test(raw);
}

/* =========================
   HELPERS: BRAND-SAFE SANITIZERS
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
    .replace(/\bmine\b/gi, 'ours')
    .replace(/\bRoameo\s+Resort\b/gi, BRAND);
}
function sanitizeCommentNoPrices(text = '', lang = 'en') {
  let out = sanitizeVoice(text || '');
  // Strip money-like content in public
  const lines = out.split(/\r?\n/).filter(Boolean).filter(line => {
    const l = line.toLowerCase();
    const hasCurrency = /(?:pkr|rs\.?|rupees|price|rate|per\s*night)/i.test(l);
    const hasMoneyish = /\b\d{1,3}(?:[ ,.]?\d{3})+\b/.test(l); // 10,000 etc
    return !(hasCurrency || hasMoneyish);
  });
  out = lines.join('\n');
  if (!out.trim()) {
    if (lang === 'ur') return 'شکریہ! مزید معلومات یا رہنمائی کے لیے ہمیں WhatsApp کریں: ' + WHATSAPP_LINK;
    if (lang === 'roman-ur') return 'Shukriya! Details ke liye WhatsApp karein: ' + WHATSAPP_LINK;
    return 'Thanks! For details, please WhatsApp us: ' + WHATSAPP_LINK;
  }
  return out;
}

/* =========================
   HELPERS: CONTACT LINES
   ========================= */
function contactLineByLang(lang = 'en') {
  if (lang === 'ur')   return `فوری رابطہ/بکنگ: WhatsApp ${WHATSAPP_LINK} — یا ہماری ویب سائٹ ${SITE_URL}`;
  if (lang === 'roman-ur') return `Booking/assistance ke liye WhatsApp: ${WHATSAPP_LINK} — ya website: ${SITE_URL}`;
  return `Bookings/assistance: WhatsApp ${WHATSAPP_LINK} — or visit ${SITE_URL}`;
}

/* =========================
   BUILDERS: DETERMINISTIC REPLIES
   ========================= */
function buildRoadReply(lang = 'en', surface = 'comment') {
  const tail = (surface === 'dm')
    ? '\n' + contactLineByLang(lang)
    : `\n${lang === 'ur'
        ? `تازہ صورتحال کے لیے WhatsApp کریں: ${WHATSAPP_LINK}`
        : lang === 'roman-ur'
          ? `Latest update ke liye WhatsApp karein: ${WHATSAPP_LINK}`
          : `For latest updates, WhatsApp us: ${WHATSAPP_LINK}`}`;

  if (lang === 'ur') {
    return (
      `${BRAND} تک سڑکیں عموماً کارپٹڈ اور کھلی رہتی ہیں۔ ریزورٹ کے قریب ایک چھوٹا پانی کراسنگ ہے؛ بزرگ مہمانوں کے لیے ہماری 4×4 جیپ مفت معاونت دیتی ہے۔ ` +
      `تیز بارش یا لینڈ سلائیڈ کے بعد روانگی سے پہلے ہم سے مختصر اپڈیٹ لے لیں۔` + tail
    );
  }
  if (lang === 'roman-ur') {
    return (
      `${BRAND} tak roads aam tor par carpeted aur open hoti hain. Resort ke qareeb chhota pani crossing hai; buzurg mehmaanon ke liye 4×4 jeep free assist available hai. ` +
      `Heavy rain/landslide ke baad nikalne se pehle humein quick update ke liye msg karein.` + tail
    );
  }
  return (
    `Roads to ${BRAND} are generally open and fully carpeted. Near the resort there’s a small water crossing; our team provides free 4×4 jeep assist for elderly guests. ` +
    `After heavy rain/landslides, ping us for a quick status update before you travel.` + tail
  );
}

function buildPriceDM(lang = 'en') {
  const r = FACTS.rates;
  if (lang === 'ur') {
    return sanitizeVoice(
      `آپ کے لیے *ڈسکاؤنٹڈ پرائسز*:\n\n` +
      `Deluxe Hut — PKR ${r.deluxe.base.toLocaleString()}/night\n` +
      `• 1st Night 10% → PKR ${r.deluxe.n1.toLocaleString()}\n` +
      `• 2nd Night 15% → PKR ${r.deluxe.n2.toLocaleString()}\n` +
      `• 3rd Night 20% → PKR ${r.deluxe.n3.toLocaleString()}\n\n` +
      `Executive Hut — PKR ${r.executive.base.toLocaleString()}/night\n` +
      `• 1st Night 10% → PKR ${r.executive.n1.toLocaleString()}\n` +
      `• 2nd Night 15% → PKR ${r.executive.n2.toLocaleString()}\n` +
      `• 3rd Night 20% → PKR ${r.executive.n3.toLocaleString()}\n\n` +
      `مزید مدد یا ریزرویشن کے لیے WhatsApp: ${WHATSAPP_LINK}\n` +
      `Website: ${SITE_URL}`
    );
  }
  if (lang === 'roman-ur') {
    return sanitizeVoice(
      `*Discounted prices* for you:\n\n` +
      `Deluxe Hut — PKR ${r.deluxe.base.toLocaleString()}/night\n` +
      `• 1st Night 10% → PKR ${r.deluxe.n1.toLocaleString()}\n` +
      `• 2nd Night 15% → PKR ${r.deluxe.n2.toLocaleString()}\n` +
      `• 3rd Night 20% → PKR ${r.deluxe.n3.toLocaleString()}\n\n` +
      `Executive Hut — PKR ${r.executive.base.toLocaleString()}/night\n` +
      `• 1st Night 10% → PKR ${r.executive.n1.toLocaleString()}\n` +
      `• 2nd Night 15% → PKR ${r.executive.n2.toLocaleString()}\n` +
      `• 3rd Night 20% → PKR ${r.executive.n3.toLocaleString()}\n\n` +
      `Booking/help: WhatsApp ${WHATSAPP_LINK}\n` +
      `Website: ${SITE_URL}`
    );
  }
  return sanitizeVoice(
    `Here are our *discounted prices*:\n\n` +
    `Deluxe Hut — PKR ${r.deluxe.base.toLocaleString()}/night\n` +
    `• 1st Night 10% → PKR ${r.deluxe.n1.toLocaleString()}\n` +
    `• 2nd Night 15% → PKR ${r.deluxe.n2.toLocaleString()}\n` +
    `• 3rd Night 20% → PKR ${r.deluxe.n3.toLocaleString()}\n\n` +
    `Executive Hut — PKR ${r.executive.base.toLocaleString()}/night\n` +
    `• 1st Night 10% → PKR ${r.executive.n1.toLocaleString()}\n` +
    `• 2nd Night 15% → PKR ${r.executive.n2.toLocaleString()}\n` +
    `• 3rd Night 20% → PKR ${r.executive.n3.toLocaleString()}\n\n` +
    `For booking or questions: WhatsApp ${WHATSAPP_LINK}\n` +
    `Website: ${SITE_URL}`
  );
}

function buildPricePublicLine(text = '') {
  const lang = detectLanguage(text);
  if (lang === 'ur')   return 'ہم نے آپ کو *ڈسکاؤنٹڈ* قیمتیں پیغام میں بھیج دی ہیں—براہِ کرم اپنے ان باکس/DM چیک کریں۔ فوری رابطہ: ' + WHATSAPP_LINK;
  if (lang === 'roman-ur') return 'Hum ne *discounted* prices DM kar di hain—apna inbox check karein. Quick help: ' + WHATSAPP_LINK;
  return 'We’ve sent you our *discounted* prices via DM—please check your inbox. For quick help: ' + WHATSAPP_LINK;
}

function buildInfluencerDM(lang = 'en') {
  if (lang === 'ur')   return sanitizeVoice(`انفلوئنسر/کولیب کے لیے براہِ راست ہماری ٹیم سے WhatsApp پر بات کریں: ${WHATSAPP_LINK}`);
  if (lang === 'roman-ur') return sanitizeVoice(`Influencer/collab ke liye hamari team se directly WhatsApp par baat karein: ${WHATSAPP_LINK}`);
  return sanitizeVoice(`For influencer/collab opportunities, please contact our team on WhatsApp: ${WHATSAPP_LINK}`);
}

function buildSmallTalk(lang = 'en') {
  if (lang === 'ur')   return sanitizeVoice(`ہم بہت اچھے ہیں—شکریہ! ${FACTS.region} کے دلکش مناظر میں ${BRAND} آپ کا خیر مقدم کرتا ہے۔ ${contactLineByLang('ur')}`);
  if (lang === 'roman-ur') return sanitizeVoice(`Hum theek hain—shukriya! ${FACTS.region} ke scenic manazir mein ${BRAND} aap ka intezar kar raha hai. ${contactLineByLang('roman-ur')}`);
  return sanitizeVoice(`We’re doing great—thanks! ${BRAND} welcomes you amid the mountain views of ${FACTS.region}. ${contactLineByLang('en')}`);
}

function buildDefault(lang = 'en') {
  if (lang === 'ur')   return sanitizeVoice(`ہم ${BRAND} سے ہیں—کشمیر کے پہاڑی مناظر میں آپ کے لیے پُرسکون قیام۔ ${contactLineByLang('ur')}`);
  if (lang === 'roman-ur') return sanitizeVoice(`Hum ${BRAND} se hain—Kashmir ki scenic beauty mein sukoon bhara stay. ${contactLineByLang('roman-ur')}`);
  return sanitizeVoice(`We’re ${BRAND}—a peaceful riverside escape in Kashmir. ${contactLineByLang('en')}`);
}

/* =========================
   FB MESSENGER (DMs)
   ========================= */
async function routeMessengerEvent(event, ctx = { source: 'messaging', pageId: '' }) {
  if (event.delivery || event.read || event.message?.is_echo) return;

  if (event.message && event.sender?.id) {
    const psid = event.sender.id;
    const text = event.message.text || '';
    return handleDirectMessage(psid, text, { channel: 'messenger' });
  }
  if (event.postback?.payload && event.sender?.id) {
    return handleDirectMessage(event.sender.id, 'help', { channel: 'messenger' });
  }
  console.log('ℹ️ Messenger event (unhandled):', JSON.stringify(event));
}

/* =========================
   FB PAGE COMMENTS (feed)
   ========================= */
async function routePageChange(change, pageId) {
  if (change.field !== 'feed') return;
  const v = change.value || {};
  if (v.item !== 'comment' || !v.comment_id) return;
  if (v.verb && v.verb !== 'add') return;

  // Skip if we ourselves commented (from.id == pageId)
  if (String(v.from?.id || '') === String(pageId || '')) {
    console.log('🚫 Skip self FB comment');
    return;
  }

  const text = (v.message || '').trim();
  const lang = detectLanguage(text);

  try {
    if (isPricingIntent(text)) {
      // Try to DM discounted prices; then public "check inbox" line
      try {
        const dm = buildPriceDM(lang);
        await fbPrivateReplyToComment(v.comment_id, dm);
      } catch (e) { logErr({ where: 'FB price DM', err: e }); }
      const publicLine = buildPricePublicLine(text);
      await replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(publicLine, lang));
      return;
    }

    if (isRoadConditionIntent(text)) {
      const msg = buildRoadReply(lang, 'comment');
      await replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(msg, lang));
      return;
    }

    // General question → one concise public reply
    if (isQuestionLike(text)) {
      const reply = buildDefault(lang);
      await replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(reply, lang));
      return;
    }

    // Non-question appreciation etc.
    const nice = lang === 'ur'
      ? `محبت کا شکریہ! ${BRAND} میں آپ کا استقبال ہے۔ ${contactLineByLang('ur')}`
      : lang === 'roman-ur'
        ? `Shukriya! ${BRAND} mein aap ka khair maqdam hai. ${contactLineByLang('roman-ur')}`
        : `Thank you! ${BRAND} looks forward to hosting you. ${contactLineByLang('en')}`;
    await replyToFacebookComment(v.comment_id, sanitizeCommentNoPrices(nice, lang));
  } catch (e) { logErr(e); }
}

// FB public reply
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

/* =========================
   INSTAGRAM (DMs)
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    return handleDirectMessage(igUserId, event.message.text || '', { channel: 'instagram' });
  }
  console.log('ℹ️ IG messaging event (unhandled):', JSON.stringify(event));
}

/* =========================
   IG COMMENTS
   ========================= */
async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const theField = change.field || '';
  const isComment = theField === 'comments' || theField.toLowerCase().includes('comment') || (v.item === 'comment');
  if (!isComment) return;

  const commentId = v.comment_id || v.id;
  if (!commentId) return;
  if (v.verb && v.verb !== 'add') return;

  // Skip self: if from.username equals our IG username, or from.id equals pageId
  try {
    const acct = await getIGAccountInfo(pageId);
    if (String(v.from?.id || '') === String(pageId || '') ||
        (acct?.username && v.from?.username && String(v.from.username).toLowerCase() === String(acct.username).toLowerCase())) {
      console.log('🚫 Skip self IG comment');
      return;
    }
  } catch (e) { logErr({ where: 'IG self-check', err: e }); }

  const text = (v.text || v.message || '').trim();
  const lang = detectLanguage(text);

  try {
    if (isPricingIntent(text)) {
      let dmSent = false;
      try {
        const privateReply = buildPriceDM(lang);
        await igPrivateReplyToComment(pageId, commentId, privateReply);
        dmSent = true;
      } catch (e) {
        logErr({ where: 'IG price DM', commentId, pageId, err: e });
      }
      const publicMsg = dmSent
        ? buildPricePublicLine(text)
        : // fallback when app cannot DM comments (#3 capability)
          (lang === 'ur'
            ? `برائے مہربانی ہمیں DM/WhatsApp کریں: ${WHATSAPP_LINK} — ہم *ڈسکاؤنٹڈ* قیمتیں شیئر کر دیں گے۔`
            : lang === 'roman-ur'
              ? `Meherbani karke DM ya WhatsApp karein: ${WHATSAPP_LINK} — hum *discounted* prices share kar denge.`
              : `Please DM or WhatsApp us: ${WHATSAPP_LINK} — we’ll share our *discounted* prices right away.`);
      await replyToInstagramComment(commentId, sanitizeCommentNoPrices(publicMsg, lang));
      return;
    }

    if (isRoadConditionIntent(text)) {
      const msg = buildRoadReply(lang, 'comment');
      await replyToInstagramComment(commentId, sanitizeCommentNoPrices(msg, lang));
      return;
    }

    if (isQuestionLike(text)) {
      const reply = buildDefault(lang);
      await replyToInstagramComment(commentId, sanitizeCommentNoPrices(reply, lang));
      return;
    }

    // Non-question: appreciation
    const nice = lang === 'ur'
      ? `محبت کا شکریہ! ${BRAND} میں آپ کا استقبال ہے۔ ${contactLineByLang('ur')}`
      : lang === 'roman-ur'
        ? `Shukriya! ${BRAND} mein aap ka khair maqdam hai. ${contactLineByLang('roman-ur')}`
        : `Thank you! ${BRAND} looks forward to hosting you. ${contactLineByLang('en')}`;
    await replyToInstagramComment(commentId, sanitizeCommentNoPrices(nice, lang));
  } catch (e) { logErr(e); }
}

// IG public reply
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

// IG account info (username) to prevent self-replies; cached
async function getIGAccountInfo(pageId) {
  const key = `igacct:${pageId}`;
  if (igAccountCache.has(key)) return igAccountCache.get(key);
  const url = `https://graph.facebook.com/v19.0/${pageId}`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN, fields: 'username,name' };
  const { data } = await axios.get(url, { params, timeout: 10000 });
  igAccountCache.set(key, data);
  return data;
}

/* =========================
   SHARED DM HANDLER
   ========================= */
async function handleDirectMessage(psid, text, opts = { channel: 'messenger' }) {
  const lang = detectLanguage(text);

  try {
    if (isInfluencerIntent(text)) {
      return sendText(psid, buildInfluencerDM(lang));
    }
    if (isPricingIntent(text)) {
      return sendText(psid, buildPriceDM(lang));
    }
    if (isRoadConditionIntent(text)) {
      return sendText(psid, buildRoadReply(lang, 'dm'));
    }
    if (isGreetingSmallTalk(text)) {
      return sendText(psid, buildSmallTalk(lang));
    }

    // Fallback deterministic help
    return sendText(psid, buildDefault(lang));
  } catch (e) { logErr(e); }
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
   ADMIN HELPERS (optional)
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
    res.json({
      ok: true,
      env: {
        PAGE_ACCESS_TOKEN: Boolean(PAGE_ACCESS_TOKEN),
        IG_MANAGE_TOKEN: Boolean(IG_MANAGE_TOKEN),
        RESORT_COORDS
      }
    });
  } catch (e) {
    console.error('status error:', e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =========================
   START
   ========================= */
app.listen(PORT, () => console.log(`🚀 ${BRAND} Bot listening on :${PORT}`));
