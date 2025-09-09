// lib/brain.js
// Centralized "what to say" brain with Vision + tools + rate calculations.

const axios = require("axios");

// ---------- CONFIG ----------
const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o"; // strong vision/OCR

// Price card verbatim (from Render env). Keep line breaks as-is.
const PRICES_TXT = String(process.env.ROAMEO_PRICES_TEXT || "").replaceAll("\\n", "\n");

// Brand links (used inside prompt)
const NAME = process.env.ROAMEO_LOCATION_NAME   || "Roameo Resorts";
const MAPS = process.env.ROAMEO_MAPS_LINK       || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6";
const WA   = process.env.ROAMEO_WHATSAPP_LINK   || "https://wa.me/923558000078";
const IG   = process.env.ROAMEO_INSTAGRAM_LINK  || "https://www.instagram.com/roameoresorts/";
const SITE = process.env.ROAMEO_WEBSITE_LINK    || "https://www.roameoresorts.com/";

// ---------- OPENAI ----------
const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  timeout: 65000,
});

async function withRetry(fn, { tries = 3, baseDelay = 600 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } 
    catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const retriable = !status || (status >= 500 && status < 600) || err.code === "ECONNABORTED";
      if (!retriable) break;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// ---------- SYSTEM PROMPT ----------
const SYSTEM = `
You are "Romeo", the official Concierge for Roameo Resorts.

Tone:
- Warm, enthusiastic, professional. Auto-match user's language (English / Urdu script / Roman Urdu).

Currency / Pricing:
- Always use **PKR** — never switch to USD/$ unless the user explicitly asks for a currency conversion.
- The **soft-launch rate card** is defined by the environment and must be treated as the single source of truth. Do not change numbers.
- In **DMs**:
  - If the user asks for "prices/rates" generally, paste the **exact rate card verbatim** (no extra text).
  - If the user asks for **totals** for X nights/days (e.g., "2 nights Deluxe"), use the **calculateRates** tool to compute a PKR breakdown, then include a short helpful line and (optionally) the rate card below if useful.
- In **Public comments**: never show numbers or rates; invite to DM/WhatsApp.

Vision / Images:
- If an image is provided (post screenshot, flyer, price photo, menu, scenic shot), perform OCR and use visible text to answer precisely. If it's another hotel's price, avoid comparing; pivot to Roameo’s value.

Bridging Strategy (for all non-price-card-only responses):
- First answer exactly what they asked.
- Then add one short line tying back to Roameo (views, cozy huts, riverside, etc).
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
      name: "roameo_brain_v2",
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

// ---------- USER MESSAGE ----------
function constructUserMessage({ surface, text, imageUrl }) {
  const parts = [];
  parts.push({
    type: "text",
    text: JSON.stringify({
      surface,
      text,
      rules: {
        dm_prices_verbatim: true,
        dm_totals_use_tool: true,
        comments_hide_prices: true
      }
    })
  });
  if (imageUrl) {
    parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "auto" } });
  }
  return { role: "user", content: parts };
}

// ---------- TOOL DEFINITIONS ----------
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
      parameters: { type: "object", properties: { origin: { type: "string" } }, required: ["origin"] },
    },
  },
  {
    type: "function",
    function: {
      name: "calculateRates",
      description: "Calculate PKR totals from the soft-launch rate card for X nights. If hut is omitted, return both Deluxe and Executive.",
      parameters: {
        type: "object",
        properties: {
          nights: { type: "number", description: "Number of nights (>=1)" },
          days:   { type: "number", description: "If days provided, assume nights = days unless nights also provided." },
          hut:    { type: "string", enum: ["deluxe","executive","both"], description: "Which hut to calculate. Default both." },
        },
        required: []
      },
    },
  },
];

// ---------- MAIN ----------
async function askBrain({ text, imageUrl, surface, history = [] }) {
  const historyMessages = history.slice(-10);
  const userMessage = constructUserMessage({ surface, text, imageUrl });
  const messages = [{ role: "system", content: SYSTEM }, ...historyMessages, userMessage];

  try {
    const isSimple = !imageUrl && !/weather|route|nearby|night|nights|day|days|total|amount|bill|invoice|calculate|calculation/i.test(text || "");
    const payload = {
      model: MODEL,
      messages,
      ...(isSimple ? { response_format: responseSchema() } : { tools, tool_choice: "auto" }),
    };

    const first = await withRetry(() => openai.post("/chat/completions", payload));
    const msg = first?.data?.choices?.[0]?.message;

    if (!msg.tool_calls) {
      if (isSimple) {
        const parsed = JSON.parse(msg.content || "{}");
        return finalizeResponse(parsed, surface, text);
      }
      const fmt = await withRetry(() =>
        openai.post("/chat/completions", {
          model: MODEL,
          messages: [...messages, { role: "assistant", content: msg.content || "…" }, { role: "user", content: "Format in the required JSON schema." }],
          response_format: responseSchema(),
        })
      );
      const parsed = JSON.parse(fmt?.data?.choices?.[0]?.message?.content || "{}");
      return finalizeResponse(parsed, surface, text);
    }

    // Execute tools
    const availableTools = { getWeatherForecast, findNearbyPlaces, getRouteInfo, calculateRates };
    const toolMsgs = [];
    for (const call of (msg.tool_calls || [])) {
      const fn = availableTools[call.function.name];
      if (!fn) continue;
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await fn(args);
      toolMsgs.push({ tool_call_id: call.id, role: "tool", name: call.function.name, content: JSON.stringify(result) });
    }

    const final = await withRetry(() =>
      openai.post("/chat/completions", { model: MODEL, response_format: responseSchema(), messages: [...messages, msg, ...toolMsgs] })
    );

    const parsed = JSON.parse(final?.data?.choices?.[0]?.message?.content || "{}");
    return finalizeResponse(parsed, surface, text);

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

// ---------- FINALIZE ----------
function finalizeResponse(parsed, surface, userText = "") {
  if (!parsed || typeof parsed.message !== "string") {
    return { message: `Please try again shortly. WhatsApp: ${WA}`, language: "en" };
  }

  // Never show numbers publicly
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

  // Enforce PKR symbol if model ever tries to use $
  if (surface === "dm" && /\$/.test(parsed.message) && !/usd|dollar/i.test(userText || "")) {
    parsed.message = parsed.message.replace(/\$/g, "PKR ");
  }

  // Do NOT force "only price card" anymore — we allow a calculation + card in DMs.
  return parsed;
}

// ---------- TOOL STUBS (server wires real ones) ----------
async function getWeatherForecast() { return { error: "not wired" }; }
async function findNearbyPlaces()   { return { error: "not wired" }; }
async function getRouteInfo()       { return { error: "not wired" }; }
async function calculateRates()     { return { error: "not wired" }; }

module.exports = {
  askBrain,
  constructUserMessage,
  getWeatherForecast,
  findNearbyPlaces,
  getRouteInfo,
  calculateRates
};
