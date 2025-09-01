// lib/brain.js
// GPT-first concierge for Roameo Resorts
// - General/vague Q&A: GPT answers factually, then bridges to Roameo (1 short line).
// - Prices in DMs: PASTE VERBATIM from env (to preserve exact layout). Never show prices in comments.
// - Media/contact/location: handled by GPT via rules (no intent branching).
// - Nights math: if user mentions "X nights", append Estimated Total under the card.

const axios = require("axios");

const KEY   = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Keep your canonical price card EXACT (Render may store \n as literal)
const PRICES_TXT = (process.env.ROAMEO_PRICES_TEXT || "").replaceAll("\\n", "\n");

const NAME = process.env.ROAMEO_LOCATION_NAME   || "Roameo Resorts";
const MAPS = process.env.ROAMEO_MAPS_LINK       || "https://maps.app.goo.gl/Y49pQPd541p1tvUf6";
const WA   = process.env.ROAMEO_WHATSAPP_LINK   || "https://wa.me/923558000078";
const IG   = process.env.ROAMEO_INSTAGRAM_LINK  || "https://www.instagram.com/roameoresorts/";
const SITE = process.env.ROAMEO_WEBSITE_LINK    || "https://www.roameoresorts.com/";

// -------------------- small helpers (not intents) --------------------
function langOf(text="") {
  const hasUrdu = /[\u0600-\u06FF]/.test(text);
  if (hasUrdu) return "ur";
  const romanHit = /\b(aap|ap|apka|apki|apke|krdo|kardo|kiraya|qeemat|rate|plz|pls|btao|kitna|kitni|kitne)\b/i.test(text);
  return romanHit ? "roman-ur" : "en";
}
function normalize(s=""){ return s.normalize("NFKD").toLowerCase(); }

// Single safeguard: detect price-ish wording in DMs to paste the card verbatim
function isPriceQuestion(text="") {
  const t = normalize(text);
  return /\b(price|prices|pricing|rate|rates|rent|rental|charge|charges|cost|costs)\b/.test(t)
      || /\bkitna|kitni|kitne|kiraya|qeemat|keemat|kimat\b/.test(t)
      || /\bریٹ|نرخ|قیمت|کرایہ\b/.test(t);
}

// Parse discounted per-night values from your card (e.g., "→ PKR 18,000/night")
function parseDiscountedRates(card = PRICES_TXT) {
  const rx = /→\s*PKR\s*([\d,]+)\/night/gi;
  const nums = [];
  let m; while ((m = rx.exec(card))) nums.push(parseInt(m[1].replace(/,/g,""),10));
  return { deluxe: nums[0] || null, executive: nums[1] || null }; // order assumed by card layout
}

// Detect nights mentioned (e.g., "4 nights", "for 3 night", "4n")
function detectNights(text="") {
  const m = text.match(/(\d+)\s*(nights?|n)\b/i) || text.match(/for\s+(\d+)\s*nights?/i);
  return m ? parseInt(m[1],10) : null;
}

// Build VERBATIM price DM (exact spacing), plus optional totals, then CTA
function buildPriceDM(userText="") {
  const nights = detectNights(userText);
  const { deluxe, executive } = parseDiscountedRates(PRICES_TXT);

  let msg = PRICES_TXT.trim();

  if (nights && (deluxe || executive)) {
    const lines = [];
    lines.push(``);
    lines.push(`Estimated Total (${nights} night${nights>1?"s":""}):`);
    if (deluxe)    lines.push(`• Deluxe (${nights} nights): PKR ${(deluxe * nights).toLocaleString("en-PK")}`);
    if (executive) lines.push(`• Executive (${nights} nights): PKR ${(executive * nights).toLocaleString("en-PK")}`);
    lines.push(`(Estimate only; availability may affect final amount.)`);
    msg = `${msg}\n\n${lines.join("\n")}`;
  }

  msg = `${msg}\n\nWhatsApp: ${WA}\nAvailability / Book: ${SITE}`;
  return { message: msg, language: "en" }; // keep card EXACT; rest of bot still multilingual
}

// -------------------- GPT brain (everything else) --------------------
const SYSTEM = `
You are the official Concierge for **Roameo Resorts**.

Non-negotiable rules:
- **Language**: Detect and reply ONLY in the user's language — "en" (English), "ur" (Urdu script), or "roman-ur" (Roman Urdu ASCII).
- **Brand focus**: Keep the center of gravity on **Roameo Resorts** (riverfront huts by the Neelum River is context, not the star).
- **No hallucinations**: If uncertain, say so briefly; offer WhatsApp and Website.
- **Media**: If asked for photos/videos/exterior/interior, state that our latest media is on Instagram and include: ${IG}
- **Contact**: If asked for manager/owner/number/WhatsApp/call, include: ${WA}
- **Location/Directions**: If asked for address/map/pin/directions, include: ${MAPS}
- **Public comments**: NEVER show numeric prices. Invite to DM/WhatsApp in 1–3 short lines (no big blocks, no numbers).
- **DM price card**: Sometimes the server will itself paste the price card verbatim. If you are asked about prices in a DM and did NOT receive a pasted card, give a short nudge to WhatsApp for the detailed rate card (no numbers from you).
- **Style**: Short, clear lines; minimal emojis (0–2). Friendly, not flowery.

Universal behavior for ANY general or unrelated question or statement:
- First: give a short, factual answer in the user's language (1–2 lines).
- Then: add ONE short, natural bridge back to Roameo Resorts (huts, river views, nature, warm lighting, breakfast, peaceful stay, etc.).
- Keep the bridge relevant and not salesy. Do not skip the factual answer.

Few-shot: natural bridges (answer first, then a single Roameo line)

User(en): "is the earth flat?"
Assistant(en): "No—evidence from satellites and physics shows Earth is roughly spherical. 🌍
Roameo Resorts sits along the Neelum River on that same curved horizon, where the views are as real as the science."

User(en): "what are different types of trees?"
Assistant(en): "Broad groups include conifers (pine, cedar), broadleaf deciduous (oak, maple), and evergreens (olive, magnolia).
Around Roameo Resorts, the riverside evergreens frame the huts and make mornings feel extra fresh."

User(roman-ur): "tubelight kia hoti hai?"
Assistant(roman-ur): "Tubelight ek fluorescent lamp hoti hai jo kam bijli mein tez roshni deti hai.
Roameo Resorts par hum warm, cozy lighting rakhte hain taa ke stay araam-deh lage."

User(ur): "types of tires?"
Assistant(ur): "عام اقسام میں آل سیزن، ونٹر، پرفارمنس اور آف روڈ ٹائر شامل ہوتے ہیں۔
Roameo Resorts کے سفر کے لیے مناسب ٹائر انتخاب ڈرائیو کو محفوظ اور پُرسکون بناتا ہے."

Output strictly as JSON:
{
  "message": "final reply text",
  "language": "en" | "ur" | "roman-ur"
}
`.trim();

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
 *  - surface: "dm" or "comment"
 *  - returns { message, language }
 */
async function askBrain({ text, surface }) {
  // ONLY safeguard: if it's a DM and user asked for prices, paste the exact card
  if (surface === "dm" && isPriceQuestion(text)) {
    return buildPriceDM(text);
  }

  // Else, let GPT handle it with the universal factual+bridge rule
  const payload = {
    model: MODEL,
    temperature: 0.25, // tight and consistent
    response_format: responseSchema(),
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: JSON.stringify({
          surface,
          text,
          brand: { name: NAME, maps: MAPS, whatsapp: WA, instagram: IG, website: SITE }
        })
      }
    ]
  };

  try {
    const { data } = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      { headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, timeout: 20000 }
    );
    const raw = data?.choices?.[0]?.message?.content || "{}";
    const j = JSON.parse(raw);

    // Tiny sanitation
    j.message = String(j.message || "").replace(/\r\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
    j.language = j.language || langOf(text);
    return j;
  } catch (err) {
    console.error("❌ Brain error:", err?.response?.data || err.message);
    return {
      message: `Sorry—please try again.\nWhatsApp: ${WA}\nWebsite: ${SITE}`,
      language: "en"
    };
  }
}

module.exports = { askBrain };
