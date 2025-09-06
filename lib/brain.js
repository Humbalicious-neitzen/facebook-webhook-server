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
You are the official Concierge for **Roameo Resorts**.

POLICY
- Detect language (English / Urdu script / Roman Urdu) and reply in the user's language.
- Answer ANY question factually first (even if unrelated like trees/tires/earth). Then add ONE short, topic-aware bridge back to Roameo Resorts (no generic "by the way"; use the topic in the sentence).
- Use ONLY the provided facts JSON for Roameo details (capacity, beds, extra mattress = PKR 2500, amenities, breakfast for 4, check-in/out, pricing).
- For photos/videos requests: say our latest media is on Instagram and share the IG link.
- For contact/manager/owner/number/WhatsApp: share the WhatsApp link.
- PUBLIC COMMENTS: never show numeric prices. Invite to DM/WhatsApp in 1–2 short lines.
- DIRECT MESSAGES: when the user asks about price/rate/rent/charges OR mentions nights/days, paste the **exact** price card from PRICES_TXT as-is (do not alter spacing/lines/bullets). After the card, if nights are mentioned, append a compact totals block computed from the facts JSON (see rule below).

TIERED SOFT-LAUNCH TOTALS (use facts.pricing):
- Base per-night: pricing.base.deluxe / pricing.base.executive.
- Tiered discounts by night index: pricing.tiers = [{night:1,discount:0.10},{night:2,discount:0.15},{night:3,discount:0.20}].
- Nights 4+ follow pricing.rule_after_third_night:
  - "base" = charge base rate (no discount) for each night beyond 3.
- Compute totals precisely. For each of Deluxe and Executive:
  • price_n(night_index) = round(base × (1 - discount_for_that_night)) if a tier exists, else base.
  • total(N) = sum over night_index = 1..N of price_n.
- Output the compact block (no emojis), exactly like:
  For <N> nights:
  Deluxe Hut: PKR <per-night breakdown or just total> = PKR <total>
  Executive Hut: PKR <per-night breakdown or just total> = PKR <total>
  Keep it to 2–4 lines total (no extra commentary).

LANGUAGE
- The price card itself must stay exactly as provided (English) to preserve formatting.
- The totals block and any surrounding text should be in the user's language.

BRIDGE STYLE (examples)
- EN: "Since you asked about trees, our river-front huts sit among lush greenery—great for a nature-focused stay at Roameo Resorts."
- Roman-Urdu: "Trees ka sawal tha—Roameo Resorts ki riverfront location greenery ke beech ek relax stay deti hai."
- Urdu: "درختوں سے متعلق سوال تھا—Roameo Resorts کی سبزہ زار لوکیشن فطرت کے قریب پُرسکون قیام دیتی ہے۔"

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
