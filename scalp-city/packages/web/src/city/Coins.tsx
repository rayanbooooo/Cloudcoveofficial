import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { onCityFx } from './cityBus';
import { useCityUi } from './cityUi';
import { VAULT_POSITION, type Vec3 } from './layout';

/**
 * Coins that arc from a tower to the vault when a position closes in profit, and a few red chips the other
 * way when it closes at a loss. They are spawned only by broker-confirmed close events, and their number is
 * fixed: it does not stand for the size of the result (that is printed on the tower's label).
 */

const MAX = 96;
const PER_BURST = 12;
const VAULT_TOP = 3.3;

interface Coin {
  t0: number;
  dur: number;
  from: Vec3;
  to: Vec3;
  lift: number;
  spin: number;
  hue: 'gold' | 'red';
}

const GOLD = new THREE.Color(2.6, 1.9, 0.35);
const RED = new THREE.Color(2.8, 0.3, 0.42);
const now = () => performance.now() / 1000;

export function Coins({ lowPower }: { lowPower: boolean }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const coins = useRef<Coin[]>([]);
  const geometry = useMemo(() => new THREE.CylinderGeometry(0.13, 0.13, 0.035, 12), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  useEffect(() => () => (geometry.dispose(), material.dispose()), [geometry, material]);

  useEffect(
    () =>
      onCityFx((fx) => {
        if (!useCityUi.getState().options.traffic) return;
        const k = fx.event.kind;
        if (k !== 'PROFIT_LOCKED' && k !== 'POSITION_CLOSED') return;
        if (coins.current.length > MAX - PER_BURST) return;
        const gold = k === 'PROFIT_LOCKED';
        const tower: Vec3 = [fx.anchor.position[0], fx.anchor.top, fx.anchor.position[2]];
        const vault: Vec3 = [VAULT_POSITION[0], VAULT_TOP, VAULT_POSITION[2]];
        const n = lowPower ? PER_BURST / 2 : PER_BURST;
        const t = now();
        for (let i = 0; i < n; i++) {
          coins.current.push({
            t0: t + Math.random() * 0.55,
            dur: 1 + Math.random() * 0.5,
            // Profit flows from the tower into the vault; a loss leaves the vault for the tower.
            from: gold ? tower : vault,
            to: gold ? vault : tower,
            lift: 2 + Math.random() * 2.5,
            spin: 6 + Math.random() * 8,
            hue: gold ? 'gold' : 'red',
          });
        }
      }),
    [lowPower],
  );

  const tmp = useMemo(() => new THREE.Object3D(), []);
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const t = now();
    const list = coins.current;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) if (t > list[i]!.t0 + list[i]!.dur) list.splice(i, 1);
    for (const c of list) {
      const p = (t - c.t0) / c.dur;
      if (p < 0) continue;
      tmp.position.set(c.from[0] + (c.to[0] - c.from[0]) * p, c.from[1] + (c.to[1] - c.from[1]) * p + 4 * c.lift * p * (1 - p), c.from[2] + (c.to[2] - c.from[2]) * p);
      tmp.rotation.set(c.spin * p, c.spin * 0.6 * p, 0);
      tmp.scale.setScalar(Math.min(1, p * 8, (1 - p) * 8 + 0.2));
      tmp.updateMatrix();
      m.setMatrixAt(n, tmp.matrix);
      m.setColorAt(n, c.hue === 'gold' ? GOLD : RED);
      n++;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[geometry, material, MAX]} count={0} frustumCulled={false} />;
}
