import type { TowerState, WorkerView } from '@scalp-city/shared';
import { money, pnlClass } from '../../lib/format';
import { useStore } from '../../store/store';
import { cx, Panel } from '../ui';

export const TOWER_COLORS: Record<TowerState, string> = {
  WATCHING: '#4c8dff',
  SETUP_FORMING: '#4c8dff',
  CHARGING: '#7fb2ff',
  READY: '#2ee6a6',
  ORDER_PENDING: '#ffb020',
  IN_TRADE: '#2ee6a6',
  PROFIT: '#2ee6a6',
  LOSS: '#ff4d6d',
  STANDING_DOWN: '#8a93a3',
  HALTED: '#ff4d6d',
};

export function directionColor(w: WorkerView): string {
  if (w.towerState === 'HALTED') return '#ff4d6d';
  if (w.towerState === 'ORDER_PENDING') return '#ffb020';
  if (w.towerState === 'STANDING_DOWN') return '#8a93a3';
  const d = w.position?.direction ?? w.signal.direction;
  if (d === 'CALL') return '#2ee6a6';
  if (d === 'PUT') return '#ff4d6d';
  return '#4c8dff';
}

function useWorkers(): WorkerView[] {
  const workers = useStore((s) => s.workers);
  const order = useStore((s) => s.workerOrder);
  return order.map((id) => workers[id]).filter((w): w is WorkerView => !!w);
}

/** Worker heatmap (spec §49): real session P&L per worker. */
export function Heatmap() {
  const workers = useWorkers();
  const select = useStore((s) => s.selectWorker);
  const selected = useStore((s) => s.ui.selectedWorker);
  const max = Math.max(1, ...workers.map((w) => Math.abs(w.stats.pnlToday ?? 0)));
  return (
    <div className="grid grid-cols-5 gap-1">
      {workers.map((w) => {
        // null = a position is open without a usable mark: shown as unknown, never as $0.
        const pnl = w.stats.pnlToday;
        const intensity = pnl === null ? 0 : Math.min(1, Math.abs(pnl) / max);
        const bg = pnl === null ? 'rgb(255 176 32 / 0.08)' : pnl > 0 ? `rgb(46 230 166 / ${0.06 + intensity * 0.32})` : pnl < 0 ? `rgb(255 77 109 / ${0.06 + intensity * 0.32})` : 'rgb(140 160 190 / 0.05)';
        return (
          <button
            key={w.config.id}
            onClick={() => select(w.config.id)}
            className={cx('focus-ring flex min-w-0 flex-col items-start gap-0.5 border px-1.5 py-1.5 text-left transition-colors', selected === w.config.id ? 'border-fg-2' : 'border-line hover:border-line-2')}
            style={{ background: bg }}
          >
            <span className="label-strong w-full truncate text-[9.5px] text-fg">{w.config.name}</span>
            <span className={cx('num text-[11px]', pnl === null ? 'text-pending' : pnlClass(pnl))}>{pnl === null ? 'NO MARK' : money(pnl, { sign: true, compact: true })}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Leaderboard (spec §50): ranked by real session P&L. */
export function Leaderboard() {
  const workers = useWorkers();
  const select = useStore((s) => s.selectWorker);
  // Unknown P&L sorts last rather than being ranked as $0.
  const rank = (w: WorkerView) => w.stats.pnlToday ?? Number.NEGATIVE_INFINITY;
  const ranked = [...workers].sort((a, b) => rank(b) - rank(a) || a.config.name.localeCompare(b.config.name));
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-left">
          <th className="label py-1 pr-1 font-normal">#</th>
          <th className="label py-1 font-normal">Worker</th>
          <th className="label py-1 text-right font-normal">P&L</th>
          <th className="label py-1 text-right font-normal">Win</th>
          <th className="label py-1 text-right font-normal">Tr</th>
          <th className="label py-1 pl-2 font-normal">Status</th>
        </tr>
      </thead>
      <tbody>
        {ranked.map((w, i) => (
          <tr key={w.config.id} className="cursor-pointer border-t border-line/60 hover:bg-ink-700/50" onClick={() => select(w.config.id)}>
            <td className="num py-1 pr-1 text-[11px] text-fg-3">{i + 1}</td>
            <td className="py-1">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-[3px]" style={{ background: directionColor(w) }} />
                <span className="label-strong text-[10.5px] text-fg">{w.config.name}</span>
                <span className="num text-[10px] text-fg-3">{w.config.symbol}</span>
              </div>
            </td>
            <td className={cx('num py-1 text-right text-[11.5px]', pnlClass(w.stats.pnlToday))}>{money(w.stats.pnlToday, { sign: true })}</td>
            <td className="num py-1 text-right text-[11px] text-fg-2">{w.stats.winRate === null ? '—' : `${Math.round(w.stats.winRate)}%`}</td>
            <td className="num py-1 text-right text-[11px] text-fg-2">{w.stats.tradesToday}</td>
            <td className="py-1 pl-2">
              <span className="label-strong truncate text-[9.5px]" style={{ color: TOWER_COLORS[w.towerState] }}>
                {w.towerState.replace('_', ' ')}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function WorkersPanel() {
  const workers = useWorkers();
  // Any unknown worker P&L makes the total unknown (money(null) renders UNAVAILABLE).
  const total = workers.some((w) => w.stats.pnlToday === null) ? null : workers.reduce((s, w) => s + (w.stats.pnlToday ?? 0), 0);
  return (
    <Panel title="Workers" meta={<span className={cx('num', pnlClass(total))}>{money(total, { sign: true })}</span>}>
      <Heatmap />
      <div className="mt-2.5">
        <Leaderboard />
      </div>
    </Panel>
  );
}
