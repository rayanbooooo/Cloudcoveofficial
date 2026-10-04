import { useEffect, useState } from 'react';
import { Api, ApiError } from '../lib/api';
import { age, countdown, humanize, timeET } from '../lib/format';
import { serverNow, useStore } from '../store/store';
import { Btn, cx, Dot, Toggle } from './ui';

function useTick(ms = 1000): number {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((x) => x + 1), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return serverNow();
}

export function EnvBadge({ compact }: { compact?: boolean }) {
  const system = useStore((s) => s.system);
  const openDrawer = useStore((s) => s.openDrawer);
  if (!system) return null;
  const live = system.env === 'live';
  return (
    <button
      onClick={() => openDrawer('live')}
      className={cx('focus-ring flex h-7 items-center gap-2 rounded-[2px] px-2.5', live ? 'badge-live' : 'badge-paper')}
      title={live ? 'LIVE — real-money account' : 'PAPER — simulated account at the broker'}
    >
      {live && <span className="h-2 w-2 rounded-full bg-white pulse" />}
      <span className="display text-[13px] tracking-[0.18em]">{live ? (compact ? 'LIVE' : 'LIVE TRADING') : 'PAPER'}</span>
      {live && !compact && (
        <span className="label-strong rounded-[1px] bg-black/30 px-1.5 py-[1px] text-[9.5px] text-white">{system.live.armed ? 'ARMED' : system.live.serverLockOpen ? 'NOT ARMED' : 'LOCKED'}</span>
      )}
    </button>
  );
}

function Chip({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-l border-line px-3" title={title}>
      <span className="label">{label}</span>
      <span className="flex items-center gap-1.5 truncate">{children}</span>
    </div>
  );
}

export function StatusChips() {
  const system = useStore((s) => s.system);
  const quotes = useStore((s) => s.quotes);
  const now = useTick();
  if (!system) return null;
  const b = system.broker;
  const m = system.market;
  const md = system.marketData;
  const brokerOk = b.status === 'CONNECTED';
  const ages = Object.values(quotes).map((q) => q.ageMs).filter((x): x is number => x !== null);
  const latency = ages.length ? Math.max(...ages) : null;
  const dataConnected = md.stock.state === 'CONNECTED';
  const anyStale = Object.values(md.symbols).some((s) => s.stale);
  const dataLabel = !dataConnected ? md.stock.state : !md.stockRealtime ? 'DELAYED' : m.isOpen && anyStale ? 'STALE' : 'LIVE';
  const dataStatus = !dataConnected ? 'error' : !md.stockRealtime || (m.isOpen && anyStale) ? 'warn' : 'ok';
  const marketCountdown = m.isOpen ? (m.sessionClose ? countdown(m.sessionClose - now) : '') : m.nextOpen ? countdown(m.nextOpen - now) : '';
  return (
    <div className="flex min-w-0 items-center">
      <Chip label="Broker" title={b.lastError ?? undefined}>
        <Dot status={brokerOk ? 'ok' : b.status === 'UNKNOWN' ? 'warn' : 'error'} />
        <span className={cx('label-strong text-[10.5px]', brokerOk ? 'text-fg' : 'text-put')}>{humanize(b.status)}</span>
        {b.accountMasked && <span className="num text-[11px] text-fg-3">{b.accountMasked}</span>}
      </Chip>
      <Chip label="Market">
        <Dot status={m.isOpen ? 'ok' : 'off'} />
        <span className={cx('label-strong text-[10.5px]', m.isOpen ? 'text-fg' : 'text-fg-2')}>{humanize(m.label)}</span>
        {marketCountdown && <span className="num text-[11px] text-fg-3">{m.isOpen ? `closes ${marketCountdown}` : `opens ${marketCountdown}`}</span>}
      </Chip>
      <Chip label="Data" title={`${md.stockFeedLabel}${md.stockPartialVolume ? ' — IEX carries only part of consolidated volume' : ''}`}>
        <Dot status={dataStatus} pulse={dataStatus === 'ok' && m.isOpen} />
        <span className={cx('label-strong text-[10.5px]', dataStatus === 'ok' ? 'text-fg' : dataStatus === 'warn' ? 'text-pending' : 'text-put')}>{dataLabel}</span>
        <span className="num text-[11px] text-fg-2">{dataConnected ? age(latency) : ''}</span>
        <span className="label hidden !text-fg-3 2xl:inline">{md.stockFeedLabel.replace('LIVE · ', '')}</span>
      </Chip>
      <Chip label="ET">
        <span className="num text-[12px] text-fg">{timeET(now)}</span>
      </Chip>
    </div>
  );
}

export function SafetyControls({ vertical }: { vertical?: boolean }) {
  const system = useStore((s) => s.system);
  const openModal = useStore((s) => s.openModal);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!system) return null;
  const c = system.controls;
  const live = system.env === 'live';

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cx('flex items-center gap-2', vertical && 'flex-wrap')}>
      <div className="flex items-center gap-2 pr-1" title="AUTOTRADING: workers may submit orders">
        <span className="label">Autotrading</span>
        <Toggle
          label="Autotrading"
          on={c.autotrading}
          disabled={busy !== null || c.killSwitch.active}
          onChange={(on) => {
            if (on && live) openModal({ kind: 'enable-autotrading' });
            else void run('auto', () => Api.setAutotrading(on));
          }}
        />
      </div>
      <div className="flex items-center gap-2 pr-1" title="PAUSE ENTRIES: no new entries; exits keep running">
        <span className="label">Pause entries</span>
        <Toggle label="Pause entries" on={c.entriesPaused} disabled={busy !== null} onChange={(on) => void run('pause', () => Api.setPaused(on))} />
      </div>
      {c.killSwitch.active ? (
        <Btn variant="outline" className="!border-live !text-live" onClick={() => openModal({ kind: 'release-kill' })}>
          ⛔ Kill switch active · release
        </Btn>
      ) : (
        <Btn variant="danger" disabled={busy !== null} onClick={() => void run('kill', () => Api.killSwitch('manual'))} title="Stop all workers, cancel working orders, block new orders. Does not close positions.">
          ⛔ Kill switch
        </Btn>
      )}
      <Btn variant="warn" disabled={busy !== null || !!system.flatten?.inProgress} onClick={() => openModal({ kind: 'flatten' })}>
        {system.flatten?.inProgress ? `Flattening ${system.flatten.closed}/${system.flatten.total}` : 'Flatten all'}
      </Btn>
      {error && <span className="max-w-[240px] truncate text-[11px] text-put" title={error}>{error}</span>}
    </div>
  );
}

/** The always-on truth line (spec §95): environment, autotrading, broker, market — and every halt reason. */
export function StatusLine() {
  const system = useStore((s) => s.system);
  const conn = useStore((s) => s.conn);
  if (!system) return null;
  const live = system.env === 'live';
  const t = system.trading;
  const reasons = t.haltReasons.filter((r) => !(r.code === 'AUTOTRADING_OFF'));
  const autotradingOn = system.controls.autotrading && !system.controls.killSwitch.active;
  const halted = autotradingOn && !t.entriesAllowed;
  const parts = [
    live ? 'LIVE' : 'PAPER',
    system.controls.killSwitch.active ? 'KILL SWITCH ACTIVE' : autotradingOn ? (halted ? 'AUTOTRADING HALTED' : 'AUTOTRADING ENABLED') : 'AUTOTRADING OFF',
    `BROKER ${humanize(system.broker.status)}`,
    `MARKET ${humanize(system.market.label)}`,
  ];
  const tone = system.controls.killSwitch.active || halted ? 'text-put' : autotradingOn ? 'text-call' : 'text-fg-2';
  return (
    <div className={cx('flex min-h-[26px] flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-[10.5px]', live ? 'bg-live/[0.07]' : 'bg-ink-900/80')}>
      <span className={cx('label-strong', tone)}>{parts.join(' · ')}</span>
      {reasons.length > 0 && (
        <span className="flex flex-wrap items-center gap-2">
          <span className="label">{halted || system.controls.killSwitch.active ? 'Reason' : 'Blocks'}</span>
          {reasons.map((r) => (
            <span key={r.code} className="label-strong rounded-[1px] border border-line-2 px-1.5 py-[1px] text-[10px] text-pending">
              {r.message}
            </span>
          ))}
        </span>
      )}
      {system.endpoints.nonStandard && (
        <span className="label-strong ml-auto whitespace-nowrap rounded-[1px] bg-pending px-1.5 py-[1px] text-[10px] text-ink-950">NON-STANDARD BROKER ENDPOINT · {system.endpoints.trading}</span>
      )}
      {conn.state !== 'open' && <span className="label-strong rounded-[1px] bg-put px-1.5 py-[1px] text-[10px] text-white">UI {conn.state.toUpperCase()}</span>}
    </div>
  );
}

export function TopBar() {
  return (
    <header className="relative z-30 flex h-[var(--bar-h)] items-center gap-3 border-b border-line bg-ink-950/95 px-3">
      <div className="flex shrink-0 items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden>
          <rect x="5" y="14" width="5" height="13" fill="#4c8dff" />
          <rect x="11.5" y="6" width="5" height="21" fill="#2ee6a6" />
          <rect x="18" y="10" width="5" height="17" fill="#e8eef6" />
          <rect x="24.5" y="17" width="3" height="10" fill="#ff4d6d" />
        </svg>
        <span className="display text-[14px] tracking-[0.22em]">SCALP CITY</span>
      </div>
      <EnvBadge />
      <div className="hidden min-w-0 flex-1 lg:block">
        <StatusChips />
      </div>
      <div className="ml-auto hidden shrink-0 md:block">
        <SafetyControls />
      </div>
    </header>
  );
}
