// lib/brain.js
// Purpose: One place that decides *what to say*.
// - DMs: If user asks price/rate/rent/charges -> return the price card **verbatim**.
// - Comments: Never show numeric prices; invite to DM.
// - Everything else: answer the literal question first, then add 1 short line bridging to Roameo Resorts.
// - Language auto-match (English / Urdu script / Roman Urdu).
//
// NEW:
// - Honors rules.allow_price_card=false (e.g., when a post is only shared without a pricing question).
// - Accepts share_meta (caption, permalink, is_share) so the model can read & respond to the post content.

const axios = require("axios");

const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// IMPORTANT: keep line breaks EXACT. Render may store "\n" as characters; normalize them back.
const PRICES_TXT = String(process.env.ROAMEO_PRICES_TEXT || "")
  .replaceAll("\\n", "\n"); // do not .trim() — preserve top/bottom spacing if any

// Brand facts / links
const NAME = process.env.ROAMEO_LOCATION_NAME || "Roameo Resorts";
const MAPS = process.env.ROAMEO_MAPS_LINK    || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6";
const WA   = process.env.ROAMEO_WHATSAPP_LINK|| "https://wa.me/923558000078";
const IG   = process.env.ROAMEO_INSTAGRAM_LINK|| "https://www.instagram.com/roameoresorts/";
const SITE = process.env.ROAMEO_WEBSITE_LINK || "https://www.roameoresorts.com/";

// ---------- SYSTEM PROMPT ----------
const SYSTEM = `You are the official Concierge for Roameo Resorts - your name is Romeo, and you're here to make every guest's experience extraordinary.

🎯 PERSONALITY & TONE:
- Warm, enthusiastic, professional; genuinely helpful.
- Center answers on Roameo Resorts; never invent prices/availability.

🌍 LANGUAGE:
- Auto-match English / Urdu script / Roman Urdu.

💬 CHANNEL RULES:
PUBLIC COMMENTS (surface = "comment"):
- NEVER display numeric prices or rates.
- Keep responses to 1–2 lines and invite to DM/WhatsApp.

DIRECT MESSAGES (surface = "dm"):
- If the user explicitly asks about prices/rates/charges, paste the **exact** price card (between BEGIN/END markers below) verbatim with **no extra text**.
- If the user did **not** ask for prices, do **not** paste the card.

PRICE CARD (ONLY USE WHEN REQUIRED):
    ${PRICES_TXT}

🖼️ POSTS & IMAGES:
- You may receive images and/or share metadata via "share_meta" (e.g., is_share=true, caption, permalink).
- If share_meta.is_share is true:
  - Read and use the *caption text* and visible text in the image to understand the context.
  - **If rules.allow_price_card=false**, do **not** output the price card even if the image shows a price. Instead, summarize or acknowledge the post and invite them to ask for rates if they want them.
  - Only paste the price card when the user's message explicitly asks for pricing (or rules.allow_price_card=true).

🔗 BRIDGING STRATEGY:
- First, directly answer the user's question (or summarize the shared post).
- Then add one short, engaging line that connects back to Roameo Resorts.
- Always include: WhatsApp: ${WA} • Website: ${SITE}

❌ OFF-TOPIC:
- If the query is unrelated to Roameo/travel/tourism, politely decline and redirect.

Return JSON in this schema:
{
  "message": "your engaging response text",
  "language": "en" | "ur" | "roman-ur"
}`.trim();

// Response schema for JSON mode
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

// Helper to construct the user message, handling multimodal content + share meta + rules.
function constructUserMessage({ surface, text, imageUrl, extraRules = {}, shareMeta = null }) {
  const content = [];

  const textPayload = {
    surface, // "dm" | "comment"
    text,
    rules: {
      dm_prices_verbatim: true,
      comments_hide_prices: true,
      allow_price_card: extraRules.allow_price_card !== false, // default true
      is_share: !!(shareMeta && shareMeta.is_share)
    },
    share_meta: shareMeta ? {
      is_share: !!shareMeta.is_share,
      caption: String(shareMeta.caption || '').slice(0, 2000),
      permalink: shareMeta.permalink || null,
      media_type: shareMeta.media_type || null
    } : null
  };

  content.push({ type: "text", text: JSON.stringify(textPayload) });

  if (imageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: imageUrl, detail: "auto" }
    });
  }

  return { role: "user", content };
}

// Define the functions available to the model.
const tools = [
  {
    type: "function",
    function: {
      name: "getWeatherForecast",
      description: "Get the 5-day weather forecast for the resort's location. Returns a day-by-day summary including temperature range and conditions.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "findNearbyPlaces",
      description: "Finds nearby places of interest, like tourist attractions, restaurants, etc. Use this to answer questions about what to do or see near the resort.",
      parameters: {
        type: "object",
        properties: {
          categories: { type: "string", description: "Comma-separated list of Geoapify categories." },
          radius: { type: "number", description: "Search radius in meters. Defaults to 5000." },
          limit: { type: "number", description: "Max number of places to return. Defaults to 10." }
        },
        required: ["categories"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRouteInfo",
      description: "Get detailed route information from a specific location to Roameo Resorts. Use for directions / travel time / distance.",
      parameters: {
        type: "object",
        properties: { origin: { type: "string", description: "User's origin city or address." } },
        required: ["origin"],
      },
    },
  },
];

async function askBrain({ text, imageUrl, surface, history = [], shareMeta = null, allowPriceCard = true }) {
  const historyMessages = history.slice(-10);
  const userMessage = constructUserMessage({
    surface, text, imageUrl,
    extraRules: { allow_price_card: allowPriceCard },
    shareMeta: shareMeta ? { ...shareMeta, is_share: true } : null
  });

  const messages = [{ role: "system", content: SYSTEM }, ...historyMessages, userMessage];

  try {
    // Step 1: initial request (JSON mode if simple)
    const initialPayload = {
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    };

    const isSimple = !imageUrl && !/weather|route|nearby/i.test(text || "");
    if (isSimple) {
      initialPayload.response_format = responseSchema();
      delete initialPayload.tools;
      delete initialPayload.tool_choice;
    }

    const { data: initialData } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      initialPayload,
      { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, timeout: 40000 }
    );

    const responseMessage = initialData?.choices?.[0]?.message;

    // Step 2: if no tool calls, ensure JSON
    if (!responseMessage.tool_calls) {
      if (initialPayload.response_format) {
        const parsed = JSON.parse(responseMessage.content || "{}");
        return finalizeResponse(parsed, surface, allowPriceCard);
      }
      const finalPayload = {
        model: MODEL,
        messages: [...messages, { role: 'assistant', content: responseMessage.content || '...' }, { role: 'user', content: 'Please format your response in the required JSON schema.' }],
        response_format: responseSchema(),
      };
      const { data: formattedData } = await axios.post("https://api.openai.com/v1/chat/completions", finalPayload, { headers: { Authorization: `Bearer ${KEY}` }});
      const raw = formattedData?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);
      return finalizeResponse(parsed, surface, allowPriceCard);
    }

    // Step 3: execute tool calls
    const toolCalls = responseMessage.tool_calls;
    const availableTools = { getWeatherForecast, findNearbyPlaces, getRouteInfo };
    const toolMessages = [];

    for (const toolCall of toolCalls) {
      const funcName = toolCall.function.name;
      const funcArgs = JSON.parse(toolCall.function.arguments || "{}");
      const funcToCall = availableTools[funcName];
      if (funcToCall) {
        const result = await funcToCall(funcArgs);
        toolMessages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: funcName,
          content: JSON.stringify(result),
        });
      }
    }

    // Step 4: final
    const finalPayload = {
      model: MODEL,
      response_format: responseSchema(),
      messages: [...messages, responseMessage, ...toolMessages],
    };
    const { data: finalData } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      finalPayload,
      { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, timeout: 25000 }
    );

    const raw = finalData?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return finalizeResponse(parsed, surface, allowPriceCard);

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

// Finalize: enforce comment price-scrub + allow_price_card rule
function finalizeResponse(parsed, surface, allowPriceCard = true) {
  if (surface === "comment") {
    const hasMoneyish = /\b(?:pkr|rs\.?|rupees|₨)\b/i.test(parsed.message) || /\b\d{2,3}(?:[ ,]?\d{3})\b/.test(parsed.message);
    if (hasMoneyish) {
      parsed.message = (parsed.language === "ur")
        ? "ریٹس کے لیے براہِ کرم DM/WhatsApp پر رابطہ کریں۔"
        : (parsed.language === "roman-ur")
          ? "Rates ke liye DM/WhatsApp par rabta karein."
          : "Please DM/WhatsApp us for rates and availability.";
      parsed.message += `\nWhatsApp: ${WA} • Website: ${SITE}`;
    }
  }

  // Detect the verbatim price card and suppress if not allowed
  if (parsed.message && PRICES_TXT && parsed.message.includes(PRICES_TXT.slice(0, 20))) {
    if (surface === "comment") {
      parsed.message = "Please DM for rates!";
    } else if (!allowPriceCard) {
      parsed.message =
        `Thanks for sharing the post! If you'd like current rates, just ask and I'll share them instantly. 🌿\nWhatsApp: ${WA} • Website: ${SITE}`;
    } else {
      // In DMs, ensure ONLY the price card is sent if it's detected
      parsed.message = PRICES_TXT;
    }
  }

  return parsed;
}

/* ===== Weather / Places / Route tools (unchanged) ===== */
async function getWeatherForecast() {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey || !latLon) return { error: "Weather API not configured" };

  const [lat, lon] = latLon.split(',');
  try {
    const { data } = await axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: { lat, lon, appid: apiKey, units: 'metric' },
      timeout: 8000
    });

    const daily = {};
    for (const p of (data.list || [])) {
      const day = p.dt_txt.split(' ')[0];
      if (!daily[day]) daily[day] = { temps: [], conditions: {} };
      daily[day].temps.push(p.main.temp);
      const cond = p.weather[0]?.main || 'Clear';
      daily[day].conditions[cond] = (daily[day].conditions[cond] || 0) + 1;
    }

    const forecast = Object.entries(daily).map(([date, { temps, conditions }]) => ({
      date,
      temp_min: Math.min(...temps).toFixed(0),
      temp_max: Math.max(...temps).toFixed(0),
      condition: Object.keys(conditions).reduce((a, b) => conditions[a] > conditions[b] ? a : b)
    }));

    return { forecast };
  } catch (e) {
    console.error("weather error", e.message);
    return { error: "Could not fetch weather." };
  }
}

async function findNearbyPlaces({ categories, radius = 5000, limit = 10 }) {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey || !latLon) return { error: "Geo API not configured" };

  const [lat, lon] = latLon.split(',');
  try {
    const params = {
      categories, filter: `circle:${lon},${lat},${radius}`,
      bias: `proximity:${lon},${lat}`, limit, apiKey
    };
    const { data } = await axios.get('https://api.geoapify.com/v2/places', { params, timeout: 8000 });
    const places = (data.features || []).map(f => ({
      name: f.properties.name,
      category: f.properties.categories?.[0],
      distance_m: f.properties.distance
    }));
    return { places };
  } catch (e) {
    console.error("places error", e.message);
    return { error: "Could not fetch places." };
  }
}

async function getRouteInfo({ origin }) {
  const axios2 = require('axios');
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey || !latLon) return { error: "Route API not configured" };

  const [destLat, destLon] = latLon.split(',').map(s => parseFloat(s.trim()));
  try {
    const geocodeUrl = 'https://api.geoapify.com/v1/geocode/search';
    const geocodeResponse = await axios2.get(geocodeUrl, { params: { text: origin, limit: 1, apiKey }, timeout: 8000 });
    const geocodeFeature = geocodeResponse.data?.features?.[0];
    if (!geocodeFeature) return { error: `Could not find location: ${origin}` };
    const [originLon, originLat] = geocodeFeature.geometry.coordinates;

    const modes = ['drive', 'walk', 'transit'];
    const routes = [];
    for (const mode of modes) {
      try {
        const routeUrl = 'https://api.geoapify.com/v1/routing';
        const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
        const routeResponse = await axios2.get(routeUrl, { params: { waypoints, mode, apiKey, traffic: mode === 'drive' ? 'approximated' : undefined }, timeout: 12000 });
        const props = routeResponse.data?.features?.[0]?.properties;
        if (!props) continue;
        const distanceKm = (props.distance / 1000).toFixed(0);
        const hours = Math.floor(props.time / 3600);
        const minutes = Math.round((props.time % 3600) / 60);
        routes.push({ mode, distance_km: Number(distanceKm), duration_formatted: `${hours}h ${minutes}m`, duration_seconds: props.time });
      } catch { /* ignore per-mode errors */ }
    }
    if (!routes.length) return { error: "Could not calculate routes" };
    return { origin, destination: "Roameo Resorts", routes, maps_link: MAPS };
  } catch {
    return { error: "Could not fetch route information" };
  }
}

module.exports = { askBrain, constructUserMessage, getWeatherForecast, findNearbyPlaces, getRouteInfo };
