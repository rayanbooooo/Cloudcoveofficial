import { directionLabel, instrumentName, priceDecimals, vwapSeries, type OrderView, type SymbolQuoteView, type WorkerView } from '@scalp-city/shared';
import { countdown, hmET, humanize, money, px, qtyStr, unitsStr } from '../../lib/format';
import type { LiveBars } from './useLiveBars';

/**
 * What the robot's monitors show. Every figure comes from the same server
 * views the rest of the app uses — real bars from the broker's feed, the
 * worker's own state, broker-confirmed position values. When something is
 * unavailable the screen says so; it never draws a stand-in.
 *
 * The screens are small on the 3D desk, so they favour a few large numbers
 * over detail; the full detail is in the panels around the stage.
 */
export interface ScreenData {
  w: WorkerView;
  bars: LiveBars;
  order: OrderView | null;
  quote: SymbolQuoteView | null;
  /** Server time (ms). */
  now: number;
}

export const SCREEN = {
  chart: { w: 704, h: 440 },
  position: { w: 832, h: 520 },
  signal: { w: 704, h: 440 },
} as const;

const C = {
  bg: '#04070c',
  panel: '#0a111a',
  line: 'rgba(140,160,190,0.12)',
  text: '#eef3fa',
  dim: '#8c99ae',
  faint: '#5a6880',
  call: '#2ee6a6',
  put: '#ff4d6d',
  amber: '#ffb020',
  blue: '#4c8dff',
  white: '#dce6f5',
};

const FONT = '"JetBrains Mono Variable", ui-monospace, Menlo, monospace';
const DISPLAY = '"Archivo Variable", "JetBrains Mono Variable", system-ui, sans-serif';

type Align = 'left' | 'right' | 'center';

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, o: { size?: number; weight?: number; color?: string; align?: Align; font?: string; max?: number } = {}): void {
  ctx.font = `${o.weight ?? 600} ${o.size ?? 22}px ${o.font ?? FONT}`;
  ctx.fillStyle = o.color ?? C.text;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = 'alphabetic';
  if (o.max) ctx.fillText(s, x, y, o.max);
  else ctx.fillText(s, x, y);
}

function frame(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string): void {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, w, h);
  // faint scanlines + a thin accent edge: reads as a screen without hiding any data
  ctx.fillStyle = 'rgba(255,255,255,0.016)';
  for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.7;
  ctx.fillRect(0, 0, w, 5);
  ctx.globalAlpha = 1;
}

function dashedLine(ctx: CanvasRenderingContext2D, x1: number, y: number, x2: number, color: string, dash = [8, 6]): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x1, y);
  ctx.lineTo(x2, y);
  ctx.stroke();
  ctx.restore();
}

function tag(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, color: string, align: Align = 'left', size = 20): void {
  ctx.font = `700 ${size}px ${FONT}`;
  const wd = ctx.measureText(s).width + 14;
  const left = align === 'right' ? x - wd : align === 'center' ? x - wd / 2 : x;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.2;
  ctx.fillRect(left, y - size, wd, size + 8);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(s, left + 7, y);
}

const etDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayKey = (t: number) => etDay.format(t);

// ── Chart screen ───────────────────────────────────────────────────────────

export function drawChartScreen(ctx: CanvasRenderingContext2D, d: ScreenData, accent: string): void {
  const { w: W, h: H } = SCREEN.chart;
  const sym = d.w.config.symbol;
  const dec = priceDecimals(sym);
  frame(ctx, W, H, accent);

  const bars = d.bars.bars.slice(-48);
  const last = bars[bars.length - 1] ?? null;
  const live = d.quote?.last ?? last?.c ?? null;
  const up = last ? last.c >= last.o : true;
  text(ctx, instrumentName(sym), 20, 52, { size: 38, weight: 800, font: DISPLAY });
  text(ctx, live === null ? '—' : px(sym, live), W - 20, 54, { size: 40, weight: 800, color: up ? C.call : C.put, align: 'right' });

  const plot = { x: 14, y: 74, w: W - 14 - 150, h: H - 74 - 50 };
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = plot.y + (plot.h * i) / 3;
    ctx.beginPath();
    ctx.moveTo(plot.x, y);
    ctx.lineTo(plot.x + plot.w, y);
    ctx.stroke();
  }

  if (bars.length < 2) {
    const msg = d.bars.status === 'loading' ? 'LOADING BARS…' : d.bars.status === 'error' ? 'NO DATA' : 'NO BARS YET';
    text(ctx, msg, plot.x + plot.w / 2 + 40, plot.y + plot.h / 2, { size: 40, weight: 800, color: d.bars.status === 'error' ? C.put : C.dim, align: 'center', font: DISPLAY });
    text(ctx, d.bars.status === 'error' ? (d.bars.error ?? 'chart unavailable').slice(0, 44) : 'real bars only — none drawn until the feed delivers them', plot.x + plot.w / 2 + 40, plot.y + plot.h / 2 + 36, { size: 20, color: C.faint, align: 'center' });
    return;
  }

  let lo = Math.min(...bars.map((b) => b.l));
  let hi = Math.max(...bars.map((b) => b.h));
  const span0 = Math.max(hi - lo, 1e-9);
  // Entry / stop / target are shown only for CFD positions, whose prices are on the same scale as the chart.
  const pos = d.w.config.instrument === 'CFD' ? d.w.position : null;
  const levels: { price: number; color: string; label: string }[] = [];
  if (pos) {
    levels.push({ price: pos.avgEntryPrice, color: C.white, label: 'ENTRY' });
    if (pos.stopPrice !== null) levels.push({ price: pos.stopPrice, color: C.put, label: 'STOP' });
    if (pos.targetPrice !== null) levels.push({ price: pos.targetPrice, color: C.call, label: 'TARGET' });
    // widen the view to include a level only if it is reasonably close to the visible range
    for (const l of levels) {
      if (l.price > hi && l.price - hi <= span0 * 2.5) hi = l.price;
      if (l.price < lo && lo - l.price <= span0 * 2.5) lo = l.price;
    }
  }
  const pad = (hi - lo) * 0.1 || 1e-6;
  const top = hi + pad;
  const bot = lo - pad;
  const yOf = (p: number) => plot.y + plot.h - ((p - bot) / (top - bot)) * plot.h;
  const n = bars.length;
  const step = plot.w / n;
  const cw = Math.max(3, step * 0.66);

  // VWAP (the same per-session anchoring the signal engine uses)
  const vw = vwapSeries(bars, dayKey);
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = vw[i];
    if (v === null || v === undefined) continue;
    const x = plot.x + step * (i + 0.5);
    if (!started) {
      ctx.moveTo(x, yOf(v));
      started = true;
    } else ctx.lineTo(x, yOf(v));
  }
  ctx.stroke();

  for (let i = 0; i < n; i++) {
    const b = bars[i]!;
    const x = plot.x + step * (i + 0.5);
    const col = b.c >= b.o ? C.call : C.put;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, yOf(b.h));
    ctx.lineTo(x, yOf(b.l));
    ctx.stroke();
    const y1 = yOf(Math.max(b.o, b.c));
    const y2 = yOf(Math.min(b.o, b.c));
    ctx.fillRect(x - cw / 2, y1, cw, Math.max(2, y2 - y1));
  }

  for (const l of levels) {
    if (l.price < bot || l.price > top) continue;
    const y = yOf(l.price);
    dashedLine(ctx, plot.x, y, plot.x + plot.w, l.color);
    tag(ctx, l.label, plot.x + plot.w - 6, y - 8, l.color, 'right', 20);
  }

  if (live !== null && live >= bot && live <= top) {
    const y = yOf(live);
    dashedLine(ctx, plot.x, y, plot.x + plot.w + 8, 'rgba(232,238,246,0.5)', [3, 4]);
    ctx.fillStyle = up ? C.call : C.put;
    ctx.fillRect(plot.x + plot.w + 8, y - 17, 134, 34);
    text(ctx, px(sym, live), plot.x + plot.w + 16, y + 8, { size: 22, weight: 800, color: C.bg });
  }
  for (let i = 0; i <= 3; i++) {
    const p = top - ((top - bot) * i) / 3;
    const y = plot.y + (plot.h * i) / 3;
    if (live !== null && Math.abs(yOf(live) - y) < 24) continue;
    text(ctx, p.toFixed(dec), plot.x + plot.w + 16, y + 7, { size: 20, color: C.dim });
  }

  text(ctx, 'VWAP', plot.x + 4, H - 14, { size: 20, color: C.amber, weight: 800 });
  text(ctx, `1m · mid · ${hmET(last!.t)} ET`, plot.x + 84, H - 14, { size: 20, color: C.faint });
  if (d.quote?.stale) tag(ctx, 'STALE', W - 16, H - 14, C.amber, 'right', 20);
  else if (d.quote?.tradeable === false) tag(ctx, 'MARKET CLOSED', W - 16, H - 14, C.amber, 'right', 20);
}

// ── Position / order screen ────────────────────────────────────────────────

export function drawPositionScreen(ctx: CanvasRenderingContext2D, d: ScreenData, accent: string): void {
  const { w: W, h: H } = SCREEN.position;
  const w = d.w;
  const sym = w.config.symbol;
  frame(ctx, W, H, accent);
  const stateColor = ({ PROFIT: C.call, IN_TRADE: C.call, READY: C.call, ORDER_PENDING: C.amber, LOSS: C.put, HALTED: C.put, STANDING_DOWN: C.dim } as Record<string, string>)[w.towerState] ?? C.blue;
  text(ctx, w.config.name, 24, 52, { size: 36, weight: 800, font: DISPLAY });
  text(ctx, w.statusText, W - 24, 50, { size: 26, weight: 800, color: stateColor, align: 'right', max: 440 });

  const pos = w.position;
  const o = d.order;
  const cfd = w.config.instrument === 'CFD';
  if (pos) {
    const long = pos.qty > 0;
    const isOption = pos.assetClass === 'us_option';
    const col = isOption ? (pos.option?.type === 'put' ? C.put : C.call) : long ? C.call : C.put;
    const qtyAbs = Math.abs(pos.qty);
    const unit = isOption ? (qtyAbs === 1 ? 'contract' : 'contracts') : cfd ? (qtyAbs === 1 ? 'unit' : 'units') : qtyAbs === 1 ? 'share' : 'shares';
    text(ctx, isOption ? (pos.option?.type.toUpperCase() ?? 'LONG') : long ? 'LONG' : 'SHORT', 24, 146, { size: 84, weight: 800, color: col, font: DISPLAY });
    text(ctx, `${qtyStr(qtyAbs)} ${unit}`, 24, 186, { size: 28, color: C.dim });
    const pnl = pos.unrealizedPnl;
    text(ctx, pnl === null ? 'NO MARK' : money(pnl, { sign: true }), W - 24, 140, { size: 76, weight: 800, color: pnl === null ? C.amber : pnl >= 0 ? C.call : C.put, align: 'right', font: DISPLAY, max: 430 });
    text(ctx, 'UNREALIZED', W - 24, 180, { size: 22, color: C.dim, align: 'right' });

    // price ladder: stop ─ entry ─ target, with the live mark
    const lx = 24;
    const ly = 232;
    const lw = W - 48;
    const prices = [pos.stopPrice, pos.avgEntryPrice, pos.targetPrice, pos.markPrice].filter((p): p is number => p !== null);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const span = Math.max(hi - lo, 1e-9);
    const xOf = (p: number) => lx + 70 + ((p - lo) / span) * (lw - 140);
    ctx.fillStyle = C.panel;
    ctx.fillRect(lx, ly - 30, lw, 146);
    ctx.fillStyle = 'rgba(140,160,190,0.25)';
    ctx.fillRect(lx + 20, ly + 34, lw - 40, 6);
    if (pos.stopPrice !== null) {
      ctx.fillStyle = 'rgba(255,77,109,0.5)';
      const a = xOf(Math.min(pos.stopPrice, pos.avgEntryPrice));
      const b = xOf(Math.max(pos.stopPrice, pos.avgEntryPrice));
      ctx.fillRect(a, ly + 30, b - a, 14);
    }
    if (pos.targetPrice !== null) {
      ctx.fillStyle = 'rgba(46,230,166,0.5)';
      const a = xOf(Math.min(pos.targetPrice, pos.avgEntryPrice));
      const b = xOf(Math.max(pos.targetPrice, pos.avgEntryPrice));
      ctx.fillRect(a, ly + 30, b - a, 14);
    }
    const mark = (p: number, color: string, label: string, above: boolean) => {
      const x = xOf(p);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, ly + 14);
      ctx.lineTo(x, ly + 60);
      ctx.stroke();
      text(ctx, label, x, above ? ly + 4 : ly + 90, { size: 22, weight: 800, color, align: 'center' });
    };
    if (pos.stopPrice !== null && cfd) mark(pos.stopPrice, C.put, 'STOP', true);
    mark(pos.avgEntryPrice, C.white, 'ENTRY', false);
    if (pos.targetPrice !== null && cfd) mark(pos.targetPrice, C.call, 'TARGET', true);
    if (pos.markPrice !== null) {
      const x = xOf(pos.markPrice);
      ctx.fillStyle = C.amber;
      ctx.beginPath();
      ctx.moveTo(x, ly + 50);
      ctx.lineTo(x - 13, ly + 74);
      ctx.lineTo(x + 13, ly + 74);
      ctx.closePath();
      ctx.fill();
      text(ctx, 'NOW', x, ly + 100, { size: 20, weight: 800, color: C.amber, align: 'center' });
    }
    if (cfd) {
      const held = pos.stopSource === 'broker';
      text(ctx, held ? `stop ${pos.stopPrice === null ? '' : px(sym, pos.stopPrice) + ' '}is held by the broker` : 'NO STOP AT THE BROKER', 24, 372, { size: 22, color: held ? C.dim : C.amber, weight: 700 });
      if (pos.riskAtStop !== null) text(ctx, `loses ${money(pos.riskAtStop)} if stopped`, W - 24, 372, { size: 22, color: C.dim, align: 'right' });
    }
  } else if (o && (w.towerState === 'ORDER_PENDING' || o.state === 'SUBMITTING' || o.state === 'SUBMITTED' || o.state === 'ACCEPTED')) {
    const buy = o.side === 'buy';
    text(ctx, 'ORDER SENT', 24, 140, { size: 80, weight: 800, color: C.amber, font: DISPLAY });
    text(ctx, `${o.purpose === 'ENTRY' ? 'Entry' : 'Exit'} · ${buy ? 'BUY' : 'SELL'} ${cfd ? unitsStr(o.qty) : `${qtyStr(o.qty)} ${o.assetClass === 'us_option' ? 'contracts' : 'shares'}`}`, 24, 190, { size: 32, color: C.text });
    text(ctx, `broker status: ${humanize(o.brokerStatus ?? o.state)}`, 24, 240, { size: 26, color: C.dim });
    text(ctx, 'waiting for the broker to confirm', 24, 282, { size: 24, color: C.faint });
    text(ctx, 'nothing is assumed filled', 24, 316, { size: 24, color: C.faint });
    const k = Math.floor(d.now / 350) % 4;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < k ? C.amber : 'rgba(255,176,32,0.2)';
      ctx.beginPath();
      ctx.arc(40 + i * 40, 372, 12, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const halted = w.towerState === 'HALTED' || w.towerState === 'STANDING_DOWN';
    text(ctx, halted ? (w.towerState === 'HALTED' ? 'HALTED' : 'STOOD DOWN') : 'FLAT', 24, 146, { size: 88, weight: 800, color: halted ? (w.towerState === 'HALTED' ? C.put : C.dim) : C.white, font: DISPLAY });
    if (w.haltReason) text(ctx, w.haltReason.slice(0, 40), 24, 192, { size: 26, color: C.amber });
    else text(ctx, `no position in ${instrumentName(sym)}`, 24, 192, { size: 26, color: C.dim });
    const m = w.market;
    text(ctx, 'NEXT ENTRY', 24, 262, { size: 22, weight: 800, color: C.faint });
    if (!cfd) {
      text(ctx, 'waits for a READY signal', 24, 308, { size: 28, color: C.dim });
      text(ctx, 'and every risk check', 24, 344, { size: 28, color: C.dim });
    } else if (m && m.plannedUnits !== null) {
      text(ctx, unitsStr(m.plannedUnits), 24, 316, { size: 52, weight: 800 });
      text(ctx, `risks at most ${money(w.config.limits.riskPerTrade)} at its stop`, 24, 358, { size: 24, color: C.dim });
    } else {
      text(ctx, (m?.sizingNote ?? 'size unavailable').slice(0, 40), 24, 312, { size: 26, color: C.amber });
    }
  }

  // footer: today at a glance
  const s = w.stats;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(24, H - 112);
  ctx.lineTo(W - 24, H - 112);
  ctx.stroke();
  const cols: [string, string, string?][] = [
    ['TODAY', money(s.realizedToday, { sign: true }), s.realizedToday > 0 ? C.call : s.realizedToday < 0 ? C.put : C.text],
    ['TRADES', `${s.tradesToday}/${w.config.limits.maxTradesPerDay}`],
    ['WIN RATE', s.winRate === null ? '—' : `${s.winRate.toFixed(0)}%`],
    ['LOSS LIMIT', `−${money(w.config.limits.dailyLossLimit)}`],
  ];
  cols.forEach(([k, v, c], i) => {
    const x = 24 + i * ((W - 48) / 4);
    text(ctx, k, x, H - 74, { size: 20, weight: 700, color: C.dim });
    text(ctx, v, x, H - 30, { size: 36, weight: 800, color: c ?? C.text, max: (W - 48) / 4 - 12 });
  });
}

// ── Signal screen ──────────────────────────────────────────────────────────

export function drawSignalScreen(ctx: CanvasRenderingContext2D, d: ScreenData, accent: string): void {
  const { w: W, h: H } = SCREEN.signal;
  const w = d.w;
  const sig = w.signal;
  frame(ctx, W, H, accent);
  const dir = sig.direction;
  const col = dir === 'CALL' ? C.call : dir === 'PUT' ? C.put : C.blue;
  text(ctx, 'SIGNAL', 22, 46, { size: 24, weight: 800, color: C.dim });
  text(ctx, humanize(sig.phase), W - 22, 46, { size: 24, weight: 800, color: sig.phase === 'READY' ? C.call : C.dim, align: 'right' });
  text(ctx, dir === 'NEUTRAL' ? 'NO SETUP' : directionLabel(dir, w.config.instrument), 22, 124, { size: 70, weight: 800, color: col, font: DISPLAY });
  text(ctx, `${sig.charge}%`, W - 22, 124, { size: 70, weight: 800, color: col, align: 'right', font: DISPLAY });

  // segmented charge bar: confirmed (solid) with the forming-bar preview (faint) behind it
  const bx = 22;
  const by = 144;
  const bw = W - 44;
  const segs = 20;
  const segW = bw / segs;
  const preview = sig.live && sig.live.direction === dir ? sig.live.charge : 0;
  for (let i = 0; i < segs; i++) {
    const frac = ((i + 1) / segs) * 100;
    const on = sig.charge >= frac - 0.01;
    const ghost = !on && preview >= frac - 0.01;
    ctx.fillStyle = on || ghost ? col : 'rgba(140,160,190,0.16)';
    ctx.globalAlpha = on ? 1 : ghost ? 0.35 : 1;
    ctx.fillRect(bx + i * segW + 2, by, segW - 4, 28);
  }
  ctx.globalAlpha = 1;

  const y0 = 226;
  sig.conditions.slice(0, 6).forEach((c, i) => {
    const colX = i % 2 === 0 ? 22 : W / 2 + 6;
    const y = y0 + Math.floor(i / 2) * 50;
    if (c.met) text(ctx, '✓', colX, y, { size: 34, weight: 800, color: C.call });
    else text(ctx, c.unavailable ? '·' : '✕', colX, y, { size: 34, weight: 800, color: c.unavailable ? C.faint : C.put });
    text(ctx, c.label.replace('Opening range', 'Open range'), colX + 40, y, { size: 24, weight: 800, color: c.met ? C.text : C.dim, max: W / 2 - 70 });
  });
  const next = sig.nextEvaluationAt;
  text(ctx, next ? `bar closes in ${countdown(next - d.now)}` : 'no bar in progress', 22, H - 18, { size: 22, color: C.dim });
  text(ctx, sig.consumed ? 'signal used' : 'last closed bar', W - 22, H - 18, { size: 22, color: C.faint, align: 'right' });
}
