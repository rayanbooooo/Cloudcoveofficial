/** Deterministic city layout: the same worker always stands in the same place. */

export type Vec3 = [number, number, number];

/** The vault sits at the front of the plaza; the worker towers stand in an arc behind it. */
export const VAULT_POSITION: Vec3 = [0, 0, 4.8];
export const PLAZA_RADIUS = 11;

/** Towers stand on an arc facing the default camera. */
export function towerPositions(count: number): Vec3[] {
  if (count <= 0) return [];
  if (count === 1) return [[0, 0, -1.5]];
  const spread = Math.min(Math.PI * 0.7, 0.34 * (count - 1) + 0.1);
  const radius = 8.6;
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const a = -spread / 2 + (spread * i) / (count - 1);
    out.push([Math.sin(a) * radius, 0, -Math.cos(a) * radius + radius - 1.5]);
  }
  return out;
}

/** Tower height: stable per slot so each worker keeps a recognisable silhouette. */
export function towerHeight(index: number, count: number): number {
  const center = (count - 1) / 2;
  return 6.8 - Math.abs(index - center) * 0.45 + (index % 2) * 0.3;
}

/** Vertical anchors of a tower of shaft height h (shared by the tower, effects and camera fit). */
export function towerLevels(h: number) {
  const deck = 0.22 + h + 0.08;
  const dial = deck + 1.15;
  return { deck, dial, label: dial + 1.05 };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BackdropBuilding {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

/** Road centre lines (world X for north–south roads, world Z for east–west). */
export const ROADS_X = [-30, -18, 18, 30];
export const ROADS_Z = [-26, -15, 16, 28];
const ROAD_HALF = 1.4;

function onRoad(x: number, z: number, w: number, d: number): boolean {
  for (const rx of ROADS_X) if (Math.abs(x - rx) < w / 2 + ROAD_HALF) return true;
  for (const rz of ROADS_Z) if (Math.abs(z - rz) < d / 2 + ROAD_HALF) return true;
  return false;
}

/** Background skyline on a block grid, clear of the plaza and the roads. */
export function backdrop(count: number, seed = 7): BackdropBuilding[] {
  const rnd = mulberry32(seed);
  const out: BackdropBuilding[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 40) {
    const x = Math.round((rnd() * 2 - 1) * 46);
    const z = Math.round((rnd() * 2 - 1) * 46) - 6;
    const dist = Math.hypot(x, z - 1);
    if (dist < PLAZA_RADIUS + 3) continue;
    // Keep the foreground (between the default camera and the plaza) open.
    if (z > 9 && Math.abs(x) < 16 + (z - 9) * 1.2) continue;
    const w = 1.6 + Math.floor(rnd() * 3) * 0.8;
    const d = 1.6 + Math.floor(rnd() * 3) * 0.8;
    if (onRoad(x, z, w, d)) continue;
    if (out.some((b) => Math.abs(b.x - x) < (b.w + w) / 2 + 0.6 && Math.abs(b.z - z) < (b.d + d) / 2 + 0.6)) continue;
    const far = Math.min(1, (dist - PLAZA_RADIUS) / 30);
    const h = 1.5 + rnd() * 5 + far * far * (6 + rnd() * 12) + (z < -10 ? 3 : 0);
    out.push({ x, z, w, d, h });
  }
  return out;
}
