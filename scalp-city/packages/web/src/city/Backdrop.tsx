import { Grid } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { backdrop, PLAZA_CENTER, PLAZA_RADIUS, RING, ROADS_X, ROADS_Z } from './layout';
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
  const edgeMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#2a4c80', toneMapped: false }), []);
  useEffect(() => () => (roadMat.dispose(), lineMat.dispose(), edgeMat.dispose()), [roadMat, lineMat, edgeMat]);
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
      {/* the boulevard that circles the plaza: one lane each way, with a glowing edge and centre line */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[PLAZA_CENTER.x, 0.014, PLAZA_CENTER.z]} material={roadMat}>
        <ringGeometry args={[RING.edgeIn, RING.edgeOut, 160]} />
      </mesh>
      {[RING.edgeIn, RING.edgeOut, (RING.inner + RING.outer) / 2].map((r, i) => (
        <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[PLAZA_CENTER.x, 0.016, PLAZA_CENTER.z]} material={i < 2 ? edgeMat : lineMat}>
          <ringGeometry args={[r - (i < 2 ? 0.022 : 0.016), r + (i < 2 ? 0 : 0.016), 160]} />
        </mesh>
      ))}
    </group>
  );
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
