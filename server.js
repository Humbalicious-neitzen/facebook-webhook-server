// server.js — Roameo Resorts omni-channel bot (brain-first)
// Surfaces: FB Messenger DMs, FB comments, IG DMs, IG comments
// All wording is decided by lib/brain.js (ChatGPT). This file only routes & sends.

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const { LRUCache } = require("lru-cache");
const { askBrain } = require("./lib/brain"); // <- our single source of truth

const app = express();
const PORT = process.env.PORT || 10000;

/* =========================
   ENV
   ========================= */
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN =
  process.env.verify_token || process.env.VERIFY_TOKEN || "verify_dev";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

// IG token (can reuse PAGE token if scoped)
const IG_MANAGE_TOKEN = process.env.IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN;

// Admin (optional)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Flags
const AUTO_REPLY_ENABLED = String(
  process.env.AUTO_REPLY_ENABLED || "true"
).toLowerCase() === "true";
const ALLOW_REPLY_IN_STANDBY = String(
  process.env.ALLOW_REPLY_IN_STANDBY || "true"
).toLowerCase() === "true";
const AUTO_TAKE_THREAD_CONTROL = String(
  process.env.AUTO_TAKE_THREAD_CONTROL || "false"
).toLowerCase() === "true";

// Brand handle to avoid replying to our own comments on IG
const BRAND_USERNAME =
  (process.env.BRAND_USERNAME || "roameoresorts").toLowerCase();

if (!APP_SECRET || !VERIFY_TOKEN || !PAGE_ACCESS_TOKEN) {
  console.warn("⚠️ Missing required env vars: APP_SECRET, VERIFY_TOKEN, PAGE_ACCESS_TOKEN");
}

/* =========================
   MIDDLEWARE & CACHES
   ========================= */
app.use(
  bodyParser.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Dedupe top-level entries
const dedupe = new LRUCache({ max: 5000, ttl: 1000 * 60 * 60 }); // 1h

/* =========================
   BASIC ROUTES
   ========================= */
app.get("/", (_req, res) => res.send("Roameo Omni Bot (brain-first) running"));

/* =========================
   VERIFY
   ========================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* =========================
   SECURITY
   ========================= */
function verifySignature(req) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig || !req.rawBody || !APP_SECRET) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/* =========================
   SEND HELPERS
   ========================= */
async function sendText(psid, text) {
  const url = "https://graph.facebook.com/v19.0/me/messages";
  const params = { access_token: PAGE_ACCESS_TOKEN };
  const payload = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { text },
  };
  await axios.post(url, payload, { params, timeout: 10000 });
}

async function replyToFacebookComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/comments`;
  await axios.post(
    url,
    { message },
    { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 }
  );
}

async function fbPrivateReplyToComment(commentId, message) {
  // Optional: send a private reply to a comment (not always delivered on IG)
  const url = `https://graph.facebook.com/v19.0/${commentId}/private_replies`;
  await axios.post(
    url,
    { message },
    { params: { access_token: PAGE_ACCESS_TOKEN }, timeout: 10000 }
  );
}

async function replyToInstagramComment(commentId, message) {
  const url = `https://graph.facebook.com/v19.0/${commentId}/replies`;
  await axios.post(
    url,
    { message },
    { params: { access_token: IG_MANAGE_TOKEN }, timeout: 10000 }
  );
}

async function igPrivateReplyToComment(pageId, commentId, message) {
  // Sends a private DM to the commenter thread from the business account
  const url = `https://graph.facebook.com/v19.0/${pageId}/messages`;
  const params = { access_token: IG_MANAGE_TOKEN || PAGE_ACCESS_TOKEN };
  const payload = { recipient: { comment_id: commentId }, message: { text: message } };
  await axios.post(url, payload, { params, timeout: 10000 });
}

async function takeThreadControl(psid) {
  const url = `https://graph.facebook.com/v19.0/me/take_thread_control`;
  const params = { access_token: PAGE_ACCESS_TOKEN };
  try {
    await axios.post(url, { recipient: { id: psid } }, { params, timeout: 10000 });
  } catch (e) {
    console.error("take_thread_control error:", e?.response?.data || e.message);
  }
}

/* =========================
   ROUTERS
   ========================= */
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(403);
  res.sendStatus(200);

  const body = req.body || {};
  try {
    if (body.object === "page") {
      for (const entry of body.entry || []) {
        const key = `page:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue;
        dedupe.set(key, true);

        // Messenger DMs
        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            await routeMessengerEvent(ev, { source: "messaging" }).catch(logErr);
          }
        }
        // FB comments/changes
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            await routeFacebookChange(change).catch(logErr);
          }
        }
        // Standby
        if (Array.isArray(entry.standby)) {
          for (const ev of entry.standby) {
            if (!ALLOW_REPLY_IN_STANDBY) continue;
            if (AUTO_TAKE_THREAD_CONTROL && ev.sender?.id) {
              await takeThreadControl(ev.sender.id).catch(() => {});
            }
            await routeMessengerEvent(ev, { source: "standby" }).catch(logErr);
          }
        }
      }
      return;
    }

    // Instagram changes (DMs + comments)
    if (body.object === "instagram") {
      for (const entry of body.entry || []) {
        const pageId = entry.id;
        const key = `ig:${entry.id}:${entry.time || Date.now()}`;
        if (dedupe.has(key)) continue;
        dedupe.set(key, true);

        if (Array.isArray(entry.messaging)) {
          for (const ev of entry.messaging) {
            await routeInstagramMessage(ev).catch(logErr);
          }
        }
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            await routeInstagramChange(change, pageId).catch(logErr);
          }
        }
      }
      return;
    }
  } catch (e) {
    logErr(e);
  }
});

/* =========================
   MESSENGER DM
   ========================= */
async function routeMessengerEvent(event, ctx = { source: "messaging" }) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    if (ctx.source === "standby" && !ALLOW_REPLY_IN_STANDBY) return;
    if (ctx.source === "standby" && AUTO_TAKE_THREAD_CONTROL) {
      await takeThreadControl(event.sender.id).catch(() => {});
    }
    if (!AUTO_REPLY_ENABLED) return;

    const text = event.message.text || "";
    const brain = await askBrain({ text, surface: "dm" });
    await sendText(event.sender.id, brain.message);
  }
  if (event.postback?.payload && event.sender?.id) {
    const brain = await askBrain({ text: "help", surface: "dm" });
    await sendText(event.sender.id, brain.message);
  }
}

/* =========================
   FACEBOOK COMMENTS
   ========================= */
function isSelfCommentFacebook(v = {}) {
  const from = v.from || {};
  return (from.name || "").toLowerCase().includes("roameo");
}

async function routeFacebookChange(change) {
  if (change.field !== "feed") return;
  const v = change.value || {};
  if (v.item === "comment" && v.comment_id) {
    if (v.verb && v.verb !== "add") return;
    if (isSelfCommentFacebook(v)) return;
    if (!AUTO_REPLY_ENABLED) return;

    const text = (v.message || "").trim();
    const brain = await askBrain({ text, surface: "comment" });
    await replyToFacebookComment(v.comment_id, brain.message);

    // Optional: also send a private reply (kept generic to avoid price leaks)
    // const dmBrain = await askBrain({ text, surface: "dm" });
    // await fbPrivateReplyToComment(v.comment_id, dmBrain.message);
  }
}

/* =========================
   INSTAGRAM DMs + COMMENTS
   ========================= */
async function routeInstagramMessage(event) {
  if (event.delivery || event.read || event.message?.is_echo) return;
  if (event.message && event.sender?.id) {
    if (!AUTO_REPLY_ENABLED) return;
    const text = event.message.text || "";
    const brain = await askBrain({ text, surface: "dm" });
    // IG DM uses the same send API as FB Messenger
    await sendText(event.sender.id, brain.message);
  }
}

function isSelfCommentInstagram(v = {}) {
  const from = v.from || {};
  return (from.username || "").toLowerCase() === BRAND_USERNAME;
}

async function routeInstagramChange(change, pageId) {
  const v = change.value || {};
  const isComment =
    (change.field || "").toLowerCase().includes("comment") ||
    v.item === "comment";
  if (!isComment) return;

  const commentId = v.comment_id || v.id;
  if (!commentId) return;
  if (v.verb && v.verb !== "add") return;
  if (isSelfCommentInstagram(v)) return;
  if (!AUTO_REPLY_ENABLED) return;

  const text = (v.text || v.message || "").trim();
  const brain = await askBrain({ text, surface: "comment" });
  await replyToInstagramComment(commentId, brain.message);

  // Optional: also DM the commenter thread privately
  // const dmBrain = await askBrain({ text, surface: "dm" });
  // await igPrivateReplyToComment(pageId, commentId, dmBrain.message);
}

/* =========================
   ADMIN HELPERS (optional)
   ========================= */
function requireAdmin(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN)
    return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/admin/subscribe", requireAdmin, async (_req, res) => {
  const subscribed_fields = [
    "messages",
    "messaging_postbacks",
    "messaging_optins",
    "message_deliveries",
    "message_reads",
    "feed",
  ];
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = { access_token: PAGE_ACCESS_TOKEN };
    const { data } = await axios.post(
      url,
      { subscribed_fields },
      { params, timeout: 10000 }
    );
    res.json({ ok: true, data, subscribed_fields });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

app.get("/admin/status", requireAdmin, async (_req, res) => {
  try {
    const url = `https://graph.facebook.com/v19.0/me/subscribed_apps`;
    const params = {
      access_token: PAGE_ACCESS_TOKEN,
      fields: "subscribed_fields",
    };
    const { data } = await axios.get(url, { params, timeout: 10000 });
    res.json({
      ok: true,
      subscribed_apps: data,
      env: {
        AUTO_REPLY_ENABLED,
        ALLOW_REPLY_IN_STANDBY,
        AUTO_TAKE_THREAD_CONTROL,
        OPENAI_ENABLED: Boolean(process.env.OPENAI_API_KEY),
        BRAND_USERNAME,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e.message });
  }
});

/* =========================
   LOG
   ========================= */
function logErr(err) {
  const payload = err?.response?.data || err.message || err;
  console.error("💥 Handler error:", payload);
}

app.listen(PORT, () => console.log(`🚀 Listening on :${PORT}`));
