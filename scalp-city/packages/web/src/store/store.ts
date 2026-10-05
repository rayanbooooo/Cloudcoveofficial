import { create } from 'zustand';
import type {
  AccountView,
  AlertView,
  Bar,
  CityEvent,
  OptionQuoteView,
  OrderView,
  PositionView,
  RiskView,
  ServerMessage,
  Snapshot,
  SymbolQuoteView,
  SystemView,
  TimelineEvent,
  WorkerView,
} from '@scalp-city/shared';
import { setDisplayCurrency } from '../lib/format';

export type DrawerId = 'account' | 'positions' | 'orders' | 'risk' | 'health' | 'journal' | 'trade' | 'settings' | 'audit' | 'live';

export type ModalState =
  | { kind: 'enable-live' }
  | { kind: 'switch-env'; target: 'paper' | 'live' }
  | { kind: 'flatten' }
  | { kind: 'release-kill' }
  | { kind: 'enable-worker'; workerId: string }
  | { kind: 'enable-autotrading' }
  | { kind: 'trade-review'; tradeId: string }
  | { kind: 'accept-reconciliation' }
  | { kind: 'reset-breaker'; breakerId: string; label: string };

export interface ConnState {
  state: 'connecting' | 'open' | 'reconnecting' | 'closed';
  lastSeq: number;
  /** serverTime − Date.now(), so the UI shows server time (spec §91). */
  serverOffset: number;
  lastMessageAt: number;
}

export interface Toast extends AlertView {
  dismissed: boolean;
}

interface State {
  session: { authenticated: boolean; username: string | null; hasUsers: boolean } | null;
  conn: ConnState;
  ready: boolean;
  system: SystemView | null;
  account: AccountView | null;
  positions: PositionView[];
  orders: Record<string, OrderView>;
  workers: Record<string, WorkerView>;
  workerOrder: string[];
  quotes: Record<string, SymbolQuoteView>;
  optionQuotes: Record<string, OptionQuoteView>;
  risk: RiskView | null;
  timeline: TimelineEvent[];
  toasts: Toast[];
  cityEvents: CityEvent[];
  ui: {
    selectedWorker: string | null;
    drawer: DrawerId | null;
    modal: ModalState | null;
    timelineOpen: boolean;
    mobileTab: 'city' | 'account' | 'workers' | 'risk';
  };
  apply(msg: ServerMessage): 'ok' | 'gap';
  setSession(s: State['session']): void;
  setConn(c: Partial<ConnState>): void;
  selectWorker(id: string | null): void;
  openDrawer(d: DrawerId | null): void;
  openModal(m: ModalState | null): void;
  setTimelineOpen(open: boolean): void;
  setMobileTab(t: State['ui']['mobileTab']): void;
  dismissToast(id: string): void;
  consumeCityEvents(): CityEvent[];
}

type BarListener = (bars: Bar[]) => void;
const barListeners = new Map<string, Set<BarListener>>();

/** Live bar updates bypass the store so charts don't re-render React on every tick. */
export function onBars(symbol: string, fn: BarListener): () => void {
  let set = barListeners.get(symbol);
  if (!set) {
    set = new Set();
    barListeners.set(symbol, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

function applySnapshot(s: Snapshot): Partial<State> {
  setDisplayCurrency(s.account.currency);
  const orders: Record<string, OrderView> = {};
  for (const o of s.orders) orders[o.id] = o;
  const workers: Record<string, WorkerView> = {};
  for (const w of s.workers) workers[w.config.id] = w;
  return {
    ready: true,
    system: s.system,
    account: s.account,
    positions: s.positions,
    orders,
    workers,
    workerOrder: s.workers.map((w) => w.config.id),
    quotes: s.quotes,
    optionQuotes: s.optionQuotes,
    risk: s.risk,
    timeline: s.timeline,
  };
}

export const useStore = create<State>((set, get) => ({
  session: null,
  conn: { state: 'connecting', lastSeq: 0, serverOffset: 0, lastMessageAt: 0 },
  ready: false,
  system: null,
  account: null,
  positions: [],
  orders: {},
  workers: {},
  workerOrder: [],
  quotes: {},
  optionQuotes: {},
  risk: null,
  timeline: [],
  toasts: [],
  cityEvents: [],
  ui: { selectedWorker: null, drawer: null, modal: null, timelineOpen: true, mobileTab: 'city' },

  apply(msg) {
    const conn = get().conn;
    if (msg.type !== 'snapshot' && msg.seq !== conn.lastSeq + 1) return 'gap';
    const now = Date.now();
    const base = { conn: { ...conn, lastSeq: msg.seq, lastMessageAt: now } };
    switch (msg.type) {
      case 'snapshot':
        set({ ...applySnapshot(msg.data), conn: { ...base.conn, serverOffset: msg.data.system.serverTime - now } });
        return 'ok';
      case 'market.tick': {
        const quotes = { ...get().quotes };
        for (const q of msg.data.quotes) quotes[q.symbol] = q;
        const optionQuotes = msg.data.optionQuotes.length ? { ...get().optionQuotes } : get().optionQuotes;
        for (const q of msg.data.optionQuotes) optionQuotes[q.symbol] = q;
        set({ ...base, quotes, optionQuotes });
        return 'ok';
      }
      case 'market.bar': {
        set(base);
        const bySymbol = new Map<string, Bar[]>();
        for (const b of msg.data.bars) {
          const arr = bySymbol.get(b.symbol) ?? [];
          arr.push(b);
          bySymbol.set(b.symbol, arr);
        }
        for (const [sym, bars] of bySymbol) for (const fn of barListeners.get(sym) ?? []) fn(bars);
        return 'ok';
      }
      case 'worker.updated': {
        const w = msg.data;
        const order = get().workerOrder.includes(w.config.id) ? get().workerOrder : [...get().workerOrder, w.config.id];
        set({ ...base, workers: { ...get().workers, [w.config.id]: w }, workerOrder: order });
        return 'ok';
      }
      case 'order.updated':
        set({ ...base, orders: { ...get().orders, [msg.data.id]: msg.data } });
        return 'ok';
      case 'position.updated':
        set({ ...base, positions: msg.data.positions });
        return 'ok';
      case 'account.updated':
        setDisplayCurrency(msg.data.currency);
        set({ ...base, account: msg.data });
        return 'ok';
      case 'risk.updated':
        set({ ...base, risk: msg.data });
        return 'ok';
      case 'system.updated':
        set({ ...base, system: msg.data, conn: { ...base.conn, serverOffset: msg.data.serverTime - now } });
        return 'ok';
      case 'timeline.event': {
        const tl = get().timeline;
        set({ ...base, timeline: tl.length >= 400 ? [...tl.slice(-399), msg.data] : [...tl, msg.data] });
        return 'ok';
      }
      case 'alert': {
        const toasts = [...get().toasts.filter((t) => !t.dismissed).slice(-5), { ...msg.data, dismissed: false }];
        set({ ...base, toasts });
        return 'ok';
      }
      case 'city.event':
        set({ ...base, cityEvents: [...get().cityEvents, msg.data].slice(-50) });
        return 'ok';
      case 'heartbeat':
        set({ conn: { ...base.conn, serverOffset: msg.data.serverTime - now } });
        return 'ok';
    }
  },

  setSession: (session) => set({ session }),
  setConn: (c) => set({ conn: { ...get().conn, ...c } }),
  selectWorker: (id) => set({ ui: { ...get().ui, selectedWorker: id } }),
  openDrawer: (d) => set({ ui: { ...get().ui, drawer: d } }),
  openModal: (m) => set({ ui: { ...get().ui, modal: m } }),
  setTimelineOpen: (open) => set({ ui: { ...get().ui, timelineOpen: open } }),
  setMobileTab: (t) => set({ ui: { ...get().ui, mobileTab: t } }),
  dismissToast: (id) => set({ toasts: get().toasts.map((t) => (t.id === id ? { ...t, dismissed: true } : t)) }),
  consumeCityEvents: () => {
    const ev = get().cityEvents;
    if (ev.length) set({ cityEvents: [] });
    return ev;
  },
}));

/** Server time (ms), corrected by the measured offset. */
export function serverNow(): number {
  return Date.now() + useStore.getState().conn.serverOffset;
}
