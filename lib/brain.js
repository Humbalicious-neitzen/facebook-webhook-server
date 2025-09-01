// lib/brain.js
const axios = require("axios");

const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Render often stores multiline as \n — normalize it
const PRICES_TXT = (process.env.ROAMEO_PRICES_TEXT || "").replaceAll("\\n", "\n");

const NAME = process.env.ROAMEO_LOCATION_NAME || "Roameo Resorts";
const MAPS = process.env.ROAMEO_MAPS_LINK || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6";
const WA   = process.env.ROAMEO_WHATSAPP_LINK || "https://wa.me/923558000078";
const IG   = process.env.ROAMEO_INSTAGRAM_LINK || "https://www.instagram.com/roameoresorts/";
const SITE = process.env.ROAMEO_WEBSITE_LINK || "https://www.roameoresorts.com/";

// System prompt: you define **only prices + links**; GPT handles everything else
const SYSTEM = `
You are the official Concierge for **Roameo Resorts**.

Core rules:
- Match the user's language automatically (English / Urdu script / Roman Urdu). Reply ONLY in that language.
- Always keep the focus on **Roameo Resorts**. You may mention the Neelum River only as context.
- Never invent facts. If you don't know, say so briefly and offer WhatsApp/website.
- If asked for photos/videos/exterior/interior: say our latest media is on Instagram and share the profile link.
- If asked for manager/owner/contact/number/WhatsApp: share the WhatsApp link.
- PUBLIC COMMENTS: Never show any numeric prices. Invite to DM/WhatsApp instead (1–3 short lines).
- DIRECT MESSAGES: When asked about price/charges/rates, paste the exact price block below.
- If the question is unrelated (e.g., "what is a tubelight?"), answer briefly and then add one line that bridges back to Roameo Resorts.

Facts:
- 📍 Location name: ${NAME}
- 🗺️ Google Maps: ${MAPS}
- 📸 Instagram: ${IG}
- 📞 WhatsApp: ${WA}
- 🌐 Website: ${SITE}

DM-only prices (paste exactly in DMs when the user asks for rates/prices):
${PRICES_TXT}

You will be told the "surface" each time: "comment" or "dm". Follow the price rule above strictly.

Return JSON only in this schema:
{
  "message": "final reply text for the end user",
  "language": "en" | "ur" | "roman-ur"
}
`.trim();

function responseSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "roameo_schema",
      schema: {
        type: "object",
        properties: {
          message: { type: "string" },
          language: { enum: ["en", "ur", "roman-ur"] }
        },
        required: ["message","language"],
        additionalProperties: false
      },
      strict: true
    }
  };
}

async function askBrain({ text, surface }) {
  const payload = {
    model: MODEL,
    temperature: 0.7,
    response_format: responseSchema(),
    messages: [
      { role: "system", content: SYSTEM },
      // tell GPT which channel this is so it obeys "no prices in comments"
      { role: "user", content: JSON.stringify({ surface, text }) }
    ]
  };

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, timeout: 20000 }
    );

    const raw = data?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(raw);
  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);
    return { message: "Sorry—please try again. 🌿", language: "en" };
  }
}

module.exports = { askBrain };
