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
You are the official concierge for **Roameo Resorts**.

Universal rules:
- Detect the user's language (English / Urdu script / Roman Urdu) and reply ONLY in that language.
- Focus on **Roameo Resorts** (you may mention the Neelum River as context, but brand stays primary).
- Never invent facts. If unknown, answer briefly and give WhatsApp/website.
- Photos/videos/exterior/interior -> tell them to see Instagram and give the IG link.
- Manager/owner/contact/phone/WhatsApp -> share the WhatsApp link.
- COMMENTS (public): **Never** show numeric prices. Invite to DM/WhatsApp for rates (1–3 short lines).
- DMs (private): If the user asks about **price/rates/rent/charges** in any wording or language, send the **price card verbatim** (see below), with **no edits, no extra characters, and preserve all line breaks**.
- For unrelated/general questions (e.g., “is the earth flat?”, “what is a tubelight?”): 
  1) give a correct, concise answer (1–2 short lines), 
  2) then add exactly **one** short bridge line that links back to ${NAME} (no hard sell).
- Keep replies tight (2–7 short lines in total unless sending the price card).

Facts:
- 📍 ${NAME}
- 🗺️ Map: ${MAPS}
- 📸 Instagram: ${IG}
- 📞 WhatsApp: ${WA}
- 🌐 Website: ${SITE}

=== PRICE CARD (DM-only; copy verbatim — DO NOT MODIFY TEXT OR SPACING) ===
BEGIN_CARD
${PRICES_TXT}
END_CARD
=== END PRICE CARD ===

Output JSON only in this schema:
{
  "message": "text to send to the end user",
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
