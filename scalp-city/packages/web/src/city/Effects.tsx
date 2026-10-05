import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { instrumentName, isOandaSymbol, parseOccSymbol, type CityEvent } from '@scalp-city/shared';
import { money, px, qtyStr } from '../lib/format';
import { serverNow, useStore } from '../store/store';
import { useLabelLayer } from './labelLayer';
import { VAULT_POSITION, type Vec3 } from './layout';
import { createBeamMaterial, createPulseMaterial, STATE_COLORS } from './materials';

export interface Anchor {
  position: Vec3;
  top: number;
}

interface Fx {
  key: string;
  kind: 'pulse' | 'column' | 'label';
  pos: Vec3;
  top: number;
  color: string;
  born: number;
  dur: number;
  text?: string;
  sub?: string;
}

/** Events older than this happened while the city was not on screen; replaying them would misreport time. */
const MAX_EVENT_AGE_MS = 8000;

function instrument(ev: CityEvent): string {
  const o = parseOccSymbol(ev.symbol);
  if (!o) return isOandaSymbol(ev.symbol) ? instrumentName(ev.symbol) : ev.symbol;
  return `${o.root} ${o.strike}${o.type === 'call' ? 'C' : 'P'}`;
}

function eventColor(ev: CityEvent): string {
  switch (ev.kind) {
    case 'ORDER_SUBMITTED':
      return STATE_COLORS.pending;
    case 'ORDER_REJECTED':
    case 'KILL_SWITCH':
      return STATE_COLORS.error;
    case 'PROFIT_LOCKED':
      return STATE_COLORS.call;
    case 'POSITION_CLOSED':
      return ev.pnl === null ? STATE_COLORS.neutral : ev.pnl >= 0 ? STATE_COLORS.call : STATE_COLORS.put;
    case 'ORDER_FILLED':
      return ev.direction === 'PUT' ? STATE_COLORS.put : ev.direction === 'CALL' ? STATE_COLORS.call : STATE_COLORS.neutral;
  }
}

/**
 * Broker-confirmed events made visible (spec §86). Effects are spawned only
 * from server `city.event` messages, which the server emits after the broker
 * confirms a submission, fill or close — never from local guesses.
 */
export function Effects({ anchors, onKill }: { anchors: Map<string, Anchor>; onKill: () => void }) {
  const [fx, setFx] = useState<Fx[]>([]);
  const seq = useRef(0);
  useFrame(({ clock }) => {
    if (!useStore.getState().cityEvents.length) return;
    const events = useStore.getState().consumeCityEvents();
    const now = serverNow();
    const born = clock.elapsedTime;
    const add: Fx[] = [];
    for (const ev of events) {
      if (now - ev.ts > MAX_EVENT_AGE_MS) continue;
      if (ev.kind === 'KILL_SWITCH') {
        onKill();
        continue;
      }
      const a = (ev.workerId && anchors.get(ev.workerId)) || { position: VAULT_POSITION, top: 9.6 };
      const color = eventColor(ev);
      const k = () => `${ev.id}:${seq.current++}`;
      add.push({ key: k(), kind: 'pulse', pos: a.position, top: a.top, color, born, dur: 1.8 });
      if (ev.kind !== 'ORDER_SUBMITTED') add.push({ key: k(), kind: 'column', pos: a.position, top: a.top, color, born, dur: 1.2 });
      const what = `${qtyStr(ev.qty)} × ${instrument(ev)}`;
      switch (ev.kind) {
        case 'ORDER_SUBMITTED':
          add.push({ key: k(), kind: 'label', pos: a.position, top: a.top, color, born, dur: 2.6, text: 'SUBMITTED', sub: what });
          break;
        case 'ORDER_FILLED':
          add.push({ key: k(), kind: 'label', pos: a.position, top: a.top, color, born, dur: 3.2, text: `FILLED @ ${px(ev.symbol, ev.price)}`, sub: what });
          break;
        case 'ORDER_REJECTED':
          add.push({ key: k(), kind: 'label', pos: a.position, top: a.top, color, born, dur: 3.2, text: 'REJECTED', sub: what });
          break;
        case 'PROFIT_LOCKED':
        case 'POSITION_CLOSED':
          add.push({ key: k(), kind: 'label', pos: a.position, top: a.top, color, born, dur: 4, text: ev.pnl === null ? 'CLOSED' : money(ev.pnl, { sign: true }), sub: what });
          break;
      }
    }
    if (add.length) setFx((f) => [...f, ...add].slice(-40));
  });
  const done = (key: string) => setFx((f) => f.filter((x) => x.key !== key));
  return (
    <>
      {fx.map((f) =>
        f.kind === 'pulse' ? (
          <Pulse key={f.key} fx={f} onDone={done} />
        ) : f.kind === 'column' ? (
          <Column key={f.key} fx={f} onDone={done} />
        ) : (
          <FloatingLabel key={f.key} fx={f} onDone={done} />
        ),
      )}
    </>
  );
}

function Pulse({ fx, onDone }: { fx: Fx; onDone: (k: string) => void }) {
  const material = useMemo(() => createPulseMaterial(fx.color), [fx.color]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }) => {
    const p = (clock.elapsedTime - fx.born) / fx.dur;
    material.uniforms.uProgress!.value = Math.min(1, Math.max(0, p));
    if (p >= 1) onDone(fx.key);
  });
  return (
    <mesh position={[fx.pos[0], 0.05, fx.pos[2]]} rotation={[-Math.PI / 2, 0, 0]} material={material}>
      <planeGeometry args={[9, 9]} />
    </mesh>
  );
}

function Column({ fx, onDone }: { fx: Fx; onDone: (k: string) => void }) {
  const material = useMemo(() => createBeamMaterial(fx.color), [fx.color]);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }) => {
    const p = (clock.elapsedTime - fx.born) / fx.dur;
    material.uniforms.uIntensity!.value = p < 0.12 ? (p / 0.12) * 1.6 : Math.max(0, 1.6 * (1 - (p - 0.12) / 0.88));
    material.uniforms.uTime!.value = clock.elapsedTime;
    if (p >= 1) onDone(fx.key);
  });
  const h = fx.top + 6;
  return (
    <mesh position={[fx.pos[0], h / 2, fx.pos[2]]} material={material}>
      <cylinderGeometry args={[1.25, 1.25, h, 32, 1, true]} />
    </mesh>
  );
}

function FloatingLabel({ fx, onDone }: { fx: Fx; onDone: (k: string) => void }) {
  const labels = useLabelLayer();
  const group = useRef<THREE.Group>(null);
  const el = useRef<HTMLDivElement>(null);
  useFrame(({ clock }) => {
    const p = (clock.elapsedTime - fx.born) / fx.dur;
    if (group.current) group.current.position.y = fx.top + 3.6 + p * 2.2;
    if (el.current) el.current.style.opacity = String(p < 0.1 ? p / 0.1 : p > 0.7 ? Math.max(0, (1 - p) / 0.3) : 1);
    if (p >= 1) onDone(fx.key);
  });
  return (
    <group ref={group} position={[fx.pos[0], fx.top + 3.6, fx.pos[2]]}>
      <Html portal={labels} center zIndexRange={[6, 0]} style={{ pointerEvents: 'none' }}>
        <div ref={el} className="whitespace-nowrap text-center" style={{ opacity: 0, textShadow: '0 0 12px rgba(0,0,0,0.9)' }}>
          <div className="num text-[15px] font-semibold" style={{ color: fx.color }}>
            {fx.text}
          </div>
          {fx.sub && <div className="num text-[10px] text-fg-2">{fx.sub}</div>}
        </div>
      </Html>
    </group>
  );
}
