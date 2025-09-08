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
- Always share: WhatsApp: ${WA} • Website: ${SITE}

📱 COMMUNICATION CHANNELS:
PUBLIC COMMENTS (surface = "comment"):
- NEVER display numeric prices or rates
- Keep responses to 1-2 engaging lines maximum
- Always invite to DM/WhatsApp: "DM us for today's rates and availability! 📱"

DIRECT MESSAGES (surface = "dm"):
- When users ask about prices/rates/charges/kiraya, provide ONLY the verbatim price card
- Paste the **exact** content between BEGIN/END markers below
- NO translation, reformatting, summarization, or calculations
- NO additional text above, below, or within the price card

BEGIN_VERBATIM_PRICE_CARD
${PRICES_TXT}
END_VERBATIM_PRICE_CARD

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

// Helper: surface-aware user instruction
function userContent({ surface, text }) {
  // Give GPT just enough context to obey the pricing rule.
  return JSON.stringify({
    surface, // "dm" or "comment"
    text,
    // Reinforce: DM prices = send card verbatim; comments = no numeric prices.
    rules: {
      dm_prices_verbatim: true,
      comments_hide_prices: true
    }
  });
}

async function askBrain({ text, surface }) {
  const payload = {
    model: MODEL,
    response_format: responseSchema(),
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user",   content: userContent({ surface, text }) }
    ]
  };

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      {
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 25000
      }
    );

    const raw = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    // Safety: never let comments leak numeric PKR lines (belt-and-suspenders)
    if (surface === "comment") {
      const hasMoneyish = /\b(?:pkr|rs\.?|rupees)\b/i.test(parsed.message) ||
                          /\b\d{2,3}(?:[ ,]?\d{3})\b/.test(parsed.message);
      if (hasMoneyish) {
        parsed.message =
          parsed.language === "ur"
            ? "ریٹس کے لیے براہِ کرم DM/WhatsApp پر رابطہ کریں۔"
            : parsed.language === "roman-ur"
              ? "Rates ke liye DM/WhatsApp par rabta karein."
              : "Please DM/WhatsApp us for rates and availability.";
        parsed.message += `\nWhatsApp: ${WA} • Website: ${SITE}`;
      }
    }

    // Absolutely preserve price card spacing in DMs:
    if (surface === "dm" && parsed.message.includes("BEGIN_CARD") && parsed.message.includes("END_CARD")) {
      const exact = parsed.message.split("BEGIN_CARD")[1].split("END_CARD")[0];
      parsed.message = exact; // strip markers, keep exact spacing
    }

    return parsed;
  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);
    // Simple multilingual fallback
    const t = (text || "").trim();
    const urduScript = /[\u0600-\u06FF]/.test(t);
    const romanUr = /(ap|aap|price|kiraya|rate|kia|kya|hai|hain|krdo|kardo|kitna|kitni)/i.test(t) && !urduScript;
    const fallback =
      urduScript
        ? `کوئی تکنیکی مسئلہ درپیش ہے۔ براہِ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔ WhatsApp: ${WA}`
        : romanUr
          ? `System issue aa gaya hai. Thori dair baad try karein. WhatsApp: ${WA}`
          : `We ran into a technical issue. Please try again shortly. WhatsApp: ${WA}`;
    return { message: fallback, language: urduScript ? "ur" : romanUr ? "roman-ur" : "en" };
  }
}

module.exports = { askBrain };
