import { RoundedBox } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { TowerState } from '@scalp-city/shared';

/** What the robot is doing, derived only from the worker's real tower state. */
export type StagePhase = 'WATCHING' | 'ANALYZING' | 'CHARGING' | 'READY' | 'ORDERING' | 'HOLDING' | 'PROFIT' | 'LOSS' | 'STANDING_DOWN' | 'HALTED';

export function phaseOf(state: TowerState): StagePhase {
  switch (state) {
    case 'SETUP_FORMING':
      return 'ANALYZING';
    case 'CHARGING':
      return 'CHARGING';
    case 'READY':
      return 'READY';
    case 'ORDER_PENDING':
      return 'ORDERING';
    case 'IN_TRADE':
      return 'HOLDING';
    case 'PROFIT':
      return 'PROFIT';
    case 'LOSS':
      return 'LOSS';
    case 'STANDING_DOWN':
      return 'STANDING_DOWN';
    case 'HALTED':
      return 'HALTED';
    default:
      return 'WATCHING';
  }
}

/** Robot-local frame: y up, the robot faces −z (toward the monitors). Units are metres. */
const SHOULDER_L = new THREE.Vector3(-0.27, 1.1, 0.04);
const SHOULDER_R = new THREE.Vector3(0.27, 1.1, 0.04);
const PIVOT = new THREE.Vector3(0, 0.6, 0.1);
const KB_Y = 0.815;
const KB_Z = -0.33;
const L1 = 0.28;
const L2 = 0.27;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

interface Pose {
  lean: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
  left: THREE.Vector3;
  right: THREE.Vector3;
  leftTilt: number;
  rightTilt: number;
  /** 0 closed … 1 open */
  eyes: number;
  glow: number;
  core: number;
  bob: number;
  typeL: number;
  typeR: number;
  /** Chair rotation about its column (rad). Negative turns the robot toward the viewer. */
  swivel: number;
}

const newPose = (): Pose => ({
  lean: 0,
  headYaw: 0,
  headPitch: 0,
  headRoll: 0,
  left: new THREE.Vector3(-0.17, KB_Y, KB_Z),
  right: new THREE.Vector3(0.4, KB_Y, KB_Z),
  leftTilt: 0.1,
  rightTilt: 0.1,
  eyes: 1,
  glow: 1.5,
  core: 1,
  bob: 0,
  typeL: 0,
  typeR: 0,
  swivel: 0,
});

/** Chair angle that turns the robot to face the viewer (camera sits behind-right of the desk). */
const FACE_VIEWER = -2.2;

/** Where the robot wants to be this instant. Pure function of (phase, time, charge). */
function computePose(phase: StagePhase, t: number, charge: number, p: Pose): void {
  // defaults: hands resting on the keyboard / mouse
  p.lean = 0;
  p.headYaw = 0;
  p.headPitch = 0.02;
  p.headRoll = 0;
  p.left.set(-0.17, KB_Y, KB_Z);
  p.right.set(0.4 + Math.sin(t * 0.9) * 0.02, KB_Y, KB_Z + 0.02 + Math.cos(t * 0.7) * 0.015);
  p.leftTilt = 0.1;
  p.rightTilt = 0.1;
  p.eyes = 1;
  p.glow = 1.5;
  p.core = 1;
  p.bob = 0;
  p.typeL = 0;
  p.typeR = 0;
  p.swivel = 0;
  switch (phase) {
    case 'WATCHING': {
      // scans the screens, and now and then glances back over its shoulder at whoever is watching
      const cycle = t % 11;
      const peek = cycle > 7.2 && cycle < 8.9;
      p.headYaw = peek ? -2.35 : Math.sin(t * 0.45) * 0.5;
      p.headPitch = peek ? -0.05 : 0.02;
      p.glow = 1.3 + (peek ? 1.2 : 0);
      p.core = 0.8;
      break;
    }
    case 'ANALYZING': {
      const targets = [-0.6, 0.05, 0.6, 0.05];
      p.headYaw = targets[Math.floor(t * 1.1) % 4]!;
      p.glow = 1.9 + Math.sin(t * 6) * 0.3;
      p.core = 1.3;
      p.typeL = 1;
      p.left.x += Math.sin(t * 1.3) * 0.03;
      break;
    }
    case 'CHARGING':
      p.lean = 0.06 + 0.1 * charge;
      p.headYaw = Math.sin(t * 0.7) * 0.18;
      p.left.set(-0.17, KB_Y + 0.06, KB_Z);
      p.right.set(0.17, KB_Y + 0.06, KB_Z);
      p.leftTilt = p.rightTilt = 0.35;
      p.glow = 2.1 + charge * 1.2 + Math.sin(t * 9) * 0.3;
      p.core = 1.5 + charge * 2;
      p.typeL = p.typeR = 0.35;
      p.eyes = 0.85;
      break;
    case 'READY':
      p.lean = 0.15;
      p.headPitch = 0.06;
      p.left.set(-0.17, KB_Y + 0.09, KB_Z);
      p.right.set(0.17, KB_Y + 0.09, KB_Z);
      p.leftTilt = p.rightTilt = 0.5;
      p.glow = 3 + Math.sin(t * 7) * 0.6;
      p.core = 3.2;
      p.typeL = p.typeR = 0.6;
      p.eyes = 0.8;
      break;
    case 'ORDERING': {
      p.lean = 0.11;
      p.headPitch = 0.05;
      p.left.set(-0.17, KB_Y, KB_Z);
      // right hand hammers the enter key
      const hit = Math.max(0, Math.sin(t * 5.4));
      p.right.set(0.22, KB_Y + 0.06 - hit * 0.06, KB_Z + 0.02);
      p.leftTilt = p.rightTilt = 0.3;
      p.glow = 3.2;
      p.core = 3.4;
      p.typeL = 1.4;
      p.typeR = 0.6;
      break;
    }
    case 'HOLDING':
      p.lean = 0.03;
      // glances between the chart (left monitor) and the position screen (centre)
      p.headYaw = 0.28 + Math.sin(t * 0.5) * 0.32;
      p.headRoll = Math.sin(t * 0.37) * 0.03;
      // left hand to the chin: thinking
      p.left.set(-0.1, 1.27, -0.1 + Math.sin(t * 0.8) * 0.01);
      p.leftTilt = -0.4;
      p.glow = 2;
      p.core = 2;
      break;
    case 'PROFIT':
      p.swivel = FACE_VIEWER;
      p.bob = Math.abs(Math.sin(t * 6)) * 0.035;
      p.headPitch = -0.16;
      p.left.set(-0.4, 1.52 + Math.sin(t * 6) * 0.05, -0.02);
      p.right.set(0.4, 1.52 + Math.sin(t * 6 + 1.3) * 0.05, -0.02);
      p.leftTilt = p.rightTilt = 0;
      p.glow = 3.4;
      p.core = 3.6;
      break;
    case 'LOSS':
      p.lean = 0.1;
      p.headPitch = 0.4;
      p.left.set(-0.14, 0.74, -0.04);
      p.right.set(0.14, 0.74, -0.04);
      p.leftTilt = p.rightTilt = 0;
      p.glow = 0.7;
      p.core = 0.5;
      p.eyes = 0.45;
      break;
    case 'STANDING_DOWN':
      p.swivel = FACE_VIEWER * 0.8;
      p.lean = -0.04;
      p.headYaw = Math.sin(t * 0.25) * 0.2;
      p.headPitch = 0.14;
      p.left.set(-0.14, 0.74, -0.04);
      p.right.set(0.14, 0.74, -0.04);
      p.leftTilt = p.rightTilt = 0;
      p.glow = 0.45;
      p.core = 0.35;
      p.eyes = 0.3;
      break;
    case 'HALTED':
      p.swivel = FACE_VIEWER;
      p.headPitch = -0.02;
      p.left.set(-0.36, 1.26, -0.28);
      p.right.set(0.36, 1.26, -0.28);
      p.leftTilt = p.rightTilt = -1.2;
      p.glow = Math.sin(t * 8) > 0 ? 3.2 : 0.4;
      p.core = Math.sin(t * 8) > 0 ? 3 : 0.3;
      p.eyes = 1;
      break;
  }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpU = new THREE.Vector3();
const tmpP = new THREE.Vector3();

/** Two-bone IK in the shoulder→wrist plane; the elbow bends toward `pole`. Returns the (reach-clamped) wrist. */
function solveArm(S: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, wrist: THREE.Vector3, elbow: THREE.Vector3): void {
  tmpU.copy(target).sub(S);
  let d = tmpU.length();
  const max = L1 + L2 - 0.004;
  const min = Math.abs(L1 - L2) + 0.02;
  d = Math.min(max, Math.max(min, d));
  tmpU.normalize();
  wrist.copy(S).addScaledVector(tmpU, d);
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(L1 * L1 - a * a, 0));
  tmpP.copy(pole).addScaledVector(tmpU, -pole.dot(tmpU));
  if (tmpP.lengthSq() < 1e-6) tmpP.set(0, -1, 0);
  tmpP.normalize();
  elbow.copy(S).addScaledVector(tmpU, a).addScaledVector(tmpP, h);
}

function place(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  tmpA.copy(b).sub(a);
  const len = Math.max(tmpA.length(), 1e-4);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(Y_AXIS, tmpA.multiplyScalar(1 / len));
}

/** Rotate `p` about the X axis through `pivot` (lean: positive = leaning toward the desk, i.e. −z). */
function leanPoint(p: THREE.Vector3, pivot: THREE.Vector3, lean: number, out: THREE.Vector3): THREE.Vector3 {
  const a = -lean;
  const dy = p.y - pivot.y;
  const dz = p.z - pivot.z;
  return out.set(p.x, pivot.y + dy * Math.cos(a) - dz * Math.sin(a), pivot.z + dy * Math.sin(a) + dz * Math.cos(a));
}

export interface DeskRobotProps {
  phase: StagePhase;
  /** Direction/state accent (hex). */
  color: string;
  /** Confirmed signal charge, 0..1. */
  charge: number;
  reducedMotion?: boolean;
}

/**
 * A trading robot at its desk. Everything it does is chosen by `phase` and
 * `charge`, which come from the worker's real state: it watches when the
 * worker watches, hammers the keyboard while an order is out at the broker,
 * thinks while holding a position, and slumps when the worker is stood down.
 */
export function DeskRobot({ phase, color, charge, reducedMotion = false }: DeskRobotProps) {
  const root = useRef<THREE.Group>(null);
  const upper = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const eyeL = useRef<THREE.Mesh>(null);
  const eyeR = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Mesh>(null);
  const antenna = useRef<THREE.Mesh>(null);
  const upperArm = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)] as const;
  const foreArm = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)] as const;
  const elbowJoint = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)] as const;
  const shoulderJoint = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)] as const;
  const hand = [useRef<THREE.Group>(null), useRef<THREE.Group>(null)] as const;
  const fingers = useRef<THREE.Mesh[]>([]);
  const sparkles = useRef<THREE.Points>(null);

  const pose = useMemo(newPose, []);
  const cur = useMemo(
    () => ({
      lean: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      eyes: 1,
      glow: 1.5,
      core: 1,
      bob: 0,
      swivel: 0,
      left: new THREE.Vector3(-0.17, KB_Y, KB_Z),
      right: new THREE.Vector3(0.4, KB_Y, KB_Z),
      leftTilt: 0,
      rightTilt: 0,
    }),
    [],
  );
  const accent = useMemo(() => new THREE.Color(color), [color]);
  const accentNow = useMemo(() => new THREE.Color(color), [color]);

  const mats = useMemo(
    () => ({
      shell: new THREE.MeshStandardMaterial({ color: '#c8d2df', roughness: 0.32, metalness: 0.65 }),
      dark: new THREE.MeshStandardMaterial({ color: '#1b2431', roughness: 0.55, metalness: 0.5 }),
      joint: new THREE.MeshStandardMaterial({ color: '#0e141d', roughness: 0.5, metalness: 0.7 }),
      glass: new THREE.MeshStandardMaterial({ color: '#05080d', roughness: 0.08, metalness: 0.9 }),
      eye: new THREE.MeshBasicMaterial({ color: color, toneMapped: false }),
      core: new THREE.MeshBasicMaterial({ color: color, toneMapped: false }),
      chair: new THREE.MeshStandardMaterial({ color: '#141b26', roughness: 0.8, metalness: 0.2 }),
      sparkle: new THREE.PointsMaterial({ color: color, size: 0.055, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    }),
    // colours are lerped in useFrame; the materials are built once
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const sparkleGeo = useMemo(() => {
    const n = 40;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('seed', new THREE.BufferAttribute(Float32Array.from({ length: n }, (_, i) => ((i * 0.6180339887) % 1)), 1));
    return g;
  }, []);
  useEffect(() => () => sparkleGeo.dispose(), [sparkleGeo]);

  const limbGeo = useMemo(() => new THREE.CylinderGeometry(0.034, 0.03, 1, 12), []);
  const foreGeo = useMemo(() => new THREE.CylinderGeometry(0.03, 0.026, 1, 12), []);
  const jointGeo = useMemo(() => new THREE.SphereGeometry(0.045, 14, 12), []);
  useEffect(
    () => () => {
      limbGeo.dispose();
      foreGeo.dispose();
      jointGeo.dispose();
    },
    [limbGeo, foreGeo, jointGeo],
  );

  const targetL = useMemo(() => new THREE.Vector3(), []);
  const targetR = useMemo(() => new THREE.Vector3(), []);
  const sL = useMemo(() => new THREE.Vector3(), []);
  const sR = useMemo(() => new THREE.Vector3(), []);
  const eL = useMemo(() => new THREE.Vector3(), []);
  const eR = useMemo(() => new THREE.Vector3(), []);
  const wL = useMemo(() => new THREE.Vector3(), []);
  const wR = useMemo(() => new THREE.Vector3(), []);
  const poleL = useMemo(() => new THREE.Vector3(-0.55, -0.75, 0.45), []);
  const poleR = useMemo(() => new THREE.Vector3(0.55, -0.75, 0.45), []);

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    computePose(phase, reducedMotion ? 0 : t, charge, pose);
    const k = reducedMotion ? 1 : 1 - Math.exp(-dt * 5);
    const kh = reducedMotion ? 1 : 1 - Math.exp(-dt * 8);
    cur.lean += (pose.lean - cur.lean) * k;
    cur.yaw += (pose.headYaw - cur.yaw) * k;
    cur.pitch += (pose.headPitch - cur.pitch) * k;
    cur.roll += (pose.headRoll - cur.roll) * k;
    cur.eyes += (pose.eyes - cur.eyes) * kh;
    cur.glow += (pose.glow - cur.glow) * kh;
    cur.core += (pose.core - cur.core) * kh;
    cur.bob += (pose.bob - cur.bob) * kh;
    cur.swivel += (pose.swivel - cur.swivel) * (reducedMotion ? 1 : 1 - Math.exp(-dt * 2.6));
    cur.left.lerp(pose.left, k);
    cur.right.lerp(pose.right, k);
    cur.leftTilt += (pose.leftTilt - cur.leftTilt) * k;
    cur.rightTilt += (pose.rightTilt - cur.rightTilt) * k;
    accentNow.lerp(accent, kh);

    if (root.current) {
      root.current.position.y = cur.bob;
      root.current.rotation.y = cur.swivel;
    }
    if (upper.current) upper.current.rotation.x = -cur.lean;
    if (head.current) {
      head.current.rotation.set(-cur.pitch, cur.yaw, cur.roll, 'YXZ');
    }

    // typing: a key press is a short dip of the wrist, so each hand jitters at its own rate
    const type = (amount: number, w: number, phaseShift: number) => (amount > 0 && !reducedMotion ? Math.max(0, Math.sin(t * w + phaseShift)) * 0.014 * Math.min(amount, 1.2) : 0);
    targetL.copy(cur.left);
    targetL.y -= type(pose.typeL, 21, 0.4);
    targetL.x += pose.typeL > 0 && !reducedMotion ? Math.sin(t * 6.1) * 0.012 * Math.min(pose.typeL, 1) : 0;
    targetR.copy(cur.right);
    targetR.y -= type(pose.typeR, 25, 1.9);

    leanPoint(SHOULDER_L, PIVOT, cur.lean, sL);
    leanPoint(SHOULDER_R, PIVOT, cur.lean, sR);
    solveArm(sL, targetL, poleL, wL, eL);
    solveArm(sR, targetR, poleR, wR, eR);

    const sides = [
      [sL, eL, wL],
      [sR, eR, wR],
    ] as const;
    sides.forEach(([s, e, w], i) => {
      const ua = upperArm[i]?.current;
      const fa = foreArm[i]?.current;
      const ej = elbowJoint[i]?.current;
      const sj = shoulderJoint[i]?.current;
      const h = hand[i]?.current;
      if (ua) place(ua, s, e);
      if (fa) place(fa, e, w);
      if (ej) ej.position.copy(e);
      if (sj) sj.position.copy(s);
      if (h) {
        h.position.copy(w);
        h.rotation.x = i === 0 ? cur.leftTilt : cur.rightTilt;
      }
    });
    // fingers flutter while typing
    fingers.current.forEach((f, i) => {
      if (!f) return;
      const left = i < 4;
      const amt = left ? pose.typeL : pose.typeR;
      f.position.y = amt > 0 && !reducedMotion ? -Math.max(0, Math.sin(t * (left ? 21 : 25) + i * 1.7)) * 0.01 * Math.min(amt, 1.2) : 0;
    });

    // eyes: blink every few seconds, narrow when tired / focused
    const blink = !reducedMotion && (t % 3.7) < 0.12 ? 0.1 : 1;
    const eyeScale = Math.max(0.08, Math.min(1, cur.eyes) * blink);
    if (eyeL.current) eyeL.current.scale.y = eyeScale;
    if (eyeR.current) eyeR.current.scale.y = eyeScale;
    mats.eye.color.copy(accentNow).multiplyScalar(0.55 + cur.glow * 0.3);
    mats.core.color.copy(accentNow).multiplyScalar(0.35 + cur.core * 0.3);
    if (core.current) core.current.scale.setScalar(0.85 + 0.15 * Math.sin(t * (2 + cur.core)));
    if (antenna.current) {
      const on = phase === 'HALTED' ? (Math.sin(t * 10) > 0 ? 1 : 0.1) : 0.5 + 0.5 * Math.sin(t * 2.4);
      (antenna.current.material as THREE.MeshBasicMaterial).color.copy(accentNow).multiplyScalar(0.3 + on * 1.4);
    }

    // sparkles rise while the worker has just closed in profit
    const sp = sparkles.current;
    if (sp) {
      sp.visible = phase === 'PROFIT';
      if (sp.visible) {
        const pos = sparkleGeo.getAttribute('position') as THREE.BufferAttribute;
        const seed = sparkleGeo.getAttribute('seed') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const s = seed.getX(i);
          const life = (t * 0.55 + s * 7) % 1;
          const ang = s * 40 + t * 0.6;
          const rad = 0.2 + life * 0.45;
          pos.setXYZ(i, Math.cos(ang) * rad, 1.1 + life * 1.0, -0.05 + Math.sin(ang) * rad * 0.5);
        }
        pos.needsUpdate = true;
        mats.sparkle.color.copy(accentNow);
        mats.sparkle.opacity = 0.9;
      }
    }
  });

  const setFinger = (i: number) => (m: THREE.Mesh | null) => {
    if (m) fingers.current[i] = m;
  };

  return (
    <group>
      {/* chair base and column stay put; the seat, the robot and its arms swivel on them */}
      <mesh position={[0, 0.03, 0.12]} material={mats.dark}>
        <cylinderGeometry args={[0.27, 0.27, 0.03, 20]} />
      </mesh>
      <mesh position={[0, 0.26, 0.12]} material={mats.joint}>
        <cylinderGeometry args={[0.03, 0.03, 0.46, 10]} />
      </mesh>
      <group ref={root} position={[0, 0, 0.12]}>
      <group position={[0, 0, -0.12]}>
      <RoundedBox args={[0.5, 0.07, 0.46]} radius={0.03} smoothness={2} position={[0, 0.5, 0.12]} material={mats.chair} />
      {/* low back: the robot's shoulders and head stay in view */}
      <RoundedBox args={[0.34, 0.26, 0.05]} radius={0.025} smoothness={2} position={[0, 0.7, 0.37]} rotation={[-0.1, 0, 0]} material={mats.chair} />
      {/* legs, mostly hidden under the desk */}
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * 0.11, 0.56, -0.08]} rotation={[Math.PI / 2 + 0.05, 0, 0]} material={mats.dark}>
            <cylinderGeometry args={[0.055, 0.05, 0.42, 10]} />
          </mesh>
          <mesh position={[s * 0.11, 0.3, -0.3]} material={mats.dark}>
            <cylinderGeometry args={[0.045, 0.04, 0.5, 10]} />
          </mesh>
          <RoundedBox args={[0.1, 0.05, 0.2]} radius={0.02} smoothness={2} position={[s * 0.11, 0.05, -0.36]} material={mats.shell} />
        </group>
      ))}
      <RoundedBox args={[0.38, 0.13, 0.26]} radius={0.04} smoothness={2} position={[0, 0.58, 0.08]} material={mats.dark} />

      {/* everything above the waist leans as one piece */}
      <group ref={upper} position={[PIVOT.x, PIVOT.y, PIVOT.z]}>
        <group position={[-PIVOT.x, -PIVOT.y, -PIVOT.z]}>
          <RoundedBox args={[0.46, 0.5, 0.27]} radius={0.06} smoothness={3} position={[0, 0.88, 0.04]} material={mats.shell} />
          {/* chest plate and core */}
          <RoundedBox args={[0.3, 0.2, 0.02]} radius={0.02} smoothness={2} position={[0, 0.9, -0.1]} material={mats.dark} />
          <mesh ref={core} position={[0, 0.9, -0.112]} rotation={[0, Math.PI, 0]} material={mats.core}>
            <circleGeometry args={[0.045, 24]} />
          </mesh>
          {/* power pack on the back: what the viewer mostly sees */}
          <RoundedBox args={[0.34, 0.34, 0.07]} radius={0.03} smoothness={2} position={[0, 0.9, 0.2]} material={mats.dark} />
          {[-1, 1].map((sx) => (
            <mesh key={sx} position={[sx * 0.09, 0.9, 0.238]} material={mats.core}>
              <boxGeometry args={[0.022, 0.26, 0.006]} />
            </mesh>
          ))}
          <mesh position={[0, 0.9, 0.238]} material={mats.joint}>
            <boxGeometry args={[0.07, 0.26, 0.006]} />
          </mesh>
          <mesh position={[0, 1.2, 0.04]} material={mats.joint}>
            <cylinderGeometry args={[0.05, 0.06, 0.1, 12]} />
          </mesh>
          {/* head */}
          <group ref={head} position={[0, 1.38, 0.04]}>
            <RoundedBox args={[0.36, 0.28, 0.3]} radius={0.07} smoothness={3} material={mats.shell} />
            <RoundedBox args={[0.3, 0.14, 0.03]} radius={0.04} smoothness={2} position={[0, 0.01, -0.145]} material={mats.glass} />
            <mesh ref={eyeL} position={[-0.062, 0.012, -0.162]} material={mats.eye}>
              <boxGeometry args={[0.07, 0.045, 0.01]} />
            </mesh>
            <mesh ref={eyeR} position={[0.062, 0.012, -0.162]} material={mats.eye}>
              <boxGeometry args={[0.07, 0.045, 0.01]} />
            </mesh>
            {[-1, 1].map((s) => (
              <mesh key={s} position={[s * 0.19, 0, 0]} rotation={[0, 0, Math.PI / 2]} material={mats.dark}>
                <cylinderGeometry args={[0.065, 0.065, 0.04, 18]} />
              </mesh>
            ))}
            {/* headset band over the top, and a glowing stripe across the back of the head */}
            <mesh position={[0, 0.01, 0]} rotation={[0, 0, 0]} material={mats.dark}>
              <torusGeometry args={[0.2, 0.012, 8, 28, Math.PI]} />
            </mesh>
            <mesh position={[0, 0.02, 0.152]} material={mats.core}>
              <boxGeometry args={[0.24, 0.022, 0.006]} />
            </mesh>
            <mesh position={[0, -0.03, 0.152]} material={mats.core}>
              <boxGeometry args={[0.12, 0.012, 0.006]} />
            </mesh>
            <mesh position={[0, 0.2, 0]} material={mats.joint}>
              <cylinderGeometry args={[0.008, 0.008, 0.12, 8]} />
            </mesh>
            <mesh ref={antenna} position={[0, 0.27, 0]}>
              <sphereGeometry args={[0.026, 12, 12]} />
              <meshBasicMaterial color={color} toneMapped={false} />
            </mesh>
          </group>
        </group>
      </group>

      {/* arms (positions are solved every frame) */}
      {[0, 1].map((i) => (
        <group key={i}>
          <mesh ref={shoulderJoint[i]} geometry={jointGeo} material={mats.joint} scale={1.45} />
          <mesh ref={upperArm[i]} geometry={limbGeo} material={mats.shell} />
          <mesh ref={elbowJoint[i]} geometry={jointGeo} material={mats.joint} />
          <mesh ref={foreArm[i]} geometry={foreGeo} material={mats.dark} />
          <group ref={hand[i]}>
            <RoundedBox args={[0.085, 0.03, 0.09]} radius={0.012} smoothness={2} position={[0, 0, -0.045]} material={mats.shell} />
            {[0, 1, 2, 3].map((f) => (
              <mesh key={f} ref={setFinger(i * 4 + f)} position={[-0.03 + f * 0.02, 0, -0.105]} material={mats.dark}>
                <boxGeometry args={[0.016, 0.014, 0.05]} />
              </mesh>
            ))}
          </group>
        </group>
      ))}

      <points ref={sparkles} geometry={sparkleGeo} material={mats.sparkle} visible={false} frustumCulled={false} />
      </group>
      </group>
    </group>
  );
}
