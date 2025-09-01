// lib/brain.js
// GPT-first brain: one canonical (English) price card in env -> GPT localizes output
// Surfaces: "dm" and "comment" (your server passes this in)

const axios = require("axios");

const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Render often stores multiline as \n — normalize it
const PRICES_TXT = (process.env.ROAMEO_PRICES_TEXT || "").replaceAll("\\n", "\n").trim();

const NAME = process.env.ROAMEO_LOCATION_NAME || "Roameo Resorts";
const MAPS = process.env.ROAMEO_MAPS_LINK    || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6";
const WA   = process.env.ROAMEO_WHATSAPP_LINK|| "https://wa.me/923558000078";
const IG   = process.env.ROAMEO_INSTAGRAM_LINK|| "https://www.instagram.com/roameoresorts/";
const SITE = process.env.ROAMEO_WEBSITE_LINK || "https://www.roameoresorts.com/";

// ============================================================================
// SYSTEM PROMPT (GPT-first; no keyword list; GPT detects intent & language)
// ============================================================================
const SYSTEM = `
You are the **official Concierge for Roameo Resorts**. You will receive:
- { "surface": "dm" | "comment", "text": "<user message>" }

### Non-negotiable rules
1) **Language** — Detect the user's language and reply ONLY in that language:
   - "en" (English), "ur" (Urdu script), or "roman-ur" (Roman Urdu, ASCII letters).
2) **Focus** — Keep the brand focus on **Roameo Resorts**. You may mention the Neelum River only as context.
3) **No hallucinations** — If unknown, say so briefly and offer WhatsApp/website.
4) **Media** — If asked for photos/videos/exterior/interior, say our latest media is on Instagram and include: ${IG}
5) **Contact** — If asked for manager/owner/contact/number/WhatsApp/call, share: ${WA}
6) **Location** — If asked for address/location/map/directions, include: ${MAPS}
7) **Public comments** — NEVER show numeric prices. Invite to DM/WhatsApp in 1–3 short lines (no big blocks).
8) **Direct messages (DMs)** — If the user asks about price/charges/rates/rent in ANY wording, do this:
   - **Localize** the headings/sentences to the user's language **but keep the exact layout, bulleting, emojis, and ALL numbers unchanged**.
   - Paste the following canonical price card as the core content (it is in English; translate the labels/phrases ONLY, not numbers/emojis):

${"```"}
${PRICES_TXT}
${"```"}

   - If the user mentions a number of nights (e.g., "4 nights"), append an **Estimated Total** section:
     • Compute total = discounted nightly rate × nights for **each hut type** shown in the card.  
     • Show one line per hut (e.g., "Deluxe (x nights): PKR <amount>").  
     • Add a short note like "Estimate only; availability may affect final amount."
   - End with a concise booking CTA (WhatsApp + Website).
9) **Vague or unrelated questions** — Briefly answer correctly, then add **one short bridge line** tying back to Roameo Resorts (no pushy sales).
10) **Style**
    - Short, clear lines. Friendly, not flowery. No over-promising. Keep emojis minimal (0–2).
    - Respect line breaks from the price card; do **not** reformat bullets or emojis.

### Output
Return ONLY strict JSON:

{
  "message": "final reply text for the end user",
  "language": "en" | "ur" | "roman-ur"
}
`.trim();

// Response schema for safety (forces JSON)
function responseSchema() {
  return {
    type: "json_schema",
    json_schema: {
      name: "roameo_schema",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          message:  { type: "string" },
          language: { enum: ["en","ur","roman-ur"] }
        },
        required: ["message","language"]
      }
    }
  };
}

/**
 * askBrain({ text, surface })
 * @param {string} text - raw user message
 * @param {"dm"|"comment"} surface - where the message came from
 * @returns {Promise<{message:string, language:"en"|"ur"|"roman-ur"}>}
 */
async function askBrain({ text, surface }) {
  const payload = {
    model: MODEL,
    temperature: 0.4,            // more deterministic to avoid drift
    response_format: responseSchema(),
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          surface,
          text,
          facts: {
            name: NAME,
            maps: MAPS,
            whatsapp: WA,
            instagram: IG,
            website: SITE,
            prices_card_canonical_english: PRICES_TXT
          }
        })
      }
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
        timeout: 20000
      }
    );

    const raw = data?.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    // Minimal sanitation: trim & collapse >2 blank lines
    parsed.message = String(parsed.message || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return parsed;
  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);
    return {
      message:
        "Sorry, something went wrong. For quick help:\nWhatsApp: " +
        WA + "\nWebsite: " + SITE,
      language: "en"
    };
  }
}

module.exports = { askBrain };
