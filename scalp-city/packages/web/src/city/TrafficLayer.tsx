import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore } from '../store/store';
import { actors } from './actors';
import { onCityFx } from './cityBus';
import { useCityUi } from './cityUi';
import { useLabelLayer } from './labelLayer';
import { createStreets } from './Streets';
import { MAX_EVENT_VEHICLES, TrafficSim, type SimMode } from './traffic';
import { VehicleRig } from './VehicleRig';

const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What the real system says the city should be doing, as a flow (0 = standing still) and a mode. */
function systemFlow(): { target: number; mode: SimMode } {
  const s = useStore.getState().system;
  if (s?.controls.killSwitch.active) return { target: 0, mode: 'halt' };
  if (s?.marketData.stock.state !== 'CONNECTED') return { target: 0, mode: 'frozen' };
  if (reducedMotion) return { target: 0, mode: 'run' };
  return s.market.isOpen ? { target: 1, mode: 'run' } : { target: 0.55, mode: 'night' };
}

/**
 * Cars, buses and trucks on the plaza boulevard and the grid roads, obeying traffic lights, with street
 * lamps. The city runs at full pace while the market is open and the feed is live, slows to night traffic
 * while the market is closed, and stands still (hazards on) without market data or after the kill
 * switch. Event vehicles join the boulevard for broker-confirmed events only.
 */
export function TrafficLayer({ lowPower }: { lowPower: boolean }) {
  const enabled = useCityUi((s) => s.options.traffic);
  const sim = useMemo(() => new TrafficSim({ density: lowPower ? 0.4 : 1 }), [lowPower]);
  const rig = useMemo(() => new VehicleRig(sim, !lowPower), [sim, lowPower]);
  const streets = useMemo(() => createStreets(sim, !lowPower), [sim, lowPower]);
  useEffect(
    () => () => {
      rig.dispose();
      streets.dispose();
    },
    [rig, streets],
  );
  const flow = useRef(0.5);
  const [tagged, setTagged] = useState('');

  useEffect(
    () =>
      onCityFx((fx) => {
        if (!useCityUi.getState().options.traffic || sim.mode === 'frozen' || sim.mode === 'halt') return;
        const tag = { text: fx.title, sub: fx.sub, color: fx.color, workerId: fx.event.workerId };
        switch (fx.event.kind) {
          case 'ORDER_FILLED':
            // Keep one slot free for the more important arrivals.
            if (MAX_EVENT_VEHICLES - sim.eventVehicles > 1) sim.requestEvent('courier', tag);
            break;
          case 'PROFIT_LOCKED':
            sim.requestEvent('armored', tag);
            break;
          case 'POSITION_CLOSED':
            sim.requestEvent('tow', tag);
            break;
          case 'ORDER_REJECTED':
            sim.requestEvent('police', tag);
            break;
        }
      }),
    [sim],
  );

  useFrame((_, dt) => {
    rig.group.visible = enabled;
    if (!enabled) return;
    const { target, mode } = systemFlow();
    flow.current += (target - flow.current) * (1 - Math.exp(-dt * 1.2));
    sim.mode = mode;
    sim.step(Math.min(dt, 0.05), flow.current, mode === 'halt');
    const hazard = mode === 'halt' || mode === 'frozen';
    rig.update(hazard);
    streets.update();
    if (rig.taggedKey !== tagged) setTagged(rig.taggedKey);
  });

  const ids = tagged.split(',').filter(Boolean);
  return (
    <>
      <primitive object={streets.group} />
      <primitive object={rig.group} />
      {enabled && ids.map((id) => <TagLabel key={id} actorId={`v${id}`} />)}
    </>
  );
}

/** What an event vehicle is about, floating over it. The text comes from the real event. */
function TagLabel({ actorId }: { actorId: string }) {
  const labels = useLabelLayer();
  const group = useRef<THREE.Group>(null);
  const actor = actors.get(actorId);
  useFrame(() => {
    const a = actors.get(actorId);
    const g = group.current;
    if (!g) return;
    g.visible = !!a;
    if (a) g.position.set(a.x, a.y + a.top + 0.55, a.z);
  });
  if (!actor?.tag) return null;
  return (
    <group ref={group} position={[actor.x, actor.y + actor.top + 0.55, actor.z]}>
      <Html portal={labels} center zIndexRange={[5, 0]} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap text-center" style={{ color: actor.tag.color, textShadow: '0 0 10px rgba(0,0,0,0.95)' }}>
          <div className="num text-[10.5px] font-semibold leading-tight">{actor.tag.text}</div>
          {actor.tag.sub && <div className="num text-[9px] leading-tight text-fg-2">{actor.tag.sub}</div>}
        </div>
      </Html>
    </group>
  );
}
