import { instrumentName } from '@scalp-city/shared';
import { age, pct, px } from '../../lib/format';
import { useStore } from '../../store/store';
import { cx, Dot, Panel } from '../ui';

/** The traded markets — real quotes with their data age; never interpolated. */
export function MarketPanel() {
  const quotes = useStore((s) => s.quotes);
  const system = useStore((s) => s.system);
  const symbols = Object.keys(quotes);
  if (!system || symbols.length === 0) return null;
  const md = system.marketData;
  return (
    <Panel title="Market" meta={md.stockFeedLabel} bodyClassName="py-1">
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-x-3 px-2.5">
        <span className="label">Sym</span>
        <span className="label text-right">Last</span>
        <span className="label text-right">Chg</span>
        <span className="label text-right">vs VWAP</span>
        {symbols.map((sym) => {
          const q = quotes[sym]!;
          const vs = q.last !== null && q.vwap !== null ? ((q.last - q.vwap) / q.vwap) * 100 : null;
          return (
            <div key={sym} className="contents">
              <span className="flex items-center gap-1.5 py-1">
                <Dot status={q.stale ? (system.market.isOpen ? 'warn' : 'off') : 'ok'} />
                <span className="label-strong text-[11.5px] text-fg" title={sym}>{instrumentName(sym)}</span>
                {q.tradeable === false && <span className="label-strong rounded-[1px] bg-pending px-1 py-[0.5px] text-[8.5px] text-ink-950" title="OANDA says this market is not tradeable right now (closed or halted)">CLOSED</span>}
              </span>
              <span className="num text-right text-[13px] text-fg" title={q.ageMs !== null ? `data age ${age(q.ageMs)}${q.bid !== null && q.ask !== null ? ` · bid ${px(sym, q.bid)} / ask ${px(sym, q.ask)}` : ''}` : undefined}>
                {px(sym, q.last)}
              </span>
              <span className={cx('num text-right text-[11.5px]', (q.changePct ?? 0) >= 0 ? 'text-call' : 'text-put')}>{pct(q.changePct, { sign: true })}</span>
              <span className={cx('num text-right text-[11.5px]', vs === null ? 'text-fg-3' : vs >= 0 ? 'text-call' : 'text-put')}>{vs === null ? '—' : `${vs >= 0 ? '▲' : '▼'} ${pct(Math.abs(vs))}`}</span>
            </div>
          );
        })}
      </div>
      {md.stockPartialVolume && <div className="label mt-1 border-t border-line px-2.5 pt-1.5 !text-[9.5px]">IEX feed · partial volume · VWAP is IEX-only</div>}
      {md.tickVolume && <div className="label mt-1 border-t border-line px-2.5 pt-1.5 !text-[9.5px]">OANDA prices · mid of bid/ask · volume = number of price updates (tick volume), not traded size</div>}
    </Panel>
  );
}
