import { useMemo, useState } from 'react';
import type { OrderView, WorkerView } from '@scalp-city/shared';
import { Api, ApiError } from '../lib/api';
import { WORKER_DESK_WIDTH } from '../lib/layout';
import { dateTimeET, humanize, money, pct, pnlClass, price, timeET } from '../lib/format';
import { useStore } from '../store/store';
import { Scanner } from './panels/Scanner';
import { directionColor, TOWER_COLORS } from './panels/Workers';
import { PriceChart, type ChartMarker } from './PriceChart';
import { cx, Drawer, ErrorText, Money, Row, Toggle } from './ui';

function PositionBlock({ w }: { w: WorkerView }) {
  const optionQuotes = useStore((s) => s.optionQuotes);
  const p = w.position;
  if (!p) return <div className="label py-2">Flat — no position.</div>;
  const q = optionQuotes[p.symbol];
  const isOption = p.assetClass === 'us_option';
  const mult = isOption ? 100 : 1;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="display text-[16px]" style={{ color: p.direction === 'PUT' ? 'var(--color-put)' : 'var(--color-call)' }}>
          {isOption ? p.option?.type.toUpperCase() : p.qty > 0 ? 'LONG' : 'SHORT'} · {p.symbol}
        </span>
        <span className={cx('num text-[18px]', pnlClass(p.unrealizedPnl))}>{money(p.unrealizedPnl, { sign: true })}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-6">
        {isOption && p.option && (
          <>
            <Row label="Underlying">{p.option.underlying}</Row>
            <Row label="Strike">{price(p.option.strike)}</Row>
            <Row label="Expiration">{p.option.expiration}</Row>
            <Row label="Bid / Ask">
              {q ? `${price(q.bid)} / ${price(q.ask)}` : '—'}
            </Row>
            <Row label="Mid">{q ? price(q.mid) : '—'}</Row>
            <Row label="Last">{q ? price(q.last) : '—'}</Row>
          </>
        )}
        <Row label="Quantity">{Math.abs(p.qty)}{isOption ? ' contracts' : ' shares'}</Row>
        <Row label="Average fill">{price(p.avgEntryPrice)}</Row>
        <Row label="Current">{price(p.markPrice)}</Row>
        <Row label="Market value">{p.markPrice === null ? '—' : money(p.markPrice * Math.abs(p.qty) * mult)}</Row>
        <Row label="Unrealized %">
          <span className={pnlClass(p.unrealizedPnlPct)}>{pct(p.unrealizedPnlPct, { sign: true })}</span>
        </Row>
        <Row label="Opened">{timeET(p.openedAt)}</Row>
      </div>
      {q?.stale && <div className="label mt-1 !text-pending">Option quote stale — exits wait for live data</div>}
    </div>
  );
}

function OrdersBlock({ orders }: { orders: OrderView[] }) {
  const [error, setError] = useState<string | null>(null);
  if (!orders.length) return <div className="label py-2">No orders today.</div>;
  return (
    <div>
      {orders.slice(0, 8).map((o) => (
        <div key={o.id} className="grid grid-cols-[52px_1fr_auto] items-baseline gap-2 border-b border-line/50 py-1 last:border-b-0">
          <span className="num text-[10.5px] text-fg-3">{timeET(o.createdAt)}</span>
          <span className="min-w-0 truncate">
            <span className="label-strong mr-1.5 text-[10px]" style={{ color: o.side === 'buy' ? 'var(--color-call)' : 'var(--color-put)' }}>
              {o.purpose === 'ENTRY' ? 'ENTRY' : 'EXIT'} {o.side.toUpperCase()}
            </span>
            <span className="num text-[11px] text-fg">
              {o.filledQty}/{o.qty} {o.symbol}
            </span>
            <span className="num ml-1.5 text-[10.5px] text-fg-3">
              {o.type}
              {o.limitPrice ? ` @${price(o.limitPrice)}` : ''}
              {o.filledAvgPrice ? ` · fill ${price(o.filledAvgPrice)}` : ''}
            </span>
            {o.rejectReason && <div className="truncate text-[10.5px] text-put">{o.rejectReason}</div>}
          </span>
          <span className="flex items-center gap-2">
            <span className="label-strong text-[10px]" style={{ color: o.state === 'FILLED' ? 'var(--color-call)' : o.state === 'REJECTED' || o.state === 'ERROR' ? 'var(--color-put)' : 'var(--color-pending)' }}>
              {humanize(o.state)}
            </span>
            {o.cancelable && (
              <button
                className="label hover:!text-put"
                onClick={async () => {
                  setError(null);
                  try {
                    await Api.cancelOrder(o.id);
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : String(e));
                  }
                }}
              >
                cancel
              </button>
            )}
          </span>
        </div>
      ))}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Inside a tower (spec §83): robot status, chart, scanner, position, orders, statistics. */
export function WorkerDesk() {
  const id = useStore((s) => s.ui.selectedWorker);
  const w = useStore((s) => (id ? s.workers[id] : undefined));
  const ordersMap = useStore((s) => s.orders);
  const select = useStore((s) => s.selectWorker);
  const openModal = useStore((s) => s.openModal);
  const [error, setError] = useState<string | null>(null);

  const orders = useMemo(() => Object.values(ordersMap).filter((o) => o.workerId === id).sort((a, b) => b.createdAt - a.createdAt), [ordersMap, id]);
  const markers: ChartMarker[] = useMemo(
    () =>
      orders
        .filter((o) => o.filledQty > 0 && o.filledAt)
        .map((o) => ({
          time: o.filledAt!,
          side: o.side,
          text: `${o.purpose === 'ENTRY' ? 'IN' : 'OUT'} ${o.filledQty}${o.filledAvgPrice ? ` @${price(o.filledAvgPrice)}` : ''}`,
        })),
    [orders],
  );

  if (!w) return <Drawer open={false} onClose={() => select(null)} title="" children={null} />;
  const s = w.stats;
  const color = directionColor(w);

  return (
    <Drawer open={!!w} onClose={() => select(null)} title={`${w.config.name} · TRADING DESK`} width={WORKER_DESK_WIDTH}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-3 w-1" style={{ background: color }} />
              <span className="label-strong text-[13px]" style={{ color: TOWER_COLORS[w.towerState] }}>
                {w.statusText}
              </span>
            </div>
            <div className="label mt-1">
              {w.config.strategyName} · {w.config.symbol} · {w.config.timeframe.replace('Min', 'm')} · {w.config.instrument}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="label">Autotrading</span>
            <Toggle
              label={`${w.config.name} autotrading`}
              on={w.autotradeEnabled}
              onChange={async (on) => {
                setError(null);
                if (on) return openModal({ kind: 'enable-worker', workerId: w.config.id });
                try {
                  await Api.setWorkerEnabled(w.config.id, false);
                } catch (e) {
                  setError(e instanceof ApiError ? e.message : String(e));
                }
              }}
            />
          </div>
        </div>
        <ErrorText>{error}</ErrorText>
        {w.unmanagedWarning && <div className="border-l-2 border-pending bg-pending/5 px-2 py-1.5 text-[12px] text-pending">{w.unmanagedWarning}</div>}

        <PriceChart symbol={w.config.symbol} markers={markers} defaultTf={w.config.timeframe} height={260} />

        <section>
          <div className="label mb-2">Signal scanner</div>
          <Scanner workerId={w.config.id} embedded />
        </section>

        <section>
          <div className="label mb-1">Position</div>
          <PositionBlock w={w} />
        </section>

        <section>
          <div className="label mb-1">Orders</div>
          <OrdersBlock orders={orders} />
        </section>

        <section>
          <div className="label mb-1">Performance (from broker fills)</div>
          <div className="grid grid-cols-4 gap-x-4 gap-y-3">
            {[
              ['Realized today', <Money key="r" value={s.realizedToday} sign />],
              ['Unrealized', <Money key="u" value={s.unrealized} sign />],
              ['Trades today', s.tradesToday],
              ['Win rate', s.winRate === null ? '—' : `${s.winRate.toFixed(1)}%`],
              ['Avg win', s.avgWin === null ? '—' : money(s.avgWin, { sign: true })],
              ['Avg loss', s.avgLoss === null ? '—' : money(s.avgLoss, { sign: true })],
              ['Profit factor', s.profitFactor === null ? '—' : s.profitFactor.toFixed(2)],
              ['Max drawdown', money(s.maxDrawdown, { sign: true })],
              ['Realized all-time', <Money key="a" value={s.realizedAllTime} sign />],
              ['Trades all-time', s.tradesAllTime],
              ['Daily goal', money(w.config.limits.dailyGoal)],
              ['Daily loss limit', `−${money(w.config.limits.dailyLossLimit)}`],
            ].map(([label, value]) => (
              <div key={label as string}>
                <div className="label">{label}</div>
                <div className="num text-[13px]">{value}</div>
              </div>
            ))}
          </div>
          <div className="label mt-2 !text-[9.5px]">
            Limits: {w.config.limits.maxTradesPerDay} trades/day · {w.config.limits.maxContracts} contracts · {money(w.config.limits.maxPositionNotional)} max position · exits TP {w.config.exits.takeProfitPct}% / SL {w.config.exits.stopLossPct}% · last evaluated {dateTimeET(w.lastEvaluatedAt)}
          </div>
        </section>
      </div>
    </Drawer>
  );
}
