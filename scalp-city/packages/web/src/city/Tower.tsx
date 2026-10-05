import { Html } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { directionLabel, type TowerState, type WorkerView } from '@scalp-city/shared';
import { directionColor } from '../components/panels/Workers';
import { cx } from '../components/ui';
import { money, pnlClass } from '../lib/format';
import { useStore } from '../store/store';
import { useLabelLayer } from './labelLayer';
import { towerLevels, type Vec3 } from './layout';
import { createBeamMaterial, createChargeRingMaterial, createMeterMaterial, createWindowMaterial, STATE_COLORS } from './materials';
import { moodFor, Robot } from './Robot';

const STATE_LABEL: Record<TowerState, string> = {
  WATCHING: 'WATCHING',
  SETUP_FORMING: 'FORMING',
  CHARGING: 'CHARGING',
  READY: 'READY',
  ORDER_PENDING: 'ORDER PENDING',
  IN_TRADE: 'IN TRADE',
  PROFIT: 'PROFIT',
  LOSS: 'LOSS',
  STANDING_DOWN: 'STANDING DOWN',
  HALTED: 'HALTED',
};

/** Lit-window share per state: an engaged worker's tower is visibly busier. */
const WINDOW_DENSITY: Record<TowerState, number> = {
  WATCHING: 0.3,
  SETUP_FORMING: 0.38,
  CHARGING: 0.5,
  READY: 0.66,
  ORDER_PENDING: 0.68,
  IN_TRADE: 0.74,
  PROFIT: 0.66,
  LOSS: 0.36,
  STANDING_DOWN: 0.12,
  HALTED: 0.06,
};

/** Beam strength: only an engaged worker (ready / ordering / holding) lights the sky. */
const BEAM: Partial<Record<TowerState, number>> = { READY: 1, ORDER_PENDING: 0.75, IN_TRADE: 0.6, PROFIT: 0.45 };

/**
 * Tower accent colour. Hue = direction (spec §78); brightness = conviction.
 * A weak lean must not light a tower like a live trade, so while watching /
 * forming / charging the colour is dimmed in proportion to the confirmed
 * charge (it never shifts hue, so a dim red still reads as a PUT lean).
 */
function towerAccent(w: WorkerView, out: THREE.Color): THREE.Color {
  switch (w.towerState) {
    case 'PROFIT':
      return out.set(STATE_COLORS.call);
    case 'LOSS':
      return out.set(STATE_COLORS.put);
    case 'WATCHING':
    case 'SETUP_FORMING':
    case 'CHARGING': {
      const t = Math.max(0, Math.min(1, w.signal.charge / Math.max(1, w.config.params.readyThreshold)));
      return out.set(directionColor(w)).multiplyScalar(0.4 + 0.6 * t);
    }
    default:
      return out.set(directionColor(w));
  }
}

export interface TowerProps {
  id: string;
  position: Vec3;
  height: number;
  /** Faces the default camera. */
  rotationY: number;
  /** City-wide multiplier: fewer lit windows when the market is closed. */
  activity: number;
  /** Small screens: name-only tag. */
  compact?: boolean;
}

export function Tower({ id, position, height, rotationY, activity, compact = false }: TowerProps) {
  const w = useStore((s) => s.workers[id]);
  const selected = useStore((s) => s.ui.selectedWorker === id);
  const select = useStore((s) => s.selectWorker);
  if (!w) return null;
  return <TowerBody w={w} position={position} height={height} rotationY={rotationY} activity={activity} compact={compact} selected={selected} onSelect={() => select(id)} />;
}

function TowerBody({
  w,
  position,
  height,
  rotationY,
  activity,
  compact,
  selected,
  onSelect,
}: {
  w: WorkerView;
  position: Vec3;
  height: number;
  rotationY: number;
  activity: number;
  compact: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const labels = useLabelLayer();
  const accent = useMemo(() => towerAccent(w, new THREE.Color()), [w]);
  const accentCss = useMemo(() => (w.towerState === 'PROFIT' ? STATE_COLORS.call : w.towerState === 'LOSS' ? STATE_COLORS.put : directionColor(w)), [w]);
  const seed = useMemo(() => w.config.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 97, [w.config.id]);
  const mats = useMemo(
    () => ({
      windows: createWindowMaterial({ base: '#0b121d', lit: '#86a9e0', density: 0.3, seed }),
      meter: createMeterMaterial(STATE_COLORS.neutral),
      ring: createChargeRingMaterial(STATE_COLORS.neutral),
      pending: new THREE.MeshBasicMaterial({ color: '#ffb020', transparent: true, opacity: 0, toneMapped: false, depthWrite: false }),
      beam: createBeamMaterial(STATE_COLORS.neutral),
      trim: new THREE.MeshBasicMaterial({ color: STATE_COLORS.neutral, toneMapped: false }),
      beacon: new THREE.MeshBasicMaterial({ color: '#ff4d6d', toneMapped: false, transparent: true, opacity: 0 }),
      metal: new THREE.MeshStandardMaterial({ color: '#131b27', roughness: 0.45, metalness: 0.7 }),
      glass: new THREE.MeshStandardMaterial({ color: '#0d1626', roughness: 0.1, metalness: 0.9, transparent: true, opacity: 0.5 }),
    }),
    [seed],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const light = useRef<THREE.PointLight>(null);
  const pending = useRef<THREE.Mesh>(null);

  // Targets derived from real worker state only.
  const state = w.towerState;
  const charge = Math.max(0, Math.min(1, w.signal.charge / 100));
  const live = w.signal.live && w.signal.live.direction === w.signal.direction ? Math.max(0, Math.min(1, w.signal.live.charge / 100)) : 0;
  const p = w.config.params;
  const ticks = useMemo(() => new THREE.Vector3(p.formingThreshold / 100, p.chargingThreshold / 100, p.readyThreshold / 100), [p.formingThreshold, p.chargingThreshold, p.readyThreshold]);
  const engagedState = state === 'READY' || state === 'ORDER_PENDING' || state === 'IN_TRADE' || state === 'PROFIT';
  const meterFill = engagedState ? 1 : charge;
  const meterGhost = engagedState ? 1 : Math.max(charge, live);
  const density = WINDOW_DENSITY[state] * activity;
  // A READY setup that already produced an order will not trade again: no beam for it.
  const used = state === 'READY' && w.signal.consumed;
  const beamGoal = used ? 0.15 : (BEAM[state] ?? 0);
  const ringVisible = state !== 'STANDING_DOWN' && state !== 'HALTED';
  const lv = towerLevels(height);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const k = 1 - Math.exp(-dt * 4);
    const wu = mats.windows.userData.uniforms as { uDensity: { value: number }; uTime: { value: number } };
    wu.uDensity.value += (density - wu.uDensity.value) * k;
    wu.uTime.value = t;

    const mu = mats.meter.uniforms;
    (mu.uColor!.value as THREE.Color).lerp(accent, k);
    mu.uFill!.value += (meterFill - mu.uFill!.value) * k;
    mu.uGhost!.value += (meterGhost - mu.uGhost!.value) * k;
    mu.uIntensity!.value = state === 'HALTED' ? (Math.sin(t * 3) > 0 ? 1 : 0.25) : state === 'READY' && !used ? 0.85 + 0.35 * Math.sin(t * 6) : 1;

    const ru = mats.ring.uniforms;
    (ru.uColor!.value as THREE.Color).lerp(accent, k);
    ru.uProgress!.value += (charge - ru.uProgress!.value) * k;
    ru.uLive!.value += (live - ru.uLive!.value) * k;
    ru.uTicks!.value = ticks;
    ru.uTime!.value = t;
    ru.uReady!.value = state === 'READY' && !used ? 1 : 0;

    const bu = mats.beam.uniforms;
    (bu.uColor!.value as THREE.Color).lerp(accent, k);
    const bGoal = beamGoal * (state === 'READY' && !used ? 0.85 + 0.15 * Math.sin(t * 5) : 1);
    bu.uIntensity!.value += (bGoal - bu.uIntensity!.value) * k;
    bu.uTime!.value = t;

    mats.trim.color.lerp(accent, k);
    mats.pending.opacity += ((state === 'ORDER_PENDING' ? 0.9 : 0) - mats.pending.opacity) * k;
    if (pending.current) pending.current.rotation.z = t * 2.4;
    mats.beacon.opacity = state === 'HALTED' ? (Math.sin(t * 4) > 0 ? 1 : 0.1) : 0;

    if (light.current) {
      light.current.color.lerp(accent, k);
      const goal = state === 'HALTED' || state === 'STANDING_DOWN' ? 1.5 : 5 + 22 * (engagedState ? 1 : charge * 0.6);
      light.current.intensity += (goal - light.current.intensity) * k;
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 6) return; // a drag that ended on the tower, not a click
    onSelect();
  };
  const hover = (on: boolean) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    document.body.style.cursor = on ? 'pointer' : '';
  };
  const c = 0.63;
  const corners: [number, number][] = [
    [-c, -c],
    [c, -c],
    [-c, c],
    [c, c],
  ];
  const pnl = w.stats.pnlToday;
  const dir = w.position?.direction ?? w.signal.direction;
  const dirText = directionLabel(dir, w.config.instrument);
  const holding = w.position !== null || w.activeOrderId !== null;

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <group onClick={click} onPointerOver={hover(true)} onPointerOut={hover(false)}>
        {/* plinth with a thin accent band just under its top edge */}
        <mesh position={[0, 0.11, 0]} material={mats.metal}>
          <boxGeometry args={[1.8, 0.22, 1.8]} />
        </mesh>
        <mesh position={[0, 0.185, 0]} material={mats.trim}>
          <boxGeometry args={[1.83, 0.025, 1.83]} />
        </mesh>
        {/* shaft */}
        <mesh position={[0, 0.22 + height / 2, 0]} material={mats.windows}>
          <boxGeometry args={[1.25, height, 1.25]} />
        </mesh>
        {/* edge strips = charge meter */}
        {corners.map(([x, z]) => (
          <mesh key={`${x}${z}`} position={[x, 0.22 + height / 2, z]} material={mats.meter}>
            <boxGeometry args={[0.05, height, 0.05]} />
          </mesh>
        ))}
        {/* crown deck + rim band */}
        <mesh position={[0, lv.deck - 0.04, 0]} material={mats.metal}>
          <boxGeometry args={[1.5, 0.08, 1.5]} />
        </mesh>
        <mesh position={[0, lv.deck - 0.05, 0]} material={mats.trim}>
          <boxGeometry args={[1.53, 0.022, 1.53]} />
        </mesh>
        <mesh position={[0, lv.deck + 0.36, -0.72]} material={mats.glass}>
          <boxGeometry args={[1.45, 0.72, 0.03]} />
        </mesh>
      </group>
      <group position={[0, lv.deck, -0.12]}>
        <Robot mood={moodFor(state)} color={accentCss} scale={0.9} />
      </group>
      {/* charge dial floating above the crown: solid = confirmed, ghost = forming-bar preview */}
      {ringVisible && (
        <mesh position={[0, lv.dial, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mats.ring}>
          <ringGeometry args={[0.8, 1.0, 96, 1]} />
        </mesh>
      )}
      <mesh ref={pending} position={[0, lv.dial, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mats.pending}>
        <ringGeometry args={[1.08, 1.14, 48, 1, 0, Math.PI * 1.2]} />
      </mesh>
      {/* sky beam: engaged workers only */}
      <mesh position={[0, lv.dial + 7, 0]} material={mats.beam}>
        <cylinderGeometry args={[0.14, 0.34, 14, 24, 1, true]} />
      </mesh>
      <mesh position={[0, lv.deck + 1.05, 0]} material={mats.beacon}>
        <sphereGeometry args={[0.1, 12, 12]} />
      </mesh>
      <pointLight ref={light} position={[0, lv.deck + 0.5, 0.8]} distance={8} decay={2} intensity={5} />
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.45, 1.53, 64]} />
          <meshBasicMaterial color="#4c8dff" toneMapped={false} transparent opacity={0.95} />
        </mesh>
      )}
      <Html portal={labels} position={[0, lv.label, 0]} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
        {compact ? (
          <button
            type="button"
            onClick={onSelect}
            className={cx('pointer-events-auto block cursor-pointer select-none whitespace-nowrap border-l-2 bg-ink-950/80 px-1.5 py-0.5', selected && 'outline outline-1 outline-signal')}
            style={{ borderLeftColor: accentCss }}
            aria-label={`Open ${w.config.name} trading desk`}
          >
            <span className="display text-[9px] tracking-[0.1em] text-fg">{w.config.name}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            className={cx(
              'pointer-events-auto block w-[124px] cursor-pointer select-none border border-l-2 bg-ink-950/85 px-2 py-1 text-left backdrop-blur-[2px] transition-colors hover:bg-ink-900/95',
              selected ? 'border-signal' : 'border-line-2',
            )}
            style={{ borderLeftColor: accentCss }}
            aria-label={`Open ${w.config.name} trading desk`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="display truncate text-[10.5px] tracking-[0.12em] text-fg">{w.config.name}</span>
              {!w.autotradeEnabled && <span className="label text-[8px]">AUTO OFF</span>}
            </div>
            <div className="label-strong mt-px truncate text-[9px]" style={{ color: accentCss }}>
              {STATE_LABEL[state]}
              {used ? ' · SIGNAL USED' : ''}
              {w.unmanagedWarning ? ' · !' : ''}
            </div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2">
              <span className={cx('num text-[11.5px]', pnlClass(pnl))}>{pnl === null ? '—' : money(pnl, { sign: true })}</span>
              <span className="num text-[9.5px] text-fg-2">{holding ? (dir === 'NEUTRAL' ? '' : dirText) : dir === 'NEUTRAL' ? 'NO SETUP' : `${dirText} ${Math.round(w.signal.charge)}%`}</span>
            </div>
          </button>
        )}
      </Html>
    </group>
  );
}
