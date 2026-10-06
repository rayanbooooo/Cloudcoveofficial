import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { instrumentDescription, instrumentName, type OrderView, type WorkerView } from '@scalp-city/shared';
import { Api, ApiError } from '../lib/api';
import { WORKER_DESK_WIDTH } from '../lib/layout';
import { useIsMobile } from '../lib/useIsMobile';
import { dateTimeET, humanize, money, pct, pnlClass, price, px, qtyStr, timeET } from '../lib/format';
import { useStore } from '../store/store';
import { Scanner } from './panels/Scanner';
import { WhyNotPlacing } from './WhyNot';
import { directionColor, TOWER_COLORS } from './panels/Workers';
import { PriceChart, type ChartLevel, type ChartMarker } from './PriceChart';
import { cx, Drawer, ErrorText, Money, Row, Toggle } from './ui';

// The 3D desk shares the three.js chunk with the city, so it costs almost nothing until a tower is opened;
// it is fetched shortly after start-up so the first click doesn't wait for it.
const loadStage = () => import('../city/RobotStage');
const RobotStage = lazy(loadStage);

function PositionBlock({ w }: { w: WorkerView }) {
  const optionQuotes = useStore((s) => s.optionQuotes);
  const p = w.position;
  if (!p) return <div className="label py-2">Flat — no position.</div>;
  const q = optionQuotes[p.symbol];
  const isOption = p.assetClass === 'us_option';
  const cfd = p.assetClass === 'cfd';
  // Shares carry a stop too, but this server holds it (the broker does not).
  const planned = cfd || p.stopSource === 'server';
  const long = p.qty > 0;
  const mult = isOption ? 100 : 1;
  const sym = p.symbol;
  const one = Math.abs(p.qty) === 1;
  const unit = isOption ? (one ? ' contract' : ' contracts') : cfd ? (one ? ' unit' : ' units') : one ? ' share' : ' shares';
  const m = w.market;
  // Account-currency exposure: units × price × the broker's quote→account conversion.
  const exposure = cfd ? (p.markPrice !== null && m?.homeFactor != null ? p.markPrice * Math.abs(p.qty) * m.homeFactor : null) : p.markPrice === null ? null : p.markPrice * Math.abs(p.qty) * mult;
  const stopDistance = planned && p.stopPrice !== null ? Math.abs(p.avgEntryPrice - p.stopPrice) : null;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="display text-[16px]" style={{ color: (isOption ? p.direction === 'PUT' : !long) ? 'var(--color-put)' : 'var(--color-call)' }}>
          {isOption ? p.option?.type.toUpperCase() : long ? 'LONG' : 'SHORT'} · {cfd ? instrumentName(sym) : sym}
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
        <Row label="Quantity">{qtyStr(Math.abs(p.qty))}{unit}</Row>
        <Row label="Average fill">{px(sym, p.avgEntryPrice)}</Row>
        <Row label="Current">{px(sym, p.markPrice)}</Row>
        <Row label="Market value">{money(exposure)}</Row>
        {planned && (
          <>
            <Row label={cfd ? 'Stop (held by OANDA)' : 'Stop (held by this server)'}>
              {p.stopPrice === null ? <span className="text-pending">NONE</span> : <>{px(sym, p.stopPrice)}<span className="ml-1 text-[10.5px] text-fg-3">({px(sym, stopDistance)} away)</span></>}
            </Row>
            <Row label="Target (bot exits)">{p.targetPrice === null ? '—' : px(sym, p.targetPrice)}</Row>
            <Row label="Loss if stop hit">{p.riskAtStop === null ? '—' : <span className="text-put">−{money(p.riskAtStop)}</span>}</Row>
          </>
        )}
        <Row label="Unrealized %">
          <span className={pnlClass(p.unrealizedPnlPct)}>{pct(p.unrealizedPnlPct, { sign: true })}</span>
        </Row>
        <Row label="Opened">{timeET(p.openedAt)}</Row>
      </div>
      {cfd && <div className="label mt-1 !text-[9.5px]">The stop lives at OANDA, so it still protects this position if this app or its server goes offline. The target is exited by the bot.</div>}
      {!cfd && p.stopSource === 'server' && <div className="label mt-1 !text-[9.5px]">The stop and the target are enforced by this server, not placed at the broker: they only protect this position while the server is running.</div>}
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
              {o.purpose === 'PROTECTIVE_STOP' ? 'STOP' : o.purpose === 'ENTRY' ? 'ENTRY' : 'EXIT'} {o.side.toUpperCase()}
            </span>
            <span className="num text-[11px] text-fg">
              {qtyStr(o.filledQty)}/{qtyStr(o.qty)} {instrumentName(o.symbol)}
            </span>
            <span className="num ml-1.5 text-[10.5px] text-fg-3">
              {o.purpose === 'PROTECTIVE_STOP' ? 'broker stop' : o.type}
              {o.stopPrice ? ` @${px(o.symbol, o.stopPrice)}` : o.limitPrice ? ` @${px(o.symbol, o.limitPrice)}` : ''}
              {o.filledAvgPrice ? ` · fill ${px(o.symbol, o.filledAvgPrice)}` : ''}
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
  const mobile = useIsMobile();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => void loadStage(), 2500);
    return () => window.clearTimeout(t);
  }, []);

  const orders = useMemo(() => Object.values(ordersMap).filter((o) => o.workerId === id).sort((a, b) => b.createdAt - a.createdAt), [ordersMap, id]);
  const markers: ChartMarker[] = useMemo(
    () =>
      orders
        .filter((o) => o.filledQty > 0 && o.filledAt)
        .map((o) => ({
          time: o.filledAt!,
          side: o.side,
          text: `${o.purpose === 'ENTRY' ? 'IN' : 'OUT'} ${qtyStr(o.filledQty)}${o.filledAvgPrice ? ` @${px(o.symbol, o.filledAvgPrice)}` : ''}`,
        })),
    [orders],
  );

  if (!w) return <Drawer open={false} onClose={() => select(null)} title="" children={null} />;
  const s = w.stats;
  const color = directionColor(w);
  const cfd = w.config.instrument === 'CFD';
  const pos = w.position;
  const levels: ChartLevel[] =
    cfd && pos
      ? [
          { price: pos.avgEntryPrice, color: '#dce6f5', title: `ENTRY ${qtyStr(Math.abs(pos.qty))}` },
          ...(pos.stopPrice !== null ? [{ price: pos.stopPrice, color: '#ff4d6d', title: 'STOP (broker)' }] : []),
          ...(pos.targetPrice !== null ? [{ price: pos.targetPrice, color: '#2ee6a6', title: 'TARGET' }] : []),
        ]
      : [];

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
            <div className="label mt-1" title={instrumentDescription(w.config.symbol)}>
              {w.config.strategyName} · {instrumentName(w.config.symbol)} · {w.config.timeframe.replace('Min', 'm')} · {cfd ? (w.config.allowShort ? 'CFD · long & short' : 'CFD · long only') : w.config.instrument}
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
        <WhyNotPlacing w={w} headline={w.signal.phase === 'READY'} />
        {w.unmanagedWarning && <div className="border-l-2 border-pending bg-pending/5 px-2 py-1.5 text-[12px] text-pending">{w.unmanagedWarning}</div>}

        <Suspense fallback={<div className="label flex items-center justify-center border border-line" style={{ height: mobile ? 250 : 340 }}>Loading desk…</div>}>
          <RobotStage workerId={w.config.id} height={mobile ? 250 : 340} lowPower={mobile} />
        </Suspense>

        {w.market && !w.market.listed && (
          <div className="border-l-2 border-pending bg-pending/5 px-2 py-1.5 text-[12px] text-pending">
            {instrumentName(w.config.symbol)} is not offered to this account by the broker, so this worker cannot trade it.
          </div>
        )}

        {!(w.market && !w.market.listed) && <PriceChart symbol={w.config.symbol} markers={markers} levels={levels} defaultTf={w.config.timeframe} height={260} />}

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
            {cfd
              ? `Limits: ${w.config.limits.maxTradesPerDay} trades/day · risks ≤ ${money(w.config.limits.riskPerTrade)} per trade · stop ${w.config.exits.stopAtr}×ATR (held by the broker) / target ${w.config.exits.targetAtr}×ATR · max hold ${w.config.exits.maxHoldMinutes} min · last evaluated ${dateTimeET(w.lastEvaluatedAt)}`
              : `Limits: ${w.config.limits.maxTradesPerDay} trades/day · ${w.config.limits.maxContracts} contracts · ${money(w.config.limits.maxPositionNotional)} max position · exits TP ${w.config.exits.takeProfitPct}% / SL ${w.config.exits.stopLossPct}% · last evaluated ${dateTimeET(w.lastEvaluatedAt)}`}
          </div>
        </section>
      </div>
    </Drawer>
  );
}
