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
// Minimal rules, GPT handles intent. We also include few-shot examples to lock behavior.
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
- **Discount Policy**: We do not offer discounts. We focus on providing exceptional value through our standard packages. If asked about a discount, politely state this and highlight the value included in our rates (e.g., "While we don't offer discounts, our packages are designed to provide a wonderful experience with great value, including [mention a key feature like 'stunning views' or 'excellent service'].")
- Always share: WhatsApp: ${WA} • Website: ${SITE}

🖼️ IMAGE ANALYSIS:
- If a user sends an image, analyze it to understand their intent.
- **Screenshots of Posts/DMs**: If the image is a screenshot of a social media post, conversation, or another resort's offer, understand the context. Identify what is being offered (e.g., room types, prices, activities) and use that to inform your response.
- **Travel Photos**: If it's a scenic photo, compliment it and connect it to the beauty of Neelum Valley and Roameo Resorts.
- **Questions about Roameo**: If it's a photo of our resort, answer any questions they have about what's depicted.
- **Unclear Images**: If the image is unclear or irrelevant, politely ask for clarification.
- Your goal is to provide a helpful, relevant response that bridges back to Roameo Resorts.

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

🛠️ AVAILABLE TOOLS:
You have access to the following tools to answer questions. Use them when a user asks for information that the tool can provide.

1. getWeatherForecast():
   - Use this tool when the user asks about the weather, forecast, temperature, or what kind of clothes to pack.

2. findNearbyPlaces({categories: string, radius: number}):
   - Use this tool to find nearby attractions, restaurants, or other points of interest.

3. getRouteInfo({origin: string}):
   - Use this tool when users ask about directions, travel time, distance, or how to reach the resort from their location.

🎪 ENGAGEMENT TECHNIQUES:
- Use relevant emojis sparingly but effectively
- Ask follow-up questions to understand guest needs
- Highlight unique selling points naturally in conversation
- Create anticipation and excitement about the experience
- Personalize responses based on their interests (families, couples, adventure seekers)

Return JSON in this schema:
{
  "message": "your engaging response text",
  "language": "en" | "ur" | "roman-ur"
}`.trim();

// We ask GPT to classify + produce the final text in one shot.
// The schema keeps the model honest (no markdown, no extra fields).
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
            image_url: {
                "url": imageUrl,
                "detail": "auto"
            }
        });
    }

    return {
        role: "user",
        content: content
    };
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
          origin: {
            type: "string",
            description: "The origin location (city, address, or landmark) that the user is coming from.",
          }
        },
        required: ["origin"],
      },
    },
  },
];

async function askBrain({ text, imageUrl, surface, history = [] }) {
  const historyMessages = history.slice(-10); // last 5 turns
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
      tools: tools,
      tool_choice: "auto",
    };

    // If no image and no tool-related keywords, request JSON directly for efficiency.
    const isSimpleQuery = !imageUrl && !/weather|route|nearby/i.test(text);
    if (isSimpleQuery) {
      initialPayload.response_format = responseSchema();
      // When no tools are likely needed, we can remove them to be safe.
      delete initialPayload.tools;
      delete initialPayload.tool_choice;
    }

    const { data: initialData } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      initialPayload,
      { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, timeout: 40000 } // Increased timeout for vision
    );

    const responseMessage = initialData?.choices?.[0]?.message;

    // --- Step 2: Check if the model requested a tool call ---
    if (!responseMessage.tool_calls) {
      // No tool needed. If we already got JSON, parse and return.
      if (initialPayload.response_format) {
        const parsed = JSON.parse(responseMessage.content || "{}");
        return finalizeResponse(parsed, surface);
      }

      // If we didn't request JSON initially (e.g., for an image query that didn't need a tool),
      // we get the response content and then format it.
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

    // --- Step 4: Send tool results back to the model for a final answer ---
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

// Helper function to perform final checks and formatting
function finalizeResponse(parsed, surface) {
  if (surface === "comment") {
    const hasMoneyish = /\b(?:pkr|rs\.?|rupees)\b/i.test(parsed.message) || /\b\d{2,3}(?:[ ,]?\d{3})\b/.test(parsed.message);
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
  if (parsed.message && parsed.message.includes(PRICES_TXT.slice(0, 20))) {
      if (surface === "comment") {
          parsed.message = "Please DM for rates!";
      } else {
          // In DMs, ensure ONLY the price card is sent if it's detected
          parsed.message = PRICES_TXT;
      }
  }

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
      timeout: 8000
    });

    // Summarize 3-hourly data into daily min/max and dominant condition
    const daily = {};
    for (const p of (data.list || [])) {
      const day = p.dt_txt.split(' ')[0];
      if (!daily[day]) {
        daily[day] = { temps: [], conditions: {} };
      }
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
      categories: categories,
      filter: `circle:${lon},${lat},${radius}`,
      bias: `proximity:${lon},${lat}`,
      limit,
      apiKey
    };
    const { data } = await axios.get('https://api.geoapify.com/v2/places', { params, timeout: 8000 });
    const places = (data.features || []).map(f => ({
      name: f.properties.name,
      category: f.properties.categories[0],
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
  const axios = require('axios');
  const latLon = (process.env.RESORT_COORDS || "").trim();
  const apiKey = process.env.GEOAPIFY_API_KEY;
  
  if (!apiKey || !latLon) {
    return { error: "Route API not configured" };
  }

  const [destLat, destLon] = latLon.split(',').map(s => parseFloat(s.trim()));
  
  try {
    // First, geocode the origin
    const geocodeUrl = 'https://api.geoapify.com/v1/geocode/search';
    const geocodeResponse = await axios.get(geocodeUrl, {
      params: { text: origin, limit: 1, apiKey },
      timeout: 8000
    });
    
    const geocodeFeature = geocodeResponse.data?.features?.[0];
    if (!geocodeFeature) {
      return { error: `Could not find location: ${origin}` };
    }
    
    const [originLon, originLat] = geocodeFeature.geometry.coordinates;
    
    // Get route information for multiple modes
    const modes = ['drive', 'walk', 'transit'];
    const routePromises = modes.map(async (mode) => {
      try {
        const routeUrl = 'https://api.geoapify.com/v1/routing';
        const waypoints = `${originLat},${originLon}|${destLat},${destLon}`;
        const routeResponse = await axios.get(routeUrl, {
          params: {
            waypoints,
            mode,
            apiKey,
            traffic: mode === 'drive' ? 'approximated' : undefined
          },
          timeout: 12000
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
    
    const routes = await Promise.all(routePromises);
    const validRoutes = routes.filter(r => r !== null);
    
    if (validRoutes.length === 0) {
      return { error: "Could not calculate routes" };
    }
    
    return {
      origin: origin,
      destination: "Roameo Resorts",
      routes: validRoutes,
      maps_link: process.env.ROAMEO_MAPS_LINK || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6"
    };
    
  } catch (e) {
    console.error("Route info error:", e.message);
    return { error: "Could not fetch route information" };
  }
}

module.exports = { askBrain, constructUserMessage, getWeatherForecast, findNearbyPlaces, getRouteInfo };
