import { useEffect, useMemo, useState } from 'react';
import type { OrderView } from '@scalp-city/shared';
import { Api, ApiError } from '../../lib/api';
import { age, dateTimeET, humanize, money, pct, pnlClass, price, timeET } from '../../lib/format';
import { useStore } from '../../store/store';
import { Btn, cx, ErrorText, Money, Row } from '../ui';

/** Account panel (spec §52) — broker values, never recomputed in the UI. */
export function AccountDrawerBody() {
  const a = useStore((s) => s.account);
  const positions = useStore((s) => s.positions.length);
  const openOrders = useStore((s) => Object.values(s.orders).filter((o) => ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'SUBMITTING'].includes(o.state)).length);
  const system = useStore((s) => s.system);
  if (!a || !system) return null;
  return (
    <div className="p-4">
      <div className="label">Equity</div>
      <div className="num text-[34px] font-medium">{a.equity === null ? <span className="label">UNAVAILABLE</span> : money(a.equity)}</div>
      <div className="mt-1 flex gap-2">
        <span className={cx('num text-[16px]', pnlClass(a.dayPnl))}>{money(a.dayPnl, { sign: true })}</span>
        <span className={cx('num text-[13px]', pnlClass(a.dayPnl))}>{pct(a.dayPnlPct, { sign: true })}</span>
        <span className="label self-center">day (equity − last equity, broker)</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-8">
        <div>
          <Row label="Cash"><Money value={a.cash} /></Row>
          <Row label="Buying power"><Money value={a.buyingPower} /></Row>
          <Row label="Options buying power"><Money value={a.optionsBuyingPower} /></Row>
          <Row label="Day-trading BP"><Money value={a.daytradingBuyingPower} /></Row>
          <Row label="Portfolio value"><Money value={a.portfolioValue} /></Row>
          <Row label="Long market value"><Money value={a.longMarketValue} /></Row>
          <Row label="Short market value"><Money value={a.shortMarketValue} /></Row>
        </div>
        <div>
          <Row label="Day P&L"><Money value={a.dayPnl} sign /></Row>
          <Row label="Realized (derived)"><Money value={a.realizedPnlDerived} sign /></Row>
          <Row label="Unrealized"><Money value={a.unrealizedPnl} sign /></Row>
          <Row label="Unrealized intraday"><Money value={a.unrealizedIntradayPnl} sign /></Row>
          <Row label="Initial margin"><Money value={a.initialMargin} /></Row>
          <Row label="Maintenance margin"><Money value={a.maintenanceMargin} /></Row>
          <Row label="Multiplier">{a.multiplier === null ? '—' : `${a.multiplier}×`}</Row>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-8">
        <div>
          <Row label="Open positions">{positions}</Row>
          <Row label="Open orders">{openOrders}</Row>
          <Row label="Broker">ALPACA</Row>
          <Row label="Environment">
            <span className={system.env === 'live' ? 'text-live' : 'text-paper'}>{system.env.toUpperCase()}</span>
          </Row>
          <Row label="Account">{a.accountNumberMasked ?? '—'}</Row>
        </div>
        <div>
          <Row label="Status">{a.status ?? '—'}</Row>
          <Row label="Trading blocked">{a.tradingBlocked === null ? '—' : a.tradingBlocked ? 'YES' : 'no'}</Row>
          <Row label="Pattern day trader">{a.patternDayTrader === null ? '—' : a.patternDayTrader ? 'YES' : 'no'}</Row>
          <Row label="Day trades (5d)">{a.daytradeCount ?? '—'}</Row>
          <Row label="Options level">{a.optionsTradingLevel ?? a.optionsApprovedLevel ?? '—'}</Row>
        </div>
      </div>
      <div className="label mt-3">Fetched from broker {a.updatedAt ? `${age(Date.now() + useStore.getState().conn.serverOffset - a.updatedAt)} ago` : '—'} · "Realized (derived)" = day P&L − intraday unrealized; deposits, fees and dividends fall into it.</div>
    </div>
  );
}

/** Positions (spec §16, §54): broker positions with live marks and worker attribution. */
export function PositionsDrawerBody() {
  const positions = useStore((s) => s.positions);
  const workers = useStore((s) => s.workers);
  const openDrawer = useStore((s) => s.openDrawer);
  if (!positions.length) return <div className="label p-4">No open positions at the broker.</div>;
  return (
    <div className="p-3">
      {positions.map((p) => (
        <div key={p.symbol} className="border-b border-line py-3 last:border-b-0">
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <span className="display text-[16px]">{p.option ? p.option.underlying : p.symbol}</span>
              <span className={cx('num text-[14px]', p.side === 'long' ? 'text-call' : 'text-put')}>
                {p.side === 'long' ? '+' : '−'}
                {p.qty}
              </span>
              {p.option && (
                <span className="label-strong text-[10.5px] text-fg-2">
                  {p.option.type.toUpperCase()} {price(p.option.strike)} · {p.option.expiration}
                </span>
              )}
            </div>
            <span className={cx('num text-[16px]', pnlClass(p.unrealizedPnl))}>{money(p.unrealizedPnl, { sign: true })}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-3 gap-x-6">
            <Row label="Average">{price(p.avgEntryPrice)}</Row>
            <Row label="Current">
              {price(p.markPrice)} <span className="label">{p.markSource === 'quote_mid' ? 'mid' : p.markSource === 'last_trade' ? 'last' : p.markSource === 'broker' ? 'broker' : ''}</span>
            </Row>
            <Row label="Market value"><Money value={p.marketValue} /></Row>
            <Row label="Unrealized %"><span className={pnlClass(p.unrealizedPnlPct)}>{pct(p.unrealizedPnlPct, { sign: true })}</span></Row>
            <Row label="Realized today"><Money value={p.realizedPnlToday} sign /></Row>
            <Row label="Owner">{p.workerId ? (workers[p.workerId]?.config.name ?? p.workerId) : 'external'}</Row>
          </div>
          {p.option && <div className="num mt-1 text-[10.5px] text-fg-3">{p.symbol}</div>}
        </div>
      ))}
      <Btn variant="outline" className="mt-2" onClick={() => openDrawer('trade')}>
        Close a position manually
      </Btn>
    </div>
  );
}

function stateColor(o: OrderView): string {
  if (o.state === 'FILLED') return 'var(--color-call)';
  if (o.state === 'REJECTED' || o.state === 'ERROR') return 'var(--color-put)';
  if (o.state === 'CANCELED' || o.state === 'EXPIRED') return 'var(--color-fg-3)';
  return 'var(--color-pending)';
}

/** Orders (spec §53): working first, cancellation is a real broker request. */
export function OrdersDrawerBody() {
  const ordersMap = useStore((s) => s.orders);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Awaited<ReturnType<typeof Api.orderEvents>>>([]);
  const orders = useMemo(() => {
    const live = new Set(['SUBMITTING', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_PENDING']);
    return Object.values(ordersMap).sort((a, b) => Number(live.has(b.state)) - Number(live.has(a.state)) || b.createdAt - a.createdAt);
  }, [ordersMap]);

  useEffect(() => {
    if (!expanded) return;
    Api.orderEvents(expanded).then(setEvents).catch(() => setEvents([]));
  }, [expanded, ordersMap]);

  return (
    <div className="p-3">
      {info && <div className="mb-2 border-l-2 border-signal px-2 py-1 text-[12px] text-fg-2">{info}</div>}
      <ErrorText>{error}</ErrorText>
      {!orders.length && <div className="label p-1">No orders this session.</div>}
      {orders.map((o) => (
        <div key={o.id} className="border-b border-line/60 py-2 last:border-b-0">
          <button className="grid w-full grid-cols-[64px_minmax(0,1fr)_auto] items-baseline gap-2 text-left" onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
            <span className="num text-[10.5px] text-fg-3">{timeET(o.submittedAt ?? o.createdAt)}</span>
            <span className="min-w-0 truncate">
              <span className="label-strong mr-2 text-[10.5px]" style={{ color: o.side === 'buy' ? 'var(--color-call)' : 'var(--color-put)' }}>
                {o.side.toUpperCase()}
              </span>
              <span className="num text-[12px]">
                {o.qty} {o.symbol}
              </span>
              <span className="num ml-2 text-[10.5px] text-fg-3">
                {o.type.replace('_', ' ')}
                {o.limitPrice ? ` lmt ${price(o.limitPrice)}` : ''}
                {o.stopPrice ? ` stp ${price(o.stopPrice)}` : ''} · {humanize(o.purpose).toLowerCase()} · {o.source.toLowerCase()}
              </span>
            </span>
            <span className="label-strong text-[10.5px]" style={{ color: stateColor(o) }}>
              {humanize(o.state)}
            </span>
          </button>
          <div className="mt-1 flex items-center gap-3 pl-[72px]">
            <span className="num text-[10.5px] text-fg-2">
              filled {o.filledQty}/{o.qty}
              {o.filledAvgPrice ? ` @ ${price(o.filledAvgPrice)}` : ''}
            </span>
            <span className="num text-[10px] text-fg-3">{o.clientOrderId.slice(0, 22)}…</span>
            {o.cancelable && (
              <Btn
                variant="outline"
                className="!h-6"
                onClick={async () => {
                  setError(null);
                  setInfo(null);
                  try {
                    const r = await Api.cancelOrder(o.id);
                    setInfo(r.message);
                  } catch (e) {
                    setError(e instanceof ApiError ? e.message : String(e));
                  }
                }}
              >
                Cancel
              </Btn>
            )}
          </div>
          {(o.rejectReason || o.errorMessage) && <div className="mt-1 pl-[72px] text-[11px] text-put">{o.rejectReason ?? o.errorMessage}</div>}
          {expanded === o.id && (
            <div className="ml-[72px] mt-2 border-l border-line-2 pl-3">
              {o.risk && (
                <div className="mb-1.5">
                  <span className="label">Risk {o.risk.approved ? 'approved' : 'blocked'} · {o.risk.checks.length} checks</span>
                </div>
              )}
              {events.map((e, i) => (
                <div key={i} className="num text-[10.5px] text-fg-2">
                  {dateTimeET(e.occurredAt)} · {e.event} → {humanize(e.toState)}
                  {e.fillQty ? ` · ${e.fillQty} @ ${price(e.fillPrice)}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
