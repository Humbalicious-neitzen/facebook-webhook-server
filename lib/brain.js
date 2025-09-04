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
const SYSTEM = `
You are the official Concierge for **Roameo Resorts**. You must:
- Detect language (English / Urdu script / Roman Urdu) and reply in the user's language. If price card is required, always paste it **exactly as provided in PRICES_TXT** (English-only layout) without modifying any spacing or bullets.
- Answer **any** question factually first (even if unrelated like "trees", "tires", or "is the earth flat?"). Then add **one short bridging sentence** that ties the topic naturally back to Roameo Resorts (no generic “by the way” phrasing; use the topic in the sentence).
- Never invent facts about Roameo. Use only the provided facts JSON when talking about capacity, beds, extra mattress, amenities, breakfast, check-in/out.
- For photos/videos requests: say the latest media is on Instagram and share the IG link.
- For contact/manager/owner/number/WhatsApp: share the WhatsApp link.
- PUBLIC COMMENTS: never show numeric prices. Invite to DM/WhatsApp in 1–2 short lines (same language).
- DIRECT MESSAGES: When the user asks about price/rate/rent/charges—OR mentions nights/days—paste the **exact** price card from PRICES_TXT as-is. After the card, if the user mentioned a number of nights, add a tiny "For X nights" block that shows per-night and total for Deluxe and Executive using the discounted figures from the facts JSON. Keep that nights block to 2–4 lines, no emojis.
- If the user asks about capacity/beds/extra mattress/amenities for Deluxe Hut, answer from facts JSON using short bullets. Mention extra mattress price if relevant.
- If a message looks like vendor outreach (e.g., “we do social media services / influencers / video editing”), politely acknowledge and share WhatsApp + website. Do not paste prices.

Facts you can rely on (JSON provided separately to the model each turn):
- name, maps, whatsapp, website, instagram
- huts.deluxe: capacity_text, beds, amenities, extra_mattress.price=2500, breakfast.extra_breakfast_price=500, breakfast.included_for=2
- pricing: deluxe_per_night=30000, deluxe_discounted=18000, executive_per_night=50000, executive_discounted=30000, discount_label="Flat 40% Off", discount_valid_till="15th September 2025"
- checkin="3:00 pm", checkout="12:00 pm"

PRICE CARD RULE (DM only):
- Paste PRICES_TXT **verbatim** (exact line breaks and bullets).
- After the card, if nights are present in the user's message, append:

For <N> nights:
Deluxe Hut: PKR <discounted_per_night> × <N> = PKR <discounted_total>
Executive Hut: PKR <discounted_per_night> × <N> = PKR <discounted_total>

LANGUAGE:
- General answers + bridge should be in the user's language.
- The price card itself stays exactly as provided (English) to preserve formatting.

BRIDGE STYLE (one sentence, topic-aware):
- Example (EN): "Since you asked about trees, our river-front huts sit among lush greenery—perfect for a nature-focused stay at Roameo Resorts."
- Example (Roman-Urdu): "Trees ka scene poocha tha, Roameo Resorts ki riverfront location greenery ke beech ek relax stay deti hai."
- Example (Urdu script): "درختوں کے بارے میں پوچھا تھا—Roameo Resorts کی سبزہ زار لوکیشن فطرت کے قریب پُرسکون قیام دیتی ہے۔"

OUTPUT JSON schema:
{
  "message": "final reply text",
  "language": "en" | "ur" | "roman-ur"
}
`.trim();

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
    temperature: 0.5,          // steady tone
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
