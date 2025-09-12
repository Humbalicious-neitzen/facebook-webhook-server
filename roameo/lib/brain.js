// lib/brain.js
// Purpose: One place that decides *what to say*.
// - DMs: If user asks price/rate/rent/charges -> return the price card **verbatim** (from env).
// - Comments: Never show numeric prices; invite to DM.
// - Everything else: answer the literal question first, then add 1 short line bridging to Roameo Resorts.
// - Language auto-match (English / Urdu script / Roman Urdu).

const axios = require("axios");
const https = require("https");

// ---------- OPENAI CLIENT (resilient) ----------
const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const openai = axios.create({
  baseURL: "https://api.openai.com/v1",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  timeout: 60000, // longer timeout to prevent "socket hang up"
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  httpsAgent: new https.Agent({ keepAlive: true })
});

// Small retry helper for transient network errors
async function withRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e?.message || '';
      const code = e?.code || '';
      const retriable = ['ECONNRESET','ETIMEDOUT','EAI_AGAIN'].includes(code) || /socket hang up|timeout/i.test(msg);
      if (i < retries && retriable) {
        const backoff = 800 * (i + 1);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw e;
    }
  }
}

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
- **Currency policy**: Always use PKR (₨ / Rs). Do NOT convert to USD. Never show "$".
- **Discount Policy**: We do not offer adhoc discounts. We focus on value through our standard packages. If asked, politely say this and highlight value.
- Always share: WhatsApp: ${WA} • Website: ${SITE}

🖼️ IMAGE & POST ANALYSIS:
- If a user sends an image or a brand-owned Instagram post, analyze it with vision.
- Extract text on the image (e.g., "Rs 9000 per person"), read captions, and answer accordingly.
- If the post is not clearly brand-owned or is inaccessible, ask for a screenshot.

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

🔗 BRIDGING STRATEGY (for all responses):
- First, always provide a direct and accurate answer to the user's question.
- After answering, add one short, engaging line that connects the topic back to Roameo Resorts.
- Example after analyzing an itinerary: "That sounds like a wonderful trip! To make your stay even more memorable, our resort in Neelum Valley offers stunning river views and cozy huts, perfect for relaxing after a day of exploring."
- Example after analyzing a menu: "That menu looks delicious! Here at Roameo, we also offer a fantastic dining experience with local and continental dishes, right by the river."
- Always close with contact info.

❌ BOUNDARY MANAGEMENT (CRITICAL):
For unrelated inquiries (not about Roameo Resorts, travel, accommodation, or tourism):
- Politely decline: "I appreciate your question, but I'm here specifically to help with Roameo Resort inquiries. For other matters, I'd recommend reaching out to the appropriate service provider."

✅ LEGITIMATE INQUIRIES TO ENGAGE WITH:
- Resort amenities, rooms, location, activities
- Booking processes, availability, group reservations
- Local attractions, weather, travel tips for Neelum Valley
- Food, dining, special packages
- Travel directions and distance/time
- Questions about our official posts or images

🛠️ AVAILABLE TOOLS:
1) getWeatherForecast()
2) findNearbyPlaces({categories, radius, limit})
3) getRouteInfo({origin})

Return JSON in this schema:
{
  "message": "your engaging response text",
  "language": "en" | "ur" | "roman-ur"
}`.trim();

// Schema keeps the model honest (no markdown, no extra fields).
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
      comments_hide_prices: true
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
          categories: {
            type: "string",
            description: "Comma-separated list of Geoapify categories to search for. Examples: 'tourism.attraction', 'catering.restaurant', 'commercial.shopping_mall'.",
          },
          radius: {
            type: "number",
            description: "Search radius in meters. Defaults to 5000.",
          },
          limit: {
            type: "number",
            description: "Max number of places to return. Defaults to 10.",
          }
        },
        required: ["categories"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getRouteInfo",
      description: "Get detailed route information from a specific location to Roameo Resorts. Use this when users ask about directions, travel time, distance, or how to reach the resort from their location.",
      parameters: {
        type: "object",
        properties: {
          origin: { type: "string", description: "Origin location (city, address, or landmark)." }
        },
        required: ["origin"],
      },
    },
  },
];

// Core brain logic with retry + fallback
async function askBrain({ text, imageUrl, surface, history = [] }) {
  const historyMessages = history.slice(-10); // last 10 roles
  const userMessage = constructUserMessage({ surface, text, imageUrl });

  const messages = [
    { role: "system", content: SYSTEM },
    ...historyMessages,
    userMessage,
  ];

  try {
    // --- Step 1: Initial request to see if the model wants to use a tool ---
    const initialPayload = {
      model: MODEL,
      messages,
      tools,
      tool_choice: "auto",
    };

    // If no image and no tool-related keywords, request JSON directly (fast path).
    const isSimpleQuery = !imageUrl && !/weather|route|nearby/i.test(text || '');
    if (isSimpleQuery) {
      initialPayload.response_format = responseSchema();
      delete initialPayload.tools;
      delete initialPayload.tool_choice;
    }

    const { data: initialData } = await withRetry(() => openai.post('/chat/completions', initialPayload));
    const responseMessage = initialData?.choices?.[0]?.message;

    // --- Step 2: No tool needed? ensure JSON schema formatting ---
    if (!responseMessage.tool_calls) {
      if (initialPayload.response_format) {
        const parsed = JSON.parse(responseMessage.content || "{}");
        return finalizeResponse(parsed, surface);
      }
      // If we didn't request JSON initially, ask it to format now.
      const finalPayload = {
        model: MODEL,
        messages: [
          ...messages,
          { role: 'assistant', content: responseMessage.content || '...' },
          { role: 'user', content: 'Please format your response in the required JSON schema.' }
        ],
        response_format: responseSchema(),
      };
      const { data: formattedData } = await withRetry(() => openai.post('/chat/completions', finalPayload));
      const raw = formattedData?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);
      return finalizeResponse(parsed, surface);
    }

    // --- Step 3: Execute the requested tool(s) ---
    const toolCalls = responseMessage.tool_calls;
    const availableTools = { getWeatherForecast, findNearbyPlaces, getRouteInfo };
    const toolMessages = [];

    for (const toolCall of toolCalls) {
      const funcName = toolCall.function.name;
      const funcArgs = JSON.parse(toolCall.function.arguments);
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

    // --- Step 4: Send tool results back for a final answer ---
    const finalPayload = {
      model: MODEL,
      response_format: responseSchema(),
      messages: [...messages, responseMessage, ...toolMessages],
    };

    const { data: finalData } = await withRetry(() => openai.post('/chat/completions', finalPayload));
    const raw = finalData?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);
    return finalizeResponse(parsed, surface);

  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);

    // If this failed while sending an image to Vision, try once more WITHOUT the image
    try {
      const messagesNoImage = [
        { role: "system", content: SYSTEM },
        ...historyMessages,
        constructUserMessage({ surface, text, imageUrl: null })
      ];
      const fallbackPayload = {
        model: MODEL,
        response_format: responseSchema(),
        messages: messagesNoImage
      };
      const { data: fbData } = await withRetry(() => openai.post('/chat/completions', fallbackPayload));
      const raw = fbData?.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);
      return finalizeResponse(parsed, surface);
    } catch (e2) {
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
}

// Helper: final checks and formatting
function finalizeResponse(parsed, surface) {
  if (!parsed || typeof parsed.message !== 'string') {
    return { message: 'Sorry, I had trouble understanding that. Please try again.', language: 'en' };
  }

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

  // Enforce price card behavior in DMs
  if (parsed.message && PRICES_TXT && parsed.message.includes(PRICES_TXT.slice(0, 20))) {
    if (surface === "comment") {
      parsed.message = "Please DM for rates!";
    } else {
      parsed.message = PRICES_TXT; // send verbatim card only, no extras
    }
  }

  // Currency safety: never show "$"
  parsed.message = parsed.message.replace(/\$/g, 'Rs');

  return parsed;
}

// Helper: get 5-day weather forecast (summarized by day)
async function getWeatherForecast() {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey || !latLon) return { error: "Weather API not configured" };

  const [lat, lon] = latLon.split(',');
  try {
    const { data } = await axios.get('https://api.openweathermap.org/data/2.5/forecast', {
      params: { lat, lon, appid: apiKey, units: 'metric' },
      timeout: 10000
    });

    // Summarize 3-hourly data into daily min/max and dominant condition
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

// Helper: find nearby points of interest
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
    const { data } = await axios.get('https://api.geoapify.com/v2/places', { params, timeout: 10000 });
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

// Helper: get route information from origin to resort
async function getRouteInfo({ origin }) {
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.GEOAPIFY_API_KEY;

  if (!apiKey || !latLon) return { error: "Route API not configured" };

  const [destLat, destLon] = latLon.split(',').map(s => parseFloat(s.trim()));

  try {
    // First, geocode the origin
    const geocodeUrl = 'https://api.geoapify.com/v1/geocode/search';
    const geocodeResponse = await axios.get(geocodeUrl, {
      params: { text: origin, limit: 1, apiKey },
      timeout: 10000
    });

    const geocodeFeature = geocodeResponse.data?.features?.[0];
    if (!geocodeFeature) return { error: `Could not find location: ${origin}` };

    const [originLon, originLat] = geocodeFeature.geometry.coordinates;

    // Get route information for multiple modes
    const modes = ['drive', 'walk', 'transit'];
    const routePromises = modes.map(async (mode) => {
      try {
        const routeUrl = 'https://api.geoapify.com/v1/routing';
        const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
        const routeResponse = await axios.get(routeUrl, {
          params: { waypoints, mode, apiKey, traffic: mode === 'drive' ? 'approximated' : undefined },
          timeout: 15000
        });

        const routeFeature = routeResponse.data?.features?.[0]?.properties;
        if (!routeFeature) return null;

        const distanceKm = (routeFeature.distance / 1000).toFixed(0);
        const hours = Math.floor(routeFeature.time / 3600);
        const minutes = Math.round((routeFeature.time % 3600) / 60);
        const durationFormatted = `${hours}h ${minutes}m`;

        return {
          mode,
          distance_km: Number(distanceKm),
          duration_formatted: durationFormatted,
          duration_seconds: routeFeature.time
        };
      } catch (e) {
        console.error(`Route error for ${mode}:`, e.message);
        return null;
      }
    });

    const routes = (await Promise.all(routePromises)).filter(Boolean);
    if (!routes.length) return { error: "Could not calculate routes" };

    return {
      origin,
      destination: "Roameo Resorts",
      routes,
      maps_link: process.env.ROAMEO_MAPS_LINK || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6"
    };
  } catch (e) {
    console.error("Route info error:", e.message);
    return { error: "Could not fetch route information" };
  }
}

module.exports = { askBrain, constructUserMessage, getWeatherForecast, findNearbyPlaces, getRouteInfo };
