import { useEffect, useMemo, useState } from 'react';
import { instrumentName, SUPPORTED_ORDER_TYPES, type AssetClass, type ManualOrderRequest, type OrderPreview, type OrderType, type WorkerView } from '@scalp-city/shared';
import { Api, ApiError } from '../../lib/api';
import { countdown, displayCurrency, humanize, money, pct, price, px, qtyStr, unitsStr } from '../../lib/format';
import { serverNow, useStore } from '../../store/store';
import { Btn, Check, cx, ErrorText, Field, inputCls, Row, Toggle } from '../ui';

const seg = (active: boolean) => cx('label-strong flex-1 border px-2 py-1.5 text-[10.5px]', active ? 'border-fg-2 bg-ink-600 text-fg' : 'border-line-2 text-fg-3 hover:text-fg-2');

/** Manual order ticket (spec §55–58). Uses the same RiskEngine as the workers. */
export function TradeDrawerBody() {
  const venue = useStore((s) => s.system?.venue);
  return venue === 'oanda' ? <CfdTicket /> : <EquityOptionTicket />;
}

function EquityOptionTicket() {
  const system = useStore((s) => s.system);
  const quotes = useStore((s) => s.quotes);
  const positions = useStore((s) => s.positions);
  const [assetClass, setAssetClass] = useState<'us_equity' | 'us_option'>('us_equity');
  const [symbol, setSymbol] = useState('QQQ');
  const [underlying, setUnderlying] = useState('QQQ');
  const [optType, setOptType] = useState<'call' | 'put'>('call');
  const [contracts, setContracts] = useState<Awaited<ReturnType<typeof Api.optionContracts>>>([]);
  const [expiration, setExpiration] = useState('');
  const [contract, setContract] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [intent, setIntent] = useState<'open' | 'close'>('open');
  const [qty, setQty] = useState('1');
  const [type, setType] = useState<OrderType>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = system?.env === 'live';

  useEffect(() => {
    if (assetClass !== 'us_option') return;
    setError(null);
    Api.optionContracts(underlying, optType)
      .then((list) => {
        setContracts(list);
        const exps = [...new Set(list.map((c) => c.expiration))].sort();
        setExpiration((e) => (exps.includes(e) ? e : (exps[0] ?? '')));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [assetClass, underlying, optType]);

  const expirations = useMemo(() => [...new Set(contracts.map((c) => c.expiration))].sort(), [contracts]);
  const strikes = useMemo(() => contracts.filter((c) => c.expiration === expiration), [contracts, expiration]);
  useEffect(() => {
    if (assetClass !== 'us_option' || !strikes.length) return;
    const spot = quotes[underlying]?.last ?? null;
    if (!strikes.some((c) => c.symbol === contract)) {
      const best = spot === null ? strikes[Math.floor(strikes.length / 2)]! : strikes.reduce((a, b) => (Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a));
      setContract(best.symbol);
    }
  }, [strikes, assetClass, underlying, quotes, contract]);

  const req = (): ManualOrderRequest => ({
    symbol: assetClass === 'us_option' ? contract : symbol.trim().toUpperCase(),
    assetClass,
    side,
    qty: Number(qty),
    type,
    limitPrice: type === 'limit' || type === 'stop_limit' ? Number(limitPrice) : null,
    stopPrice: type === 'stop' || type === 'stop_limit' ? Number(stopPrice) : null,
    intent,
  });

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await Api.previewOrder(req()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const o = await Api.submitOrder(preview.previewToken);
      setResult(`${humanize(o.state)}${o.rejectReason ? ` — ${o.rejectReason}` : ''} · ${o.side.toUpperCase()} ${o.qty} ${o.symbol}`);
      setPreview(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!system) return null;
  const types = SUPPORTED_ORDER_TYPES[assetClass];
  const now = serverNow();

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className={cx('border px-3 py-2 text-[12px]', live ? 'border-live/60 bg-live/5 text-live' : 'border-paper/40 text-paper')}>
        {live ? 'LIVE — orders from this ticket are real-money orders.' : 'PAPER — orders go to your Alpaca paper account.'} Every order passes the same risk engine as the workers.
      </div>
      <div className="flex gap-1">
        <button className={seg(assetClass === 'us_equity')} onClick={() => setAssetClass('us_equity')}>
          Equity
        </button>
        <button className={seg(assetClass === 'us_option')} onClick={() => setAssetClass('us_option')}>
          Option
        </button>
      </div>
      {assetClass === 'us_equity' ? (
        <Field label="Symbol">
          <input className={inputCls} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Underlying">
            <select className={inputCls} value={underlying} onChange={(e) => setUnderlying(e.target.value)}>
              {Object.keys(quotes).map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <div className="flex gap-1">
              <button className={seg(optType === 'call')} onClick={() => setOptType('call')}>
                Call
              </button>
              <button className={seg(optType === 'put')} onClick={() => setOptType('put')}>
                Put
              </button>
            </div>
          </Field>
          <Field label="Expiration">
            <select className={inputCls} value={expiration} onChange={(e) => setExpiration(e.target.value)}>
              {expirations.map((e) => (
                <option key={e}>{e}</option>
              ))}
            </select>
          </Field>
          <Field label="Strike (listed by broker)">
            <select className={inputCls} value={contract} onChange={(e) => setContract(e.target.value)}>
              {strikes.map((c) => (
                <option key={c.symbol} value={c.symbol} disabled={!c.tradable}>
                  {price(c.strike)} {c.openInterest !== null ? `· OI ${c.openInterest}` : ''}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Side">
          <div className="flex gap-1">
            <button className={seg(side === 'buy')} onClick={() => setSide('buy')}>
              Buy
            </button>
            <button className={seg(side === 'sell')} onClick={() => setSide('sell')}>
              Sell
            </button>
          </div>
        </Field>
        <Field label="Intent">
          <div className="flex gap-1">
            <button className={seg(intent === 'open')} onClick={() => setIntent('open')}>
              Open
            </button>
            <button className={seg(intent === 'close')} onClick={() => setIntent('close')}>
              Close
            </button>
          </div>
        </Field>
        <Field label="Quantity">
          <input className={inputCls} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Order type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as OrderType)}>
            {types.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ').toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        {(type === 'limit' || type === 'stop_limit') && (
          <Field label="Limit price">
            <input className={inputCls} inputMode="decimal" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
          </Field>
        )}
        {(type === 'stop' || type === 'stop_limit') && (
          <Field label="Stop price">
            <input className={inputCls} inputMode="decimal" value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} />
          </Field>
        )}
      </div>
      {intent === 'close' && positions.length > 0 && (
        <div className="label">
          Held:{' '}
          {positions.map((p) => (
            <button
              key={p.symbol}
              className="num mr-2 text-[11px] text-fg-2 underline-offset-2 hover:underline"
              onClick={() => {
                setAssetClass(p.assetClass === 'us_option' ? 'us_option' : 'us_equity');
                if (p.assetClass === 'us_option' && p.option) {
                  setUnderlying(p.option.underlying);
                  setOptType(p.option.type);
                  setExpiration(p.option.expiration);
                  setContract(p.symbol);
                } else setSymbol(p.symbol);
                setSide(p.side === 'long' ? 'sell' : 'buy');
                setQty(String(p.qty));
              }}
            >
              {p.symbol} {p.side === 'long' ? '+' : '−'}
              {p.qty}
            </button>
          ))}
        </div>
      )}
      <Btn variant="outline" onClick={doPreview} disabled={busy || !(Number(qty) > 0)}>
        Preview order
      </Btn>
      <ErrorText>{error}</ErrorText>
      {result && <div className="border-l-2 border-signal px-2 py-1.5 text-[12px] text-fg">{result}</div>}

      {preview && (
        <div className={cx('border p-3', live ? 'border-live/70' : 'border-line-2')}>
          <div className="flex items-baseline justify-between">
            <div className="display text-[15px]">ORDER PREVIEW</div>
            <span className="label">expires {countdown(preview.expiresAt - now)}</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="display text-[18px]" style={{ color: preview.request.side === 'buy' ? 'var(--color-call)' : 'var(--color-put)' }}>
              {preview.request.side.toUpperCase()}
            </span>
            <span className="num text-[15px]">{preview.request.symbol}</span>
          </div>
          <Row label="Quantity">{preview.request.qty}</Row>
          <Row label="Estimated price">{price(preview.estimatedPrice)}</Row>
          <Row label="Estimated notional">{money(preview.estimatedNotional)}</Row>
          <Row label="Account buying power">{money(preview.buyingPower)}</Row>
          <Row label="Risk (of equity)">{pct(preview.riskPct)}</Row>
          <Row label="Environment">
            <span className={live ? 'text-live' : 'text-paper'}>{preview.env.toUpperCase()}</span>
          </Row>
          {preview.warnings.map((w) => (
            <div key={w} className="mt-1 text-[11.5px] text-pending">
              {w}
            </div>
          ))}
          <div className="mt-2 grid grid-cols-2 gap-x-3">
            {preview.risk.checks.map((c) => (
              <Check key={c.id} ok={c.passed} label={c.label} detail={c.passed ? undefined : c.detail} />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Btn variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Btn>
            <Btn variant={live ? 'danger' : 'solid'} onClick={submit} disabled={busy || !preview.risk.approved}>
              {live ? 'Submit real order' : 'Submit paper order'}
            </Btn>
          </div>
          {!preview.risk.approved && <div className="mt-2 text-[12px] text-put">Blocked by risk: {preview.risk.blockedBy?.label} — {preview.risk.blockedBy?.detail}</div>}
        </div>
      )}
    </div>
  );
}

/** Manual ticket for OANDA markets (gold, indices, FX): same RiskEngine, broker-side stop, size in units. */
function CfdTicket() {
  const system = useStore((s) => s.system);
  const quotes = useStore((s) => s.quotes);
  const workers = useStore((s) => s.workers);
  const positions = useStore((s) => s.positions);
  const symbols = Object.keys(quotes);
  const [symbol, setSymbol] = useState(symbols[0] ?? 'XAU_USD');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [intent, setIntent] = useState<'open' | 'close'>('open');
  const [qty, setQty] = useState('');
  const [type, setType] = useState<OrderType>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = system?.env === 'live';
  const worker = Object.values(workers).find((w) => w.config.symbol === symbol);
  const m = worker?.market ?? null;
  const q = quotes[symbol];
  const dp = m?.displayPrecision ?? 2;

  const planned = () => {
    if (!q || q.bid === null || q.ask === null || !m?.plannedStop) return null;
    const raw = side === 'buy' ? q.ask - m.plannedStop : q.bid + m.plannedStop;
    return Number(raw.toFixed(dp));
  };

  const req = (): ManualOrderRequest => ({
    symbol,
    assetClass: 'cfd' as AssetClass,
    side,
    qty: Number(qty),
    type,
    limitPrice: type === 'limit' ? Number(limitPrice) : null,
    stopPrice: null,
    intent,
    stopLoss: intent === 'open' && stopLoss !== '' ? Number(stopLoss) : null,
  });

  const doPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setPreview(await Api.previewOrder(req()));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const o = await Api.submitOrder(preview.previewToken);
      setResult(`${humanize(o.state)}${o.rejectReason ? ` — ${o.rejectReason}` : ''} · ${o.side.toUpperCase()} ${qtyStr(o.qty)} ${instrumentName(o.symbol)}`);
      setPreview(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!system) return null;
  const now = serverNow();
  const ccy = displayCurrency();
  const step = m?.unitsPrecision === null || m?.unitsPrecision === undefined ? null : 10 ** -m.unitsPrecision;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className={cx('border px-3 py-2 text-[12px]', live ? 'border-live/60 bg-live/5 text-live' : 'border-paper/40 text-paper')}>
        {live ? 'LIVE — orders from this ticket are real-money orders at OANDA.' : 'PRACTICE — orders go to your OANDA practice account.'} Every order passes the same risk engine as the workers.
      </div>
      <Field label="Market">
        <select
          className={inputCls}
          value={symbol}
          onChange={(e) => {
            setSymbol(e.target.value);
            setPreview(null);
            setStopLoss('');
          }}
        >
          {symbols.map((s) => (
            <option key={s} value={s}>
              {instrumentName(s)} · {s}
            </option>
          ))}
        </select>
      </Field>
      {q && (
        <div className="num flex flex-wrap gap-x-4 text-[11px] text-fg-2">
          <span>bid {px(symbol, q.bid)}</span>
          <span>ask {px(symbol, q.ask)}</span>
          <span>spread {q.bid !== null && q.ask !== null ? px(symbol, q.ask - q.bid) : '—'}</span>
          <span className={q.tradeable === false ? 'text-pending' : q.stale ? 'text-pending' : 'text-call'}>{q.tradeable === false ? 'NOT TRADEABLE' : q.stale ? 'STALE' : 'LIVE'}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Direction">
          <div className="flex gap-1">
            <button className={seg(side === 'buy')} onClick={() => setSide('buy')}>
              {intent === 'open' ? 'Long (buy)' : 'Buy'}
            </button>
            <button className={seg(side === 'sell')} onClick={() => setSide('sell')}>
              {intent === 'open' ? 'Short (sell)' : 'Sell'}
            </button>
          </div>
        </Field>
        <Field label="Intent">
          <div className="flex gap-1">
            <button className={seg(intent === 'open')} onClick={() => setIntent('open')}>
              Open
            </button>
            <button className={seg(intent === 'close')} onClick={() => setIntent('close')}>
              Close
            </button>
          </div>
        </Field>
        <Field label={`Units${m?.minUnits ? ` (min ${qtyStr(m.minUnits)}${step ? `, step ${qtyStr(step)}` : ''})` : ''}`}>
          <input className={inputCls} inputMode="decimal" value={qty} placeholder={m?.plannedUnits ? qtyStr(m.plannedUnits) : ''} onChange={(e) => setQty(e.target.value)} />
        </Field>
        <Field label="Order type">
          <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as OrderType)}>
            {SUPPORTED_ORDER_TYPES.cfd.map((t) => (
              <option key={t} value={t}>
                {t.toUpperCase()}
              </option>
            ))}
          </select>
        </Field>
        {type === 'limit' && (
          <Field label="Limit price (worst price you accept)">
            <input className={inputCls} inputMode="decimal" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} />
          </Field>
        )}
        {intent === 'open' && (
          <Field label="Stop loss (held by OANDA)">
            <div className="flex gap-1">
              <input className={inputCls} inputMode="decimal" value={stopLoss} placeholder="price" onChange={(e) => setStopLoss(e.target.value)} />
              <Btn variant="outline" className="!h-8 shrink-0" disabled={planned() === null} onClick={() => setStopLoss(String(planned()))} title="A stop 1.5 × ATR from the live price, the same distance the workers use">
                ATR stop
              </Btn>
            </div>
          </Field>
        )}
      </div>
      {m?.plannedUnits ? (
        <button className="label text-left underline-offset-2 hover:underline" onClick={() => setQty(String(m.plannedUnits))}>
          Use the worker's size: {unitsStr(m.plannedUnits)} (risks ≤ {money(worker!.config.limits.riskPerTrade)} at its stop)
        </button>
      ) : null}
      {intent === 'close' && positions.length > 0 && (
        <div className="label">
          Held:{' '}
          {positions.map((p) => (
            <button
              key={p.symbol}
              className="num mr-2 text-[11px] text-fg-2 underline-offset-2 hover:underline"
              onClick={() => {
                setSymbol(p.symbol);
                setSide(p.side === 'long' ? 'sell' : 'buy');
                setQty(String(p.qty));
              }}
            >
              {instrumentName(p.symbol)} {p.side === 'long' ? 'LONG' : 'SHORT'} {qtyStr(p.qty)}
            </button>
          ))}
        </div>
      )}
      {intent === 'open' && stopLoss === '' && <div className="text-[11.5px] text-pending">No stop loss: this position would have no protection at OANDA if Scalp City goes offline.</div>}
      <Btn variant="outline" onClick={doPreview} disabled={busy || !(Number(qty) > 0)}>
        Preview order
      </Btn>
      <ErrorText>{error}</ErrorText>
      {result && <div className="border-l-2 border-signal px-2 py-1.5 text-[12px] text-fg">{result}</div>}

      {preview && (
        <div className={cx('border p-3', live ? 'border-live/70' : 'border-line-2')}>
          <div className="flex items-baseline justify-between">
            <div className="display text-[15px]">ORDER PREVIEW</div>
            <span className="label">expires {countdown(preview.expiresAt - now)}</span>
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="display text-[18px]" style={{ color: preview.request.side === 'buy' ? 'var(--color-call)' : 'var(--color-put)' }}>
              {preview.request.intent === 'open' ? (preview.request.side === 'buy' ? 'LONG' : 'SHORT') : preview.request.side.toUpperCase()}
            </span>
            <span className="num text-[15px]">{instrumentName(preview.request.symbol)}</span>
          </div>
          <Row label="Units">{qtyStr(preview.request.qty)}</Row>
          <Row label="Estimated price">{px(preview.request.symbol, preview.estimatedPrice)}</Row>
          <Row label={`Value (${ccy})`}>{money(preview.estimatedNotional)}</Row>
          <Row label="Margin needed / free">
            {preview.estimatedMargin === null ? '—' : money(preview.estimatedMargin)} / {money(preview.marginAvailable)}
          </Row>
          {preview.request.intent === 'open' && (
            <Row label="Loss if the stop is hit">{preview.riskAtStop === null ? <span className="text-pending">no stop</span> : <span className="text-put">{money(preview.riskAtStop)}</span>}</Row>
          )}
          <Row label="Position value (of equity)">{pct(preview.riskPct)}</Row>
          <Row label="Environment">
            <span className={live ? 'text-live' : 'text-paper'}>{live ? 'LIVE' : 'PRACTICE'}</span>
          </Row>
          {preview.warnings.map((w) => (
            <div key={w} className="mt-1 text-[11.5px] text-pending">
              {w}
            </div>
          ))}
          <div className="mt-2 grid grid-cols-2 gap-x-3">
            {preview.risk.checks.map((c) => (
              <Check key={c.id} ok={c.passed} label={c.label} detail={c.passed ? undefined : c.detail} />
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Btn variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Btn>
            <Btn variant={live ? 'danger' : 'solid'} onClick={submit} disabled={busy || !preview.risk.approved}>
              {live ? 'Submit real order' : 'Submit practice order'}
            </Btn>
          </div>
          {!preview.risk.approved && <div className="mt-2 text-[12px] text-put">Blocked by risk: {preview.risk.blockedBy?.label} — {preview.risk.blockedBy?.detail}</div>}
        </div>
      )}
    </div>
  );
}

function WorkerSettings({ w }: { w: WorkerView }) {
  const live = useStore((s) => s.system?.env === 'live');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [instrument, setInstrument] = useState(w.config.instrument);
  const [allowShort, setAllowShort] = useState(w.config.allowShort);
  const [needConfirm, setNeedConfirm] = useState(false);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const cfd = w.config.instrument === 'CFD';
  const ccy = displayCurrency();
  const fields: [string, string, 'limits' | 'exits' | 'options', number][] = cfd
    ? [
        ['maxTradesPerDay', 'Max trades', 'limits', w.config.limits.maxTradesPerDay],
        ['riskPerTrade', `Risk / trade (${ccy})`, 'limits', w.config.limits.riskPerTrade],
        ['maxPositionNotional', `Max position (${ccy})`, 'limits', w.config.limits.maxPositionNotional],
        ['dailyLossLimit', `Daily loss (${ccy})`, 'limits', w.config.limits.dailyLossLimit],
        ['dailyGoal', `Daily goal (${ccy})`, 'limits', w.config.limits.dailyGoal],
        ['stopAtr', 'Stop (× ATR)', 'exits', w.config.exits.stopAtr],
        ['targetAtr', 'Target (× ATR)', 'exits', w.config.exits.targetAtr],
        ['maxHoldMinutes', 'Max hold min', 'exits', w.config.exits.maxHoldMinutes],
        ['flattenBeforeCloseMinutes', 'Flatten before close', 'exits', w.config.exits.flattenBeforeCloseMinutes],
        ['cooldownBars', 'Cooldown bars', 'exits', w.config.exits.cooldownBars],
      ]
    : [
        ['maxTradesPerDay', 'Max trades', 'limits', w.config.limits.maxTradesPerDay],
        ['maxContracts', 'Max contracts', 'limits', w.config.limits.maxContracts],
        ['maxShares', 'Max shares', 'limits', w.config.limits.maxShares],
        ['maxPositionNotional', `Max position (${ccy})`, 'limits', w.config.limits.maxPositionNotional],
        ['dailyLossLimit', `Daily loss (${ccy})`, 'limits', w.config.limits.dailyLossLimit],
        ['dailyGoal', `Daily goal (${ccy})`, 'limits', w.config.limits.dailyGoal],
        ['takeProfitPct', 'Take profit %', 'exits', w.config.exits.takeProfitPct],
        ['stopLossPct', 'Stop loss %', 'exits', w.config.exits.stopLossPct],
        ['maxHoldMinutes', 'Max hold min', 'exits', w.config.exits.maxHoldMinutes],
        ['flattenBeforeCloseMinutes', 'Flatten before close', 'exits', w.config.exits.flattenBeforeCloseMinutes],
        ['minDte', 'Min DTE', 'options', w.config.options.minDte],
        ['maxDte', 'Max DTE', 'options', w.config.options.maxDte],
        ['strikeOffset', 'Strikes OTM', 'options', w.config.options.strikeOffset],
        ['maxSpreadPct', 'Max spread %', 'options', w.config.options.maxSpreadPct],
        ['minVolume', 'Min volume', 'options', w.config.options.minVolume],
        ['minOpenInterest', 'Min OI', 'options', w.config.options.minOpenInterest],
      ];

  const save = async (confirmed = false) => {
    setError(null);
    setSaved(false);
    const patch: Record<string, Record<string, number>> = { limits: {}, exits: {}, options: {} };
    for (const [key, , group] of fields) if (draft[key] !== undefined && draft[key] !== '') patch[group]![key] = Number(draft[key]);
    try {
      await Api.updateWorker(w.config.id, { ...patch, instrument: cfd ? undefined : instrument, allowShort, confirmed: confirmed || undefined, password: password || undefined });
      setDraft({});
      setNeedConfirm(false);
      setNeedPassword(false);
      setPassword('');
      setSaved(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) setNeedConfirm(true);
      else if (e instanceof ApiError && e.code === 'REAUTH_REQUIRED') {
        setNeedConfirm(true);
        setNeedPassword(true);
      } else setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <span className="label-strong text-[12px] text-fg">{w.config.name}</span>
          <span className="label ml-2">{w.config.strategyName}</span>
        </div>
        {cfd ? (
          <span className="label">{w.config.symbol} · trades the instrument itself</span>
        ) : (
          <div className="flex items-center gap-1">
            {(['OPTIONS', 'EQUITY'] as const).map((i) => (
              <button key={i} className={seg(instrument === i)} onClick={() => setInstrument(i)}>
                {i}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="grid grid-cols-4 gap-2">
        {fields.map(([key, label, , cur]) => (
          <Field key={key} label={label}>
            <input className={cx(inputCls, '!h-7 !text-[11.5px]')} placeholder={String(cur)} value={draft[key] ?? ''} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </Field>
        ))}
      </div>
      {(instrument === 'EQUITY' || cfd) && (
        <div className="mt-2 flex items-center gap-2">
          <Toggle label="Allow short" on={allowShort} onChange={setAllowShort} />
          <span className="label">{cfd ? 'Allow SHORT entries on bearish signals' : 'Allow short sales on PUT signals (equity mode)'}</span>
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <Btn variant="outline" onClick={() => save(false)}>
          Save
        </Btn>
        {saved && <span className="label !text-call">Saved · audit-logged</span>}
      </div>
      {needConfirm && (
        <div className="mt-2 border border-pending/50 bg-pending/5 p-2">
          <div className="text-[12px] text-pending">This change increases risk for {w.config.name}. Confirm to apply.</div>
          {(needPassword || live) && (
            <input type="password" placeholder="Password (required in LIVE)" className={cx(inputCls, 'mt-2')} value={password} onChange={(e) => setPassword(e.target.value)} />
          )}
          <div className="mt-2 flex gap-2">
            <Btn variant="ghost" onClick={() => setNeedConfirm(false)}>
              Cancel
            </Btn>
            <Btn variant="warn" onClick={() => save(true)}>
              Confirm
            </Btn>
          </div>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** Worker configuration (spec §28, §104). */
export function SettingsDrawerBody() {
  const workers = useStore((s) => s.workers);
  const order = useStore((s) => s.workerOrder);
  return (
    <div className="px-4 py-2">
      <div className="label py-2">Per-worker limits apply on top of the global risk limits. Changes that loosen risk require confirmation (and your password in LIVE).</div>
      {order.map((id) => workers[id] && <WorkerSettings key={id} w={workers[id]!} />)}
    </div>
  );
}
