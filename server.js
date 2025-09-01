// server.js — Roameo Resorts omni-channel bot (GPT brain; no intent tree)
// Channels: FB DMs + FB comments + IG DMs + IG comments
// Policies enforced here:
//  - All replies come from GPT brain (lib/brain.js). No hand-coded intents.
//  - Public comments NEVER show numeric prices (scrub as guard).
//  - If a public comment asks for prices, also send a private DM with prices.
//  - DMs append "WhatsApp + Website" CTA.

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const { LRUCache } = require("lru-cache");
const { askBrain } = require("./lib/brain");

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV & CONSTANTS
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.verify_token || process.env.VERIFY_TOKEN || "verify_dev";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// IG token (can reuse PAGE token if scoped)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Brand constants
const BRAND_USERNAME = "roameoresorts"; // avoid self-replies
const WHATSAPP_NUMBER = "03558000078"; // IG comments (number only rule if you want)
const WHATSAPP_LINK   = process.env.ROAMEO_WHATSAPP_LINK || "https://wa.me/923558000078"; // DMs + FB comments
const SITE_URL        = process.env.ROAMEO_WEBSITE_LINK || "https://www.roameoresorts.com/";
const SITE_SHORT      = new URL(SITE_URL).hostname;

// Limits
const MAX_OUT_CHAR = 800;

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn("⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN");
}
if (!process.env.OPENAI_API_KEY) {
  console.warn("ℹ️ OPENAI_API_KEY not set. Brain cannot reply.");
}

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(bodyParser.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h

/* =========================
   BASIC ROUTES
   ========================= */
app.get("/", (_req, res) => res.send("Roameo Omni Bot (GPT) running"));

/* =========================
   VERIFY
   ========================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"] || req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* =========================
   SECURITY
   ========================= */
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

/* =========================
   HELPERS
   ========================= */
function splitToChunks(s, limit = MAX_OUT_CHAR) {
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
async function sendBatched(psid, textOrArray) {
  const parts = Array.isArray(textOrArray) ? textOrArray : [textOrArray];
  for (const p of parts) {
    for (const chunk of splitToChunks(p, MAX_OUT_CHAR)) {
      await sendText(psid, chunk);
    }
  }
}

// Guard: NEVER allow numeric prices in public comments, even if GPT makes a mistake
function stripPricesForComments(s) {
  return String(s || "").replace(/\b(?:PKR|Rs\.?|Rupees?)\b[\s:.,\d→%\-]+/gi, "[rates shared in DM]");
}

// Simple detector: did the public comment ask for prices?
function isPricingIntent(text = "") {
  const t = String(text).toLowerCase();
  return /\b(price|prices|pricing|rate|rates|tariff|cost|charges?|rent|rental)\b/.test(t)
      || /قیمت|کرایہ|ریٹ|نرخ/.test(text)
      || /\bkitna|kitni|kitne|kitnay\b/i.test(text);
}

function logErr(err) {
  const payload = err?.response?.data || err.message || err;
  if (payload?.error) console.error("FB/IG API error", payload);
  else console.error("💥 Handler error:", payload);
}

/* =========================
   Brain glue (no intents)
   ========================= */
function surfaceFor({ isComment }) {
  return isComment ? "comment" : "dm";
}

async function buildReply({ text, isComment }) {
  const surface = surfaceFor({ isComment });
  const out = await askBrain({ text, surface });
  let message = out.message || "We’re here to help at Roameo Resorts! 💚";

  if (surface === "comment") {
    // Guard against accidental numeric prices in public
    message = stripPricesForComments(message);
    return message;
  }

  // DMs → CTA footer
  return `${message}\n\nWhatsApp: ${WHATSAPP_LINK} • Website: ${SITE_SHORT}`;
}

/* =========================
   WEBHOOKS & ROUTERS
   ========================= */
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
          for (const ev of entry.messaging) await routeMessengerEvent(ev, { source: "messaging" }).catch(logErr);
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) await routePageChange(change).catch(logErr);
        }
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            // We keep it simple: ignore standby unless you want to take thread control
          }
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

/* =========================
   FB Messenger (DMs)
   ========================= */
async function routeMessengerEvent(event, _ctx) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const text = (event.message.text || "").trim();
    return handleTextMessage(event.sender.id, text, { channel: "messenger" });
  }
  if (event.postback?.payload && event.sender?.id) {
    return handleTextMessage(event.sender.id, "help", { channel: "messenger" });
  }
}

/* =========================
   FB Page Comments
   ========================= */
async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(url, { message: _trimForComment(message) }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
async function fbPrivateReplyToComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(url, { message: splitToChunks(message)[0] }, { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 });
}
function isSelfComment(v = {}, platform = "facebook") {
  const from = v.from || {};
  if (platform === "instagram") return from.username && from.username.toLowerCase() === BRAND_USERNAME.toLowerCase();
  return (from.name || "").toLowerCase().includes("roameo");
}

async function routePageChange(change) {
  if (change.field !== "feed") return;
  const v = change.value || {};
  if (v.item === "comment" && v.comment_id) {
    const text = (v.message || "").trim();
    if (v.verb && v.verb !== "add") return;
    if (isSelfComment(v, "facebook")) return;

    try {
      // Public reply (scrubbed)
      const publicReply = await buildReply({ text, isComment: true });
      await replyToFacebookComment(v.comment_id, publicReply);

      // If user asked for prices, send a private DM with prices too
      if (isPricingIntent(text)) {
        const dmReply = await buildReply({ text: "Please share prices", isComment: false });
        await fbPrivateReplyToComment(v.comment_id, dmReply);
      }
    } catch (e) { logErr(e); }
  }
}

/* =========================
   Instagram (DMs + Comments)
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    const igUserId = event.sender.id;
    const text = (event.message.text || "").trim();
    const reply = await buildReply({ text, isComment: false });
    return sendBatched(igUserId, reply);
  }
}
async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(url, { message: _trimForComment(message) }, { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 });
}
async function igPrivateReplyToComment(pageId, commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
  const payload = { recipient: { comment_id: commentId }, message: { text: splitToChunks(message)[0] } };
  await axios.post(url, payload, { params, timeout: 10000 });
}
async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const isComment = (change.field || "").toLowerCase().includes("comment") || (v.item === "comment");
  if (isComment && (v.comment_id || v.id)) {
    const commentId = v.comment_id || v.id;
    const text = (v.text || v.message || "").trim();
    if (v.verb && v.verb !== "add") return;
    if (isSelfComment(v, "instagram")) return;

    try {
      // Public reply (scrubbed)
      const publicReply = await buildReply({ text, isComment: true });
      await replyToInstagramComment(commentId, publicReply);

      // If user asked for prices, send a private DM with prices too
      if (isPricingIntent(text)) {
        const dmReply = await buildReply({ text: "Please share prices", isComment: false });
        await igPrivateReplyToComment(pageId, commentId, dmReply);
      }
    } catch (e) { logErr(e); }
  }
}

/* =========================
   Shared DM handler
   ========================= */
async function handleTextMessage(psid, text, _opts = { channel: "messenger" }) {
  const reply = await buildReply({ text, isComment: false });
  await sendBatched(psid, reply);
}

/* =========================
   SEND API
   ========================= */
async function sendText(psid, text) {
  const url = "https://graph.facebook.com/v19.0/me/messages";
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } };
  await axios.post(url, payload, { params, timeout: 10000 });
}
function _trimForComment(s, limit = MAX_OUT_CHAR) {
  const str = String(s || "");
  if (str.length <= limit) return str;
  return str.slice(0, limit - 1).trim() + "…";
}

/* =========================
   ADMIN HELPERS
   ========================= */
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}
app.post("/admin/subscribe", requireAdmin, async (_req, res) => {
  const subscribed_fields = ["messages","messaging_postbacks","messaging_optins","message_deliveries","message_reads","feed"];
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const { data } = await axios.post(url, { subscribed_fields }, { params, timeout: 10000 });
    res.json({ ok: true, data, subscribed_fields });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});
app.get("/admin/status", requireAdmin, async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN, fields: "subscribed_fields" };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    res.json({
      ok: true,
      subscribed_apps: data,
      env: {
        OPENAI_ENABLED: Boolean(process.env.OPENAI_API_KEY),
        WHATSAPP_LINK: WHATSAPP_LINK,
        SITE_URL: SITE_URL
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =========================
   START
   ========================= */
app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
