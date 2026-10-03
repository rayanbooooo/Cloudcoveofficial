// GET /wallet-pass?s=<serial>&t=<token>: the "Add to Apple Wallet" download.
// Safari on iPhone opens the .pkpass straight into Wallet.
import { db, json } from "../_shared/db.ts";
import { findPass, pkpassResponse, renderPass } from "../_shared/wallet/render.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const serial = url.searchParams.get("s") ?? "";
  const token = url.searchParams.get("t") ?? "";

  const pass = serial ? await findPass(db, serial) : null;
  if (!pass || !token || pass.auth_token !== token) return json({ error: "This card link isn't valid. Scan the QR code at your table again." }, 404);

  try {
    return pkpassResponse(await renderPass(db, pass), pass.updated_at);
  } catch (e) {
    console.error("render failed", e);
    return json({ error: "We couldn't create your card right now. Please try again in a minute." }, 500);
  }
});
