// Apple Wallet store card for a Private Guest List membership.
//
// Pure code with no I/O. The packer receives its crypto and zip libraries as arguments,
// so the same file runs in Supabase Edge Functions (Deno, npm: imports) and in Node tests.

export type Tier = "silver" | "gold" | "black";

export type PassInput = {
  passTypeIdentifier: string;
  teamIdentifier: string;
  webServiceURL: string;
  serialNumber: string;
  authenticationToken: string;
  venue: {
    name: string;
    area: string | null;
    theme: string;
    latitude: number | null;
    longitude: number | null;
    tierGoldAt: number;
    tierBlackAt: number;
  };
  member: {
    membershipId: string;
    firstName: string;
    memberNo: string;
    tier: Tier;
    visits: number;
    joinedAt: string;
    birthdayTreatReady: boolean;
  };
};

// Card colours per venue theme. Labels use the theme's metallic accent.
export const THEMES: Record<string, { bg: string; fg: string; label: string; icon: [number, number, number] }> = {
  gold:    { bg: "rgb(13,13,15)", fg: "rgb(244,239,230)", label: "rgb(212,178,122)", icon: [212, 178, 122] },
  emerald: { bg: "rgb(8,19,15)",  fg: "rgb(236,242,238)", label: "rgb(201,164,92)",  icon: [201, 164, 92] },
  rose:    { bg: "rgb(19,12,16)", fg: "rgb(246,236,239)", label: "rgb(226,169,154)", icon: [226, 169, 154] },
  ocean:   { bg: "rgb(10,15,23)", fg: "rgb(238,242,247)", label: "rgb(227,200,154)", icon: [227, 200, 154] },
};

const TIER_NAME: Record<Tier, string> = { silver: "Silver", gold: "Gold", black: "Black" };

export function nextTierText(tier: Tier, visits: number, goldAt: number, blackAt: number): string {
  if (tier === "silver") {
    const n = Math.max(1, goldAt - visits);
    return `Gold in ${n} visit${n === 1 ? "" : "s"}`;
  }
  if (tier === "gold") {
    const n = Math.max(1, blackAt - visits);
    return `Black in ${n} visit${n === 1 ? "" : "s"}`;
  }
  return "Highest tier";
}

export function buildPassJson(p: PassInput): Record<string, unknown> {
  const t = THEMES[p.venue.theme] ?? THEMES.gold;
  const m = p.member;
  const since = new Date(m.joinedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Dubai" });

  const pass: Record<string, unknown> = {
    formatVersion: 1,
    passTypeIdentifier: p.passTypeIdentifier,
    teamIdentifier: p.teamIdentifier,
    serialNumber: p.serialNumber,
    authenticationToken: p.authenticationToken,
    webServiceURL: p.webServiceURL,
    organizationName: p.venue.name,
    description: `${p.venue.name} membership card`,
    logoText: p.venue.name,
    backgroundColor: t.bg,
    foregroundColor: t.fg,
    labelColor: t.label,
    sharingProhibited: true,
    storeCard: {
      headerFields: [
        // changeMessage makes iOS show a lock-screen notification when the value changes.
        { key: "tier", label: "TIER", value: TIER_NAME[m.tier], changeMessage: `You're now %@ at ${p.venue.name}.` },
      ],
      primaryFields: [
        { key: "member", label: "MEMBER", value: m.firstName },
      ],
      secondaryFields: [
        { key: "visits", label: "VISITS", value: m.visits },
        { key: "next", label: "NEXT", value: nextTierText(m.tier, m.visits, p.venue.tierGoldAt, p.venue.tierBlackAt) },
      ],
      auxiliaryFields: [
        {
          key: "offer",
          label: "TONIGHT",
          value: m.birthdayTreatReady ? "Birthday treat waiting" : "Show this card on arrival",
          changeMessage: "%@",
        },
        { key: "since", label: "SINCE", value: since, textAlignment: "PKTextAlignmentRight" },
      ],
      backFields: [
        { key: "no", label: "Member number", value: m.memberNo },
        {
          key: "perks",
          label: "Your perks",
          value:
            `Silver: welcome drink and a birthday treat every year.\n` +
            `Gold (${p.venue.tierGoldAt} visits): priority booking on weekends.\n` +
            `Black (${p.venue.tierBlackAt} visits): a private host and the best table.`,
        },
        { key: "how", label: "How to use", value: "Show this card to your server. They scan it to log your visit and apply your perks." },
        { key: "privacy", label: "Messages", value: "You can stop offers at any time by replying STOP on WhatsApp or asking the team." },
      ],
    },
    barcodes: [
      { format: "PKBarcodeFormatQR", message: `PGL:${m.membershipId}`, messageEncoding: "iso-8859-1", altText: m.memberNo },
    ],
  };

  // Shows the card on the lock screen when the guest is near the venue.
  if (p.venue.latitude != null && p.venue.longitude != null) {
    pass.locations = [{
      latitude: Number(p.venue.latitude),
      longitude: Number(p.venue.longitude),
      relevantText: `Welcome back to ${p.venue.name}. Show your card for your perks.`,
    }];
  }
  return pass;
}

// ---------------------------------------------------------------------------
// Packing: pass.json + images + manifest.json + detached PKCS #7 signature, zipped.
// ---------------------------------------------------------------------------
export type SigningCerts = {
  signerCertPem: string;       // Pass Type ID certificate
  signerKeyPem: string;        // its private key
  signerKeyPassphrase?: string;
  wwdrPem: string;             // Apple WWDR intermediate certificate
};

type Deps = {
  // deno-lint-ignore no-explicit-any
  forge: any;
  zipSync: (files: Record<string, Uint8Array>, opts?: { level?: number }) => Uint8Array;
};

function toBinary(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + 0x8000)));
  }
  return s;
}

function fromBinary(s: string): Uint8Array {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
}

export function createPacker({ forge, zipSync }: Deps) {
  const sha1Hex = (bytes: Uint8Array): string => {
    const md = forge.md.sha1.create();
    md.update(toBinary(bytes));
    return md.digest().toHex();
  };

  return function pack(passJson: Record<string, unknown>, images: Record<string, Uint8Array>, certs: SigningCerts): Uint8Array {
    if (!images["icon.png"]) throw new Error("A Wallet pass needs icon.png.");
    const enc = new TextEncoder();
    const files: Record<string, Uint8Array> = { "pass.json": enc.encode(JSON.stringify(passJson)), ...images };

    const manifest: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(files)) manifest[name] = sha1Hex(bytes);
    const manifestBytes = enc.encode(JSON.stringify(manifest));

    const signer = forge.pki.certificateFromPem(certs.signerCertPem);
    const key = certs.signerKeyPassphrase
      ? forge.pki.decryptRsaPrivateKey(certs.signerKeyPem, certs.signerKeyPassphrase)
      : forge.pki.privateKeyFromPem(certs.signerKeyPem);
    if (!key) throw new Error("Could not read the pass signing key. Check WALLET_SIGNER_KEY and its passphrase.");

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(toBinary(manifestBytes));
    p7.addCertificate(forge.pki.certificateFromPem(certs.wwdrPem));
    p7.addCertificate(signer);
    p7.addSigner({
      key,
      certificate: signer,
      digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: new Date() },
      ],
    });
    p7.sign({ detached: true });
    const signature = fromBinary(forge.asn1.toDer(p7.toAsn1()).getBytes());

    return zipSync({ ...files, "manifest.json": manifestBytes, "signature": signature }, { level: 6 });
  };
}

// ---------------------------------------------------------------------------
// Fallback artwork: a solid square in the venue's accent colour, used when a
// venue has not uploaded its own icon to storage yet.
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function solidPng(size: number, rgb: [number, number, number], zlibSync: (d: Uint8Array) => Uint8Array): Uint8Array {
  const row = 1 + size * 3;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(rgb, y * row + 1 + x * 3);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, size); hv.setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
