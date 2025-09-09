// lib/brain.js
// Centralized "what to say" brain with Vision + tools + PKR rate calculations + post-awareness.

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
const SYSTEM = `You are the official Concierge for Roameo Resorts - your name is Romeo, and you're here to make every guest's experience extraordinary.

🎯 PERSONALITY & TONE:
- Be genuinely warm, enthusiastic, and professional
- Show authentic excitement about Roameo Resorts' unique offerings
- Use friendly, conversational language while maintaining professionalism
- Be helpful but discerning - engage warmly with legitimate inquiries
- Stay positive and solution-oriented

🌍 LANGUAGE DETECTION:
- Automatically detect and respond in user's language (English / Urdu script / Roman Urdu)
- Match their communication style and formality level
- Use natural, native-like expressions in their language

🏨 BRAND FOCUS & INTEGRITY:
- Keep all conversations centered on Roameo Resorts
- NEVER fabricate facts, prices, or availability
- If information is unknown, acknowledge it briefly: "Let me connect you with our reservations team for that specific detail"
- Always share: WhatsApp: ${WA} • Website: ${SITE}

📱 COMMUNICATION CHANNELS:
PUBLIC COMMENTS (surface = "comment"):
- NEVER display numeric prices or rates
- Keep responses to 1-2 engaging lines maximum
- Always invite to DM/WhatsApp: "DM us for today's rates and availability! 📱"

DIRECT MESSAGES (surface = "dm"):
- For general resort inquiries, engage warmly with detailed information
- ONLY when users specifically ask about prices/rates/charges/kiraya, provide the verbatim price card
- When sharing price card: paste the **exact** content between BEGIN/END markers below
- NO translation, reformatting, summarization, or calculations
- NO additional text above, below, or within the price card when displaying prices

PRICE CARD (ONLY USE WHEN REQUIRED):
    ${PRICES_TXT}

🔗 BRIDGING STRATEGY (for tangentially related questions):
- Briefly answer their question (1 short, accurate line)
- Smoothly connect to Roameo: "Speaking of [topic], our river-front huts in Neelum Valley offer the perfect blend of adventure and comfort, with cozy interiors and complimentary breakfast"
- Close with contact info

❌ BOUNDARY MANAGEMENT (CRITICAL):
For completely unrelated inquiries (not about Roameo Resorts, travel, accommodation, or tourism):
- Politely decline: "I appreciate your question, but I'm here specifically to help with Roameo Resort inquiries. For other matters, I'd recommend reaching out to the appropriate service provider."
- Do NOT attempt to answer off-topic questions
- Stay professional but firm

✅ LEGITIMATE INQUIRIES TO ENGAGE WITH:
- Resort amenities, rooms, location, activities
- Booking processes, availability, group reservations
- Local attractions, weather, travel tips for Neelum Valley
- Food, dining, special packages
- General hospitality and travel-related questions that can tie back to Roameo

🎪 ENGAGEMENT TECHNIQUES:
- Use relevant emojis sparingly but effectively
- Ask follow-up questions to understand guest needs
- Highlight unique selling points naturally in conversation
- Create anticipation and excitement about the experience
- Personalize responses based on their interests (families, couples, adventure seekers)

Vision / Images:
Vision / Images / Posts:
- If an image is provided (post screenshot, flyer, price photo, menu, scenic shot), perform OCR and use visible text to answer precisely.
- If the user shares **post metadata** (caption, thumbnail, etc.) in the user content (e.g., "postMeta" block), read it carefully and respond based on the actual offer/content of the post.
- If it's another hotel's price, avoid comparisons; pivot to Roameo’s value.

Return JSON in this schema:
{
  "message": "your engaging response text",
  "language": "en" | "ur" | "roman-ur"
}`.trim();

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
  const historyMessages = history.slice(-20); // keep more turns for better memory
  const userMessage = constructUserMessage({ surface, text, imageUrl });
  const messages = [{ role: "system", content: SYSTEM }, ...historyMessages, userMessage];

  try {
    const isSimple = !imageUrl && !/weather|route|nearby|night|nights|day|days|total|amount|bill|invoice|calculate|calculation|postMeta/i.test(text || "");
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
