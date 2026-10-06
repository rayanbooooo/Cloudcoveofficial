import { useEffect, useState } from 'react';
import type { RiskLimits, RiskLimitsChangePreview } from '@scalp-city/shared';
import { Api, ApiError } from '../../lib/api';
import { age, dateTimeET, displayCurrency, humanize, money, qtyStr } from '../../lib/format';
import { useStore } from '../../store/store';
import { Btn, Check, cx, ErrorText, Field, inputCls, Money, Row } from '../ui';

/** `unit: 'ccy'` is the account currency (USD, GBP, …). */
interface LimitField {
  key: keyof RiskLimits;
  label: string;
  unit?: string;
  hint?: string;
}

const OPTIONS_LIMIT_FIELDS: LimitField[] = [
  { key: 'maxDailyLoss', label: 'Max daily loss', unit: 'ccy' },
  { key: 'maxPositionNotional', label: 'Max position', unit: 'ccy' },
  { key: 'maxOrderNotional', label: 'Max order value', unit: 'ccy' },
  { key: 'maxContracts', label: 'Max contracts' },
  { key: 'maxShares', label: 'Max shares' },
  { key: 'maxRiskPerTrade', label: 'Max loss per trade (shares)', unit: 'ccy', hint: 'The most a share entry may lose if its stop is hit. Orders that would risk more are refused.' },
  { key: 'maxConcurrentPositions', label: 'Max positions' },
  { key: 'maxTradesPerDay', label: 'Max trades / day' },
  { key: 'maxOrdersPerMinute', label: 'Max orders / minute' },
  { key: 'maxPriceDeviationPct', label: 'Max price deviation', unit: '%' },
  { key: 'noEntriesBeforeCloseMinutes', label: 'No entries before close', unit: 'min' },
];

/**
 * Limits that let the 1-minute scalpers run at full speed on a PAPER account: up to 300 trades a day, all five
 * workers in a position at once, $5,000 per position. Filling the form changes nothing until it is reviewed and confirmed.
 */
const FAST_SCALPING: Partial<Record<keyof RiskLimits, number>> = {
  maxDailyLoss: 300,
  maxPositionNotional: 5000,
  maxOrderNotional: 5000,
  maxShares: 100,
  maxRiskPerTrade: 25,
  maxConcurrentPositions: 5,
  maxTradesPerDay: 300,
  maxOrdersPerMinute: 40,
};

/** OANDA CFDs: sizes are units, so the per-order limits are money values and the per-trade loss at the stop is capped. */
const CFD_LIMIT_FIELDS: LimitField[] = [
  { key: 'maxDailyLoss', label: 'Max daily loss', unit: 'ccy', hint: 'New entries stop for the day once the account is down this much.' },
  { key: 'maxRiskPerTrade', label: 'Max loss per trade', unit: 'ccy', hint: 'The most an order may lose if its stop is hit. Orders that would risk more are refused.' },
  { key: 'maxPositionNotional', label: 'Max position value', unit: 'ccy', hint: 'Open exposure per instrument (units × price, in account currency).' },
  { key: 'maxOrderNotional', label: 'Max order value', unit: 'ccy' },
  { key: 'maxConcurrentPositions', label: 'Max positions' },
  { key: 'maxTradesPerDay', label: 'Max trades / day' },
  { key: 'maxOrdersPerMinute', label: 'Max orders / minute' },
  { key: 'maxPriceDeviationPct', label: 'Max price deviation', unit: '%' },
  { key: 'noEntriesBeforeCloseMinutes', label: 'No entries before session end', unit: 'min' },
];

function LimitsEditor() {
  const risk = useStore((s) => s.risk);
  const live = useStore((s) => s.system?.env === 'live');
  const venue = useStore((s) => s.system?.venue ?? 'alpaca');
  useStore((s) => s.account?.currency);
  const LIMIT_FIELDS = venue === 'oanda' ? CFD_LIMIT_FIELDS : OPTIONS_LIMIT_FIELDS;
  const [draft, setDraft] = useState<Partial<Record<keyof RiskLimits, string>>>({});
  const [preview, setPreview] = useState<RiskLimitsChangePreview | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!risk) return null;
  const L = risk.limits;

  const patch = (): Partial<RiskLimits> => {
    const out: Partial<RiskLimits> = {};
    for (const f of LIMIT_FIELDS) {
      const v = draft[f.key];
      if (v === undefined || v === '') continue;
      (out as Record<string, number>)[f.key] = Number(v);
    }
    return out;
  };

  const review = async () => {
    setError(null);
    setSaved(false);
    try {
      setPreview(await Api.previewRiskLimits(patch()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  const apply = async () => {
    setError(null);
    try {
      await Api.updateRiskLimits(patch(), preview?.increasesRisk ? true : undefined, preview?.requiresPassword ? password : undefined);
      setDraft({});
      setPreview(null);
      setPassword('');
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        {LIMIT_FIELDS.map((f) => (
          <Field key={f.key} label={`${f.label}${f.unit ? ` (${f.unit === 'ccy' ? displayCurrency() : f.unit})` : ''}`}>
            <input
              className={inputCls}
              inputMode="decimal"
              title={f.hint}
              placeholder={String(L[f.key])}
              value={draft[f.key] ?? ''}
              onChange={(e) => {
                setPreview(null);
                setDraft({ ...draft, [f.key]: e.target.value });
              }}
            />
          </Field>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Btn variant="outline" onClick={review} disabled={Object.keys(patch()).length === 0}>
          Review change
        </Btn>
        {venue !== 'oanda' && (
          <Btn
            variant="ghost"
            title="Fills the form for the 1-minute scalpers on a paper account. Nothing changes until you review and confirm."
            onClick={() => {
              setPreview(null);
              setSaved(false);
              setDraft(Object.fromEntries(Object.entries(FAST_SCALPING).map(([k, v]) => [k, String(v)])));
            }}
          >
            Fast scalping preset
          </Btn>
        )}
        {saved && <span className="label !text-call">Saved · audit-logged</span>}
      </div>
      {venue !== 'oanda' && (
        <div className="label mt-1.5 !text-[9.5px]">
          The preset is for PAPER: up to 300 trades a day, 5 positions at once, $5,000 per position. Lower these before real money. On a live margin account under $25,000 the day-trade rule still stops it after three round trips in five days.
        </div>
      )}
      {preview && (
        <div className={cx('mt-3 border p-3', preview.increasesRisk ? 'border-pending/60 bg-pending/5' : 'border-line-2')}>
          <div className={cx('display text-[13px]', preview.increasesRisk ? 'text-pending' : 'text-fg')}>{preview.increasesRisk ? 'THIS INCREASES RISK' : 'Tightens or keeps risk'}</div>
          {preview.changes.map((c) => (
            <div key={c.key} className="num mt-1 flex justify-between text-[12px]">
              <span className="text-fg-2">{LIMIT_FIELDS.find((f) => f.key === c.key)?.label ?? c.key}</span>
              <span className={c.increasesRisk ? 'text-pending' : 'text-fg'}>
                {String(c.from)} → {String(c.to)}
              </span>
            </div>
          ))}
          {preview.changes.some((c) => c.key === 'maxDailyLoss' && c.increasesRisk) && (
            <div className="mt-2 text-[12px] text-pending">This increases the maximum potential daily loss.</div>
          )}
          {preview.requiresPassword && (
            <div className="mt-3">
              <Field label="Password (required to increase risk while LIVE)">
                <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </Field>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Btn variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Btn>
            <Btn variant={preview.increasesRisk ? 'warn' : 'solid'} onClick={apply} disabled={preview.changes.length === 0 || (preview.requiresPassword && !password)}>
              Confirm
            </Btn>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="label mt-2">Limits cannot be disabled. {live ? 'LIVE: increases require your password.' : ''}</div>
    </div>
  );
}

/** Risk dashboard (spec §62), breakers (§90), reconciliation (§35), limits (§102, §104). */
export function RiskDrawerBody() {
  const risk = useStore((s) => s.risk);
  const system = useStore((s) => s.system);
  const openModal = useStore((s) => s.openModal);
  const [error, setError] = useState<string | null>(null);
  if (!risk || !system) return null;
  const rec = system.reconciliation;
  return (
    <div className="flex flex-col gap-5 p-4">
      <section>
        <div className="grid grid-cols-2 gap-x-8">
          <div>
            <Row label="Daily P&L"><Money value={risk.dailyPnl} sign /></Row>
            <Row label="Daily loss limit">−{money(risk.maxDailyLoss)}</Row>
            <Row label="Remaining risk"><Money value={risk.remainingRisk} /></Row>
            <Row label="Open positions">{risk.openPositions} / {risk.maxPositions}</Row>
            <Row label="Open orders">{risk.openOrders}</Row>
          </div>
          <div>
            <Row label="Trades today">{risk.tradesToday} / {risk.maxTradesPerDay}</Row>
            {system.venue === 'oanda' ? <Row label="Margin available"><Money value={risk.marginAvailable} /></Row> : <Row label="Buying power"><Money value={risk.buyingPower} /></Row>}
            <Row label="Data latency">{age(risk.dataLatencyMs)}</Row>
            <Row label="Broker">{humanize(risk.brokerStatus)}</Row>
            <Row label="Trading">
              <span className={risk.entriesAllowed ? 'text-call' : 'text-put'}>{risk.entriesAllowed ? 'ENABLED' : 'BLOCKED'}</span>
            </Row>
          </div>
        </div>
        {risk.dailyLossHalted && <div className="mt-2 border-l-2 border-put bg-put/5 px-2 py-1.5 text-[12px] text-put">TRADING HALTED — Daily loss limit reached. All new entries disabled.</div>}
        {risk.blockReasons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {risk.blockReasons.map((r) => (
              <span key={r} className="label-strong rounded-[1px] border border-line-2 px-1.5 py-[1px] text-[10px] text-pending">
                {r}
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="label mb-1.5">Circuit breakers</div>
        {system.breakers.map((b) => (
          <div key={b.id} className="flex items-center justify-between border-b border-line/50 py-1.5 last:border-b-0">
            <Check ok={!b.tripped} label={b.label} detail={b.tripped ? `${b.detail ?? ''} · ${dateTimeET(b.trippedAt)}` : undefined} />
            {b.tripped && (
              <Btn variant="outline" className="!h-6" onClick={() => openModal({ kind: 'reset-breaker', breakerId: b.id, label: b.label })}>
                Reset
              </Btn>
            )}
          </div>
        ))}
      </section>

      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label">Reconciliation</span>
          <span className={cx('label-strong text-[11px]', rec.status === 'RECONCILED' ? 'text-call' : rec.status === 'MISMATCH' ? 'text-put' : 'text-pending')}>{rec.status}</span>
        </div>
        {rec.mismatches.map((m) => (
          <div key={`${m.kind}${m.symbol}`} className="border-l-2 border-put bg-put/5 px-2 py-1.5 text-[12px]">
            <div className="label-strong text-[10.5px] text-put">{humanize(m.kind)}</div>
            <div className="num grid grid-cols-3 gap-2 text-[12px]">
              <span>{m.symbol}</span>
              <span>Local {qtyStr(m.local)}</span>
              <span>Broker {qtyStr(m.broker)}</span>
            </div>
          </div>
        ))}
        {rec.status === 'MISMATCH' && <div className="mt-1 text-[12px] text-put">Trading disabled until state is reconciled.</div>}
        {rec.externalPositions.length > 0 && <div className="label mt-1">External holdings (not traded by workers): {rec.externalPositions.join(', ')}</div>}
        <div className="mt-2 flex gap-2">
          <Btn
            variant="outline"
            onClick={async () => {
              setError(null);
              try {
                await Api.reconcileRun();
              } catch (e) {
                setError(e instanceof ApiError ? e.message : String(e));
              }
            }}
          >
            Run now
          </Btn>
          {rec.status === 'MISMATCH' && (
            <Btn variant="warn" onClick={() => openModal({ kind: 'accept-reconciliation' })}>
              Accept broker state
            </Btn>
          )}
        </div>
        <div className="label mt-1">Last run {dateTimeET(rec.lastRunAt)}</div>
        <ErrorText>{error}</ErrorText>
      </section>

      <section>
        <div className="label mb-2">Risk limits</div>
        <LimitsEditor />
      </section>
    </div>
  );
}

export function useReadiness(enabled: boolean) {
  const [data, setData] = useState<Awaited<ReturnType<typeof Api.readiness>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      Api.readiness()
        .then((r) => alive && setData(r))
        .catch((e) => alive && setError(e instanceof ApiError ? e.message : String(e)));
    void load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [enabled]);
  return { data, error };
}
