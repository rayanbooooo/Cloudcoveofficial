// POST /join: a guest joins a venue's Private Guest List from the table QR code.
// Returns the welcome drink voucher (first join only) and the Add to Apple Wallet link.
import { cors, db, json } from "../_shared/db.ts";

const CONSENT_TEXT =
  "Send me member invites and offers on WhatsApp. At most twice a month, and you can opt out anytime. Your drink does not depend on this.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send the form as JSON." }, 400);
  }

  const venue = String(body.venue ?? "").toLowerCase();
  const name = String(body.first_name ?? "").trim().slice(0, 40);
  const phone = String(body.phone ?? "").replace(/[\s()-]/g, "");
  const day = Number(body.birthday_day) || null;
  const month = Number(body.birthday_month) || null;

  if (!venue) return json({ error: "Missing venue." }, 400);
  if (!name) return json({ error: "Enter your first name." }, 400);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return json({ error: "Enter your WhatsApp number with the country code, for example +971 50 123 4567." }, 400);
  if ((day && (day < 1 || day > 31)) || (month && (month < 1 || month > 12))) return json({ error: "Check your birthday." }, 400);

  const { data, error } = await db.rpc("join_venue", {
    p_venue_slug: venue,
    p_phone: phone,
    p_first_name: name,
    p_birthday_day: day,
    p_birthday_month: month,
    p_interests: Array.isArray(body.interests) ? body.interests.map(String).slice(0, 10) : [],
    p_opt_in: body.marketing_opt_in === true,
    p_consent_text: CONSENT_TEXT,
    p_source: String(body.source ?? "qr").slice(0, 40),
    p_language: ["en", "ar", "ru", "fr", "nl"].includes(String(body.language)) ? String(body.language) : "en",
  });
  if (error) {
    if (error.code === "P0002") return json({ error: "This venue isn't on the guest list yet." }, 404);
    console.error("join_venue failed", error);
    return json({ error: "We couldn't save your membership. Please try again." }, 500);
  }

  const base = Deno.env.get("SUPABASE_URL") + "/functions/v1/wallet-pass";
  return json({
    ...data,
    wallet_url: `${base}?s=${data.wallet.serial}&t=${data.wallet.token}`,
    wallet: undefined,
  });
});
