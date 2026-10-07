import { useEffect, useState } from 'react';
import { directionLabel, instrumentName, type JournalTradeView, type StreamStatusView } from '@scalp-city/shared';
import { Api, ApiError } from '../../lib/api';
import { age, dateET, dateTimeET, envLabel, humanize, money, pnlClass, price, px, qtyStr, timeET } from '../../lib/format';
import { serverNow, useStore } from '../../store/store';
import { useReadiness } from './Risk';
import { Btn, Check, cx, Dot, ErrorText, Row } from '../ui';

/** LIVE TRADING configuration and readiness (spec §104, §124, §125). */
export function LiveDrawerBody() {
  const system = useStore((s) => s.system);
  const risk = useStore((s) => s.risk);
  const openModal = useStore((s) => s.openModal);
  const { data: readiness, error } = useReadiness(true);
  const [msg, setMsg] = useState<string | null>(null);
  if (!system || !risk) return null;
  const live = system.env === 'live';
  const L = risk.limits;
  const other = live ? 'paper' : 'live';
  const cfd = system.venue === 'oanda';
  const envName = envLabel(system.env, system.venue);
  const otherName = envLabel(other, system.venue);
  return (
    <div className="flex flex-col gap-5 p-4">
      <section className={cx('border p-3', live ? 'border-live/60 bg-live/5' : 'border-paper/40')}>
        <div className="label">Environment</div>
        <div className={cx('display mt-0.5 text-[22px]', live ? 'text-live' : 'text-paper')}>{envName}</div>
        <div className="label mt-0.5">
          {system.broker.name.toUpperCase()}
          {system.broker.accountMasked ? ` · ${system.broker.accountMasked}` : ''}
          {!live && cfd ? ' · simulated money, real prices' : ''}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-8">
          <div>
            <Row label="Server lock">{system.live.serverLockOpen ? <span className="text-pending">OPEN</span> : 'LOCKED'}</Row>
            <Row label="Execution">{live ? (system.live.armed ? <span className="text-live">ARMED</span> : 'NOT ARMED') : envName.toLowerCase()}</Row>
            <Row label="Autotrading">{system.controls.autotrading ? 'ON' : 'OFF'}</Row>
            <Row label="Kill switch">{system.controls.killSwitch.active ? <span className="text-put">ACTIVE</span> : 'READY'}</Row>
          </div>
          <div>
            <Row label="Max daily loss">−{money(L.maxDailyLoss)}</Row>
            <Row label="Max position">{money(L.maxPositionNotional)}</Row>
            {cfd ? <Row label="Max loss / trade">{money(L.maxRiskPerTrade)}</Row> : <Row label="Max contracts">{L.maxContracts}</Row>}
            <Row label="Max positions">{L.maxConcurrentPositions}</Row>
            <Row label="Max trades">{L.maxTradesPerDay}</Row>
          </div>
        </div>
        {live && system.live.armed && (
          <div className="mt-2 text-[12px] text-fg-2">
            Armed by {system.live.armedBy} at {dateTimeET(system.live.armedAt)}. Orders submitted now are real-money orders.
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {live && !system.live.armed && (
            <Btn variant="danger" onClick={() => openModal({ kind: 'enable-live' })} disabled={!system.live.serverLockOpen}>
              Enable live trading
            </Btn>
          )}
          {live && system.live.armed && (
            <Btn
              variant="outline"
              onClick={async () => {
                await Api.disarmLive();
                setMsg('Live execution disarmed.');
              }}
            >
              Disarm live execution
            </Btn>
          )}
          {system.availableEnvs.includes(other) && (
            <Btn variant={other === 'live' ? 'warn' : 'outline'} onClick={() => openModal({ kind: 'switch-env', target: other })}>
              Switch to {otherName}
            </Btn>
          )}
        </div>
        {!system.live.serverLockOpen && live && <div className="label mt-2">LIVE_TRADING_ENABLED=false on the server — live orders are refused regardless of this app.</div>}
        {msg && <div className="label mt-2 !text-fg-2">{msg}</div>}
      </section>

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label">Live trading readiness</span>
          {readiness && <span className={cx('label-strong text-[11px]', readiness.ready ? 'text-call' : 'text-put')}>{readiness.ready ? 'SYSTEM READY' : 'NOT READY'}</span>}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {readiness?.items.map((i) => <Check key={i.id} ok={i.ok} label={i.label} detail={i.detail} />)}
        </div>
        <div className="label mt-2">Checked {timeET(readiness?.checkedAt)} · re-verified server-side when you arm</div>
      </section>
    </div>
  );
}

function StreamRow({ label, s }: { label: string; s: StreamStatusView }) {
  const status = s.state === 'CONNECTED' ? 'ok' : s.state === 'CONNECTING' || s.state === 'RECONNECTING' ? 'warn' : 'error';
  return (
    <div className="flex items-center justify-between border-b border-line/50 py-1.5 last:border-b-0">
      <span className="flex items-center gap-2">
        <Dot status={status} pulse={status === 'ok'} />
        <span className="label-strong text-[11px] text-fg">{label}</span>
      </span>
      <span className="num text-[11px] text-fg-2">
        {s.state}
        {s.reconnectAttempts ? ` · retry ${s.reconnectAttempts}` : ''}
        {s.lastError ? ` · ${s.lastError}` : ''}
      </span>
    </div>
  );
}

/** System health (spec §89). */
export function HealthDrawerBody() {
  const system = useStore((s) => s.system);
  const usesOptions = useStore((s) => Object.values(s.workers).some((w) => w.config.instrument === 'OPTIONS'));
  if (!system) return null;
  const md = system.marketData;
  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <div className="label mb-1.5">System health</div>
        {system.health.map((h) => (
          <div key={h.id} className="flex items-center justify-between border-b border-line/50 py-2 last:border-b-0">
            <span className="flex items-center gap-2">
              <Dot status={h.status} pulse={h.status === 'ok'} />
              <span className="label-strong text-[12px] text-fg">{h.label}</span>
            </span>
            <span className="num max-w-[60%] truncate text-right text-[11px] text-fg-2" title={h.detail}>
              {h.detail}
            </span>
          </div>
        ))}
      </section>
      <section>
        <div className="label mb-1.5">Streams</div>
        {system.venue === 'oanda' ? (
          <>
            <StreamRow label="OANDA transaction stream (fills, stops)" s={system.broker.tradeStream} />
            <StreamRow label="OANDA price stream" s={md.stock} />
          </>
        ) : (
          <>
            <StreamRow label="Broker order stream" s={system.broker.tradeStream} />
            <StreamRow label={`Stock data · ${md.stockFeed.toUpperCase()}`} s={md.stock} />
            {usesOptions ? (
              <StreamRow label={`Options data · ${md.optionsFeed.toUpperCase()}`} s={md.options} />
            ) : (
              <div className="flex items-center justify-between border-b border-line/50 py-1.5 last:border-b-0">
                <span className="flex items-center gap-2">
                  <Dot status="off" />
                  <span className="label-strong text-[11px] text-fg-3">Options data</span>
                </span>
                <span className="num text-[11px] text-fg-3">not used by the share workers</span>
              </div>
            )}
          </>
        )}
      </section>
      <section>
        <div className="label mb-1.5">
          Data freshness (max {age(md.maxDataAgeMs)}
          {system.venue === 'alpaca' && system.market.sessions !== 'regular' && md.offHoursMaxDataAgeMs > md.maxDataAgeMs ? `, ${age(md.offHoursMaxDataAgeMs)} outside 09:30–16:00` : ''})
        </div>
        {Object.entries(md.symbols).map(([sym, v]) => (
          <Row key={sym} label={instrumentName(sym)}>
            <span className={v.stale ? 'text-pending' : 'text-call'}>{v.stale ? 'STALE' : 'LIVE'}</span> <span className="text-fg-2">{age(v.ageMs)}</span>
          </Row>
        ))}
        <div className="label mt-2">
          {md.stockFeedLabel}
          {system.venue === 'oanda' ? ' · mid of bid/ask · volume = tick count' : usesOptions ? ` · ${md.optionsFeedLabel}${md.optionsBlockReason ? ` · ${md.optionsBlockReason}` : ''}` : md.stockPartialVolume ? ' · this feed shows only part of the market volume, so VWAP and volume are computed from that part only' : ''}
        </div>
      </section>
      <section>
        <div className="label mb-1.5">Clock</div>
        <Row label="Server time (ET)">{timeET(serverNow())}</Row>
        <Row label="Skew vs broker">
          <span className={system.clock.ok ? 'text-call' : 'text-put'}>{system.clock.brokerSkewMs === null ? 'not verified' : `${system.clock.brokerSkewMs}ms`}</span>
        </Row>
        {system.venue === 'alpaca' && <Row label="Trading hours">{system.market.sessions === 'all' ? 'all sessions' : system.market.sessions === 'extended' ? 'extended hours' : 'regular session'}</Row>}
        <Row label="Phase">{humanize(system.phase)}</Row>
        <div className="label mt-1">{system.phaseDetail}</div>
      </section>
    </div>
  );
}

/** Trade journal (spec §117). */
export function JournalDrawerBody() {
  const openModal = useStore((s) => s.openModal);
  const [trades, setTrades] = useState<JournalTradeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeline = useStore((s) => s.timeline.length);
  useEffect(() => {
    Api.journal()
      .then(setTrades)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [timeline]);
  return (
    <div className="p-3">
      <ErrorText>{error}</ErrorText>
      {trades && trades.length === 0 && <div className="label p-1">No trades recorded in this environment yet.</div>}
      {trades?.map((t) => (
        <button key={t.id} onClick={() => openModal({ kind: 'trade-review', tradeId: t.id })} className="grid w-full grid-cols-[72px_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-line/50 py-2 text-left hover:bg-ink-700/40">
          <span className="num text-[10.5px] text-fg-3">
            {dateET(t.openedAt)} {timeET(t.openedAt).slice(0, 5)}
          </span>
          <span className="min-w-0 truncate">
            <span className="label-strong mr-2 text-[10.5px]" style={{ color: t.direction === 'PUT' ? 'var(--color-put)' : 'var(--color-call)' }}>
              {directionLabel(t.direction, t.assetClass)}
            </span>
            <span className="label-strong mr-2 text-[10.5px] text-fg">{t.workerName ?? 'MANUAL'}</span>
            <span className="num text-[11px] text-fg-2">
              {qtyStr(t.qty)} {t.option ? `${t.option.underlying} ${price(t.option.strike)}${t.option.type[0]!.toUpperCase()}` : instrumentName(t.symbol)} · {px(t.symbol, t.entryAvgPrice)} → {px(t.symbol, t.exitAvgPrice)}
            </span>
            {t.exitReason && <span className="label ml-2">{humanize(t.exitReason)}</span>}
          </span>
          <span className={cx('num text-[12px]', t.status === 'OPEN' ? 'text-pending' : pnlClass(t.realizedPnl))}>{t.status === 'OPEN' ? 'OPEN' : money(t.realizedPnl, { sign: true })}</span>
        </button>
      ))}
    </div>
  );
}

/** Immutable audit log (spec §38) with chain verification. */
export function AuditDrawerBody() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof Api.audit>>>([]);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAtId: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Api.audit()
      .then(setRows)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, []);
  return (
    <div className="p-3">
      <div className="mb-2 flex items-center gap-3">
        <Btn
          variant="outline"
          onClick={async () => {
            setVerify(null);
            setVerify(await Api.auditVerify());
          }}
        >
          Verify hash chain
        </Btn>
        {verify && (
          <span className={cx('label-strong text-[11px]', verify.ok ? 'text-call' : 'text-put')}>
            {verify.ok ? `INTACT · ${verify.checked} records` : `BROKEN at record ${verify.brokenAtId}`}
          </span>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[118px_minmax(0,1fr)] gap-2 border-b border-line/40 py-1.5">
          <span className="num text-[10.5px] text-fg-3">{dateTimeET(r.occurredAt)}</span>
          <span className="min-w-0">
            <span className="label-strong mr-2 text-[10.5px] text-fg">{humanize(r.action)}</span>
            <span className="label mr-2">{r.actor}</span>
            {r.env && <span className={cx('label mr-2', r.env === 'live' ? '!text-live' : '!text-paper')}>{r.env}</span>}
            {r.symbol && <span className="num mr-2 text-[10.5px] text-fg-2">{r.symbol}</span>}
            {Object.keys(r.details).length > 0 && <div className="num truncate text-[10px] text-fg-3">{JSON.stringify(r.details)}</div>}
          </span>
        </div>
      ))}
    </div>
  );
}
