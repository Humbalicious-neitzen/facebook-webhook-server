// server.js — Roameo Resorts omni-channel bot
// FB DMs + FB comments + IG DMs + IG comments
// Uses brain.js for everything EXCEPT: pricing in DMs is deterministic here.
// Public comments: numeric prices are never shown; if user asks price in a comment,
// we DM the full price card automatically.

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const { LRUCache } = require("lru-cache");
const { askBrain, detectLang } = require("./lib/brain");

const app = express();
const PORT = process.env.PORT || 10000;

/* ==== ENV ==== */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || "verify_dev";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

const ROAMEO_WHATSAPP_LINK = process.env.ROAMEO_WHATSAPP_LINK || "https://wa.me/923558000078";
const ROAMEO_WEBSITE_LINK  = process.env.ROAMEO_WEBSITE_LINK  || "https://www.roameoresorts.com/";
const INSTAGRAM_PROFILE    = process.env.ROAMEO_INSTAGRAM     || "https://www.instagram.com/roameoresorts/";

// Prices you control (PKR). Edit anytime without touching brain.js
const PRICE_DELUXE_BASE    = Number(process.env.PRICE_DELUXE_BASE    || 30000);
const PRICE_EXECUTIVE_BASE = Number(process.env.PRICE_EXECUTIVE_BASE || 50000);
const DISCOUNT_PERCENT     = Number(process.env.DISCOUNT_PERCENT     || 40);
const DISCOUNT_VALID_UNTIL = process.env.DISCOUNT_VALID_UNTIL || "6th September 2025";

// Limits
const MAX_OUT_CHAR = 800;

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn("⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("ℹ️ OPENAI_API_KEY not set. Brain replies will fail.");
}

/* ==== utils ==== */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 });

function verifySignature(req) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig || !req.rawBody || !APP_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

function chunks(s, limit = MAX_OUT_CHAR) {
  const out = [];
  let str = (s || "").trim();
  while (str.length > limit) {
    let cut = Math.max(
      str.lastIndexOf("\n", limit),
      str.lastIndexOf(". ", limit),
      str.lastIndexOf("•", limit),
      str.lastIndexOf("—", limit),
      str.lastIndexOf("!", limit),
      str.lastIndexOf("?", limit)
    );
    if (cut <= 0) cut = limit;
    out.push(str.slice(0, cut).trim());
    str = str.slice(cut).trim();
  }
  if (str) out.push(str);
  return out;
}
async function sendBatched(psid, text) {
  for (const c of chunks(text)) await sendText(psid, c);
}
async function sendText(psid, text) {
  const url = "https://graph.facebook.com/v19.0/me/messages";
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

function priceAsked(text="") {
  const t = text.toLowerCase();
  return /\b(price|prices|pricing|rate|rates|tariff|cost|charges?|rent|rental)\b/.test(t)
      || /قیمت|کرایہ|ریٹ|نرخ/.test(text)
      || /\bkitna|kitni|kitne|kitnay\b/i.test(text);
}
function scrubPricesForPublic(s) {
  return String(s||"").replace(/\b(?:PKR|Rs\.?|Rupees?)\b[\s:.,\d→/%\-]+/gi, "[rates shared in DM]");
}
function fm(n){ return Number(n).toLocaleString("en-PK"); }
function discounted(n){ return Math.round(n * (1 - DISCOUNT_PERCENT/100)); }

/* ==== deterministic DM pricing (never left to GPT) ==== */
function dmPriceCard(userText="") {
  const lang = detectLang(userText);
  const dB = PRICE_DELUXE_BASE, eB = PRICE_EXECUTIVE_BASE;
  const dD = discounted(dB),   eD = discounted(eB);

  if (lang === "ur") {
    return [
`Roameo Resorts میں اس وقت ${DISCOUNT_PERCENT}% محدود مدت کی رعایت—صرف ${DISCOUNT_VALID_UNTIL} تک!`,
`📍 ڈسکاؤنٹڈ ریٹس:`,
`ڈیلکس ہٹ — PKR ${fm(dB)}\n✨ فلیٹ ${DISCOUNT_PERCENT}% آف → PKR ${fm(dD)}`,
`ایگزیکٹو ہٹ — PKR ${fm(eB)}\n✨ فلیٹ ${DISCOUNT_PERCENT}% آف → PKR ${fm(eD)}`,
`شرائط:\n• تمام ٹیکسز شامل\n• فی بُکنگ 2 مہمانوں کے لیے ناشتہ مفت\n• اضافی ناشتہ: PKR 500 فی فرد\n• کنفرمیشن کے لیے 50% ادائیگی ضروری\n• آفر ${DISCOUNT_VALID_UNTIL} تک مؤثر`,
`بکنگ یا دستیابی کے لیے میسج کر دیں۔\n\nWhatsApp: ${ROAMEO_WHATSAPP_LINK} • Website: ${ROAMEO_WEBSITE_LINK}`
    ].join("\n\n");
  }
  if (lang === "roman-ur") {
    return [
`Roameo Resorts par ${DISCOUNT_PERCENT}% limited-time discount — ${DISCOUNT_VALID_UNTIL} tak!`,
`📍 Discounted Rates:`,
`Deluxe Hut — PKR ${fm(dB)}\n✨ Flat ${DISCOUNT_PERCENT}% Off → PKR ${fm(dD)}`,
`Executive Hut — PKR ${fm(eB)}\n✨ Flat ${DISCOUNT_PERCENT}% Off → PKR ${fm(eD)}`,
`T&Cs:\n• Taxes included\n• Breakfast for 2 per booking\n• Extra breakfast PKR 500/person\n• 50% advance to confirm\n• Offer valid till ${DISCOUNT_VALID_UNTIL}`,
`Availability/book ke liye bata dein.\n\nWhatsApp: ${ROAMEO_WHATSAPP_LINK} • Website: ${ROAMEO_WEBSITE_LINK}`
    ].join("\n\n");
  }
  return [
`At **Roameo Resorts**, we’re running a ${DISCOUNT_PERCENT}% limited-time discount (valid till ${DISCOUNT_VALID_UNTIL}).`,
`📍 Discounted Rates:`,
`Deluxe Hut — PKR ${fm(dB)}\n✨ Flat ${DISCOUNT_PERCENT}% Off → PKR ${fm(dD)}`,
`Executive Hut — PKR ${fm(eB)}\n✨ Flat ${DISCOUNT_PERCENT}% Off → PKR ${fm(eD)}`,
`T&Cs:\n• Rates include taxes\n• Breakfast for 2 per booking\n• Extra breakfast PKR 500/person\n• 50% advance to confirm\n• Offer valid till ${DISCOUNT_VALID_UNTIL}`,
`Tell us your dates and guests and we’ll get you set.\n\nWhatsApp: ${ROAMEO_WHATSAPP_LINK} • Website: ${ROAMEO_WEBSITE_LINK}`
  ].join("\n\n");
}

/* ==== one router to the brain + deterministic pricing ==== */
async function buildReply({ text, isComment }) {
  // 1) If public comment asks for price → public scrubbed reply + DM the card.
  // 2) If DM asks for price → deterministic card.
  const surface = isComment ? "comment" : "dm";

  if (!isComment && priceAsked(text)) {
    return { message: dmPriceCard(text), alsoDM: null };
  }

  // Ask GPT brain (it already: brand-first, links vague Qs to Roameo, routes “video/exterior” to Instagram, “manager/contact” to WhatsApp)
  const brain = await askBrain({ text, surface });

  let message = String(brain.message || "").trim();
  if (!message) message = "At Roameo Resorts, we’re here to help with plans, prices and availability.";

  // Public: never show numbers if GPT accidentally mentioned any
  if (isComment) {
    message = scrubPricesForPublic(message);
  } else {
    // DMs: always add CTA
    message += `\n\nWhatsApp: ${ROAMEO_WHATSAPP_LINK} • Website: ${ROAMEO_WEBSITE_LINK}`;
  }

  // If the original public comment was a price question, signal caller to DM the price card too.
  const alsoDM = isComment && priceAsked(text) ? dmPriceCard(text) : null;

  return { message, alsoDM };
}

/* ==== webhook plumbing ==== */
app.get("/", (_req, res) => res.send("Roameo Omni Bot (GPT) running"));
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"] || req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  const body = req.body || {};
  try {
    if (body.object === "page") {
      for (const entry of (body.entry || [])) {
        const key = `page:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) await routeMessengerEvent(ev).catch(console.error);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routeFacebookChange(change).catch(console.error);
        }
      }
      return;
    }

    if (body.object === "instagram") {
      for (const entry of (body.entry || [])) {
        const pageId = entry.id;
        const key = `ig:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue; dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) await routeInstagramMessage(ev).catch(console.error);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routeInstagramChange(change, pageId).catch(console.error);
        }
      }
      return;
    }
  } catch (e) {
    console.error("💥 Handler error:", e?.response?.data || e.message || e);
  }
});

/* ==== FB: DMs ==== */
async function routeMessengerEvent(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const text = (event.message.text || "").trim();
    const { message } = await buildReply({ text, isComment: false });
    return sendBatched(event.sender.id, message);
  }
}

/* ==== FB: comments ==== */
async function routeFacebookChange(change) {
  if (change.field !== "feed") return;
  const v = change.value || {};
  if (v.item === "comment" && v.comment_id && (!v.verb || v.verb === "add")) {
    // avoid replying to ourselves
    if ((v.from?.name || "").toLowerCase().includes("roameo")) return;

    const text = (v.message || "").trim();
    const { message, alsoDM } = await buildReply({ text, isComment: true });

    // public reply
    await axios.post(`https://graph.facebook.com/v19.0/${v.comment_id}/comments`,
      { message }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });

    // private reply with prices if asked
    if (alsoDM) {
      await axios.post(`https://graph.facebook.com/v19.0/${v.comment_id}/private_replies`,
        { message: chunks(alsoDM)[0] }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
    }
  }
}

/* ==== IG: DMs ==== */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const text = (event.message.text || "").trim();
    const { message } = await buildReply({ text, isComment: false });
    return sendBatched(event.sender.id, message);
  }
}

/* ==== IG: comments ==== */
async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const isComment = (change.field || "").toLowerCase().includes("comment") || v.item === "comment";
  if (!isComment) return;

  const commentId = v.comment_id || v.id;
  if (!commentId || (v.verb && v.verb !== "add")) return;
  if ((v.from?.username || "").toLowerCase() === "roameoresorts") return;

  const text = (v.text || v.message || "").trim();
  const { message, alsoDM } = await buildReply({ text, isComment: true });

  // public reply
  await axios.post(`https://graph.facebook.com/v19.0/${commentId}/replies`,
    { message }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });

  // private reply with prices if asked
  if (alsoDM) {
    const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
    const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
    const payload = { recipient: { comment_id: commentId }, message: { text: chunks(alsoDM)[0] } };
    await axios.post(url, payload, { params, timeout: 10000 });
  }
}

/* ==== admin ==== */
app.get("/admin/status", async (_req, res) => {
  res.json({
    ok: true,
    env: {
      prices: { deluxe: PRICE_DELUXE_BASE, executive: PRICE_EXECUTIVE_BASE, discount: DISCOUNT_PERCENT, until: DISCOUNT_VALID_UNTIL },
      whatsapp: ROAMEO_WHATSAPP_LINK,
      website: ROAMEO_WEBSITE_LINK,
      instagram: INSTAGRAM_PROFILE
    }
  });
});

/* ==== start ==== */
app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
