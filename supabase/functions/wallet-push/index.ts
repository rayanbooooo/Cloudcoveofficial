// POST /wallet-push: sends Apple push notifications for every card that changed.
// Run it every minute with pg_cron (see docs/apple-wallet-setup.md). The push itself is empty;
// it tells the iPhone to fetch the new card from wallet-service, and iOS shows the
// field's changeMessage ("You're now Gold at …") on the lock screen.
//
// Wallet pushes must use the Pass Type ID certificate (token-based APNs auth is not
// accepted for passes), so this opens an HTTP/2 client with that certificate.
import { db, json } from "../_shared/db.ts";

const APNS = "https://api.push.apple.com/3/device/";

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`) return json({ error: "Forbidden" }, 403);

  const { data: queue, error } = await db.from("wallet_push_queue").select("id, serial").is("sent_at", null).order("id").limit(500);
  if (error) return json({ error: error.message }, 500);
  if (!queue?.length) return json({ pushed: 0 });

  const serials = [...new Set(queue.map((q) => q.serial))];
  const { data: regs } = await db.from("wallet_registrations").select("device_library_id, serial, push_token").in("serial", serials);

  const client = Deno.createHttpClient({
    cert: Deno.env.get("WALLET_SIGNER_CERT")!,
    key: Deno.env.get("WALLET_SIGNER_KEY")!,
    http2: true,
    http1: false,
  });

  let pushed = 0, gone = 0;
  const tokens = [...new Map((regs ?? []).map((r) => [r.push_token, r])).values()];
  await Promise.all(tokens.map(async (r) => {
    const res = await fetch(APNS + r.push_token, {
      method: "POST",
      client,
      headers: { "apns-topic": Deno.env.get("WALLET_PASS_TYPE_ID")! },
      body: "{}",
    });
    if (res.ok) pushed++;
    else if (res.status === 410) {
      // The device removed the card or reset; stop sending to it.
      gone++;
      await db.from("wallet_registrations").delete().eq("push_token", r.push_token);
    } else {
      console.error("APNs push failed", res.status, await res.text());
    }
  }));
  client.close();

  await db.from("wallet_push_queue").update({ sent_at: new Date().toISOString() }).in("id", queue.map((q) => q.id));
  return json({ queued: queue.length, devices: tokens.length, pushed, removed: gone });
});
