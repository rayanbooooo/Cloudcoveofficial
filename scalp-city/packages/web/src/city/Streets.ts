import * as THREE from 'three';
import { PLAZA_CENTER, ROADS_X, ROADS_Z } from './layout';
import type { Gate, Light, TrafficSim } from './traffic';
import { glowTexture } from './vehicleModels';

/**
 * Street furniture: lamp posts with warm light pools along the roads and around the plaza, and a traffic
 * signal at every crossing that shows what the traffic simulation is actually doing.
 */

type RGB = readonly [number, number, number];

const CURB = 1.36; // just outside the road surface
const LAMP_Y = 1.18;
const SIGNAL_Y = 0.98;

const GREEN: RGB = [0.2, 2.4, 1.4];
const YELLOW: RGB = [2.8, 1.7, 0.2];
const RED: RGB = [3.2, 0.18, 0.26];
const OFF: RGB = [0.16, 0.17, 0.2];
const LAMP: RGB = [2.4, 1.9, 1.1];
const LAMP_POOL: RGB = [0.36, 0.27, 0.14];

export interface Post {
  x: number;
  z: number;
  /** Unit vector from the post toward the road it lights. */
  ax: number;
  az: number;
}

/** Lamp posts along every road (alternating sides, clear of crossings) and around the plaza. */
export function lampPosts(): Post[] {
  const out: Post[] = [];
  const clearOf = (v: number, crossings: number[]) => crossings.every((c) => Math.abs(v - c) > 3.4);
  for (const rx of ROADS_X) {
    let k = 0;
    for (let z = -52; z <= 52; z += 7.5, k++) {
      if (!clearOf(z, ROADS_Z)) continue;
      const side = k % 2 === 0 ? -1 : 1;
      out.push({ x: rx + side * CURB, z, ax: -side, az: 0 });
    }
  }
  for (const rz of ROADS_Z) {
    let k = 0;
    for (let x = -52; x <= 52; x += 7.5, k++) {
      if (!clearOf(x, ROADS_X)) continue;
      const side = k % 2 === 0 ? -1 : 1;
      out.push({ x, z: rz + side * CURB, ax: 0, az: -side });
    }
  }
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = ((i + 0.5) / n) * Math.PI * 2;
    out.push({ x: PLAZA_CENTER.x + Math.cos(a) * 11.5, z: PLAZA_CENTER.z + Math.sin(a) * 11.5, ax: -Math.cos(a), az: -Math.sin(a) });
  }
  return out;
}

interface Signal {
  x: number;
  z: number;
  gate: Gate;
}

function signalPosts(sim: TrafficSim): Signal[] {
  const out: Signal[] = [];
  for (const g of sim.gates) {
    // Opposite corners show the same signal: it reads as a pair that alternates with the other pair.
    const corners: [number, number][] = g.axis === 'NS' ? [[1, 1], [-1, -1]] : [[1, -1], [-1, 1]];
    for (const [sx, sz] of corners) out.push({ x: g.x + sx * CURB, z: g.z + sz * CURB, gate: g });
  }
  return out;
}

function boxes(count: number, w: number, h: number, d: number, mat: THREE.Material, lift: number): THREE.InstancedMesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, lift, 0);
  const m = new THREE.InstancedMesh(g, mat, Math.max(1, count));
  m.frustumCulled = false;
  return m;
}

export interface Streets {
  group: THREE.Group;
  update(): void;
  dispose(): void;
}

export function createStreets(sim: TrafficSim, pools: boolean): Streets {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => (disposables.push(x), x);

  const lamps = lampPosts();
  const signals = signalPosts(sim);
  const poleMat = own(new THREE.MeshStandardMaterial({ color: '#1c2535', roughness: 0.6, metalness: 0.6 }));
  const lampMat = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(...LAMP), toneMapped: false }));
  const signalMat = own(new THREE.MeshBasicMaterial({ toneMapped: false }));

  const m = new THREE.Matrix4();
  const c = new THREE.Color();

  const lampPoles = own(boxes(lamps.length, 0.045, LAMP_Y, 0.045, poleMat, LAMP_Y / 2));
  const lampHeads = own(boxes(lamps.length, 0.17, 0.04, 0.17, lampMat, 0));
  lamps.forEach((p, i) => {
    lampPoles.setMatrixAt(i, m.makeTranslation(p.x, 0, p.z));
    lampHeads.setMatrixAt(i, m.makeTranslation(p.x + p.ax * 0.17, LAMP_Y, p.z + p.az * 0.17));
  });
  lampPoles.count = lampHeads.count = lamps.length;
  group.add(lampPoles, lampHeads);

  if (pools) {
    const tex = own(glowTexture());
    const poolMat = own(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    const g = own(new THREE.PlaneGeometry(3, 3));
    g.rotateX(-Math.PI / 2);
    const mesh = own(new THREE.InstancedMesh(g, poolMat, lamps.length));
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lamps.length * 3), 3);
    lamps.forEach((p, i) => {
      mesh.setMatrixAt(i, m.makeTranslation(p.x + p.ax * 0.9, 0.018, p.z + p.az * 0.9));
      mesh.setColorAt(i, c.setRGB(...LAMP_POOL));
    });
    group.add(mesh);
  }

  const signalPoles = own(boxes(signals.length, 0.04, SIGNAL_Y, 0.04, poleMat, SIGNAL_Y / 2));
  const signalHeads = own(boxes(signals.length, 0.15, 0.15, 0.15, signalMat, 0));
  signalHeads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(signals.length * 3), 3);
  signalHeads.instanceColor.setUsage(THREE.DynamicDrawUsage);
  signals.forEach((s, i) => {
    signalPoles.setMatrixAt(i, m.makeTranslation(s.x, 0, s.z));
    signalHeads.setMatrixAt(i, m.makeTranslation(s.x, SIGNAL_Y, s.z));
  });
  signalPoles.count = signalHeads.count = signals.length;
  group.add(signalPoles, signalHeads);

  const colours: Record<Light, RGB> = { 0: GREEN, 1: YELLOW, 2: RED };

  return {
    group,
    update() {
      // Stopped by the kill switch: every signal flashes red. No market data: flashing amber.
      const flash = Math.floor(sim.time * 2) % 2 === 0;
      const arr = signalHeads.instanceColor!.array as Float32Array;
      signals.forEach((s, i) => {
        const rgb = sim.mode === 'halt' ? (flash ? RED : OFF) : sim.mode === 'frozen' ? (flash ? YELLOW : OFF) : colours[sim.light(s.gate)];
        arr[i * 3] = rgb[0];
        arr[i * 3 + 1] = rgb[1];
        arr[i * 3 + 2] = rgb[2];
      });
      signalHeads.instanceColor!.needsUpdate = true;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
