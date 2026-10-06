import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { actors, kmh, type Actor } from './actors';
import { useCityUi } from './cityUi';
import { useLabelLayer } from './labelLayer';

/**
 * Picking for things that move: vehicles, drones and the blimp. They are instanced or animated every
 * frame, so instead of raycasting each one this projects the few dozen of them to the screen and takes the
 * nearest to the pointer. Towers and the vault keep their own handlers; a click that hits none of them
 * arrives here through the canvas's pointer-missed event (which already ignores drags).
 */

type PickFn = (clientX: number, clientY: number) => Actor | null;
let pickAt: PickFn | null = null;

/** Hand this to the canvas's `onPointerMissed`: a click on empty city starts a ride if it lands on something that moves. */
export function handleMissedClick(e: MouseEvent): void {
  const a = pickAt?.(e.clientX, e.clientY);
  if (a) useCityUi.getState().startRide(a.id);
}

export function Picker() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const el = gl.domElement;
    const v = new THREE.Vector3();
    // Fingers are less exact than a mouse.
    const reach = window.matchMedia('(pointer: coarse)').matches ? 1.9 : 1;
    const pick: PickFn = (cx, cy) => {
      const rect = el.getBoundingClientRect();
      const px = cx - rect.left;
      const py = cy - rect.top;
      const { options } = useCityUi.getState();
      let best: Actor | null = null;
      let bestD = Infinity;
      for (const a of actors.values()) {
        if (!(a.kind === 'vehicle' ? options.traffic : options.sky)) continue;
        v.set(a.x, a.y + a.top * 0.5, a.z).project(camera);
        if (v.z < -1 || v.z > 1) continue;
        const d = Math.hypot((v.x * 0.5 + 0.5) * rect.width - px, (-v.y * 0.5 + 0.5) * rect.height - py);
        if (d < a.pick * reach && d < bestD) {
          best = a;
          bestD = d;
        }
      }
      return best;
    };
    pickAt = pick;
    let raf = 0;
    let at: { x: number; y: number } | null = null;
    const hover = () => {
      raf = 0;
      if (!at) return;
      const a = pick(at.x, at.y);
      useCityUi.getState().setHover(a?.id ?? null);
      // The canvas's own cursor, so a tower's hover (which sets the page cursor) is not overridden.
      el.style.cursor = a ? 'pointer' : '';
    };
    const move = (e: PointerEvent) => {
      if (e.buttons !== 0) {
        // Dragging the camera: no hover.
        at = null;
        useCityUi.getState().setHover(null);
        el.style.cursor = '';
        return;
      }
      at = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(hover);
    };
    const leave = () => {
      at = null;
      useCityUi.getState().setHover(null);
      el.style.cursor = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
      if (raf) cancelAnimationFrame(raf);
      if (pickAt === pick) pickAt = null;
      el.style.cursor = '';
    };
  }, [camera, gl]);
  return null;
}

/** Name, speed and a hint over whatever the pointer is on. */
export function HoverTag() {
  const hover = useCityUi((s) => s.hover);
  const riding = useCityUi((s) => s.ride !== null);
  const labels = useLabelLayer();
  const group = useRef<THREE.Group>(null);
  const speed = useRef<HTMLSpanElement>(null);
  useFrame(() => {
    const a = hover ? actors.get(hover) : undefined;
    const g = group.current;
    if (!g) return;
    g.visible = !!a;
    if (a) {
      g.position.set(a.x, a.y, a.z);
      if (speed.current) speed.current.textContent = a.kind === 'vehicle' ? `${kmh(a.speed)} km/h` : '';
    }
  });
  const a = hover ? actors.get(hover) : undefined;
  if (!hover || riding || !a) return null;
  return (
    <group ref={group} position={[a.x, a.y, a.z]}>
      <Html portal={labels} center zIndexRange={[7, 0]} style={{ pointerEvents: 'none' }}>
        <div className="translate-y-6 whitespace-nowrap border border-line-2 bg-ink-950/90 px-2 py-1 text-center backdrop-blur-[2px]">
          <div className="label-strong text-[9px] text-fg">
            {a.name} <span ref={speed} className="num text-fg-2" />
          </div>
          <div className="label text-[8.5px]">Click to ride along</div>
        </div>
      </Html>
    </group>
  );
}
