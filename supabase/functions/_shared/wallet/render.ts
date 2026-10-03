// Loads a membership's current state and renders its signed .pkpass.
import forge from "npm:node-forge@1.4.0";
import { zipSync, zlibSync } from "npm:fflate@0.8.3";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildPassJson, createPacker, solidPng, THEMES, type Tier } from "./pass.ts";

const pack = createPacker({ forge, zipSync });

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret ${name}. See docs/apple-wallet-setup.md.`);
  return v;
}

export const PASS_TYPE_ID = () => env("WALLET_PASS_TYPE_ID");

export type PassRow = {
  serial: string;
  auth_token: string;
  updated_at: string;
  membership_id: string;
};

export async function findPass(db: SupabaseClient, serial: string): Promise<PassRow | null> {
  const { data, error } = await db.from("wallet_passes").select("serial, auth_token, updated_at, membership_id").eq("serial", serial).maybeSingle();
  if (error) throw error;
  return data;
}

export async function renderPass(db: SupabaseClient, pass: PassRow): Promise<Uint8Array> {
  const { data: m, error } = await db
    .from("memberships")
    .select("id, member_no, tier, visits, joined_at, guests(first_name), venues(slug, name, area, theme, latitude, longitude, tier_gold_at, tier_black_at)")
    .eq("id", pass.membership_id)
    .single();
  if (error) throw error;

  const { count: birthdayReady } = await db
    .from("vouchers")
    .select("id", { count: "exact", head: true })
    .eq("membership_id", m.id)
    .eq("kind", "birthday")
    .is("redeemed_at", null)
    .gt("expires_at", new Date().toISOString());

  // deno-lint-ignore no-explicit-any
  const venue = m.venues as any, guest = m.guests as any;
  const json = buildPassJson({
    passTypeIdentifier: PASS_TYPE_ID(),
    teamIdentifier: env("WALLET_TEAM_ID"),
    webServiceURL: env("WALLET_WEB_SERVICE_URL"),
    serialNumber: pass.serial,
    authenticationToken: pass.auth_token,
    venue: {
      name: venue.name, area: venue.area, theme: venue.theme,
      latitude: venue.latitude, longitude: venue.longitude,
      tierGoldAt: venue.tier_gold_at, tierBlackAt: venue.tier_black_at,
    },
    member: {
      membershipId: m.id, firstName: guest.first_name, memberNo: m.member_no,
      tier: m.tier as Tier, visits: m.visits, joinedAt: m.joined_at,
      birthdayTreatReady: (birthdayReady ?? 0) > 0,
    },
  });

  return pack(json, await venueImages(db, venue.slug, venue.theme), {
    signerCertPem: env("WALLET_SIGNER_CERT"),
    signerKeyPem: env("WALLET_SIGNER_KEY"),
    signerKeyPassphrase: Deno.env.get("WALLET_SIGNER_KEY_PASSPHRASE") || undefined,
    wwdrPem: env("WALLET_WWDR_CERT"),
  });
}

// Venue artwork lives in the `wallet-assets` storage bucket under the venue slug:
// icon.png, icon@2x.png, icon@3x.png, logo.png, logo@2x.png, strip.png, strip@2x.png.
// Anything missing is skipped; a missing icon falls back to a plain accent square.
const IMAGE_NAMES = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png", "strip.png", "strip@2x.png", "strip@3x.png"];
const imageCache = new Map<string, { at: number; files: Record<string, Uint8Array> }>();

async function venueImages(db: SupabaseClient, slug: string, theme: string): Promise<Record<string, Uint8Array>> {
  const hit = imageCache.get(slug);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.files;

  const files: Record<string, Uint8Array> = {};
  await Promise.all(IMAGE_NAMES.map(async (name) => {
    const { data } = await db.storage.from("wallet-assets").download(`${slug}/${name}`);
    if (data) files[name] = new Uint8Array(await data.arrayBuffer());
  }));
  if (!files["icon.png"]) {
    const rgb = (THEMES[theme] ?? THEMES.gold).icon;
    files["icon.png"] = solidPng(29, rgb, zlibSync);
    files["icon@2x.png"] = solidPng(58, rgb, zlibSync);
    files["icon@3x.png"] = solidPng(87, rgb, zlibSync);
  }
  imageCache.set(slug, { at: Date.now(), files });
  return files;
}

export function pkpassResponse(bytes: Uint8Array, updatedAt: string): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/vnd.apple.pkpass",
      "Content-Disposition": 'attachment; filename="membership.pkpass"',
      "Last-Modified": new Date(updatedAt).toUTCString(),
      "Cache-Control": "no-store",
    },
  });
}
