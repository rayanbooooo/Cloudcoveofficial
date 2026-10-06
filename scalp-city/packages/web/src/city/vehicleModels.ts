import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ModelGroup } from './traffic';

/**
 * Low-poly vehicle models, each merged from a few boxes with vertex colours. Vehicles drive along +X,
 * stand on y = 0 and are as wide as their z extent. The body takes its paint from the instance colour
 * (white parts take it in full, dark parts such as glass and tyres stay dark); lights, brake lights, the
 * headlight pool and the roof beacon are separate meshes so their brightness can change per vehicle.
 */

export interface VehicleModel {
  body: THREE.BufferGeometry;
  /** Two headlights, white: the instance colour sets hue and brightness. */
  head: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  /** A soft pool of light on the road ahead. */
  pool: THREE.BufferGeometry;
  /** A roof light for event vehicles. */
  beacon: THREE.BufferGeometry;
  length: number;
  /** Height of the roof line, for tags and the chase camera. */
  roof: number;
}

type RGB = [number, number, number];
const PAINT: RGB = [1, 1, 1];
const GLASS: RGB = [0.05, 0.08, 0.13];
const TYRE: RGB = [0.025, 0.025, 0.03];
const TRIM: RGB = [0.16, 0.18, 0.22];

function part(w: number, h: number, d: number, x: number, y: number, z: number, color: RGB): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(color, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!m) throw new Error('vehicle model could not be merged');
  return m;
}

function wheels(xs: number[], half: number, r = 0.075): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const x of xs) for (const side of [-1, 1]) out.push(part(r * 2, r * 2, 0.07, x, r, side * (half - 0.02), TYRE));
  return out;
}

function lights(xFront: number, xBack: number, y: number, zs: number, h = 0.045): { head: THREE.BufferGeometry; tail: THREE.BufferGeometry } {
  const white: RGB = [1, 1, 1];
  return {
    head: merge([part(0.03, h, 0.1, xFront, y, zs, white), part(0.03, h, 0.1, xFront, y, -zs, white)]),
    tail: merge([part(0.03, h, 0.1, xBack, y, zs, white), part(0.03, h, 0.1, xBack, y, -zs, white)]),
  };
}

function pool(xFront: number, w: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1.5, w * 1.7);
  g.rotateX(-Math.PI / 2);
  g.translate(xFront + 0.55, 0.018, 0);
  return g;
}

function beacon(y: number, x = 0): THREE.BufferGeometry {
  return merge([part(0.12, 0.06, 0.26, x, y + 0.03, 0, [1, 1, 1])]);
}

function car(): VehicleModel {
  const L = 0.95;
  const W = 0.46;
  const body = merge([
    part(L, 0.16, W, 0, 0.14, 0, PAINT),
    part(0.5, 0.1, W * 0.88, -0.05, 0.27, 0, GLASS),
    part(0.44, 0.035, W * 0.8, -0.05, 0.3375, 0, PAINT),
    part(0.2, 0.03, W * 0.9, 0.34, 0.235, 0, PAINT), // bonnet
    part(0.04, 0.05, W * 0.96, L / 2, 0.1, 0, TRIM), // bumpers
    part(0.04, 0.05, W * 0.96, -L / 2, 0.1, 0, TRIM),
    ...wheels([0.3, -0.3], W / 2),
  ]);
  const l = lights(L / 2 + 0.005, -L / 2 - 0.005, 0.155, 0.15);
  return { body, ...l, pool: pool(L / 2, W), beacon: beacon(0.355, -0.05), length: L, roof: 0.355 };
}

function van(): VehicleModel {
  const L = 1.15;
  const W = 0.5;
  const body = merge([
    part(L, 0.2, W, 0, 0.16, 0, PAINT),
    part(0.8, 0.26, W * 0.96, -0.16, 0.39, 0, PAINT), // box body
    part(0.3, 0.16, W * 0.88, 0.37, 0.31, 0, GLASS), // cab glass
    part(0.2, 0.03, W * 0.9, 0.4, 0.25, 0, PAINT),
    part(0.04, 0.06, W * 0.96, L / 2, 0.1, 0, TRIM),
    part(0.04, 0.06, W * 0.96, -L / 2, 0.1, 0, TRIM),
    ...wheels([0.36, -0.34], W / 2),
  ]);
  const l = lights(L / 2 + 0.005, -L / 2 - 0.005, 0.18, 0.17);
  return { body, ...l, pool: pool(L / 2, W), beacon: beacon(0.52, 0.2), length: L, roof: 0.52 };
}

function bus(): VehicleModel {
  const L = 2.3;
  const W = 0.56;
  const body = merge([
    part(L, 0.4, W, 0, 0.26, 0, PAINT),
    part(L - 0.08, 0.15, W + 0.006, 0, 0.37, 0, GLASS), // window band, a hair wider than the body
    part(L - 0.04, 0.035, W * 0.96, 0, 0.4775, 0, PAINT),
    part(0.5, 0.05, W * 0.5, -0.5, 0.52, 0, TRIM), // roof unit
    part(0.04, 0.07, W * 0.96, L / 2, 0.1, 0, TRIM),
    part(0.04, 0.07, W * 0.96, -L / 2, 0.1, 0, TRIM),
    ...wheels([0.75, -0.75], W / 2),
  ]);
  const l = lights(L / 2 + 0.005, -L / 2 - 0.005, 0.2, 0.2);
  return { body, ...l, pool: pool(L / 2, W), beacon: beacon(0.495, 0.5), length: L, roof: 0.5 };
}

function truck(): VehicleModel {
  const L = 1.9;
  const W = 0.54;
  const cargo: RGB = [0.82, 0.84, 0.88];
  const body = merge([
    part(0.58, 0.34, W, 0.6, 0.23, 0, PAINT), // cab
    part(0.24, 0.14, W * 0.9, 0.78, 0.33, 0, GLASS),
    part(1.22, 0.44, W, -0.3, 0.3, 0, cargo), // cargo box
    part(L, 0.07, W * 0.9, 0, 0.1, 0, TRIM), // chassis
    part(0.04, 0.07, W * 0.96, L / 2, 0.1, 0, TRIM),
    part(0.04, 0.07, W * 0.96, -L / 2, 0.1, 0, TRIM),
    ...wheels([0.62, -0.1, -0.55], W / 2, 0.085),
  ]);
  const l = lights(L / 2 + 0.005, -L / 2 - 0.005, 0.19, 0.19);
  return { body, ...l, pool: pool(L / 2, W), beacon: beacon(0.4, 0.6), length: L, roof: 0.52 };
}

export function buildVehicleModels(): Record<ModelGroup, VehicleModel> {
  return { car: car(), van: van(), bus: bus(), truck: truck() };
}

/** A soft round glow for light pools, drawn once. */
export function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,0.4)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
