import { Grid } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { backdrop, mulberry32, PLAZA_RADIUS, ROADS_X, ROADS_Z } from './layout';
import { createSkyMaterial, createWindowMaterial } from './materials';

/** Skyline around the plaza. Decorative only: it carries no trading state. */
export function Skyline({ count, activity }: { count: number; activity: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const buildings = useMemo(() => backdrop(count), [count]);
  const material = useMemo(() => createWindowMaterial({ base: '#080d16', lit: '#7f9cc9', density: 0.2, seed: 3 }), []);
  const geometry = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 1);
    g.translate(0, 0.5, 0);
    return g;
  }, []);
  useEffect(() => () => (material.dispose(), geometry.dispose()), [material, geometry]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    buildings.forEach((b, i) => {
      m.compose(new THREE.Vector3(b.x, 0, b.z), new THREE.Quaternion(), new THREE.Vector3(b.w, b.h, b.d));
      mesh.setMatrixAt(i, m);
    });
    mesh.count = buildings.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [buildings]);
  useFrame(({ clock }, dt) => {
    const u = material.userData.uniforms as { uDensity: { value: number }; uTime: { value: number } };
    u.uDensity.value += (0.24 * activity - u.uDensity.value) * (1 - Math.exp(-dt * 2));
    u.uTime.value = clock.elapsedTime;
  });
  return <instancedMesh ref={ref} args={[geometry, material, count]} frustumCulled={false} />;
}

/** Ground, roads and the plaza the towers stand on. */
export function Ground() {
  const roadMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#0a0f17', roughness: 0.9, metalness: 0.1 }), []);
  const lineMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#1d3354', toneMapped: false }), []);
  useEffect(() => () => (roadMat.dispose(), lineMat.dispose()), [roadMat, lineMat]);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[240, 240]} />
        <meshStandardMaterial color="#04070c" roughness={0.95} metalness={0.05} />
      </mesh>
      <Grid
        position={[0, 0.001, 0]}
        args={[200, 200]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#0d1828"
        sectionSize={6}
        sectionThickness={0.9}
        sectionColor="#14243c"
        fadeDistance={70}
        fadeStrength={1.4}
        infiniteGrid
      />
      {ROADS_X.map((x) => (
        <group key={`x${x}`}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.004, 0]} material={roadMat}>
            <planeGeometry args={[2.6, 120]} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.006, 0]} material={lineMat}>
            <planeGeometry args={[0.04, 120]} />
          </mesh>
        </group>
      ))}
      {ROADS_Z.map((z) => (
        <group key={`z${z}`}>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, z]} material={roadMat}>
            <planeGeometry args={[120, 2.6]} />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.007, z]} material={lineMat}>
            <planeGeometry args={[120, 0.04]} />
          </mesh>
        </group>
      ))}
      {/* plaza */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.008, 1]}>
        <circleGeometry args={[PLAZA_RADIUS, 96]} />
        <meshStandardMaterial color="#070c14" roughness={0.6} metalness={0.4} />
      </mesh>
      {[PLAZA_RADIUS, PLAZA_RADIUS - 0.35, 4.2].map((r, i) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 1]}>
          <ringGeometry args={[r - (i === 0 ? 0.06 : 0.025), r, 128]} />
          <meshBasicMaterial color={i === 0 ? '#2a4c80' : '#16294a'} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

interface Lane {
  axis: 'x' | 'z';
  at: number;
  dir: 1 | -1;
  /** Travel range along the lane; lanes stay behind/beside the plaza so lights never sit under the UI. */
  from: number;
  to: number;
}

const FAR = -55;
const NEAR_LIMIT = 8;

/**
 * Traffic moves only while the regular session is open and the stock feed
 * is connected (spec §85): a still city means a closed or unfed market.
 */
export function Traffic({ enabled, count }: { enabled: boolean; count: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const cars = useMemo(() => {
    const rnd = mulberry32(42);
    const lanes: Lane[] = [];
    for (const x of ROADS_X) lanes.push({ axis: 'z', at: x - 0.5, dir: 1, from: FAR, to: NEAR_LIMIT }, { axis: 'z', at: x + 0.5, dir: -1, from: FAR, to: NEAR_LIMIT });
    for (const z of ROADS_Z.filter((rz) => rz < 0)) lanes.push({ axis: 'x', at: z - 0.5, dir: -1, from: -55, to: 55 }, { axis: 'x', at: z + 0.5, dir: 1, from: -55, to: 55 });
    return Array.from({ length: count }, (_, i) => ({ lane: lanes[i % lanes.length]!, offset: rnd(), speed: 4 + rnd() * 5 }));
  }, [count]);
  const geometry = useMemo(() => new THREE.BoxGeometry(0.3, 0.05, 0.1), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), []);
  useEffect(() => () => (geometry.dispose(), material.dispose()), [geometry, material]);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const head = new THREE.Color('#fff1d6').multiplyScalar(1.6);
    const tail = new THREE.Color('#ff3348').multiplyScalar(1.4);
    cars.forEach((c, i) => mesh.setColorAt(i, c.lane.dir === 1 ? head : tail));
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [cars]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const mesh = ref.current;
    if (!mesh || !enabled) return;
    const t = clock.elapsedTime;
    cars.forEach((c, i) => {
      const span = c.lane.to - c.lane.from;
      const along = c.lane.from + ((((c.offset * span + t * c.speed * c.lane.dir) % span) + span) % span);
      if (c.lane.axis === 'z') {
        tmp.position.set(c.lane.at, 0.05, along);
        tmp.rotation.set(0, Math.PI / 2, 0);
      } else {
        tmp.position.set(along, 0.05, c.lane.at);
        tmp.rotation.set(0, 0, 0);
      }
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={ref} args={[geometry, material, count]} visible={enabled} frustumCulled={false} />;
}

/** Sky dome. The horizon turns red while the kill switch is engaged. */
export function Sky({ alert }: { alert: number }) {
  const material = useMemo(() => createSkyMaterial(), []);
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ clock }, dt) => {
    material.uniforms.uTime!.value = clock.elapsedTime;
    material.uniforms.uAlert!.value += (alert - material.uniforms.uAlert!.value) * (1 - Math.exp(-dt * 3));
  });
  return (
    <mesh material={material} renderOrder={-1}>
      <sphereGeometry args={[140, 32, 16]} />
    </mesh>
  );
}
