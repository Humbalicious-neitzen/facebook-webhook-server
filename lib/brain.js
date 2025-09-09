// lib/brain.js
// Centralized "what to say" brain with Vision + tools + robust retries.

const axios = require("axios");

// ---------- CONFIG ----------
const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // stronger at vision/OCR

// For price card passthrough
const PRICES_TXT = String(process.env.ROAMEO_PRICES_TEXT || "").replaceAll("\\n", "\n");

// Brand links (used inside prompt)
const NAME = process.env.ROAMEO_LOCATION_NAME   || "Roameo Resorts";
const MAPS = process.env.ROAMEO_MAPS_LINK       || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6";
const WA   = process.env.ROAMEO_WHATSAPP_LINK   || "https://wa.me/923558000078";
const IG   = process.env.ROAMEO_INSTAGRAM_LINK  || "https://www.instagram.com/roameoresorts/";
const SITE = process.env.ROAMEO_WEBSITE_LINK    || "https://www.roameoresorts.com/";

// ---------- OPENAI HELPERS ----------
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  timeout: 65000, // Vision can take longer
});

// simple retry with backoff for transient errors/timeouts
async function withRetry(fn, { tries = 3, baseDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const retriable = !status || (status >= 500 && status < 600);
      if (!retriable && err.code !== "ECONNABORTED") break;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// ---------- SYSTEM PROMPT ----------
const SYSTEM = `
You are the official Concierge for Roameo Resorts (name: Romeo).

Tone:
- Warm, enthusiastic, professional. Helpful but discerning.
- Auto-match user's language (English / Urdu script / Roman Urdu).

Hard Rules:
- Don't fabricate facts, prices, or availability.
- Discounts: We do not offer discounts; instead highlight included value.
- Always share: WhatsApp: ${WA} • Website: ${SITE}
- If asked for prices in DM, paste the exact price card verbatim (no extra text).
- In public comments: never show numbers or prices; invite to DM.

Vision / Images:
- If an image is provided (e.g., screenshot of a post/offer/flyer/menu/DM, scenic photo, room photo):
  - Perform OCR and read any text/logos/numbers visibly present in the image.
  - Summarize what's shown and answer the user's question precisely.
  - If it's about someone else's offer, don't compare prices; pivot to Roameo’s value.
  - If unclear, ask a brief, targeted clarification.
- If an IG/FB screenshot of a conversation or a post is provided, treat it as user context and respond helpfully.

Channels:
- surface="comment": 1–2 short lines; never post any numeric amounts. Always invite to DM/WhatsApp.
- surface="dm": normal conversation. If user clearly asks for price/rate/charges, send ONLY the price card verbatim (no extra text).

Bridging Strategy (for all responses except pure price card):
- First, answer exactly what they asked.
- Then add one short line that ties back to Roameo (view, cozy huts, riverside, etc.)
- Close with contact info.

Output JSON:
{
  "message": "final text",
  "language": "en" | "ur" | "roman-ur"
}
`.trim();

function responseSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "roameo_brain_v1",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          message:  { type: "string" },
          language: { type: "string", enum: ["en","ur","roman-ur"] }
        },
        required: ["message","language"]
      }
    }
  };
}

// ---------- USER MESSAGE BUILDER ----------
function constructUserMessage({ surface, text, imageUrl }) {
  const parts = [];

  // Primary text payload to the model (includes small rules for the run)
  parts.push({
    type: "text",
    text: JSON.stringify({
      surface,
      text,
      rules: {
        dm_prices_verbatim: true,
        comments_hide_prices: true
      }
    })
  });

  // Attach image if present
  if (imageUrl) {
    parts.push({
      type: "image_url",
      image_url: { url: imageUrl, detail: "auto" }
    });
  }

  return { role: "user", content: parts };
}

// ---------- TOOLS (server injects actual functions) ----------
const tools = [
  {
    type: "function",
    function: {
      name: "getWeatherForecast",
      description: "5-day weather forecast for the resort",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "findNearbyPlaces",
      description: "Places of interest around the resort",
      parameters: {
        type: "object",
        properties: {
          categories: { type: "string" },
          radius:     { type: "number" },
          limit:      { type: "number" }
        },
        required: ["categories"]
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRouteInfo",
      description: "Routing/time/distance from user origin to Roameo",
      parameters: {
        type: "object",
        properties: { origin: { type: "string" } },
        required: ["origin"]
      },
    },
  },
];

// ---------- MAIN ENTRY ----------
async function askBrain({ text, imageUrl, surface, history = [] }) {
  const historyMessages = history.slice(-10);
  const userMessage = constructUserMessage({ surface, text, imageUrl });
  const messages = [{ role: "system", content: SYSTEM }, ...historyMessages, userMessage];

  try {
    // Smart path: if no image and no tool hints, ask for final JSON directly
    const isSimple = !imageUrl && !/weather|route|nearby/i.test(text || "");
    const initialPayload = {
      model: MODEL,
      messages,
      ...(isSimple ? { response_format: responseSchema() } : { tools, tool_choice: "auto" }),
    };

    const initialData = await withRetry(() =>
      openai.post("/chat/completions", initialPayload)
    );

    const msg = initialData?.data?.choices?.[0]?.message;

    // No tool call → ensure JSON format
    if (!msg.tool_calls) {
      if (isSimple) {
        const parsed = JSON.parse(msg.content || "{}");
        return finalizeResponse(parsed, surface);
      }
      // ask for schema formatting as a second step
      const fmt = await withRetry(() =>
        openai.post("/chat/completions", {
          model: MODEL,
          messages: [
            ...messages,
            { role: "assistant", content: msg.content || "…" },
            { role: "user", content: "Please format in the required JSON schema." },
          ],
          response_format: responseSchema(),
        })
      );
      const parsed = JSON.parse(fmt?.data?.choices?.[0]?.message?.content || "{}");
      return finalizeResponse(parsed, surface);
    }

    // Tool calls
    const toolCalls = msg.tool_calls || [];
    const availableTools = { getWeatherForecast, findNearbyPlaces, getRouteInfo };
    const toolMsgs = [];
    for (const call of toolCalls) {
      const fn = availableTools[call.function.name];
      if (!fn) continue;
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await fn(args);
      toolMsgs.push({
        tool_call_id: call.id,
        role: "tool",
        name: call.function.name,
        content: JSON.stringify(result),
      });
    }

    const final = await withRetry(() =>
      openai.post("/chat/completions", {
        model: MODEL,
        response_format: responseSchema(),
        messages: [...messages, msg, ...toolMsgs],
      })
    );

    const parsed = JSON.parse(final?.data?.choices?.[0]?.message?.content || "{}");
    return finalizeResponse(parsed, surface);

  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);
    const t = (text || "").trim();
    const urduScript = /[\u0600-\u06FF]/.test(t);
    const romanUr = /(ap|aap|price|kiraya|rate|kia|kya|hai|hain|krdo|kardo|kitna|kitni)/i.test(t) && !urduScript;
    const fallback = urduScript
      ? `کوئی تکنیکی مسئلہ درپیش ہے۔ براہِ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔ WhatsApp: ${WA}`
      : romanUr
        ? `System issue aa gaya hai. Thori dair baad try karein. WhatsApp: ${WA}`
        : `We ran into a technical issue. Please try again shortly. WhatsApp: ${WA}`;
    return { message: fallback, language: urduScript ? "ur" : romanUr ? "roman-ur" : "en" };
  }
}

// ---------- FINALIZER ----------
function finalizeResponse(parsed, surface) {
  if (!parsed || typeof parsed.message !== "string") {
    return { message: `Please try again shortly. WhatsApp: ${WA}`, language: "en" };
  }

  // Public comments must never leak prices/numbers
  if (surface === "comment") {
    const hasMoneyish =
      /\b(?:pkr|rs\.?|rupees|price|prices|pricing|rate|rates|tariff|rent|rental|per\s*night)\b/i.test(parsed.message) ||
      /\b\d{2,3}(?:[ ,]?\d{3})\b/.test(parsed.message);
    if (hasMoneyish) {
      parsed.message =
        parsed.language === "ur"
          ? "ریٹس کے لیے براہِ کرم DM/WhatsApp پر رابطہ کریں۔\nWhatsApp: " + WA + " • Website: " + SITE
          : parsed.language === "roman-ur"
            ? "Rates ke liye DM/WhatsApp par rabta karein.\nWhatsApp: " + WA + " • Website: " + SITE
            : "Please DM/WhatsApp us for rates and availability.\nWhatsApp: " + WA + " • Website: " + SITE;
    }
  }

  // If the model pasted the price card, enforce channel rules
  if (parsed.message && PRICES_TXT && parsed.message.includes(PRICES_TXT.slice(0, 20))) {
    if (surface === "comment") {
      parsed.message = "Please DM for rates!";
    } else {
      parsed.message = PRICES_TXT; // DM: only the card, no extra text
    }
  }

  return parsed;
}

// ---------- BUILT-IN TOOL STUBS (server injects real ones at runtime tests) ----------
async function getWeatherForecast() { return { error: "not wired" }; }
async function findNearbyPlaces()   { return { error: "not wired" }; }
async function getRouteInfo()       { return { error: "not wired" }; }

module.exports = {
  askBrain,
  constructUserMessage,
  getWeatherForecast,
  findNearbyPlaces,
  getRouteInfo
};
