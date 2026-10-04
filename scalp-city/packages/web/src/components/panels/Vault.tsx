import { money, pct, pnlClass } from '../../lib/format';
import { useStore } from '../../store/store';
import { cx, Money, Panel, Stat } from '../ui';

/** The Vault: the real account, straight from the broker (spec §51). */
export function Vault() {
  const a = useStore((s) => s.account);
  const positions = useStore((s) => s.positions.length);
  const workers = useStore((s) => s.workerOrder.length);
  const active = useStore((s) => Object.values(s.workers).filter((w) => w.autotradeEnabled).length);
  const openDrawer = useStore((s) => s.openDrawer);
  if (!a) return null;
  return (
    <Panel
      title="The Vault"
      meta={
        <span className="flex items-center gap-1.5">
          ALPACA <span className="num !text-fg-2">{a.accountNumberMasked ?? '—'}</span>
        </span>
      }
      accent={a.dayPnl !== null && a.dayPnl < 0 ? 'var(--color-put)' : 'var(--color-call)'}
    >
      <button className="block w-full text-left" onClick={() => openDrawer('account')} title="Open account">
        <div className="label">Equity</div>
        <div className="num text-[30px] leading-[1.1] font-medium tracking-tight text-fg">
          {a.equity === null ? <span className="label !text-[13px]">UNAVAILABLE</span> : money(a.equity)}
        </div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className={cx('num text-[15px] font-medium', pnlClass(a.dayPnl))}>{money(a.dayPnl, { sign: true })}</span>
          <span className={cx('num text-[12px]', pnlClass(a.dayPnl))}>{pct(a.dayPnlPct, { sign: true })}</span>
          <span className="label">day</span>
        </div>
      </button>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-line pt-2.5">
        <Stat label="Buying power">
          <Money value={a.buyingPower} />
        </Stat>
        <Stat label="Options BP">
          <Money value={a.optionsBuyingPower} />
        </Stat>
        <Stat label="Positions">
          <span className="text-[13px]">{positions}</span>
        </Stat>
        <Stat label="Workers">
          <span className="text-[13px]">
            {active}
            <span className="text-fg-3">/{workers} on</span>
          </span>
        </Stat>
      </div>
      {a.patternDayTrader !== null && a.equity !== null && a.equity < 25_000 && (a.multiplier ?? 1) > 1 && (
        <div className="mt-2 border-l-2 border-pending px-2 py-1 text-[11px] text-pending">
          PDT: {a.daytradeCount ?? 0}/3 day trades used (equity under $25k)
        </div>
      )}
    </Panel>
  );
}
