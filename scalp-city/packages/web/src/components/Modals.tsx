import { useEffect, useState } from 'react';
import type { JournalTradeView } from '@scalp-city/shared';
import { Api, ApiError } from '../lib/api';
import { dateTimeET, humanize, money, pnlClass, price } from '../lib/format';
import { useStore } from '../store/store';
import { useReadiness } from './drawers/Risk';
import { ConditionList } from './panels/Scanner';
import { PriceChart } from './PriceChart';
import { Btn, Check, cx, ErrorText, Field, inputCls, Modal, Row } from './ui';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, onDone?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

/** ENABLE LIVE TRADING — two explicit steps, password, account confirmation (spec §3). */
function EnableLiveModal({ onClose }: { onClose: () => void }) {
  const system = useStore((s) => s.system);
  const [step, setStep] = useState<1 | 2>(1);
  const [ack, setAck] = useState(false);
  const [password, setPassword] = useState('');
  const { data: readiness } = useReadiness(true);
  const { busy, error, run } = useAction();
  const account = system?.broker.accountMasked ?? '••••';
  return (
    <Modal open onClose={onClose} title="LIVE TRADING" danger width={520}>
      {step === 1 ? (
        <div className="flex flex-col gap-3">
          <p className="text-[14px] text-fg">You are about to enable real-money order execution.</p>
          <p className="text-[13px] text-fg-2">Orders submitted by this application can result in real financial losses.</p>
          <div className="border border-line-2 p-3">
            <Row label="Broker">ALPACA</Row>
            <Row label="Account">{account}</Row>
            <Row label="Environment">
              <span className="text-live">LIVE</span>
            </Row>
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5 accent-[#ff3b30]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>I understand that this will enable real-money trading.</span>
          </label>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose}>
              Cancel
            </Btn>
            <Btn variant="danger" disabled={!ack} onClick={() => setStep(2)}>
              Enable live trading
            </Btn>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-fg">Second confirmation. The server re-verifies every check below and your password before arming.</p>
          <div className="grid grid-cols-2 gap-x-4 border border-line-2 p-2">
            {readiness?.items.map((i) => <Check key={i.id} ok={i.ok} label={i.label} />)}
          </div>
          {readiness && !readiness.ready && <div className="text-[12px] text-put">Not ready — live execution will be refused until every item passes.</div>}
          <Field label="Your password">
            <input type="password" autoComplete="current-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorText>{error}</ErrorText>
          <div className="flex justify-end gap-2">
            <Btn variant="ghost" onClick={onClose}>
              Cancel
            </Btn>
            <Btn
              variant="danger"
              disabled={busy || !password}
              onClick={() => run(() => Api.enableLive({ password, confirmAccount: account, acknowledgeRealMoney: ack, secondConfirmation: true }), onClose)}
            >
              Confirm — arm live execution
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SwitchEnvModal({ target, onClose }: { target: 'paper' | 'live'; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const toLive = target === 'live';
  return (
    <Modal open onClose={onClose} title={`SWITCH TO ${target.toUpperCase()}`} danger={toLive}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-fg-2">
          The trading system will stop, close its broker and data connections, and rebuild for the {target.toUpperCase()} account through the full recovery sequence. Workers come back with autotrading OFF.
          {toLive && ' Live execution stays locked until you separately enable it.'}
        </p>
        <Field label="Your password">
          <input type="password" autoComplete="current-password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant={toLive ? 'danger' : 'solid'} disabled={busy || !password} onClick={() => run(() => Api.switchEnv(target, password), onClose)}>
            Switch to {target.toUpperCase()}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function FlattenModal({ onClose }: { onClose: () => void }) {
  const positions = useStore((s) => s.positions);
  const live = useStore((s) => s.system?.env === 'live');
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} title="FLATTEN ALL" danger={live}>
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-fg">This will submit orders intended to close all currently open positions.</p>
        {live && <p className="text-[13px] text-live">This is a real-money action.</p>}
        <div className="border border-line-2 p-2">
          {positions.length === 0 ? (
            <div className="label">No open positions at the broker.</div>
          ) : (
            positions.map((p) => (
              <Row key={p.symbol} label={p.symbol}>
                {p.side === 'long' ? 'SELL' : 'BUY'} {p.qty} · <span className={pnlClass(p.unrealizedPnl)}>{money(p.unrealizedPnl, { sign: true })}</span>
              </Row>
            ))
          )}
        </div>
        <p className="label">Working orders are canceled first. Entries are paused. Positions are verified against the broker — nothing is zeroed locally.</p>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant="danger" disabled={busy} onClick={() => run(() => Api.flatten(), onClose)}>
            Confirm flatten
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

function SimpleConfirm({ title, body, action, danger, confirmLabel, onClose }: { title: string; body: React.ReactNode; action: () => Promise<unknown>; danger?: boolean; confirmLabel: string; onClose: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Modal open onClose={onClose} title={title} danger={danger}>
      <div className="flex flex-col gap-3">
        <div className="text-[13px] text-fg-2">{body}</div>
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn variant={danger ? 'danger' : 'warn'} disabled={busy} onClick={() => run(action, onClose)}>
            {confirmLabel}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/** Trade review (spec §118). */
function TradeReviewModal({ tradeId, onClose }: { tradeId: string; onClose: () => void }) {
  const [data, setData] = useState<{ trade: JournalTradeView; events: { kind: string; qty: number | null; price: number | null; realizedPnl: number | null; at: number | null }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Api.journalTrade(tradeId)
      .then(setData)
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [tradeId]);
  const t = data?.trade;
  const date = t ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(t.openedAt) : undefined;
  return (
    <Modal open onClose={onClose} title="TRADE REVIEW" width={760}>
      <ErrorText>{error}</ErrorText>
      {t && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_280px]">
          <div>
            <PriceChart
              symbol={t.underlying ?? t.symbol}
              date={date}
              height={240}
              markers={(data?.events ?? []).filter((e) => e.at).map((e) => ({ time: e.at!, side: e.kind === 'ENTRY_FILL' ? 'buy' : 'sell', text: `${e.kind === 'ENTRY_FILL' ? 'IN' : 'OUT'} ${e.qty ?? ''} @${price(e.price)}` }))}
            />
            {t.signalConditions && (
              <div className="mt-3">
                <div className="label mb-1">Signal at entry · {t.signalCharge ?? '—'}%</div>
                <ConditionList conditions={t.signalConditions} />
              </div>
            )}
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label-strong text-[13px] text-fg">{t.workerName ?? 'MANUAL'}</span>
              <span className="display text-[15px]" style={{ color: t.direction === 'PUT' ? 'var(--color-put)' : 'var(--color-call)' }}>
                {t.direction}
              </span>
            </div>
            <div className={cx('num mt-1 text-[26px]', pnlClass(t.realizedPnl))}>{t.status === 'OPEN' ? 'OPEN' : money(t.realizedPnl, { sign: true })}</div>
            <Row label="Instrument">{t.option ? `${t.option.underlying} ${price(t.option.strike)} ${t.option.type.toUpperCase()} ${t.option.expiration}` : t.symbol}</Row>
            <Row label="Contracts / shares">{t.qty}</Row>
            <Row label="Entry">{price(t.entryAvgPrice)}</Row>
            <Row label="Exit">{price(t.exitAvgPrice)}</Row>
            <Row label="Exit reason">{t.exitReason ? humanize(t.exitReason) : '—'}</Row>
            <Row label="Opened">{dateTimeET(t.openedAt)}</Row>
            <Row label="Closed">{dateTimeET(t.closedAt)}</Row>
            <div className="label mt-3 mb-1">Risk</div>
            <Row label="Position size">{money(t.positionNotional)}</Row>
            <Row label="Daily P&L before">{money(t.dailyPnlBefore, { sign: true })}</Row>
            <Row label="Daily P&L after">{money(t.dailyPnlAfter, { sign: true })}</Row>
            <div className="label mt-3">Broker orders: {[...t.entryOrderIds, ...t.exitOrderIds].length} · P&L from actual fills, gross of regulatory fees</div>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Modals() {
  const modal = useStore((s) => s.ui.modal);
  const close = () => useStore.getState().openModal(null);
  const workers = useStore((s) => s.workers);
  if (!modal) return null;
  switch (modal.kind) {
    case 'enable-live':
      return <EnableLiveModal onClose={close} />;
    case 'switch-env':
      return <SwitchEnvModal target={modal.target} onClose={close} />;
    case 'flatten':
      return <FlattenModal onClose={close} />;
    case 'release-kill':
      return <SimpleConfirm title="RELEASE KILL SWITCH" body="Workers stay OFF and autotrading stays OFF after release. You will need to re-enable them deliberately." action={() => Api.releaseKillSwitch()} confirmLabel="Release kill switch" onClose={close} />;
    case 'enable-autotrading':
      return (
        <SimpleConfirm
          title="ENABLE AUTOTRADING · LIVE"
          danger
          body="Enabled workers may submit real-money orders autonomously when their signals pass every risk check."
          action={() => Api.setAutotrading(true, true)}
          confirmLabel="Enable autotrading"
          onClose={close}
        />
      );
    case 'enable-worker': {
      const w = workers[modal.workerId];
      return (
        <SimpleConfirm
          title={`ENABLE ${w?.config.name ?? modal.workerId}`}
          body={
            <>
              {w?.config.name} will be allowed to submit orders autonomously ({w?.config.instrument}, up to {w?.config.limits.maxTradesPerDay} trades/day, {w?.config.limits.maxContracts} contracts, daily loss −{money(w?.config.limits.dailyLossLimit ?? null)}). Every order still passes the risk engine. Global autotrading must also be ON.
            </>
          }
          action={() => Api.setWorkerEnabled(modal.workerId, true, true)}
          confirmLabel="Enable worker"
          onClose={close}
        />
      );
    }
    case 'trade-review':
      return <TradeReviewModal tradeId={modal.tradeId} onClose={close} />;
    case 'accept-reconciliation':
      return (
        <SimpleConfirm
          title="ACCEPT BROKER STATE"
          body="The broker's positions become Scalp City's record. Positions Scalp City did not open are adopted as external (workers will not trade them); positions missing at the broker are closed in the journal with unknown P&L. This is audit-logged."
          action={() => Api.reconcileAccept()}
          confirmLabel="Accept broker state"
          onClose={close}
        />
      );
    case 'reset-breaker':
      return <SimpleConfirm title={`RESET · ${modal.label.toUpperCase()}`} body="Only reset once you understand and have resolved the cause. Trading resumes only if every other check passes." action={() => Api.resetBreaker(modal.breakerId)} confirmLabel="Reset breaker" onClose={close} />;
  }
}
