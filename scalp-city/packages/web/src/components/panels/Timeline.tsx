import type { TimelineKind } from '@scalp-city/shared';
import { timeET } from '../../lib/format';
import { useStore } from '../../store/store';
import { cx } from '../ui';

const KIND_COLOR: Record<TimelineKind, string> = {
  signal: 'text-signal',
  risk: 'text-pending',
  order: 'text-fg-2',
  fill: 'text-call',
  exit: 'text-fg',
  pnl: 'text-fg',
  system: 'text-fg-3',
  alert: 'text-put',
  control: 'text-pending',
};

/** Session activity with the real event timestamps (spec §45, §85). */
export function Timeline({ maxRows }: { maxRows?: number }) {
  const events = useStore((s) => s.timeline);
  const workers = useStore((s) => s.workers);
  const open = useStore((s) => s.ui.timelineOpen);
  const setOpen = useStore((s) => s.setTimelineOpen);
  const rows = [...events].reverse().slice(0, maxRows ?? 120);
  return (
    <section className="panel flex min-h-0 flex-col">
      <button className="panel-head w-full" onClick={() => setOpen(!open)}>
        <span className="label">Timeline</span>
        <span className="label !text-fg-2">
          {events.length} events · {open ? 'collapse ▾' : 'expand ▴'}
        </span>
      </button>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1">
          {rows.length === 0 && <div className="label py-2">No activity yet this session.</div>}
          {rows.map((e) => (
            <div key={e.id} className="grid grid-cols-[64px_56px_minmax(0,1fr)] items-baseline gap-2 border-b border-line/40 py-[3px] last:border-b-0">
              <span className="num text-[11px] text-fg-3">{timeET(e.ts)}</span>
              <span className={cx('label-strong text-[9.5px]', KIND_COLOR[e.kind], e.severity === 'error' && '!text-put', e.severity === 'success' && '!text-call')}>{e.kind}</span>
              <span className="min-w-0 truncate text-[11.5px]">
                <span className={cx(e.severity === 'error' ? 'text-put' : e.severity === 'success' ? 'text-call' : 'text-fg')}>{e.title}</span>
                {e.detail && <span className="num ml-2 text-[10.5px] text-fg-3">{e.detail}</span>}
                {e.workerId && !e.title.includes(workers[e.workerId]?.config.name ?? '§') && <span className="label ml-2">{workers[e.workerId]?.config.name}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
