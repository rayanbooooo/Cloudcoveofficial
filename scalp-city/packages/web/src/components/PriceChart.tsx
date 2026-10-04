import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef, useState } from 'react';
import { aggregateBars, atr, ema, timeframeMinutes, vwapSeries, type Bar, type Timeframe } from '@scalp-city/shared';
import { Api } from '../lib/api';
import { hmET, price } from '../lib/format';
import { onBars, useStore } from '../store/store';
import { cx } from './ui';

export interface ChartMarker {
  time: number;
  side: 'buy' | 'sell';
  text: string;
}

const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const sessionKey = (t: number) => etDay.format(t);
const toTime = (t: number) => Math.floor(t / 1000) as UTCTimestamp;

/**
 * Real-market chart (spec §46–47): candles, VWAP, EMA50, volume and fills.
 * History is loaded once; live 1-minute bars then update only the last
 * candle and the last indicator points — the chart is never rebuilt per tick.
 */
export function PriceChart({ symbol, markers = [], date, height = 300, defaultTf = '1Min' }: { symbol: string; markers?: ChartMarker[]; date?: string; height?: number; defaultTf?: Timeframe }) {
  const ref = useRef<HTMLDivElement>(null);
  const markerRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [tf, setTf] = useState<Timeframe>(defaultTf);
  const [meta, setMeta] = useState<{ source: string; feed: string; error: string | null; atr: number | null }>({ source: '', feed: '', error: null, atr: null });
  const sessionOpen = useStore((s) => s.system?.market.sessionOpen ?? null);
  const sessionClose = useStore((s) => s.system?.market.sessionClose ?? null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart: IChartApi = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#5d6a7d', fontFamily: 'JetBrains Mono Variable, monospace', fontSize: 10, attributionLogo: true },
      grid: { vertLines: { color: 'rgba(140,160,190,0.06)' }, horzLines: { color: 'rgba(140,160,190,0.06)' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: 'rgba(140,160,190,0.35)', width: 1, labelBackgroundColor: '#131b28' }, horzLine: { color: 'rgba(140,160,190,0.35)', width: 1, labelBackgroundColor: '#131b28' } },
      rightPriceScale: { borderColor: 'rgba(140,160,190,0.13)' },
      timeScale: { borderColor: 'rgba(140,160,190,0.13)', timeVisible: true, secondsVisible: false, tickMarkFormatter: (t: Time) => hmET((t as number) * 1000) },
      localization: { timeFormatter: (t: Time) => hmET((t as number) * 1000), priceFormatter: (p: number) => price(p) },
    });
    const candles: ISeriesApi<'Candlestick'> = chart.addSeries(CandlestickSeries, {
      upColor: '#26c28e',
      downColor: '#e0455f',
      borderVisible: false,
      wickUpColor: '#26c28e',
      wickDownColor: '#e0455f',
      priceLineColor: 'rgba(232,238,246,0.4)',
    });
    const vwapLine = chart.addSeries(LineSeries, { color: '#ffb020', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const emaLine = chart.addSeries(LineSeries, { color: '#4c8dff', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
    const markerApi: ISeriesMarkersPluginApi<Time> = createSeriesMarkers(candles, []);

    let oneMin: Bar[] = [];
    let disposed = false;
    let pending = false;

    const render = (full: boolean) => {
      const bars = tf === '1Min' ? oneMin : aggregateBars(oneMin, tf, Date.now());
      if (!bars.length) return;
      const closes = bars.map((b) => b.c);
      const vw = vwapSeries(bars, sessionKey);
      const em = ema(closes, 50);
      const at = atr(bars, 14);
      const candle = (b: Bar) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c });
      const vol = (b: Bar) => ({ time: toTime(b.t), value: b.v, color: b.c >= b.o ? 'rgba(38,194,142,0.28)' : 'rgba(224,69,95,0.28)' });
      if (full) {
        candles.setData(bars.map(candle));
        volume.setData(bars.map(vol));
        vwapLine.setData(bars.flatMap((b, i) => (vw[i] == null ? [] : [{ time: toTime(b.t), value: vw[i]! }])));
        emaLine.setData(bars.flatMap((b, i) => (em[i] == null ? [] : [{ time: toTime(b.t), value: em[i]! }])));
      } else {
        const last = bars[bars.length - 1]!;
        const i = bars.length - 1;
        candles.update(candle(last));
        volume.update(vol(last));
        if (vw[i] != null) vwapLine.update({ time: toTime(last.t), value: vw[i]! });
        if (em[i] != null) emaLine.update({ time: toTime(last.t), value: em[i]! });
      }
      setMeta((m) => ({ ...m, atr: at[at.length - 1] ?? null }));
    };

    setMeta((m) => ({ ...m, error: null }));
    Api.chart(symbol, '1Min', date)
      .then((res) => {
        if (disposed) return;
        oneMin = res.bars;
        setMeta({ source: res.source, feed: res.feedLabel, error: null, atr: null });
        render(true);
        chart.timeScale().fitContent();
      })
      .catch((e: Error) => !disposed && setMeta((m) => ({ ...m, error: e.message })));

    // Live updates (only for today's chart, regular session only).
    const off = date
      ? () => undefined
      : onBars(symbol, (updates) => {
          for (const b of updates) {
            if (sessionOpen !== null && (b.t < sessionOpen || (sessionClose !== null && b.t >= sessionClose))) continue;
            const idx = oneMin.findIndex((x) => x.t === b.t);
            if (idx >= 0) oneMin[idx] = b;
            else if (!oneMin.length || b.t > oneMin[oneMin.length - 1]!.t) oneMin.push(b);
          }
          if (pending) return;
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            if (!disposed) render(false);
          });
        });

    markerRef.current = markerApi;
    return () => {
      disposed = true;
      markerRef.current = null;
      off();
      chart.remove();
    };
  }, [symbol, tf, date, sessionOpen, sessionClose]);

  // Markers update without rebuilding the chart.
  useEffect(() => {
    const api = markerRef.current;
    if (!api) return;
    const mins = timeframeMinutes(tf) * 60_000;
    const ms: SeriesMarker<Time>[] = markers
      .map((m) => ({
        time: toTime(Math.floor(m.time / mins) * mins),
        position: m.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const),
        color: m.side === 'buy' ? '#2ee6a6' : '#ff4d6d',
        shape: m.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const),
        text: m.text,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    api.setMarkers(ms);
  }, [markers, tf, symbol, date]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="label-strong text-[11px] text-fg">{symbol}</span>
        {(['1Min', '5Min', '15Min'] as Timeframe[]).map((t) => (
          <button key={t} onClick={() => setTf(t)} className={cx('label-strong rounded-[1px] px-1.5 py-[1px] text-[10px]', tf === t ? 'bg-ink-600 text-fg' : 'text-fg-3 hover:text-fg-2')}>
            {t.replace('Min', 'm')}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-px w-3 bg-pending" />
            <span className="label">VWAP</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="h-px w-3 bg-signal" />
            <span className="label">EMA50</span>
          </span>
          <span className="label">ATR {meta.atr === null ? '—' : meta.atr.toFixed(2)}</span>
          <span className="label !text-fg-3">{meta.source === 'historical' ? 'HISTORICAL' : meta.feed}</span>
        </span>
      </div>
      <div ref={ref} style={{ height }} className="relative w-full">
        {meta.error && <div className="absolute inset-0 flex items-center justify-center text-[12px] text-put">{meta.error}</div>}
      </div>
    </div>
  );
}
