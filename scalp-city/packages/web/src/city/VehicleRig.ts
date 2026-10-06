import * as THREE from 'three';
import { actors, type Actor } from './actors';
import { KINDS, MAX_EVENT_VEHICLES, type ModelGroup, type TrafficSim, type Vehicle, type VehicleKind } from './traffic';
import { buildVehicleModels, glowTexture, type VehicleModel } from './vehicleModels';

/**
 * Draws the traffic: one instanced mesh per vehicle model for the body, the headlights, the brake lights,
 * the light pool on the road and the roof beacon of event vehicles. Owns its geometry and materials.
 */

type RGB = readonly [number, number, number];

const PAINT_HEX = ['#d5dbe6', '#4a5a74', '#c0505f', '#4a82d8', '#eceff5', '#38977a', '#9575dc'];
const KIND_PAINT: Partial<Record<VehicleKind, string>> = {
  taxi: '#f2b21c',
  bus: '#2f9eb0',
  police: '#e9eef5',
  armored: '#59677b',
  courier: '#eef3fa',
  tow: '#ff7a1a',
};

const HEAD: RGB = [2.1, 1.9, 1.5];
const TAIL: RGB = [1.1, 0.05, 0.09];
const BRAKE: RGB = [3.6, 0.12, 0.16];
const AMBER: RGB = [3, 1.5, 0.1];
const DIM_TAIL: RGB = [0.45, 0.03, 0.05];
const POOL: RGB = [0.5, 0.44, 0.28];
const RED: RGB = [3.4, 0.12, 0.2];
const BLUE: RGB = [0.25, 0.7, 3.6];
const ROAD_Y = 0.02;

const PICK_RADIUS: Record<ModelGroup, number> = { car: 15, van: 16, truck: 18, bus: 21 };

function rgb(hex: string): RGB {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const PAINTS = PAINT_HEX.map(rgb);
const KIND_COLOURS: Partial<Record<VehicleKind, RGB>> = Object.fromEntries(Object.entries(KIND_PAINT).map(([k, v]) => [k, rgb(v)]));

interface Layer {
  model: VehicleModel;
  body: THREE.InstancedMesh;
  head: THREE.InstancedMesh;
  tail: THREE.InstancedMesh;
  pool: THREE.InstancedMesh | null;
  beacon: THREE.InstancedMesh;
  n: number;
  nb: number;
}

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, capacity: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, capacity));
  m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, capacity) * 3), 3);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.instanceColor.setUsage(THREE.DynamicDrawUsage);
  m.frustumCulled = false;
  m.count = 0;
  return m;
}

function put(mesh: THREE.InstancedMesh, i: number, m: Float32Array, c: RGB, k = 1): void {
  (mesh.instanceMatrix.array as Float32Array).set(m, i * 16);
  const a = mesh.instanceColor!.array as Float32Array;
  a[i * 3] = c[0] * k;
  a[i * 3 + 1] = c[1] * k;
  a[i * 3 + 2] = c[2] * k;
}

export class VehicleRig {
  readonly group = new THREE.Group();
  private readonly layers = {} as Record<ModelGroup, Layer>;
  private readonly materials: THREE.Material[] = [];
  private readonly models: Record<ModelGroup, VehicleModel>;
  private readonly texture: THREE.CanvasTexture | null;
  private readonly known = new Map<number, Actor>();
  private readonly m = new Float32Array(16);
  private readonly tagColours = new Map<string, RGB>();
  /** Tagged (event) vehicles on screen, for the labels. Changes only when one arrives or leaves. */
  taggedKey = '';

  constructor(
    private readonly sim: TrafficSim,
    pools: boolean,
  ) {
    this.models = buildVehicleModels();
    this.texture = pools ? glowTexture() : null;
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.3 });
    const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const poolMat = this.texture ? new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }) : null;
    this.materials.push(bodyMat, lightMat);
    if (poolMat) this.materials.push(poolMat);

    const capacity: Record<ModelGroup, number> = { car: 0, van: 0, bus: 0, truck: 0 };
    for (const c of sim.cars) capacity[KINDS[c.kind].group]++;
    for (const g of Object.keys(capacity) as ModelGroup[]) {
      const model = this.models[g];
      const cap = capacity[g] + MAX_EVENT_VEHICLES;
      const layer: Layer = {
        model,
        body: instanced(model.body, bodyMat, cap),
        head: instanced(model.head, lightMat, cap),
        tail: instanced(model.tail, lightMat, cap),
        pool: poolMat ? instanced(model.pool, poolMat, cap) : null,
        beacon: instanced(model.beacon, lightMat, MAX_EVENT_VEHICLES),
        n: 0,
        nb: 0,
      };
      this.layers[g] = layer;
      this.group.add(layer.body, layer.head, layer.tail, layer.beacon);
      if (layer.pool) {
        layer.pool.renderOrder = 2;
        this.group.add(layer.pool);
      }
    }
  }

  private actorFor(c: Vehicle): Actor {
    let a = this.known.get(c.id);
    if (!a) {
      const spec = KINDS[c.kind];
      const model = this.models[spec.group];
      a = {
        id: `v${c.id}`,
        kind: 'vehicle',
        name: spec.label,
        x: c.x,
        y: ROAD_Y,
        z: c.z,
        yaw: c.yaw,
        speed: 0,
        tag: c.tag,
        pick: PICK_RADIUS[spec.group],
        top: model.roof,
        chase: { back: 4.4 + spec.len * 1.3, up: 1.7 + model.roof * 2.2, ahead: 1.6 },
      };
      this.known.set(c.id, a);
      actors.set(a.id, a);
    }
    return a;
  }

  private tagColour(css: string): RGB {
    let c = this.tagColours.get(css);
    if (!c) {
      c = rgb(css);
      this.tagColours.set(css, c);
    }
    return c;
  }

  /** `hazard`: the city is stopped (no data, or the kill switch), so every vehicle flashes its hazard lights. */
  update(hazard: boolean): void {
    const sim = this.sim;
    const t = sim.time;
    const blink = Math.floor(t * 2.2) % 2 === 0;
    const m = this.m;
    for (const l of Object.values(this.layers)) {
      l.n = 0;
      l.nb = 0;
    }
    const seen = new Set<number>();
    let tagged = '';
    for (const c of sim.cars) {
      const spec = KINDS[c.kind];
      const l = this.layers[spec.group];
      const i = l.n++;
      seen.add(c.id);
      const f = c.fade;
      const sc = f * f * (3 - 2 * f);
      const cs = Math.cos(c.yaw) * sc;
      const sn = Math.sin(c.yaw) * sc;
      m[0] = cs; m[1] = 0; m[2] = -sn; m[3] = 0;
      m[4] = 0; m[5] = sc; m[6] = 0; m[7] = 0;
      m[8] = sn; m[9] = 0; m[10] = cs; m[11] = 0;
      m[12] = c.x; m[13] = ROAD_Y; m[14] = c.z; m[15] = 1;

      const paint = KIND_COLOURS[c.kind] ?? PAINTS[c.paint % PAINTS.length]!;
      put(l.body, i, m, paint);
      const stopped = c.v < 0.2;
      const braking = c.acc < -0.6 || stopped;
      put(l.head, i, m, hazard ? (blink ? AMBER : DIM_TAIL) : HEAD);
      put(l.tail, i, m, hazard ? (blink ? AMBER : DIM_TAIL) : braking ? BRAKE : TAIL);
      if (l.pool) put(l.pool, i, m, POOL, sc);

      if (c.tag) {
        const j = l.nb++;
        let colour: RGB;
        switch (c.kind) {
          case 'police':
            colour = Math.floor(t * 7) % 2 === 0 ? RED : BLUE;
            break;
          case 'tow':
            colour = Math.floor(t * 3) % 2 === 0 ? AMBER : DIM_TAIL;
            break;
          default: {
            const base = this.tagColour(c.tag.color);
            const k = 1.6 + 1.6 * (0.5 + 0.5 * Math.sin(t * 6));
            colour = [base[0] * k, base[1] * k, base[2] * k];
          }
        }
        put(l.beacon, j, m, colour);
        tagged += `${c.id},`;
      }

      const a = this.actorFor(c);
      a.x = c.x;
      a.z = c.z;
      a.yaw = c.yaw;
      a.speed = c.v;
      a.tag = c.tag;
    }
    for (const l of Object.values(this.layers)) {
      for (const mesh of [l.body, l.head, l.tail, l.pool, l.beacon]) {
        if (!mesh) continue;
        mesh.count = mesh === l.beacon ? l.nb : l.n;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.needsUpdate = true;
      }
    }
    for (const [id, a] of this.known) {
      if (!seen.has(id)) {
        this.known.delete(id);
        actors.delete(a.id);
      }
    }
    this.taggedKey = tagged;
  }

  dispose(): void {
    for (const a of this.known.values()) actors.delete(a.id);
    this.known.clear();
    for (const g of Object.values(this.models)) for (const geo of [g.body, g.head, g.tail, g.pool, g.beacon]) geo.dispose();
    for (const l of Object.values(this.layers)) for (const mesh of [l.body, l.head, l.tail, l.pool, l.beacon]) mesh?.dispose();
    for (const mat of this.materials) mat.dispose();
    this.texture?.dispose();
  }
}
