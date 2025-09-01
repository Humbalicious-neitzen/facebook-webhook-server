// lib/brain.js
const axios = require("axios");

/**
 * Ask the Roameo Resorts Brain (powered by GPT).
 * It knows prices, location, contact, Instagram, etc.
 */
async function askBrain({ text, surface = "dm" }) {
  const systemPrompt = `
You are the official AI assistant for **Roameo Resorts**.
Always:
- Reply in the same language the user used (English, Urdu script, or Roman Urdu).
- Be warm, concise, and helpful. Use emojis where natural.
- Always bring the conversation back to Roameo Resorts (never wander off).
- In DMs: you can share prices, WhatsApp link, website, Instagram link.
- In comments: NEVER post prices. Instead, tell them to DM us for rates.
- If asked about photos, videos, exterior/interior → share our Instagram link.
- If asked for manager or contact → share WhatsApp number.
- If asked vague or irrelevant things (e.g., “what is a tubelight?”) → still answer briefly, but connect back to Roameo Resorts subtly.
- Always say **Roameo Resorts**, not Tehjian Valley.

Facts you must use:
- 📍 Location: Roameo Resorts, private riverfront huts by the Neelam River  
- 🗺️ Maps: ${process.env.ROAMEO_MAPS_LINK}  
- 🌐 Website: ${process.env.ROAMEO_WEBSITE_LINK}  
- 📸 Instagram: ${process.env.ROAMEO_INSTAGRAM_LINK}  
- 📞 WhatsApp: ${process.env.ROAMEO_WHATSAPP_LINK}  
- 🛏️ Prices: ${process.env.ROAMEO_PRICES_TEXT}
`;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.8,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const content = response.data.choices?.[0]?.message?.content?.trim();
    return { message: content || "I’m here to help with Roameo Resorts! 💚" };
  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);
    return {
      message:
        "Sorry, I had trouble fetching info right now — please try again! 🌿",
    };
  }
}

module.exports = { askBrain };
