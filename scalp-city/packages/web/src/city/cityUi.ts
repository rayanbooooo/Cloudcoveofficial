import { create } from 'zustand';
import { useStore } from '../store/store';

/** Viewer preferences and interaction state for the 3D city. Nothing here touches trading. */

export interface CityOptions {
  /** Cars, buses and trucks driving about (and the event vehicles). */
  traffic: boolean;
  /** Drones and the blimp. */
  sky: boolean;
}

const KEY = 'scalpcity.city.options';

function load(): CityOptions {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<CityOptions>;
      return { traffic: p.traffic !== false, sky: p.sky !== false };
    }
  } catch {
    // Storage can be blocked or empty: the defaults are fine.
  }
  return { traffic: true, sky: true };
}

function save(o: CityOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Not persisted; the choice still holds for this visit.
  }
}

interface CityUi {
  options: CityOptions;
  /** Actor under the pointer. */
  hover: string | null;
  /** Actor the camera is riding along with. */
  ride: string | null;
  /** Counts the camera cuts of a ride (the vehicle left one end of its road and came back at the other). */
  cuts: number;
  /** What the blimp's ticker shows. */
  ticker: 'quotes' | 'pnl';
  setOption<K extends keyof CityOptions>(key: K, value: boolean): void;
  setTicker(t: 'quotes' | 'pnl'): void;
  setHover(id: string | null): void;
  startRide(id: string): void;
  stopRide(): void;
  cut(): void;
}

export const useCityUi = create<CityUi>((set, get) => ({
  options: load(),
  hover: null,
  ride: null,
  cuts: 0,
  ticker: 'quotes',
  setTicker: (ticker) => set({ ticker }),
  setOption: (key, value) => {
    const options = { ...get().options, [key]: value };
    save(options);
    set({ options });
  },
  setHover: (hover) => {
    if (get().hover !== hover) set({ hover });
  },
  startRide: (id) => {
    // A ride replaces a worker close-up: the camera can only be in one place.
    if (useStore.getState().ui.selectedWorker) useStore.getState().selectWorker(null);
    set({ ride: id, hover: null });
  },
  stopRide: () => {
    if (get().ride !== null) set({ ride: null });
  },
  cut: () => set({ cuts: get().cuts + 1 }),
}));
