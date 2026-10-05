import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { DESKTOP_PANELS, DRAWER_WIDTHS, WORKER_DESK_WIDTH } from '../lib/layout';
import { useStore } from '../store/store';
import { Ground, Sky, Skyline, Traffic } from './Backdrop';
import { Effects, type Anchor } from './Effects';
import { towerHeight, towerLevels, towerPositions, VAULT_POSITION, type Vec3 } from './layout';
import { STATE_COLORS } from './materials';
import { Tower } from './Tower';
import { Vault } from './Vault';
import { LabelLayer } from './labelLayer';

const FOV = 30;
const HOME_TARGET = new THREE.Vector3(0, 3.2, 0.6);
const HOME_DIR = new THREE.Vector3(0, 0.4, 1).normalize();

interface Controls {
  target: THREE.Vector3;
  update(): unknown;
  addEventListener(type: 'start', fn: () => void): void;
  removeEventListener(type: 'start', fn: () => void): void;
}

interface TowerSlot {
  id: string;
  position: Vec3;
  height: number;
}

/** A world point the default view must show, with the screen margin (px) it needs around it. */
interface FitPoint {
  p: THREE.Vector3;
  mx: number;
  my: number;
}

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Canvas region not covered by floating panels (px), and the projection shift that centres on it. */
function freeArea(width: number, height: number, framing: boolean, rightCover: number) {
  if (!framing) return { left: 0, right: width, top: 0, bottom: height, dx: 0, dy: 0 };
  const left = DESKTOP_PANELS.left;
  return { left, right: width - rightCover, top: 0, bottom: height - DESKTOP_PANELS.bottom, dx: (rightCover - left) / 2, dy: DESKTOP_PANELS.bottom / 2 };
}

function fitPoints(slots: TowerSlot[]): FitPoint[] {
  const pts: FitPoint[] = [];
  for (const s of slots) {
    const [x, , z] = s.position;
    pts.push({ p: new THREE.Vector3(x, 0, z + 0.9), mx: 14, my: 10 });
    pts.push({ p: new THREE.Vector3(x, towerLevels(s.height).label, z), mx: 84, my: 64 });
  }
  pts.push({ p: new THREE.Vector3(VAULT_POSITION[0], 0, VAULT_POSITION[2] + 2.9), mx: 12, my: 14 });
  return pts;
}

/**
 * Smallest camera distance (along the home direction) at which every fit
 * point lands inside the free area with its margin, found by bisection on a
 * scratch camera. Robust to any window size and any number of workers.
 */
function fitHome(width: number, height: number, framing: boolean, pts: FitPoint[]): THREE.Vector3 {
  const free = freeArea(width, height, framing, framing ? DESKTOP_PANELS.right : 0);
  const cam = new THREE.PerspectiveCamera(FOV, width / height, 0.5, 400);
  if (framing) cam.setViewOffset(width, height, free.dx, free.dy, width, height);
  const v = new THREE.Vector3();
  const fits = (d: number) => {
    cam.position.copy(HOME_TARGET).addScaledVector(HOME_DIR, d);
    cam.lookAt(HOME_TARGET);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    return pts.every(({ p, mx, my }) => {
      v.copy(p).project(cam);
      const sx = ((v.x + 1) / 2) * width;
      const sy = ((1 - v.y) / 2) * height;
      return v.z < 1 && sx >= free.left + mx && sx <= free.right - mx && sy >= free.top + my && sy <= free.bottom - my;
    });
  };
  let lo = 10;
  let hi = 80;
  if (!fits(hi)) return HOME_TARGET.clone().addScaledVector(HOME_DIR, hi);
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return HOME_TARGET.clone().addScaledVector(HOME_DIR, hi);
}

/**
 * Frames the city inside the area the panels leave free (shifting the
 * projection centre rather than the camera), and flies to a selected tower.
 */
function CameraRig({ slots, anchors, framing }: { slots: TowerSlot[]; anchors: Map<string, Anchor>; framing: boolean }) {
  const selected = useStore((s) => s.ui.selectedWorker);
  const drawer = useStore((s) => s.ui.drawer);
  const controls = useThree((s) => s.controls) as unknown as Controls | null;
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const fly = useRef<{ target: THREE.Vector3; pos: THREE.Vector3; t: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });
  const placed = useRef<string | null>(null);
  const pts = useMemo(() => fitPoints(slots), [slots]);
  const rightCover = framing ? (selected ? WORKER_DESK_WIDTH : drawer ? DRAWER_WIDTHS[drawer] : DESKTOP_PANELS.right) : 0;

  useEffect(() => {
    if (!controls) return;
    const stop = () => {
      fly.current = null;
    };
    controls.addEventListener('start', stop);
    return () => controls.removeEventListener('start', stop);
  }, [controls]);

  // Home view: placed on first frame and re-fitted when the canvas size or the worker set changes.
  useEffect(() => {
    if (!controls || size.width === 0 || size.height === 0) return;
    const key = `${size.width}x${size.height}:${slots.length}`;
    if (placed.current === key) return;
    const first = placed.current === null;
    placed.current = key;
    const home = fitHome(size.width, size.height, framing, pts);
    if (first) {
      camera.position.copy(home);
      controls.target.copy(HOME_TARGET);
      controls.update();
    } else if (!selected) {
      fly.current = { target: HOME_TARGET.clone(), pos: home, t: 0 };
    }
  }, [controls, size.width, size.height, slots.length, framing, pts, camera, selected]);

  useEffect(() => {
    if (!controls || placed.current === null) return;
    const a = selected ? anchors.get(selected) : undefined;
    if (a) {
      // Ease in on the tower but keep its neighbours in view: a gentle push, not a close-up.
      const target = new THREE.Vector3(a.position[0], a.top * 0.5, a.position[2]);
      const dir = camera.position.clone().sub(controls.target).normalize();
      const dist = Math.max(18, camera.position.distanceTo(controls.target) * 0.72);
      fly.current = { target, pos: target.clone().addScaledVector(dir, dist), t: 0 };
    } else {
      fly.current = { target: HOME_TARGET.clone(), pos: fitHome(size.width, size.height, framing, pts), t: 0 };
    }
    // Only a selection change starts a flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useFrame((state, dt) => {
    const { width, height } = state.size;
    const free = freeArea(width, height, framing, rightCover);
    const o = offset.current;
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
    o.x += (free.dx - o.x) * k;
    o.y += (free.dy - o.y) * k;
    const v = camera.view;
    if (framing) {
      if (!v || !v.enabled || v.fullWidth !== width || v.fullHeight !== height || Math.abs(v.offsetX - o.x) > 0.2 || Math.abs(v.offsetY - o.y) > 0.2) {
        camera.setViewOffset(width, height, o.x, o.y, width, height);
      }
    } else if (v?.enabled) {
      camera.clearViewOffset();
    }
    const f = fly.current;
    if (f && controls) {
      const kf = reducedMotion ? 1 : 1 - Math.exp(-dt * 3);
      controls.target.lerp(f.target, kf);
      camera.position.lerp(f.pos, kf);
      f.t += dt;
      if (f.t > 3 || camera.position.distanceToSquared(f.pos) < 1e-4) fly.current = null;
      controls.update();
    }
  });
  return null;
}

function CityContent({ lowPower, onKill }: { lowPower: boolean; onKill: () => void }) {
  const order = useStore((s) => s.workerOrder);
  const marketOpen = useStore((s) => s.system?.market.isOpen ?? false);
  const stockLive = useStore((s) => s.system?.marketData.stock.state === 'CONNECTED');
  const kill = useStore((s) => s.system?.controls.killSwitch.active ?? false);
  const layout = useMemo<TowerSlot[]>(() => {
    const pos = towerPositions(order.length);
    return order.map((id, i) => ({ id, position: pos[i]!, height: towerHeight(i, order.length) }));
  }, [order]);
  const anchors = useMemo(() => new Map<string, Anchor>(layout.map((l) => [l.id, { position: l.position, top: towerLevels(l.height).dial }])), [layout]);
  // A closed market dims the city; traffic needs an open session and a live feed.
  const activity = marketOpen ? 1 : 0.55;
  const cameraHome = HOME_TARGET.clone().addScaledVector(HOME_DIR, 28);
  return (
    <>
      <color attach="background" args={['#03060c']} />
      <fog attach="fog" args={['#081120', 30, 96]} />
      <ambientLight intensity={0.4} color="#7d8fb0" />
      <hemisphereLight args={['#1d3150', '#05070a', 0.9]} />
      <directionalLight position={[-14, 20, -12]} intensity={1.1} color="#9db7e8" />
      <directionalLight position={[10, 8, 16]} intensity={0.25} color="#4c8dff" />
      <Sky alert={kill ? 1 : 0} />
      <Ground />
      <Skyline count={lowPower ? 90 : 230} activity={activity} />
      <Traffic enabled={marketOpen && stockLive} count={lowPower ? 24 : 64} />
      <Vault activity={activity} />
      {layout.map((l) => (
        <Tower
          key={l.id}
          id={l.id}
          position={l.position}
          height={l.height}
          rotationY={Math.atan2(cameraHome.x - l.position[0], cameraHome.z - l.position[2])}
          activity={activity}
          compact={lowPower}
        />
      ))}
      <Effects anchors={anchors} onKill={onKill} />
      <CameraRig slots={layout} anchors={anchors} framing={!lowPower} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
        minDistance={9}
        maxDistance={60}
        minPolarAngle={0.25}
        maxPolarAngle={1.42}
        rotateSpeed={0.6}
        zoomSpeed={0.7}
      />
      {!lowPower && (
        <EffectComposer multisampling={4}>
          <Bloom mipmapBlur intensity={0.9} luminanceThreshold={0.62} luminanceSmoothing={0.18} radius={0.72} />
          <Vignette darkness={0.6} offset={0.32} />
        </EffectComposer>
      )}
    </>
  );
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-[340px] text-center">
        <div className="label-strong text-fg-2">3D city unavailable</div>
        <div className="mt-1 text-[12px] text-fg-3">{reason} Trading state, controls and the kill switch are unaffected and remain in the panels.</div>
      </div>
    </div>
  );
}

class SceneBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  override render() {
    if (this.state.error) return <Unavailable reason={`The renderer failed (${this.state.error}).`} />;
    return this.props.children;
  }
}

function Legend() {
  // The legend sits in the free area; a drawer or the trading desk covers part of it.
  const covered = useStore((s) => s.ui.drawer !== null || s.ui.selectedWorker !== null);
  const cfd = useStore((s) => s.system?.venue === 'oanda');
  if (covered) return null;
  const items: [string, string][] = [
    [cfd ? 'LONG' : 'CALL', STATE_COLORS.call],
    [cfd ? 'SHORT' : 'PUT', STATE_COLORS.put],
    ['NO SETUP', STATE_COLORS.neutral],
    ['ORDER PENDING', STATE_COLORS.pending],
    ['STOOD DOWN', STATE_COLORS.halted],
  ];
  return (
    <div
      className="pointer-events-none absolute flex -translate-x-1/2 items-center gap-3 whitespace-nowrap"
      style={{ bottom: DESKTOP_PANELS.bottom + 10, left: `calc(${DESKTOP_PANELS.left}px + (100% - ${DESKTOP_PANELS.left + DESKTOP_PANELS.right}px) / 2)` }}
    >
      {items.map(([label, color]) => (
        <span key={label} className="label flex items-center gap-1 text-[9px]">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function CityNotice() {
  const marketOpen = useStore((s) => s.system?.market.isOpen ?? false);
  const label = useStore((s) => s.system?.market.label ?? 'UNKNOWN');
  const stock = useStore((s) => s.system?.marketData.stock.state ?? 'DISCONNECTED');
  const kill = useStore((s) => s.system?.controls.killSwitch.active ?? false);
  let text: string | null = null;
  let tone = 'text-fg-3';
  if (kill) {
    text = 'KILL SWITCH ENGAGED — ALL WORKERS STOPPED';
    tone = 'text-put';
  } else if (stock !== 'CONNECTED') {
    text = `MARKET DATA ${stock} — CITY SHOWS LAST KNOWN STATE`;
    tone = 'text-pending';
  } else if (!marketOpen) {
    text = `MARKET ${label.replace('_', ' ')} — CITY AT REST`;
  }
  if (!text) return null;
  return <div className={`label-strong pointer-events-none absolute left-1/2 top-7 -translate-x-1/2 whitespace-nowrap text-[9.5px] ${tone}`}>{text}</div>;
}

/**
 * The city (spec §76–90). It renders server state only: tower colour, charge,
 * beams and robots come from worker views, effects from broker-confirmed
 * city events. Nothing here can place or alter an order.
 */
export default function CityScene({ lowPower = false }: { lowPower?: boolean }) {
  const [supported] = useState(webglAvailable);
  const [lost, setLost] = useState(false);
  const [flash, setFlash] = useState(0);
  const labels = useRef<HTMLDivElement>(null);
  if (!supported) return <Unavailable reason="WebGL is not available in this browser." />;
  return (
    <div className="relative isolate h-full w-full overflow-hidden bg-[#03060c]">
      <SceneBoundary>
        <LabelLayer.Provider value={labels}>
          <Canvas
            dpr={lowPower ? 1 : [1, 1.75]}
            gl={{ antialias: lowPower, powerPreference: 'high-performance', stencil: false }}
            camera={{ fov: FOV, near: 0.5, far: 400, position: [0, 14, 30] }}
            onCreated={({ gl }) => {
              gl.domElement.addEventListener('webglcontextlost', () => setLost(true));
              gl.domElement.addEventListener('webglcontextrestored', () => setLost(false));
            }}
          >
            <CityContent lowPower={lowPower} onKill={() => setFlash((n) => n + 1)} />
          </Canvas>
        </LabelLayer.Provider>
      </SceneBoundary>
      <div ref={labels} className="pointer-events-none absolute inset-0" />
      {!lowPower && <Legend />}
      <CityNotice />
      {flash > 0 && <div key={flash} className="kill-flash pointer-events-none absolute inset-0" />}
      {lost && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70">
          <span className="label-strong text-pending">3D view paused — graphics context lost</span>
        </div>
      )}
    </div>
  );
}
