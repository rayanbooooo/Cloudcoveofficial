// Apple's PassKit web service. iPhones call these routes to register for updates
// and fetch the latest version of a card. Set WALLET_WEB_SERVICE_URL to this function's URL
// (https://<project-ref>.supabase.co/functions/v1/wallet-service). Deploy with --no-verify-jwt,
// because Apple authenticates with the pass's own token, not a Supabase JWT.
//
//   POST   /v1/devices/:device/registrations/:passType/:serial   register a device
//   DELETE /v1/devices/:device/registrations/:passType/:serial   unregister
//   GET    /v1/devices/:device/registrations/:passType           serials updated since a tag
//   GET    /v1/passes/:passType/:serial                          latest pass
//   POST   /v1/log                                               device error log
import { db } from "../_shared/db.ts";
import { findPass, PASS_TYPE_ID, pkpassResponse, renderPass } from "../_shared/wallet/render.ts";

const text = (status: number, body = "") => new Response(body, { status });

async function authorised(req: Request, serial: string) {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.startsWith("ApplePass ") ? header.slice(10) : "";
  const pass = await findPass(db, serial);
  return pass && token && pass.auth_token === token ? pass : null;
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/wallet-service/, "");
  const parts = path.split("/").filter(Boolean); // ["v1", ...]
  if (parts[0] !== "v1") return text(404);

  try {
    // Device logs: Apple sends these when something goes wrong on the phone.
    if (parts[1] === "log" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      console.warn("PassKit device log", JSON.stringify(body).slice(0, 2000));
      return text(200);
    }

    // /v1/devices/:device/registrations/:passType[/:serial]
    if (parts[1] === "devices" && parts[3] === "registrations") {
      const device = parts[2], passType = parts[4], serial = parts[5];
      if (passType !== PASS_TYPE_ID()) return text(404);

      if (serial && req.method === "POST") {
        if (!(await authorised(req, serial))) return text(401);
        const { pushToken } = await req.json().catch(() => ({ pushToken: "" }));
        if (!pushToken) return text(400);
        const { data: existing } = await db.from("wallet_registrations").select("serial").eq("device_library_id", device).eq("serial", serial).maybeSingle();
        const { error } = await db.from("wallet_registrations").upsert({ device_library_id: device, serial, push_token: pushToken });
        if (error) throw error;
        return text(existing ? 200 : 201);
      }

      if (serial && req.method === "DELETE") {
        if (!(await authorised(req, serial))) return text(401);
        await db.from("wallet_registrations").delete().eq("device_library_id", device).eq("serial", serial);
        return text(200);
      }

      if (!serial && req.method === "GET") {
        const since = new URL(req.url).searchParams.get("passesUpdatedSince");
        const { data: regs, error } = await db.from("wallet_registrations").select("serial, wallet_passes(updated_at)").eq("device_library_id", device);
        if (error) throw error;
        // deno-lint-ignore no-explicit-any
        const rows = (regs ?? []).map((r: any) => ({ serial: r.serial, updated: new Date(r.wallet_passes.updated_at).getTime() }));
        const changed = rows.filter((r) => !since || r.updated > Number(since));
        if (!changed.length) return text(204);
        const lastUpdated = String(Math.max(...rows.map((r) => r.updated)));
        return new Response(JSON.stringify({ serialNumbers: changed.map((r) => r.serial), lastUpdated }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // /v1/passes/:passType/:serial
    if (parts[1] === "passes" && req.method === "GET") {
      if (parts[2] !== PASS_TYPE_ID()) return text(404);
      const pass = await authorised(req, parts[3]);
      if (!pass) return text(401);
      const since = req.headers.get("If-Modified-Since");
      // HTTP dates have one-second precision, so compare at that resolution.
      if (since && Math.floor(new Date(pass.updated_at).getTime() / 1000) <= Math.floor(new Date(since).getTime() / 1000)) return text(304);
      return pkpassResponse(await renderPass(db, pass), pass.updated_at);
    }

    return text(404);
  } catch (e) {
    console.error("wallet-service error", e);
    return text(500);
  }
});
