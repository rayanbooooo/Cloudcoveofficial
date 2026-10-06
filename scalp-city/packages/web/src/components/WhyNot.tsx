import { useEffect, useState } from 'react';
import type { WorkerView } from '@scalp-city/shared';
import { Api, ApiError } from '../lib/api';
import { entryBlockers, type Blocker } from '../lib/blockers';
import { serverNow, useStore } from '../store/store';
import { Btn, cx } from './ui';

const ACTION_LABEL: Record<NonNullable<Blocker['action']>, string> = {
  autotrading: 'Turn on',
  worker: 'Turn on',
  resume: 'Resume',
  release: 'Release',
};

/**
 * What stands between a signal and an order, as a list with the fix next to each item that has one.
 * Nothing is shown while the worker is in a trade or has an order out, or when nothing is in the way.
 * `headline` words the title for a signal that is READY (the case that looks like it should be trading).
 */
export function WhyNotPlacing({ w, headline }: { w: WorkerView; headline?: boolean }) {
  const system = useStore((s) => s.system);
  const quote = useStore((s) => s.quotes[w.config.symbol]);
  const openModal = useStore((s) => s.openModal);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Countdowns move on without any new data arriving (a closed market is quiet).
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, []);
  if (!system) return null;
  const blockers = entryBlockers(w, system, quote, serverNow());
  if (blockers.length === 0) return null;
  const live = system.env === 'live';

  const act = async (b: Blocker) => {
    setError(null);
    try {
      setBusy(true);
      switch (b.action) {
        case 'autotrading':
          // Live trading asks for a confirmation first, like the switch in the top bar.
          if (live) openModal({ kind: 'enable-autotrading' });
          else await Api.setAutotrading(true);
          break;
        case 'worker':
          openModal({ kind: 'enable-worker', workerId: w.config.id });
          break;
        case 'resume':
          await Api.setPaused(false);
          break;
        case 'release':
          openModal({ kind: 'release-kill' });
          break;
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const shown = blockers.slice(0, 5);
  return (
    <div className="border-l-2 border-pending bg-pending/5 px-2.5 py-2" role="status">
      <div className="label-strong text-[10.5px] text-pending">
        {headline ? (blockers.length === 1 ? 'Not placing: 1 thing in the way' : `Not placing: ${blockers.length} things in the way`) : blockers.length === 1 ? 'Not trading now: 1 reason' : `Not trading now: ${blockers.length} reasons`}
      </div>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {shown.map((b) => (
          <li key={b.code} className="flex items-start gap-2">
            <span className="num mt-[1px] w-3 shrink-0 text-[11px] text-pending">✕</span>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] leading-snug text-fg">{b.text}</div>
              {b.detail && <div className={cx('text-[11px] leading-snug text-fg-3')}>{b.detail}</div>}
            </div>
            {b.action && (
              <Btn variant="warn" className="!h-6 shrink-0 !px-2 !text-[10px]" disabled={busy} onClick={() => void act(b)}>
                {ACTION_LABEL[b.action]}
              </Btn>
            )}
          </li>
        ))}
      </ul>
      {blockers.length > shown.length && <div className="label mt-1">+{blockers.length - shown.length} more</div>}
      {error && <div className="mt-1 text-[11px] text-put">{error}</div>}
    </div>
  );
}
