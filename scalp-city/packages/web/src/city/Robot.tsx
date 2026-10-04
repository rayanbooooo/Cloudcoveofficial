import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { TowerState } from '@scalp-city/shared';

export type RobotMood = 'WATCHING' | 'ANALYZING' | 'CHARGING' | 'TRADING' | 'PROFIT' | 'STANDING_DOWN' | 'HALTED';

export function moodFor(state: TowerState): RobotMood {
  switch (state) {
    case 'SETUP_FORMING':
      return 'ANALYZING';
    case 'CHARGING':
    case 'READY':
      return 'CHARGING';
    case 'ORDER_PENDING':
    case 'IN_TRADE':
      return 'TRADING';
    case 'PROFIT':
      return 'PROFIT';
    case 'STANDING_DOWN':
    case 'LOSS':
      return 'STANDING_DOWN';
    case 'HALTED':
      return 'HALTED';
    default:
      return 'WATCHING';
  }
}

/**
 * A trading worker at its desk (spec §82). Pure primitives — no external
 * assets. Its animation is a function of the worker's real state only.
 */
export function Robot({ mood, color, scale = 1 }: { mood: RobotMood; color: string; scale?: number }) {
  const root = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Mesh>(null);
  const armR = useRef<THREE.Mesh>(null);
  const visorMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#000', emissive: new THREE.Color(color), emissiveIntensity: 2 }), [color]);
  const shell = useMemo(() => new THREE.MeshStandardMaterial({ color: '#c9d3e0', roughness: 0.35, metalness: 0.6 }), []);
  const dark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#1a2230', roughness: 0.6, metalness: 0.4 }), []);
  const screenMat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#05080d', emissive: new THREE.Color(color), emissiveIntensity: 0.5 }), [color]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (!root.current || !head.current || !armL.current || !armR.current) return;
    visorMat.emissive.set(color);
    let headYaw = 0;
    let bob = 0;
    let arm = 0;
    let visor = 1.6;
    let slump = 0;
    switch (mood) {
      case 'WATCHING':
        headYaw = Math.sin(t * 0.5) * 0.6;
        visor = 1.2;
        break;
      case 'ANALYZING':
        headYaw = Math.sin(t * 1.3) * 0.35;
        visor = 1.8 + Math.sin(t * 6) * 0.3;
        arm = Math.sin(t * 3) * 0.15;
        break;
      case 'CHARGING':
        headYaw = Math.sin(t * 0.8) * 0.15;
        visor = 2.4 + Math.sin(t * 9) * 0.6;
        arm = 0.3 + Math.sin(t * 5) * 0.1;
        break;
      case 'TRADING':
        headYaw = -0.1;
        visor = 2.6;
        arm = Math.abs(Math.sin(t * 14)) * 0.35;
        break;
      case 'PROFIT':
        bob = Math.abs(Math.sin(t * 6)) * 0.12;
        arm = 1.2 + Math.sin(t * 6) * 0.2;
        visor = 3;
        break;
      case 'STANDING_DOWN':
        headYaw = 0.2;
        visor = 0.5;
        slump = 0.1;
        break;
      case 'HALTED':
        visor = Math.sin(t * 3) > 0 ? 2.5 : 0.2;
        slump = 0.35;
        break;
    }
    head.current.rotation.y += (headYaw - head.current.rotation.y) * 0.08;
    head.current.rotation.x += (slump - head.current.rotation.x) * 0.08;
    root.current.position.y = bob;
    armL.current.rotation.x = -0.6 - arm;
    armR.current.rotation.x = -0.6 - (mood === 'TRADING' ? Math.abs(Math.sin(t * 14 + 1.5)) * 0.35 : arm);
    visorMat.emissiveIntensity += (visor - visorMat.emissiveIntensity) * 0.15;
  });

  return (
    <group scale={scale}>
      {/* desk with monitors */}
      <mesh position={[0, 0.32, 0.38]} material={dark}>
        <boxGeometry args={[0.95, 0.06, 0.4]} />
      </mesh>
      <mesh position={[-0.22, 0.55, 0.52]} rotation={[-0.15, 0.25, 0]} material={screenMat}>
        <boxGeometry args={[0.36, 0.24, 0.02]} />
      </mesh>
      <mesh position={[0.22, 0.55, 0.52]} rotation={[-0.15, -0.25, 0]} material={screenMat}>
        <boxGeometry args={[0.36, 0.24, 0.02]} />
      </mesh>
      <group ref={root}>
        {/* body */}
        <mesh position={[0, 0.42, 0]} material={shell}>
          <boxGeometry args={[0.34, 0.4, 0.24]} />
        </mesh>
        <mesh position={[0, 0.22, 0]} material={dark}>
          <cylinderGeometry args={[0.1, 0.14, 0.12, 12]} />
        </mesh>
        {/* head */}
        <group ref={head} position={[0, 0.75, 0]}>
          <mesh material={shell}>
            <boxGeometry args={[0.3, 0.22, 0.24]} />
          </mesh>
          <mesh position={[0, 0.01, 0.125]} material={visorMat}>
            <boxGeometry args={[0.24, 0.06, 0.01]} />
          </mesh>
          <mesh position={[0, 0.16, 0]} material={dark}>
            <cylinderGeometry args={[0.008, 0.008, 0.1, 6]} />
          </mesh>
          <mesh position={[0, 0.22, 0]} material={visorMat}>
            <sphereGeometry args={[0.022, 10, 10]} />
          </mesh>
        </group>
        {/* arms */}
        <mesh ref={armL} position={[-0.22, 0.52, 0.06]} material={dark}>
          <boxGeometry args={[0.07, 0.07, 0.34]} />
        </mesh>
        <mesh ref={armR} position={[0.22, 0.52, 0.06]} material={dark}>
          <boxGeometry args={[0.07, 0.07, 0.34]} />
        </mesh>
      </group>
    </group>
  );
}
