import { directionLabel, type ConditionResult, type WorkerView } from '@scalp-city/shared';
import { signalIsStale, timeframeMs } from '../../lib/blockers';
import { countdown, dateTimeET, humanize, money, px, qtyStr, unitsStr } from '../../lib/format';
import { serverNow, useStore } from '../../store/store';
import { ChargeBar, Check, cx, Panel } from '../ui';
import { WhyNotPlacing } from '../WhyNot';

const RISK_LABELS: Record<string, string> = {
  data_fresh: 'Data',
  account: 'Account',
  margin: 'Margin',
  risk_per_trade: 'Risk at stop',
  stop_side: 'Stop placement',
  instrument: 'Instrument',
  buying_power: 'Buying power',
  liquidity: 'Liquidity',
  max_positions: 'Position limit',
  daily_loss: 'Daily loss',
  market_open: 'Market open',
  broker: 'Broker',
};

/** CFD workers: what the next entry would be, sized from the live price and ATR — and why not, when it can't be. */
function SizingLine({ w }: { w: WorkerView }) {
  const m = w.market!;
  const sym = w.config.symbol;
  const pos = w.position;
  return (
    <div className="border-t border-line pt-1.5" title="Size = what you are willing to lose at the stop ÷ stop distance, rounded down to the broker's unit step, then capped by the notional and margin limits.">
      <div className="label mb-0.5 flex justify-between">
        <span>Next entry</span>
        <span className="num !text-fg-2">{m.tradeable === false ? 'MARKET CLOSED' : m.tradeable === null ? 'no price yet' : 'tradeable'}</span>
      </div>
      {pos ? (
        <div className="num text-[11px] text-fg-2">
          holding {unitsStr(Math.abs(pos.qty))} · stop {pos.stopPrice === null ? <span className="text-pending">none at broker</span> : px(sym, pos.stopPrice)}
          {pos.targetPrice !== null ? ` · target ${px(sym, pos.targetPrice)}` : ''}
        </div>
      ) : m.plannedUnits !== null ? (
        <div className="num text-[11px] text-fg-2">
          {unitsStr(m.plannedUnits)} · stop {m.plannedStop === null ? '—' : px(sym, m.plannedStop)} away · target {m.plannedTarget === null ? '—' : px(sym, m.plannedTarget)} away · risks ≤ {money(w.config.limits.riskPerTrade)}
        </div>
      ) : (
        <div className="text-[11px] text-pending">{m.sizingNote ?? 'size unavailable'}</div>
      )}
    </div>
  );
}

export function pickScannerWorker(workers: Record<string, WorkerView>, selected: string | null): WorkerView | null {
  if (selected && workers[selected]) return workers[selected]!;
  const list = Object.values(workers);
  if (!list.length) return null;
  return [...list].sort((a, b) => (b.signal.live?.charge ?? b.signal.charge) - (a.signal.live?.charge ?? a.signal.charge))[0]!;
}

export function ConditionList({ conditions }: { conditions: ConditionResult[] }) {
  return (
    <div>
      {conditions.map((c) => (
        <div key={c.id} className="flex items-baseline gap-2 py-[2px]" title={c.detail}>
          <span className={cx('num w-3 text-[11px]', c.met ? 'text-call' : c.unavailable ? 'text-fg-3' : 'text-fg-3')}>{c.met ? '✓' : c.unavailable ? '·' : '✕'}</span>
          <span className={cx('label-strong w-[112px] shrink-0 text-[10.5px]', c.met ? 'text-fg' : 'text-fg-3')}>{c.label}</span>
          <span className="num min-w-0 truncate text-[10.5px] text-fg-3">{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** Signal scanner (spec §21, §44, §84): every number is derived from real bars. */
export function Scanner({ workerId, embedded }: { workerId?: string | null; embedded?: boolean }) {
  const workers = useStore((s) => s.workers);
  const selected = useStore((s) => s.ui.selectedWorker);
  const orders = useStore((s) => s.orders);
  const system = useStore((s) => s.system);
  const w = workerId ? (workers[workerId] ?? null) : pickScannerWorker(workers, selected);
  if (!w) return null;
  const sig = w.signal;
  // Headline = the CONFIRMED evaluation (last closed bar): the only one that can trade.
  // The forming-bar preview is shown separately and labelled as such.
  const dir = sig.direction;
  const color = dir === 'CALL' ? 'var(--color-call)' : dir === 'PUT' ? 'var(--color-put)' : 'var(--color-signal)';
  const dirText = (d: typeof dir) => directionLabel(d, w.config.instrument);
  const preview = sig.live;
  const previewColor = preview?.direction === 'CALL' ? 'var(--color-call)' : preview?.direction === 'PUT' ? 'var(--color-put)' : 'var(--color-fg-2)';
  const order = w.activeOrderId ? orders[w.activeOrderId] : null;
  const risk = sig.lastRisk;
  const now = serverNow();
  const confirming = !!preview && preview.direction !== 'NEUTRAL' && preview.charge >= w.config.params.readyThreshold && sig.phase !== 'READY';
  // A signal from the last bar before the market closed is still on screen the next morning: say so.
  const stale = !!system && signalIsStale(w, system, now);
  const tfMs = timeframeMs(w.config.timeframe);
  const looksReady = sig.phase === 'READY' || confirming || sig.charge >= w.config.params.readyThreshold;

  const body = (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="display text-[18px]" style={{ color }}>
            {dir === 'NEUTRAL' ? 'NO SETUP' : dirText(dir)}
          </span>
          <span className="label">{w.market?.displayName ?? w.config.symbol} · {w.config.timeframe.replace('Min', 'm')}</span>
        </div>
        <span className="label-strong text-[11px]" style={{ color: sig.phase === 'READY' && !stale ? 'var(--color-call)' : 'var(--color-fg-2)' }}>
          {sig.phase === 'READY' ? (stale ? 'READY · LAST BAR' : 'READY') : humanize(sig.phase)}
        </span>
      </div>
      {stale && sig.barTime !== null && (
        <div className="label -mt-1 !text-[9.5px]">
          As of {dateTimeET(sig.barTime + tfMs)} ET{system && !system.market.isOpen ? ' · the market is closed, so no new bars yet' : ' · no new bar for a while'}
        </div>
      )}
      {!embedded && looksReady && <WhyNotPlacing w={w} headline />}
      <div className={cx('flex flex-col gap-2', stale && 'opacity-60')}>
        <ConditionList conditions={sig.conditions} />
        <div>
          <ChargeBar value={sig.charge} color={color} ghost={preview && preview.direction === dir ? preview.charge : undefined} />
          <div className="mt-1 flex items-baseline justify-between">
            <span className="num text-[13px] text-fg">
              {sig.charge}% <span className="label">confirmed</span>
            </span>
            <span className="label">
              {confirming
                ? `confirming · bar closes ${countdown((sig.nextEvaluationAt ?? now) - now)}`
                : sig.nextEvaluationAt
                  ? `next bar ${countdown(sig.nextEvaluationAt - now)}`
                  : 'market closed'}
            </span>
          </div>
          {preview && (
            <div className="label mt-0.5 flex justify-between !text-[9.5px]">
              <span>
                forming bar preview:{' '}
                <span className="num" style={{ color: previewColor }}>
                  {preview.direction === 'NEUTRAL' ? 'no setup' : `${dirText(preview.direction)} ${preview.charge}%`}
                </span>
              </span>
              <span>{sig.consumed ? 'signal used' : 'preview never trades'}</span>
            </div>
          )}
        </div>
      </div>
      {w.market && <SizingLine w={w} />}
      {risk && (
        <div className={cx('border-t border-line pt-1.5', stale && 'opacity-60')}>
          <div className="label mb-1 flex justify-between">
            <span>{stale ? 'Risk check · last attempt' : 'Risk check'}</span>
            <span className={risk.approved ? '!text-call' : '!text-put'}>{risk.approved ? 'APPROVED' : 'BLOCKED'}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3">
            {risk.checks
              .filter((c) => RISK_LABELS[c.id] || !c.passed)
              .slice(0, 10)
              .map((c) => (
                <Check key={c.id} ok={c.passed} label={RISK_LABELS[c.id] ?? c.label} detail={c.passed ? undefined : c.detail} />
              ))}
          </div>
        </div>
      )}
      {order && (
        <div className="flex items-center justify-between border-t border-line pt-1.5">
          <span className="label">{order.purpose === 'ENTRY' ? 'Entry' : 'Exit'} order</span>
          <span className="label-strong text-[11px]" style={{ color: order.state === 'FILLED' ? 'var(--color-call)' : 'var(--color-pending)' }}>
            {humanize(order.state)} · {qtyStr(order.filledQty)}/{qtyStr(order.qty)}
          </span>
        </div>
      )}
      {w.unmanagedWarning && <div className="border-l-2 border-pending px-2 py-1 text-[11px] text-pending">{w.unmanagedWarning}</div>}
    </div>
  );

  if (embedded) return body;
  return (
    <Panel title="Signal scanner" meta={w.config.name} accent={color}>
      {body}
    </Panel>
  );
}
