import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { cx } from '../components/ui';
import { envLabel, money, pct, pnlClass } from '../lib/format';
import { useStore } from '../store/store';
import { onCityFx } from './cityBus';
import { useLabelLayer } from './labelLayer';
import { VAULT_POSITION } from './layout';
import { STATE_COLORS } from './materials';

const CALL = new THREE.Color(STATE_COLORS.call);
const PUT = new THREE.Color(STATE_COLORS.put);
const FLAT = new THREE.Color(STATE_COLORS.neutral);
const OFF = new THREE.Color(STATE_COLORS.halted);
const PAPER = new THREE.Color('#7aa2d6');
const LIVE = new THREE.Color('#ff3b30');

/**
 * The account vault (spec §84) at the front of the plaza. Every number on it
 * is broker-reported; when the account is unavailable it says so instead of
 * showing a stale balance. The emblem carries the environment: blue for
 * PAPER, red for LIVE.
 */
export function Vault({ activity }: { activity: number }) {
  const labels = useLabelLayer();
  const account = useStore((s) => s.account);
  const env = useStore((s) => s.system?.env ?? 'paper');
  const venue = useStore((s) => s.system?.venue);
  const openDrawer = useStore((s) => s.openDrawer);
  const available = !!account?.available && account.equity !== null;
  const dayPnl = available ? account!.dayPnl : null;
  const dayPct = available ? account!.dayPnlPct : null;

  const mats = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({ color: '#0c131e', roughness: 0.3, metalness: 0.85 }),
      base: new THREE.MeshStandardMaterial({ color: '#101824', roughness: 0.55, metalness: 0.7 }),
      band: new THREE.MeshBasicMaterial({ color: FLAT.clone(), toneMapped: false }),
      rib: new THREE.MeshBasicMaterial({ color: FLAT.clone(), toneMapped: false }),
      emblem: new THREE.MeshStandardMaterial({ color: '#0b0f16', emissive: PAPER.clone(), emissiveIntensity: 1.8, roughness: 0.3, metalness: 0.6 }),
      halo: new THREE.MeshBasicMaterial({ color: PAPER.clone(), toneMapped: false, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  const emblem = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const goal = useMemo(() => new THREE.Color(), []);
  // A burst of coins reaching the vault makes the emblem flare as they land (they take about a second).
  const landings = useRef<number[]>([]);
  const flare = useRef(0);
  useEffect(
    () =>
      onCityFx((fx) => {
        if (fx.event.kind === 'PROFIT_LOCKED') landings.current.push(performance.now() + 900);
      }),
    [],
  );

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const k = 1 - Math.exp(-dt * 3);
    const base = !available ? OFF : dayPnl === null || dayPnl === 0 ? FLAT : dayPnl > 0 ? CALL : PUT;
    const strength = available ? (1.1 + Math.min(1.6, Math.abs(dayPct ?? 0) * 0.8)) * (0.6 + 0.4 * activity) : 0.5;
    goal.copy(base).multiplyScalar(strength);
    mats.band.color.lerp(goal, k);
    mats.rib.color.lerp(goal, k);
    const envColor = env === 'live' ? LIVE : PAPER;
    mats.emblem.emissive.lerp(envColor, k);
    mats.halo.color.lerp(envColor, k);
    const nowMs = performance.now();
    while (landings.current.length && landings.current[0]! <= nowMs) {
      landings.current.shift();
      flare.current = 1;
    }
    flare.current = Math.max(0, flare.current - dt * 1.4);
    mats.emblem.emissiveIntensity = 1.8 + flare.current * 4;
    if (emblem.current) {
      emblem.current.scale.setScalar(1 + flare.current * 0.35);
      emblem.current.rotation.y = t * 0.5;
      emblem.current.position.y = 3.25 + Math.sin(t * 0.9) * 0.08;
    }
    if (halo.current) halo.current.rotation.z = -t * 0.3;
  });

  const ribs = Array.from({ length: 8 }, (_, i) => (i / 8) * Math.PI * 2 + Math.PI / 8);
  return (
    <group position={VAULT_POSITION}>
      <mesh position={[0, 0.15, 0]} material={mats.base}>
        <cylinderGeometry args={[2.7, 2.85, 0.3, 8]} />
      </mesh>
      <mesh position={[0, 0.3 + 1.0, 0]} material={mats.body}>
        <cylinderGeometry args={[1.95, 2.25, 2.0, 8]} />
      </mesh>
      {/* P&L rim: green up on the day, red down, blue flat, grey when the account is unavailable */}
      <mesh position={[0, 2.31, 0]} material={mats.band}>
        <cylinderGeometry args={[1.97, 1.97, 0.05, 8, 1, true]} />
      </mesh>
      <mesh position={[0, 0.34, 0]} material={mats.band}>
        <cylinderGeometry args={[2.29, 2.29, 0.04, 8, 1, true]} />
      </mesh>
      {ribs.map((a) => (
        <mesh key={a} position={[Math.sin(a) * 2.11, 1.3, Math.cos(a) * 2.11]} rotation={[0, a, 0.0]} material={mats.rib}>
          <boxGeometry args={[0.035, 1.9, 0.035]} />
        </mesh>
      ))}
      <mesh ref={emblem} position={[0, 3.25, 0]} material={mats.emblem}>
        <octahedronGeometry args={[0.45, 0]} />
      </mesh>
      <mesh ref={halo} position={[0, 2.36, 0]} rotation={[-Math.PI / 2, 0, 0]} material={mats.halo}>
        <ringGeometry args={[0.7, 0.76, 64, 1, 0, Math.PI * 1.6]} />
      </mesh>
      <Html portal={labels} position={[0, 4.25, 0]} center zIndexRange={[4, 0]} style={{ pointerEvents: 'none' }}>
        <button
          type="button"
          onClick={() => openDrawer('account')}
          className="pointer-events-auto block cursor-pointer select-none whitespace-nowrap border border-line-2 bg-ink-950/85 px-2.5 py-1 text-center backdrop-blur-[2px] hover:bg-ink-900/95"
          aria-label="Open account"
        >
          <div className="flex items-center justify-center gap-1.5">
            <span className="label-strong text-[8.5px] text-fg-2">VAULT</span>
            <span className={cx('label-strong px-1 text-[8px]', env === 'live' ? 'bg-live text-white' : 'border border-dashed border-paper text-paper')}>{envLabel(env, venue)}</span>
          </div>
          {available ? (
            <>
              <div className="num text-[13px] leading-tight text-fg">{money(account!.equity)}</div>
              <div className={cx('num text-[10px] leading-tight', pnlClass(dayPnl))}>
                {money(dayPnl, { sign: true })} · {pct(dayPct, { sign: true })}
              </div>
            </>
          ) : (
            <div className="label-strong mt-0.5 text-[9.5px] !text-pending">ACCOUNT UNAVAILABLE</div>
          )}
        </button>
      </Html>
    </group>
  );
}
