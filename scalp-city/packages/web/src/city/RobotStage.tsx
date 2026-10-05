import { PerformanceMonitor, RoundedBox } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { directionLabel, instrumentName, type OrderView, type SymbolQuoteView, type WorkerView } from '@scalp-city/shared';
import { directionColor } from '../components/panels/Workers';
import { money, px, qtyStr, unitsStr } from '../lib/format';
import { serverNow, useStore } from '../store/store';
import { DeskRobot, phaseOf, type StagePhase } from './stage/DeskRobot';
import { drawChartScreen, drawPositionScreen, drawSignalScreen, SCREEN, type ScreenData } from './stage/screens';
import { useLiveBars, type LiveBars } from './stage/useLiveBars';
import { createChargeRingMaterial, createWindowMaterial, STATE_COLORS } from './materials';

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Live {
  w: WorkerView;
  order: OrderView | null;
  quote: SymbolQuoteView | null;
}

/** A canvas that the 3D monitors use as their screen. It is redrawn a few times a second from `draw`. */
function useScreenTexture(size: { w: number; h: number }, draw: (ctx: CanvasRenderingContext2D) => void, fps: number): THREE.CanvasTexture {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = size.w;
    c.height = size.h;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }, [size.w, size.h]);
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });
  useEffect(() => {
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d');
    if (!ctx) return;
    const tick = () => {
      ctx.save();
      try {
        drawRef.current(ctx);
      } catch {
        // a bad frame must never take the 3D view down; the next tick redraws
      }
      ctx.restore();
      tex.needsUpdate = true;
    };
    tick();
    const id = window.setInterval(tick, 1000 / fps);
    return () => window.clearInterval(id);
  }, [tex, fps]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex;
}

function Monitor({
  texture,
  width,
  position,
  rotationY = 0,
  aspect,
}: {
  texture: THREE.CanvasTexture;
  width: number;
  position: [number, number, number];
  rotationY?: number;
  aspect: number;
}) {
  const height = width / aspect;
  const screen = useMemo(() => new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }), [texture]);
  const bezel = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0b1018', roughness: 0.4, metalness: 0.8 }), []);
  useEffect(
    () => () => {
      screen.dispose();
      bezel.dispose();
    },
    [screen, bezel],
  );
  return (
    <group position={position} rotation={[-0.2, rotationY, 0]}>
      <RoundedBox args={[width + 0.05, height + 0.05, 0.035]} radius={0.016} smoothness={2} material={bezel} />
      <mesh position={[0, 0, 0.019]} material={screen}>
        <planeGeometry args={[width, height]} />
      </mesh>
      <mesh position={[0, -height / 2 - 0.1, -0.03]} material={bezel}>
        <boxGeometry args={[0.07, 0.17, 0.03]} />
      </mesh>
      <mesh position={[0, -height / 2 - 0.19, 0.02]} material={bezel}>
        <boxGeometry args={[0.32, 0.015, 0.2]} />
      </mesh>
    </group>
  );
}

function Skyline() {
  const material = useMemo(() => createWindowMaterial({ base: '#070c14', lit: '#5d7fb8', density: 0.22, seed: 11 }), []);
  useEffect(() => () => material.dispose(), [material]);
  const blocks = useMemo(() => {
    let s = 7;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
    return Array.from({ length: 26 }, (_, i) => {
      const w = 0.5 + rnd() * 0.7;
      return { x: -7.5 + i * 0.6 + rnd() * 0.1, h: 0.9 + rnd() * 3.2, w, z: -5.2 - rnd() * 1.4 };
    });
  }, []);
  return (
    <group>
      {blocks.map((b, i) => (
        <mesh key={i} position={[b.x, b.h / 2, b.z]} material={material}>
          <boxGeometry args={[b.w, b.h, b.w]} />
        </mesh>
      ))}
    </group>
  );
}

/** Slow orbit that follows the pointer a little, so the desk feels like a place and not a picture. */
function CameraRig({ target, narrow }: { target: THREE.Vector3; narrow: boolean }) {
  const camera = useThree((s) => s.camera);
  const base = useMemo(() => new THREE.Vector3(1.5, 4.25, 4.1), []);
  const goal = useMemo(() => new THREE.Vector3(), []);
  const aspect = useThree((s) => s.size.width / Math.max(1, s.size.height));
  useFrame((state, dt) => {
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 3);
    const ox = reducedMotion ? 0 : state.pointer.x;
    const oy = reducedMotion ? 0 : state.pointer.y;
    // narrow canvases need more distance to keep the whole desk in frame
    const zoom = Math.min(1.9, Math.max(0.8, 1.8 / aspect)) * (narrow ? 1.05 : 1);
    goal.set(target.x + (base.x - target.x) * zoom + ox * 0.55, base.y + (zoom - 1) * 0.5 + oy * 0.22, target.z + (base.z - target.z) * zoom);
    camera.position.lerp(goal, k);
    camera.lookAt(target);
  });
  return null;
}

/** Lamp on the desk: a state beacon the viewer can read at a glance. */
function Beacon({ phase, color }: { phase: StagePhase; color: string }) {
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  const target = useMemo(() => new THREE.Color(color), [color]);
  useEffect(() => () => mat.dispose(), [mat]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    let i = 0.55;
    if (phase === 'HALTED') i = Math.sin(t * 8) > 0 ? 1.6 : 0.1;
    else if (phase === 'ORDERING') i = 0.8 + 0.8 * Math.abs(Math.sin(t * 5));
    else if (phase === 'READY') i = 1.0 + 0.5 * Math.sin(t * 6);
    else if (phase === 'HOLDING' || phase === 'PROFIT') i = 1.0;
    else if (phase === 'STANDING_DOWN') i = 0.2;
    mat.color.copy(target).multiplyScalar(i);
  });
  return (
    <group position={[1.32, 0.78, -0.42]}>
      <mesh position={[0, 0.02, 0]}>
        <cylinderGeometry args={[0.08, 0.1, 0.04, 20]} />
        <meshStandardMaterial color="#121a26" roughness={0.5} metalness={0.7} />
      </mesh>
      <mesh position={[0, 0.12, 0]} material={mat}>
        <cylinderGeometry args={[0.055, 0.055, 0.15, 20]} />
      </mesh>
    </group>
  );
}

/** The signal's charge as a ring lying on the desk — the same dial that floats over the tower. */
function ChargeDial({ w, color }: { w: WorkerView; color: string }) {
  const mat = useMemo(() => createChargeRingMaterial(color), [color]);
  useEffect(() => () => mat.dispose(), [mat]);
  const accent = useMemo(() => new THREE.Color(color), [color]);
  const ticks = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ clock }, dt) => {
    const k = 1 - Math.exp(-dt * 4);
    const p = w.config.params;
    const charge = Math.max(0, Math.min(1, w.signal.charge / 100));
    const live = w.signal.live && w.signal.live.direction === w.signal.direction ? Math.max(0, Math.min(1, w.signal.live.charge / 100)) : 0;
    const u = mat.uniforms;
    (u.uColor!.value as THREE.Color).lerp(accent, k);
    u.uProgress!.value += (charge - u.uProgress!.value) * k;
    u.uLive!.value += (live - u.uLive!.value) * k;
    u.uTicks!.value = ticks.set(p.formingThreshold / 100, p.chargingThreshold / 100, p.readyThreshold / 100);
    u.uTime!.value = clock.elapsedTime;
    u.uReady!.value = w.towerState === 'READY' ? 1 : 0;
  });
  return (
    <mesh position={[-0.7, 0.8, -0.5]} rotation={[-Math.PI / 2, 0, 0]} material={mat} scale={0.2}>
      <ringGeometry args={[0.8, 1.0, 72, 1]} />
    </mesh>
  );
}

interface Popup {
  id: number;
  text: string;
  sub?: string;
  color: string;
  born: number;
}

function PopupSprite({ p, onDone }: { p: Popup; onDone: (id: number) => void }) {
  const texture = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 200;
    const ctx = c.getContext('2d')!;
    ctx.textAlign = 'center';
    ctx.font = '800 64px "Archivo Variable", system-ui, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, 320, 92);
    if (p.sub) {
      ctx.font = '600 30px "JetBrains Mono Variable", monospace';
      ctx.fillStyle = '#cdd8e8';
      ctx.fillText(p.sub, 320, 146);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [p]);
  const mat = useMemo(() => new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false, opacity: 0 }), [texture]);
  const sprite = useRef<THREE.Sprite>(null);
  useEffect(
    () => () => {
      texture.dispose();
      mat.dispose();
    },
    [texture, mat],
  );
  useFrame(({ clock }) => {
    const life = (clock.elapsedTime - p.born) / 4.2;
    if (sprite.current) sprite.current.position.y = 1.7 + life * 0.5;
    mat.opacity = life < 0.08 ? life / 0.08 : life > 0.7 ? Math.max(0, (1 - life) / 0.3) : 1;
    if (life >= 1) onDone(p.id);
  });
  return <sprite ref={sprite} position={[0, 1.7, 0]} scale={[1.7, 0.53, 1]} material={mat} renderOrder={10} />;
}

/** Floating call-outs for things that actually happened: an order going out, a fill, a close. */
function Popups({ items, onDone }: { items: Popup[]; onDone: (id: number) => void }) {
  return (
    <>
      {items.map((p) => (
        <PopupSprite key={p.id} p={p} onDone={onDone} />
      ))}
    </>
  );
}

function Floor() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, -1]}>
        <planeGeometry args={[24, 14]} />
        <meshStandardMaterial color="#070b12" roughness={0.9} metalness={0.1} />
      </mesh>
      <gridHelper args={[24, 48, '#16233a', '#0d1626']} position={[0, 0.001, -1]} />
    </group>
  );
}

function Desk({ color }: { color: string }) {
  const top = useMemo(() => new THREE.MeshStandardMaterial({ color: '#10161f', roughness: 0.45, metalness: 0.5 }), []);
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0b1018', roughness: 0.6, metalness: 0.6 }), []);
  const edge = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  const keys = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#0a0f16';
    ctx.fillRect(0, 0, 256, 96);
    ctx.fillStyle = '#243044';
    for (let r = 0; r < 5; r++) {
      const n = r === 4 ? 6 : 14;
      for (let k = 0; k < n; k++) {
        const w = r === 4 ? (k === 2 ? 90 : 20) : 16;
        const x = r === 4 ? [8, 32, 56, 80, 176, 200][k]! : 6 + k * 17.4;
        ctx.fillRect(x, 8 + r * 17, w, 13);
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);
  const keyMat = useMemo(() => new THREE.MeshStandardMaterial({ map: keys, roughness: 0.6, metalness: 0.3, emissive: new THREE.Color('#3b5e9a'), emissiveMap: keys, emissiveIntensity: 0.5 }), [keys]);
  useEffect(
    () => () => {
      top.dispose();
      dark.dispose();
      edge.dispose();
      keys.dispose();
      keyMat.dispose();
    },
    [top, dark, edge, keys, keyMat],
  );
  return (
    <group>
      <RoundedBox args={[2.9, 0.05, 0.9]} radius={0.015} smoothness={2} position={[0, 0.755, -0.63]} material={top} />
      <mesh position={[0, 0.745, -0.18]} material={edge}>
        <boxGeometry args={[2.88, 0.012, 0.012]} />
      </mesh>
      {[-1.38, 1.38].map((x) => (
        <mesh key={x} position={[x, 0.37, -0.63]} material={dark}>
          <boxGeometry args={[0.05, 0.74, 0.84]} />
        </mesh>
      ))}
      <mesh position={[0, 0.5, -1.02]} material={dark}>
        <boxGeometry args={[2.7, 0.5, 0.03]} />
      </mesh>
      {/* keyboard + mouse */}
      <RoundedBox args={[0.5, 0.018, 0.17]} radius={0.006} smoothness={2} position={[0, 0.789, -0.34]} material={keyMat} />
      <RoundedBox args={[0.07, 0.025, 0.1]} radius={0.02} smoothness={3} position={[0.4, 0.79, -0.33]} material={dark} />
      <mesh position={[0.4, 0.782, -0.33]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.28, 0.24]} />
        <meshStandardMaterial color="#0b1018" roughness={0.9} />
      </mesh>
      {/* mug */}
      <mesh position={[-1.1, 0.83, -0.4]}>
        <cylinderGeometry args={[0.045, 0.04, 0.09, 18]} />
        <meshStandardMaterial color="#d9e2ee" roughness={0.4} metalness={0.2} />
      </mesh>
    </group>
  );
}

/** The colour the tower itself wears for this state (direction while watching, green/red for a closed trade). */
function stageAccent(w: WorkerView): string {
  switch (w.towerState) {
    case 'HALTED':
    case 'LOSS':
      return STATE_COLORS.put;
    case 'PROFIT':
      return STATE_COLORS.call;
    case 'ORDER_PENDING':
      return STATE_COLORS.pending;
    case 'STANDING_DOWN':
      return STATE_COLORS.halted;
    default:
      return directionColor(w);
  }
}

function StageScene({ w, live, barsRef, lowPower }: { w: WorkerView; live: RefObject<Live | null>; barsRef: RefObject<LiveBars>; lowPower: boolean }) {
  const phase = phaseOf(w.towerState);
  const accentHex = useMemo(() => stageAccent(w), [w]);
  const charge = Math.max(0, Math.min(1, w.signal.charge / 100));
  const target = useMemo(() => new THREE.Vector3(0.02, 1.16, -0.5), []);

  // The screens read the latest values at draw time, so they never wait for a React render.
  const frameData = useCallback((): ScreenData => ({ w: live.current?.w ?? w, bars: barsRef.current, order: live.current?.order ?? null, quote: live.current?.quote ?? null, now: serverNow() }), [live, barsRef, w]);
  const accentRef = useRef(accentHex);
  useEffect(() => {
    accentRef.current = accentHex;
  }, [accentHex]);
  const chartTex = useScreenTexture(SCREEN.chart, useCallback((ctx) => drawChartScreen(ctx, frameData(), accentRef.current), [frameData]), 4);
  const posTex = useScreenTexture(SCREEN.position, useCallback((ctx) => drawPositionScreen(ctx, frameData(), accentRef.current), [frameData]), 5);
  const sigTex = useScreenTexture(SCREEN.signal, useCallback((ctx) => drawSignalScreen(ctx, frameData(), accentRef.current), [frameData]), 4);

  const glow = useRef<THREE.PointLight>(null);
  const glowColor = useMemo(() => new THREE.Color(accentHex), [accentHex]);
  useFrame((_, dt) => {
    if (!glow.current) return;
    const k = 1 - Math.exp(-dt * 4);
    glow.current.color.lerp(glowColor, k);
    const goal = phase === 'HALTED' ? 0.9 : phase === 'STANDING_DOWN' ? 0.5 : 1.5 + charge * 1.2;
    glow.current.intensity += (goal - glow.current.intensity) * k;
  });

  return (
    <>
      <color attach="background" args={['#04070c']} />
      <fog attach="fog" args={['#060b13', 6, 13]} />
      <ambientLight intensity={0.85} color="#8296bd" />
      <hemisphereLight args={['#3a5688', '#05070b', 1.0]} />
      <directionalLight position={[2.2, 4.6, 3.4]} intensity={1.5} color="#cfdcf5" />
      <directionalLight position={[-3, 2.5, 1.5]} intensity={0.5} color="#5a93ff" />
      <pointLight ref={glow} position={[0, 1.5, -0.5]} distance={4.2} decay={2} intensity={1.5} color={accentHex} />
      <Floor />
      <Skyline />
      <Desk color={accentHex} />
      <Monitor texture={chartTex} width={0.92} aspect={SCREEN.chart.w / SCREEN.chart.h} position={[-1.04, 1.46, -0.78]} rotationY={0.4} />
      <Monitor texture={posTex} width={1.08} aspect={SCREEN.position.w / SCREEN.position.h} position={[0, 1.5, -1.02]} />
      <Monitor texture={sigTex} width={0.92} aspect={SCREEN.signal.w / SCREEN.signal.h} position={[1.04, 1.46, -0.78]} rotationY={-0.4} />
      <ChargeDial w={w} color={accentHex} />
      <Beacon phase={phase} color={accentHex} />
      <DeskRobot phase={phase} color={accentHex} charge={charge} reducedMotion={reducedMotion} />
      <CameraRig target={target} narrow={lowPower} />
      {!lowPower && (
        <EffectComposer multisampling={2}>
          <Bloom mipmapBlur intensity={0.55} luminanceThreshold={0.7} luminanceSmoothing={0.2} radius={0.6} />
        </EffectComposer>
      )}
    </>
  );
}

class StageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center text-center">
          <span className="label">3D desk unavailable — trading data below is unaffected.</span>
        </div>
      );
    }
    return this.props.children;
  }
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

/** One plain-English line about what the robot is doing, from the worker's real state. */
export function robotActivity(w: WorkerView): string {
  const name = instrumentName(w.config.symbol);
  const p = w.position;
  switch (w.towerState) {
    case 'WATCHING':
      return `Watching ${name} for a setup`;
    case 'SETUP_FORMING':
      return 'Setup forming — checking the conditions';
    case 'CHARGING':
      return `Setup charging · ${w.signal.charge}% of the way to ready`;
    case 'READY':
      return w.autotradeEnabled ? 'Setup ready — running the risk checks' : 'Setup ready — autotrading is OFF for this worker, no order will be sent';
    case 'ORDER_PENDING':
      return 'Order sent — waiting for the broker to confirm';
    case 'IN_TRADE':
      return p
        ? `In a ${directionLabel(p.direction, w.config.instrument)} trade · ${unitsStr(Math.abs(p.qty))}${p.stopSource === 'broker' ? ' · stop held by the broker' : p.stopSource === 'server' ? ' · stop held by this server' : ''}`
        : 'In a trade';
    case 'PROFIT':
      return 'Position closed in profit';
    case 'LOSS':
      return 'Position closed at a loss';
    case 'STANDING_DOWN':
      if (w.market && !w.market.listed) return `${name} is not offered to this account — nothing to trade`;
      return `Stood down${w.haltReason ? ` — ${w.haltReason}` : ''}`;
    case 'HALTED':
      return `Halted${w.haltReason ? ` — ${w.haltReason}` : ''}`;
  }
}

/**
 * The worker at its desk (the "little robot trading" you get when you open a
 * tower). A close-up 3D scene whose every moving part is driven by the
 * worker's real state, with monitors showing the real bars and the real
 * position. It places no orders and has no controls that could.
 */
function StageFrame({ workerId, height, lowPower, big, onToggle }: { workerId: string; height: number | string; lowPower: boolean; big: boolean; onToggle: () => void }) {
  const w = useStore((s) => s.workers[workerId]);
  const order = useStore((s) => (w?.activeOrderId ? (s.orders[w.activeOrderId] ?? null) : null));
  const quote = useStore((s) => (w ? (s.quotes[w.config.symbol] ?? null) : null));
  const [lost, setLost] = useState(false);
  // A slow machine drops the post-processing and renders at 1× before it drops frames.
  const [degraded, setDegraded] = useState(false);
  const [popups, setPopups] = useState<Popup[]>([]);
  const nextId = useRef(1);
  const clockRef = useRef(0);
  const prev = useRef<{ order: string | null; pos: boolean; realized: number; state: string } | null>(null);
  const symbol = w?.config.symbol ?? '';
  const barsRef = useLiveBars(symbol);

  const live = useRef<Live | null>(null);
  useEffect(() => {
    if (w) live.current = { w, order, quote };
  });

  // Call-outs only for real transitions seen while this desk is open (never for the state it opened in).
  useEffect(() => {
    if (!w) return;
    const now = { order: w.activeOrderId, pos: w.position !== null, realized: w.stats.realizedToday, state: w.towerState };
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const add = (text: string, color: string, sub?: string) => setPopups((list) => [...list.slice(-3), { id: nextId.current++, text, sub, color, born: clockRef.current }]);
    const name = instrumentName(w.config.symbol);
    if (!before.order && now.order) {
      const o = order;
      add('ORDER SENT', STATE_COLORS.pending, o ? `${o.side.toUpperCase()} ${qtyStr(o.qty)} ${name}` : name);
    }
    if (!before.pos && now.pos && w.position) {
      const long = w.position.qty > 0;
      add(`FILLED · ${long ? 'LONG' : 'SHORT'}`, long ? STATE_COLORS.call : STATE_COLORS.put, `${qtyStr(Math.abs(w.position.qty))} ${name} @ ${px(w.config.symbol, w.position.avgEntryPrice)}`);
    }
    if (before.pos && !now.pos) {
      const delta = now.realized - before.realized;
      const ok = Math.abs(delta) > 0.005;
      add(ok ? money(delta, { sign: true }) : 'POSITION CLOSED', delta >= 0 ? STATE_COLORS.call : STATE_COLORS.put, ok ? `${name} closed` : name);
    }
    if (before.state !== 'HALTED' && now.state === 'HALTED') add('HALTED', STATE_COLORS.put, w.haltReason ?? undefined);
  }, [w, order]);

  const done = useCallback((id: number) => setPopups((list) => list.filter((p) => p.id !== id)), []);

  if (!w) return null;
  const color = stageAccent(w);
  const stale = quote?.stale === true;

  return (
    <div className="relative h-full overflow-hidden border border-line bg-[#04070c]" style={{ height }} aria-label={`${w.config.name} at its trading desk: ${robotActivity(w)}`} role="img">
      <StageBoundary>
        <Canvas
          dpr={lowPower || degraded ? 1 : [1, big ? 2 : 1.75]}
          gl={{ antialias: lowPower, powerPreference: 'high-performance', stencil: false }}
          camera={{ fov: 26, near: 0.1, far: 60, position: [1.5, 4.25, 4.1] }}
          onCreated={({ gl, clock }) => {
            clockRef.current = clock.elapsedTime;
            gl.domElement.addEventListener('webglcontextlost', () => setLost(true));
            gl.domElement.addEventListener('webglcontextrestored', () => setLost(false));
          }}
        >
          <PerformanceMonitor bounds={() => [24, 60]} onDecline={() => setDegraded(true)} />
          <ClockBridge onTick={(t) => (clockRef.current = t)} />
          <StageScene w={w} live={live} barsRef={barsRef} lowPower={lowPower || degraded} />
          <Popups items={popups} onDone={done} />
        </Canvas>
      </StageBoundary>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 bg-gradient-to-b from-[#04070c] via-[#04070c]/70 to-transparent p-2.5 pb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-[3px] shrink-0" style={{ background: color }} />
            <span className="display truncate text-[12px] tracking-[0.12em] text-fg">{w.config.name}</span>
            <span className="label !text-[9px] !text-fg-3">{stale ? <span className="!text-pending">DATA STALE</span> : 'LIVE DATA'}</span>
          </div>
          <div className="mt-0.5 max-w-[460px] truncate text-[11px] text-fg-2">{robotActivity(w)}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        className="focus-ring label-strong absolute right-2 top-2 border border-line-2 bg-ink-950/80 px-2 py-1 text-[9.5px] text-fg-2 hover:text-fg"
        aria-label={big ? 'Close the full-screen desk' : 'Open the desk full screen'}
      >
        {big ? 'CLOSE ✕' : 'EXPAND ⤢'}
      </button>
      {lost && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70">
          <span className="label-strong text-pending">3D view paused — graphics context lost</span>
        </div>
      )}
    </div>
  );
}

/** Keeps the React side's idea of "now in the 3D clock" for stamping popups. */
function ClockBridge({ onTick }: { onTick: (t: number) => void }) {
  useFrame(({ clock }) => onTick(clock.elapsedTime));
  return null;
}

export default function RobotStage({ workerId, height = 340, lowPower = false }: { workerId: string; height?: number; lowPower?: boolean }) {
  const [supported] = useState(webglAvailable);
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    // Capture phase + stopImmediatePropagation: the first Escape only closes the full-screen view, not the whole desk.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setBig(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [big]);
  if (!supported) return null;
  return (
    <div>
      {big ? (
        <div className="label flex items-center justify-center border border-line" style={{ height }}>
          The desk is open full screen
        </div>
      ) : (
        <StageFrame workerId={workerId} height={height} lowPower={lowPower} big={false} onToggle={() => setBig(true)} />
      )}
      <div className="label mt-1 !text-[9.5px]">The screens show the real 1-minute bars, the worker&rsquo;s real signal and the broker-confirmed position. The robot only reflects them — it cannot place orders.</div>
      {big &&
        createPortal(
          <div className="fixed inset-0 z-[70] bg-ink-950/92 p-[4vh_3vw]" onClick={() => setBig(false)}>
            <div className="h-full" onClick={(e) => e.stopPropagation()}>
              <StageFrame workerId={workerId} height="100%" lowPower={false} big onToggle={() => setBig(false)} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
