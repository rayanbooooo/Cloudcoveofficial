import { useEffect, useRef, type RefObject } from 'react';
import type { Bar } from '@scalp-city/shared';
import { Api } from '../../lib/api';
import { onBars, useStore } from '../../store/store';

export interface LiveBars {
  /** Oldest first. Only bars the server delivered — nothing is synthesised. */
  bars: Bar[];
  status: 'loading' | 'ok' | 'error';
  error: string | null;
}

/**
 * Recent real 1-minute bars of one symbol, for the robot's monitor: loaded
 * once from the server, then merged from the live bar feed (regular-session
 * bars only, like the price chart). The result lives in a ref so the 3D
 * screens can read it every frame without re-rendering React.
 */
export function useLiveBars(symbol: string, keep = 90): RefObject<LiveBars> {
  const ref = useRef<LiveBars>({ bars: [], status: 'loading', error: null });
  useEffect(() => {
    let disposed = false;
    const byTime = new Map<number, Bar>();
    const publish = (status: LiveBars['status'], error: string | null) => {
      const all = [...byTime.values()].sort((a, b) => a.t - b.t);
      ref.current = { bars: all.slice(-keep), status, error };
    };
    ref.current = { bars: [], status: 'loading', error: null };
    Api.chart(symbol, '1Min')
      .then((res) => {
        if (disposed) return;
        for (const b of res.bars) byTime.set(b.t, b);
        publish('ok', null);
      })
      .catch((e: unknown) => {
        if (!disposed) publish('error', e instanceof Error ? e.message : String(e));
      });
    const off = onBars(symbol, (updates) => {
      const m = useStore.getState().system?.market;
      for (const b of updates) {
        if (m && m.sessionOpen !== null && (b.t < m.sessionOpen || (m.sessionClose !== null && b.t >= m.sessionClose))) continue;
        byTime.set(b.t, b);
      }
      // A live update before the history arrived is kept, but the status stays 'loading' until it does.
      publish(ref.current.status, ref.current.error);
    });
    return () => {
      disposed = true;
      off();
    };
  }, [symbol, keep]);
  return ref;
}
