/**
 * Everything in the city that moves and can be picked or followed: vehicles, drones, the blimp.
 * The owners of the 3D objects update these records each frame; the picker, the hover tag and the
 * chase camera only read them.
 */

export type ActorKind = 'vehicle' | 'drone' | 'blimp';

export interface ActorTag {
  text: string;
  sub?: string;
  workerId?: string | null;
  /** CSS colour. */
  color: string;
}

export interface Actor {
  id: string;
  kind: ActorKind;
  /** Short name for tags and the ride badge, e.g. TAXI. */
  name: string;
  x: number;
  y: number;
  z: number;
  /** Heading around Y, with 0 pointing along +X. */
  yaw: number;
  /** World units per second. */
  speed: number;
  /** Set for vehicles that exist because of a real broker event: what happened. */
  tag: ActorTag | null;
  /** Click radius, screen pixels. */
  pick: number;
  /** Height of the top above `y`, for labels. */
  top: number;
  /** Chase camera: distance behind, height above, look-ahead distance, and (optionally) distance to the right-hand side. */
  chase: { back: number; up: number; ahead: number; side?: number };
}

export const actors = new Map<string, Actor>();

/** Simulated speed shown to people: 1 world unit is about 4.7 m. */
export function kmh(speed: number): number {
  return Math.round(speed * 4.7 * 3.6);
}

/** A live actor of a kind, preferring ones that are on the plaza boulevard (they never leave the city). */
export function findActor(kind: ActorKind, name?: string): Actor | null {
  let best: Actor | null = null;
  let bestScore = -1;
  for (const a of actors.values()) {
    if (a.kind !== kind || (name && a.name !== name)) continue;
    const onRing = a.kind === 'vehicle' && Math.hypot(a.x, a.z - 1) < 12 ? 1 : 0;
    const score = onRing + Math.random();
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return best;
}
