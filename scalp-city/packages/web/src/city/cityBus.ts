import type { CityEvent } from '@scalp-city/shared';
import type { Vec3 } from './layout';

/**
 * Broker-confirmed city events, fanned out. The one consumer of the store's event queue (Effects) emits
 * each fresh event here once, so that other parts of the scene (the event vehicles, the coin bursts) can
 * react without competing for the queue. Nothing is emitted from local guesses.
 */
export interface CityFx {
  event: CityEvent;
  /** The worker's tower (or the vault, for events without a worker). */
  anchor: { position: Vec3; top: number };
  color: string;
  title: string;
  sub: string;
}

type Listener = (fx: CityFx) => void;
const listeners = new Set<Listener>();

export function emitCityFx(fx: CityFx): void {
  for (const l of listeners) l(fx);
}

export function onCityFx(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
