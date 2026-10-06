import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { money, pct, px } from '../lib/format';
import { useStore } from '../store/store';
import { actors, type Actor } from './actors';
import { useCityUi } from './cityUi';
import { PLAZA_CENTER } from './layout';

/**
 * Life above the city: a ring of patrol drones with searchlights, and a blimp that sails round the city
 * with a ticker on each side. The ticker shows real figures from the store (the symbols the workers trade
 * and the account's day), greyed out and labelled when the feed is down. Decoration otherwise.
 */

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type RGB = readonly [number, number, number];

function part(g: THREE.BufferGeometry, x: number, y: number, z: number, color: RGB): THREE.BufferGeometry {
  g.translate(x, y, z);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set(color, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!m) throw new Error('drone model could not be merged');
  return m;
}

// ---------------------------------------------------------------------------------------------------
// Drones
// ---------------------------------------------------------------------------------------------------

interface DroneSpec {
  r: number;
  h: number;
  w: number;
  th0: number;
  phase: number;
  beam: boolean;
}

function droneSpecs(n: number): DroneSpec[] {
  // Orbits stay inside the ring of buildings that stands back from the plaza, and above the tower bases.
  return Array.from({ length: n }, (_, i) => ({
    r: 9.4 + (i % 4) * 0.85,
    h: 4.8 + ((i * 1.7) % 4.4),
    w: (i % 2 === 0 ? 1 : -1) * (0.1 + (i % 3) * 0.045),
    th0: (i / n) * Math.PI * 2,
    phase: i * 1.3,
    beam: i % 3 === 0,
  }));
}

const DRONE_SCALE = 1.5;
const BEAM_H = 10;

export function Drones({ lowPower }: { lowPower: boolean }) {
  const enabled = useCityUi((s) => s.options.sky);
  const specs = useMemo(() => droneSpecs(lowPower ? 3 : 7), [lowPower]);
  const rig = useMemo(() => {
    const body = merge([
      part(new THREE.CylinderGeometry(0.12, 0.14, 0.07, 6), 0, 0, 0, [0.14, 0.16, 0.2]),
      part(new THREE.BoxGeometry(0.5, 0.018, 0.04).rotateY(Math.PI / 4), 0, 0.01, 0, [0.1, 0.12, 0.16]),
      part(new THREE.BoxGeometry(0.5, 0.018, 0.04).rotateY(-Math.PI / 4), 0, 0.01, 0, [0.1, 0.12, 0.16]),
      ...[
        [0.18, 0.18],
        [0.18, -0.18],
        [-0.18, 0.18],
        [-0.18, -0.18],
      ].map(([x, z]) => part(new THREE.CylinderGeometry(0.085, 0.085, 0.008, 10), x!, 0.035, z!, [0.07, 0.08, 0.11])),
      part(new THREE.SphereGeometry(0.045, 8, 6), 0.08, -0.06, 0, [0.02, 0.02, 0.03]),
    ]);
    const nav = merge([part(new THREE.BoxGeometry(0.035, 0.03, 0.035), 0.18, 0.02, -0.18, [3.4, 0.1, 0.12]), part(new THREE.BoxGeometry(0.035, 0.03, 0.035), 0.18, 0.02, 0.18, [0.1, 3.2, 0.3])]);
    const strobe = merge([part(new THREE.BoxGeometry(0.05, 0.035, 0.05), 0, 0.06, 0, [1, 1, 1])]);
    // A searchlight cone, apex at the drone, fading to nothing at the ground (additive, so black is invisible).
    const cone = new THREE.CylinderGeometry(0.04, 0.85, BEAM_H, 20, 1, true);
    cone.translate(0, -BEAM_H / 2, 0);
    {
      const pos = cone.getAttribute('position');
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const k = Math.pow(Math.max(0, 1 + pos.getY(i) / BEAM_H), 1.8) * 0.26;
        col.set([0.55 * k, 0.7 * k, 1 * k], i * 3);
      }
      cone.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5 });
    const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const beamMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    const n = specs.length;
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, count: number) => {
      const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return m;
    };
    const meshes = {
      body: mk(body, bodyMat, n),
      nav: mk(nav, lightMat, n),
      strobe: mk(strobe, lightMat, n),
      beam: mk(cone, beamMat, specs.filter((s) => s.beam).length),
    };
    meshes.strobe.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
    meshes.strobe.instanceColor.setUsage(THREE.DynamicDrawUsage);
    meshes.beam.renderOrder = 2;
    const group = new THREE.Group();
    group.add(meshes.body, meshes.nav, meshes.strobe, meshes.beam);
    return { group, meshes, geometries: [body, nav, strobe, cone], materials: [bodyMat, lightMat, beamMat] };
  }, [specs]);

  const actorsRef = useRef<Actor[]>([]);
  useEffect(() => {
    const list = specs.map(
      (_, i): Actor => ({
        id: `d${i}`,
        kind: 'drone',
        name: 'DRONE',
        x: 0,
        y: 6,
        z: 0,
        yaw: 0,
        speed: 0,
        tag: null,
        pick: 20,
        top: 0.3,
        chase: { back: 3.4, up: 1.3, ahead: 1.6 },
      }),
    );
    actorsRef.current = list;
    for (const a of list) actors.set(a.id, a);
    return () => {
      for (const a of list) actors.delete(a.id);
      actorsRef.current = [];
      for (const g of rig.geometries) g.dispose();
      for (const m of rig.materials) m.dispose();
      for (const m of Object.values(rig.meshes)) m.dispose();
    };
  }, [specs, rig]);

  const tmp = useMemo(() => new THREE.Object3D(), []);
  const time = useRef(0);
  useFrame((_, dt) => {
    rig.group.visible = enabled;
    if (!enabled) return;
    if (!reducedMotion) time.current += Math.min(dt, 0.1);
    const t = time.current;
    const { body, nav, strobe, beam } = rig.meshes;
    let b = 0;
    specs.forEach((d, i) => {
      const th = d.th0 + d.w * t;
      const x = PLAZA_CENTER.x + Math.cos(th) * d.r;
      const z = PLAZA_CENTER.z + Math.sin(th) * d.r;
      const y = d.h + Math.sin(t * 1.2 + d.phase) * 0.18;
      // Heading along the orbit: the tangent of (cos, sin), turned for the direction of travel.
      const tx = -Math.sin(th) * Math.sign(d.w);
      const tz = Math.cos(th) * Math.sign(d.w);
      const yaw = Math.atan2(-tz, tx);
      tmp.position.set(x, y, z);
      tmp.rotation.set(0, yaw, 0);
      tmp.scale.setScalar(DRONE_SCALE);
      tmp.updateMatrix();
      body.setMatrixAt(i, tmp.matrix);
      nav.setMatrixAt(i, tmp.matrix);
      strobe.setMatrixAt(i, tmp.matrix);
      const flash = (t * 0.9 + d.phase) % 1 < 0.1 ? 4 : 0.05;
      (strobe.instanceColor!.array as Float32Array).set([flash, flash, flash], i * 3);
      if (d.beam) {
        tmp.scale.set(1, Math.max(0.2, y / BEAM_H), 1);
        tmp.rotation.set(0, 0, 0);
        tmp.updateMatrix();
        beam.setMatrixAt(b++, tmp.matrix);
      }
      const a = actorsRef.current[i];
      if (a) {
        a.x = x;
        a.y = y;
        a.z = z;
        a.yaw = yaw;
        a.speed = Math.abs(d.w) * d.r;
      }
    });
    for (const m of [body, nav, strobe, beam]) {
      m.count = m === beam ? b : specs.length;
      m.instanceMatrix.needsUpdate = true;
    }
    strobe.instanceColor!.needsUpdate = true;
  });
  return <primitive object={rig.group} />;
}

// ---------------------------------------------------------------------------------------------------
// Blimp with a ticker
// ---------------------------------------------------------------------------------------------------

interface Item {
  text: string;
  color: string;
}

const FG = '#e8eef6';
const GREY = '#7b8697';
const GREEN = '#2ee6a6';
const RED = '#ff4d6d';
const AMBER = '#ffb020';

/** What the ticker says, straight from the store: nothing is made up, and a figure that is not there is not shown. */
function tickerItems(mode: 'quotes' | 'pnl'): Item[] {
  const s = useStore.getState();
  const live = s.system?.marketData.stock.state === 'CONNECTED';
  if (mode === 'pnl') {
    const a = s.account;
    if (!a?.available || a.equity === null) return [{ text: 'ACCOUNT UNAVAILABLE', color: AMBER }];
    const day = a.dayPnl;
    const on = Object.values(s.workers).filter((w) => w.autotradeEnabled).length;
    return [
      { text: `EQUITY ${money(a.equity)}`, color: FG },
      { text: `DAY ${money(day, { sign: true })} ${pct(a.dayPnlPct, { sign: true })}`, color: day === null || day === 0 ? FG : day > 0 ? GREEN : RED },
      { text: `OPEN POSITIONS ${s.positions.length}`, color: FG },
      { text: `WORKERS ${on}/${s.workerOrder.length} ON`, color: FG },
    ];
  }
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const id of s.workerOrder) {
    const sym = s.workers[id]?.config.symbol;
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    const q = s.quotes[sym];
    if (!q || q.last === null) continue;
    const chg = q.changePct;
    const grey = !live || q.stale;
    items.push({ text: `${sym} ${px(sym, q.last)} ${chg === null ? '' : pct(chg, { sign: true })}`.trim(), color: grey ? GREY : chg === null || chg === 0 ? FG : chg > 0 ? GREEN : RED });
  }
  if (!items.length) return [{ text: 'AWAITING MARKET DATA', color: AMBER }];
  if (!live) items.unshift({ text: 'FEED DOWN · LAST KNOWN', color: AMBER });
  return items;
}

// The canvas has the screen's proportions (2.5 wide, 0.68 tall on the envelope), so the text is not stretched.
const TICKER_W = 1024;
const TICKER_H = 280;
const FONT = '600 112px ui-monospace, "JetBrains Mono Variable", Menlo, monospace';
const GAP = 230;
/** Ticker scroll speed, canvas pixels per second. */
const SCROLL = 190;

class Ticker {
  readonly canvas = document.createElement('canvas');
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private segments: { text: string; color: string; x: number }[] = [];
  private total = 1;
  private key = '';

  constructor() {
    this.canvas.width = TICKER_W;
    this.canvas.height = TICKER_H;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  /** Re-lay the text out when what it says has changed. */
  setItems(items: Item[]): void {
    const key = items.map((i) => `${i.text}|${i.color}`).join('\n');
    if (key === this.key) return;
    this.key = key;
    const ctx = this.ctx;
    ctx.font = FONT;
    let x = 0;
    this.segments = items.map((i) => {
      const seg = { text: i.text, color: i.color, x };
      x += ctx.measureText(i.text).width + GAP;
      return seg;
    });
    this.total = Math.max(x, TICKER_W);
  }

  draw(scroll: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, TICKER_W, TICKER_H);
    ctx.fillStyle = '#16294a';
    ctx.fillRect(0, 0, TICKER_W, 8);
    ctx.fillRect(0, TICKER_H - 8, TICKER_W, 8);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    const off = scroll % this.total;
    for (let rep = -1; rep < 3; rep++) {
      for (const s of this.segments) {
        const x = s.x + rep * this.total - off;
        if (x > TICKER_W || x < -TICKER_W) continue;
        ctx.fillStyle = s.color;
        ctx.fillText(s.text, x, TICKER_H / 2 + 6);
      }
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** A patch of the envelope's side to put the screen on, following its curve. `flip` is the far side (text mirrored so it reads from outside). */
function screenGeometry(flip: boolean): THREE.BufferGeometry {
  const NX = 24;
  const NY = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= NX; i++) {
    const x = -1.25 + (2.5 * i) / NX;
    const r = BLIMP.ry * Math.sqrt(Math.max(0, 1 - (x / BLIMP.rx) ** 2)) * 1.015;
    for (let j = 0; j <= NY; j++) {
      const th = -0.5 + (1.0 * j) / NY;
      pos.push(x, r * Math.sin(th), (flip ? -1 : 1) * r * Math.cos(th));
      uv.push(flip ? 1 - i / NX : i / NX, j / NY);
    }
  }
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NY; j++) {
      const a = i * (NY + 1) + j;
      const b = (i + 1) * (NY + 1) + j;
      const c = b + 1;
      const d = a + 1;
      if (flip) idx.push(a, c, b, a, d, c);
      else idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

const BLIMP = { rx: 2.1, ry: 0.68 };
/** The blimp's route: a wide oval behind and around the plaza, high above the skyline, clear of the default camera. */
const ROUTE = { cx: 0, cz: -5, rx: 32, rz: 14, y: 19 };
const ROUTE_RATE = 0.052; // radians per second

export function Blimp({ lowPower }: { lowPower: boolean }) {
  const enabled = useCityUi((s) => s.options.sky);
  const group = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const ticker = useMemo(() => new Ticker(), []);
  const parts = useMemo(() => {
    const envelope = new THREE.SphereGeometry(1, 28, 18);
    envelope.scale(BLIMP.rx, BLIMP.ry, BLIMP.ry);
    const fins = merge([
      part(new THREE.BoxGeometry(0.5, 0.04, 0.9), -1.85, 0, 0, [0.12, 0.15, 0.2]),
      part(new THREE.BoxGeometry(0.5, 0.9, 0.04), -1.85, 0, 0, [0.12, 0.15, 0.2]),
      part(new THREE.BoxGeometry(0.62, 0.15, 0.24), 0.1, -0.74, 0, [0.1, 0.12, 0.16]),
    ]);
    const lights = merge([
      part(new THREE.BoxGeometry(0.08, 0.08, 0.08), -2.0, 0, 0.5, [0.1, 3.2, 0.3]),
      part(new THREE.BoxGeometry(0.08, 0.08, 0.08), -2.0, 0, -0.5, [3.4, 0.1, 0.12]),
      part(new THREE.BoxGeometry(0.1, 0.1, 0.1), 2.1, 0, 0, [3, 3, 3]),
    ]);
    const near = screenGeometry(false);
    const far = screenGeometry(true);
    const hull = new THREE.MeshStandardMaterial({ color: '#2a3447', roughness: 0.45, metalness: 0.35 });
    const finMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 });
    const lightMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const screen = new THREE.MeshBasicMaterial({ map: ticker.texture, toneMapped: false });
    return { envelope, fins, lights, near, far, hull, finMat, lightMat, screen };
  }, [ticker]);
  useEffect(
    () => () => {
      ticker.dispose();
      for (const v of Object.values(parts)) v.dispose();
    },
    [ticker, parts],
  );

  const actor = useMemo<Actor>(
    () => ({ id: 'blimp', kind: 'blimp', name: 'BLIMP', x: 0, y: ROUTE.y, z: 0, yaw: 0, speed: 0, tag: null, pick: 30, top: 0.9, chase: { back: 1.5, up: 1.6, ahead: 0, side: 8 } }),
    [],
  );
  useEffect(() => {
    actors.set(actor.id, actor);
    return () => {
      actors.delete(actor.id);
    };
  }, [actor]);

  const time = useRef(8);
  const sinceDraw = useRef(0);
  const frustum = useMemo(() => new THREE.Frustum(), []);
  const m4 = useMemo(() => new THREE.Matrix4(), []);
  const sphere = useMemo(() => new THREE.Sphere(new THREE.Vector3(), 3), []);
  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    g.visible = enabled;
    if (!enabled) return;
    if (!reducedMotion) time.current += Math.min(dt, 0.1);
    const t = time.current;
    const phi = t * ROUTE_RATE;
    const x = ROUTE.cx + Math.cos(phi) * ROUTE.rx;
    const z = ROUTE.cz + Math.sin(phi) * ROUTE.rz;
    const y = ROUTE.y + Math.sin(t * 0.35) * 0.5;
    const tx = -Math.sin(phi) * ROUTE.rx;
    const tz = Math.cos(phi) * ROUTE.rz;
    const len = Math.hypot(tx, tz);
    const yaw = Math.atan2(-tz, tx);
    g.position.set(x, y, z);
    g.rotation.set(0, yaw, 0);
    actor.x = x;
    actor.y = y;
    actor.z = z;
    actor.yaw = yaw;
    actor.speed = len * ROUTE_RATE;

    // The ticker is only redrawn while the blimp can be seen (and a few times a second).
    sinceDraw.current += dt;
    const every = lowPower ? 1 / 6 : 1 / 14;
    if (sinceDraw.current >= every) {
      sphere.center.set(x, y, z);
      m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(m4);
      if (frustum.intersectsSphere(sphere)) {
        sinceDraw.current = 0;
        ticker.setItems(tickerItems(useCityUi.getState().ticker));
        ticker.draw(reducedMotion ? 0 : t * SCROLL);
      }
    }
  });

  return (
    <group ref={group}>
      <mesh geometry={parts.envelope} material={parts.hull} />
      <mesh geometry={parts.fins} material={parts.finMat} />
      <mesh geometry={parts.lights} material={parts.lightMat} />
      <mesh geometry={parts.near} material={parts.screen} />
      <mesh geometry={parts.far} material={parts.screen} />
    </group>
  );
}
