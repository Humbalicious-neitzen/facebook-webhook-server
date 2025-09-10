// lib/brain.js
// Purpose: One place that decides *what to say*.
// - DMs: If user asks price/rate/rent/charges -> return the price card **verbatim**.
// - Comments: Never show numeric prices; invite to DM.
// - Everything else: answer the literal question first, then add 1 short line bridging to Roameo Resorts.
// - Language auto-match (English / Urdu script / Roman Urdu).

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
- Be genuinely warm, enthusiastic, and professional
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
- If information is unknown, briefly say you'll connect them with reservations
- **Currency:** Always respond in PKR (₨). Never use $ or convert to USD.
- **Discount Policy:** We do not offer additional discounts beyond the official rate card. If asked, politely state this and highlight value.
- Always share: WhatsApp: ${WA} • Website: ${SITE}

🖼️ IMAGE & POST ANALYSIS:
- If a user sends an image or a preview/thumbnail of a post, analyze it to understand their intent.
- If the message includes a "postMeta:" block, treat it as ground truth about the post's author/permalink/caption.
- Screenshots of posts/DMs: identify what is being offered and answer accordingly (respect rate rules below).

📱 COMMUNICATION SURFACES:
PUBLIC COMMENTS (surface = "comment"):
- NEVER display numeric prices or rates
- Keep responses 1–2 engaging lines; always invite to DM/WhatsApp

DIRECT MESSAGES (surface = "dm"):
- For general resort inquiries, engage warmly with details
- If users specifically ask about prices/rates/charges/kiraya, provide the **verbatim** price card (between BEGIN/END), no extra text
- If users ask for a **total for N nights/days/rooms**, you may compute totals based on the rate card, but if they explicitly say "prices/rates", prefer sending the verbatim card

PRICE CARD (ONLY USE WHEN REQUIRED):
${PRICES_TXT}

🔗 BRIDGING STRATEGY:
- First, answer the literal question accurately.
- Then add one short, engaging line connecting to Roameo Resorts.
- Close with contact info (WhatsApp + Website).

❌ OFF-TOPIC:
- Politely decline unrelated topics.

🛠️ AVAILABLE TOOLS:
1) getWeatherForecast()
2) findNearbyPlaces({categories, radius?, limit?})
3) getRouteInfo({origin})

Return JSON in this schema:
{
  "message": "your engaging response text",
  "language": "en" | "ur" | "roman-ur"
}`.trim();

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

// Helper to construct the user message, handling multimodal content.
function constructUserMessage({ surface, text, imageUrl }) {
  const content = [];

  // Add the text part, including surface and rules.
  const textContent = JSON.stringify({
    surface, // "dm" or "comment"
    text,
    rules: {
      dm_prices_verbatim: true,
      comments_hide_prices: true,
      currency: "PKR"
    }
  });
  content.push({ type: "text", text: textContent });

  // Add the image part if an imageUrl is provided.
  if (imageUrl) {
    content.push({
      type: "image_url",
      image_url: { url: imageUrl, detail: "auto" }
    });
  }

  return { role: "user", content };
}

// Define functions available to the model.
const tools = [
  {
    type: "function",
    function: { name: "getWeatherForecast", description: "Get the 5-day weather forecast.", parameters: { type: "object", properties: {}, required: [] } },
  },
  {
    type: "function",
    function: {
      name: "findNearbyPlaces",
      description: "Find nearby attractions or places.",
      parameters: {
        type: "object",
        properties: {
          categories: { type: "string", description: "Geoapify categories (comma-separated)" },
          radius: { type: "number", description: "Search radius in meters. Default 5000." },
          limit: { type: "number", description: "Max items. Default 10." }
        },
        required: ["categories"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "getRouteInfo",
      description: "Get route information from origin to Roameo Resorts.",
      parameters: {
        type: "object",
        properties: { origin: { type: "string", description: "Origin city/address." } },
        required: ["origin"]
      }
    }
  }
];

async function askBrain({ text, imageUrl, surface, history = [] }) {
  const historyMessages = history.slice(-20);
  const userMessage = constructUserMessage({ surface, text, imageUrl });

  const messages = [
    { role: "system", content: SYSTEM },
    ...historyMessages,
    userMessage,
  ];

  try {
    // Step 1: initial call (tool auto for complex; JSON for simple)
    const initialPayload = {
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    };

    const isSimpleQuery = !imageUrl && !/weather|route|nearby|place|drive|distance/i.test(text || "");
    if (isSimpleQuery) {
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

    // Step 2: Tool decision
    if (!responseMessage.tool_calls) {
      if (initialPayload.response_format) {
        const parsed = JSON.parse(responseMessage.content || "{}");
        return finalizeResponse(parsed, surface);
      }

      // Ask for JSON formatting
      const finalPayload = {
        model: MODEL,
        messages: [...messages, { role: 'assistant', content: responseMessage.content || '...' }, { role: 'user', content: 'Please format your response in the required JSON schema.' }],
        response_format: responseSchema(),
      };
      const { data: formattedData } = await axios.post("https://api.openai.com/v1/chat/completions", finalPayload, { headers: { Authorization: `Bearer ${KEY}` }});
      const raw = formattedData?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);
      return finalizeResponse(parsed, surface);
    }

    // Step 3: Execute tools
    const toolCalls = responseMessage.tool_calls;
    const availableTools = { getWeatherForecast, findNearbyPlaces, getRouteInfo };
    const toolMessages = [];

    for (const toolCall of toolCalls) {
      const funcName = toolCall.function.name;
      const funcArgs = JSON.parse(toolCall.function.arguments || "{}");
      const funcToCall = availableTools[funcName];
      if (funcToCall) {
        const result = await funcToCall(funcArgs);
        toolMessages.push({ tool_call_id: toolCall.id, role: "tool", name: funcName, content: JSON.stringify(result) });
      }
    }

    // Step 4: Finalize
    const finalPayload = { model: MODEL, response_format: responseSchema(), messages: [...messages, responseMessage, ...toolMessages] };
    const { data: finalData } = await axios.post("https://api.openai.com/v1/chat/completions", finalPayload, { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, timeout: 25000 });
    const raw = finalData?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
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

function finalizeResponse(parsed, surface) {
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

  // Sanitize price card response just in case
  if (parsed.message && PRICES_TXT && parsed.message.includes(PRICES_TXT.slice(0, 20))) {
    if (surface === "comment") {
      parsed.message = "Please DM for rates!";
    } else {
      parsed.message = PRICES_TXT;
    }
  }

  return parsed;
}

// ===== Tools =====
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
      categories,
      filter: `circle:${lon},${lat},${radius}`,
      bias: `proximity:${lon},${lat}`,
      limit,
      apiKey
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
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.GEOAPIFY_API_KEY;
  if (!apiKey || !latLon) return { error: "Route API not configured" };

  const [destLat, destLon] = latLon.split(',').map(s => parseFloat(s.trim()));

  try {
    // Geocode origin
    const geocodeUrl = 'https://api.geoapify.com/v1/geocode/search';
    const geocodeResponse = await axios.get(geocodeUrl, { params: { text: origin, limit: 1, apiKey }, timeout: 8000 });
    const geocodeFeature = geocodeResponse.data?.features?.[0];
    if (!geocodeFeature) return { error: `Could not find location: ${origin}` };
    const [originLon, originLat] = geocodeFeature.geometry.coordinates;

    // Multi-mode routing
    const modes = ['drive', 'walk', 'transit'];
    const routePromises = modes.map(async (mode) => {
      try {
        const routeUrl = 'https://api.geoapify.com/v1/routing';
        const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
        const routeResponse = await axios.get(routeUrl, {
          params: { waypoints, mode, apiKey, traffic: mode === 'drive' ? 'approximated' : undefined },
          timeout: 12000
        });
        const props = routeResponse.data?.features?.[0]?.properties;
        if (!props) return null;

        const distKm = Math.round(props.distance / 1000);
        const hours = Math.floor(props.time / 3600);
        const minutes = Math.round((props.time % 3600) / 60);

        return { mode, distance_km: distKm, duration_formatted: `${hours}h ${minutes}m`, duration_seconds: props.time };
      } catch { return null; }
    });

    const routes = (await Promise.all(routePromises)).filter(Boolean);
    if (!routes.length) return { error: "Could not calculate routes" };

    return { origin, destination: "Roameo Resorts", routes, maps_link: MAPS };
  } catch (e) {
    console.error("Route info error:", e.message);
    return { error: "Could not fetch route information" };
  }
}

module.exports = { askBrain, constructUserMessage, getWeatherForecast, findNearbyPlaces, getRouteInfo };
