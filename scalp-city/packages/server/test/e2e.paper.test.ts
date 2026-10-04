import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CityEvent, JournalTradeView, Snapshot, TimelineEvent, WorkerView } from '@scalp-city/shared';
import { startE2E, type E2E } from './support/e2eHarness.js';

/**
 * PAPER end-to-end acceptance flow (spec §123, §129), automated.
 *
 * The production Alpaca adapters (REST, JSON trade stream, msgpack data
 * streams) run unmodified against a protocol-level fake of Alpaca, driven
 * on a virtual clock through a scripted market:
 *
 *   history: opening range ~600.3, a decline to 597, then flat
 *   live:    a high-volume rally back through VWAP, EMA50 and the OR high
 *
 * Expected: QQQ OG charges to a CALL, passes risk, buys an ATM call, the
 * broker fills it, the rally continues, take-profit fires, the exit fills,
 * and realized P&L flows to the worker, vault, journal and audit log.
 */

// 09:30–09:44 range near 600, decline to 597 by 10:30, flat after.
function historyPath(symbol: string, i: number, base: number): number {
  if (symbol !== 'QQQ') return base + Math.sin(i / 5) * 0.2;
  if (i < 15) return 600 + 0.3 * Math.sin(i);
  if (i < 60) return 600 - ((i - 15) * 3) / 45;
  return 597 + 0.05 * Math.sin(i);
}

let e: E2E;

beforeAll(async () => {
  e = await startE2E({ fake: { historyPath } });
}, 60_000);

afterAll(async () => {
  await e?.close();
});

const snapshot = async () => (await e.api<Snapshot>('GET', '/api/snapshot')).body;
const worker = async (id: string) => (await snapshot()).workers.find((w) => w.config.id === id)!;

/** Print trades through the current minute, then close the bar one second after the minute ends. */
async function minute(price: number, volume: number): Promise<void> {
  const steps = 5;
  for (let k = 1; k <= steps; k++) {
    e.fake.trade('QQQ', price - 0.2 + (0.2 * k) / steps, volume / steps);
    e.fake.trade('SPY', 570, 100);
    e.fake.trade('IWM', 220, 100);
  }
  const now = e.clock.now();
  const nextMinute = Math.floor(now / 60_000) * 60_000 + 60_000;
  await e.advance(nextMinute + 1000 - now);
  const bar = e.fake.closeBar('QQQ');
  e.fake.closeBar('SPY');
  e.fake.closeBar('IWM');
  // Synchronise on the server, not on a sleep: under CPU load a fixed delay
  // let assertions race the bar evaluation. Wait until qqq-og has evaluated
  // exactly this bar.
  if (bar) await e.waitFor(async () => ((await worker('qqq-og')).signal.barTime ?? 0) >= bar.t, `qqq-og evaluated the ${new Date(bar.t).toISOString()} bar`);
}

describe('PAPER end-to-end: market data → signal → risk → order → fill → position → exit → P&L', () => {
  it('starts, authenticates, connects to the broker, reconciles and reaches READY', async () => {
    const s = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.system.phase === 'READY' ? snap : null;
    }, 'system READY');
    expect(s.system.env).toBe('paper');
    expect(s.system.broker.status).toBe('CONNECTED');
    expect(s.system.broker.accountMasked).toBe('••••4821');
    expect(s.system.marketData.stock.state).toBe('CONNECTED');
    expect(s.system.reconciliation.status).toBe('RECONCILED');
    expect(s.system.endpoints.nonStandard).toBe(true); // the fake is flagged, never presented as Alpaca
    expect(s.account.equity).toBe(100_000);
    expect(s.workers).toHaveLength(5);
    // Autotrading is OFF after every start.
    expect(s.system.controls.autotrading).toBe(false);
    expect(s.workers.every((w) => !w.autotradeEnabled)).toBe(true);
    // The UI received a snapshot over the WebSocket.
    expect(e.messages.some((m) => m.type === 'snapshot')).toBe(true);
  });

  it('loads real QQQ/SPY/IWM data with indicators from history', async () => {
    const s = await snapshot();
    for (const sym of ['QQQ', 'SPY', 'IWM']) {
      expect(s.quotes[sym]!.last).not.toBeNull();
      expect(s.quotes[sym]!.vwap).not.toBeNull();
      expect(s.quotes[sym]!.ema50).not.toBeNull();
    }
    expect(s.quotes.QQQ!.last!).toBeLessThan(s.quotes.QQQ!.vwap!); // the decline left price under VWAP
  });

  it('enables autotrading and the QQQ OG worker (with confirmation)', async () => {
    const refused = await e.api('POST', '/api/workers/qqq-og/enabled', { enabled: true });
    expect(refused.status).toBe(428); // enabling autonomous execution requires confirmation
    expect((await e.api('POST', '/api/controls/autotrading', { enabled: true })).status).toBe(200);
    const r = await e.api<WorkerView>('POST', '/api/workers/qqq-og/enabled', { enabled: true, confirmed: true });
    expect(r.status).toBe(200);
    expect(r.body.autotradeEnabled).toBe(true);
  });

  it('charges a CALL setup from a real rally and enters only after risk approval and a broker fill', async () => {
    await minute(597.6, 30_000); // 11:00 — still below VWAP
    await minute(598.4, 30_000); // 11:01 — reclaims VWAP
    await minute(599.3, 30_000); // 11:02
    await minute(600.2, 30_000); // 11:03 — CHARGING, below the opening-range high
    let w = await worker('qqq-og');
    expect(w.signal.direction).toBe('CALL');
    expect(['CHARGING', 'READY']).toContain(w.signal.phase);
    await minute(601.0, 30_000); // 11:04 — every condition confirmed → READY

    const filled = await e.waitFor(async () => {
      const ww = await worker('qqq-og');
      return ww.position ? ww : null;
    }, 'entry filled', 15_000);
    expect(filled.position!.assetClass).toBe('us_option');
    expect(filled.position!.direction).toBe('CALL');
    expect(filled.position!.option!.type).toBe('call');
    expect(filled.position!.qty).toBeGreaterThan(0);
    w = filled;

    // Lifecycle strictly from broker evidence. The broker's position list
    // refreshes shortly after the fill event, so wait for it rather than race it.
    const s = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.positions.length > 0 ? snap : null;
    }, 'broker position listed');
    const entry = s.orders.find((o) => o.workerId === 'qqq-og' && o.purpose === 'ENTRY')!;
    expect(entry.state).toBe('FILLED');
    expect(entry.risk!.approved).toBe(true);
    expect(entry.filledQty).toBe(entry.qty);
    expect(entry.brokerOrderId).not.toBeNull();
    const ids = entry.risk!.checks.map((c) => c.id);
    for (const id of ['buying_power', 'liquidity', 'max_positions', 'daily_loss', 'market_open', 'data_fresh', 'broker']) expect(ids).toContain(id);
    // Broker and local ledger agree.
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.workerId).toBe('qqq-og');
    expect(e.fake.positions.get(s.positions[0]!.symbol)!.qty).toBe(w.position!.qty);
  });

  it('manages the position and exits on take-profit after a broker fill', async () => {
    await minute(601.8, 20_000);
    // Rally continues: the ATM call reprices well above +25%.
    e.fake.trade('QQQ', 603.6, 500);
    const flat = await e.waitFor(async () => {
      const ww = await worker('qqq-og');
      return !ww.position && ww.stats.tradesAllTime === 1 ? ww : null;
    }, 'take-profit exit filled', 20_000);
    expect(flat.stats.realizedToday).toBeGreaterThan(0);
    expect(flat.stats.winRate).toBe(100);

    // The broker is authoritative: wait for its position list to refresh after the fill.
    const s = await e.waitFor(async () => {
      const snap = await snapshot();
      return snap.positions.length === 0 ? snap : null;
    }, 'broker positions flat');
    const exit = s.orders.find((o) => o.workerId === 'qqq-og' && o.purpose === 'EXIT')!;
    expect(exit.state).toBe('FILLED');
    expect(e.fake.positions.size).toBe(0);
  });

  it('realized P&L equals the actual fills and reaches the vault, journal, leaderboard and heatmap', async () => {
    const s = await snapshot();
    const entry = s.orders.find((o) => o.workerId === 'qqq-og' && o.purpose === 'ENTRY')!;
    const exit = s.orders.find((o) => o.workerId === 'qqq-og' && o.purpose === 'EXIT')!;
    const expected = (exit.filledAvgPrice! - entry.filledAvgPrice!) * entry.filledQty * 100;

    const j = await e.api<JournalTradeView[]>('GET', '/api/journal');
    expect(j.body).toHaveLength(1);
    const t = j.body[0]!;
    expect(t.status).toBe('CLOSED');
    expect(t.realizedPnl!).toBeCloseTo(expected, 6);
    expect(t.exitReason).toBe('TAKE_PROFIT');
    expect(t.signalCharge).toBe(100);
    expect(t.signalConditions!.length).toBe(6);
    expect(t.entryOrderIds).toContain(entry.id);
    expect(t.exitOrderIds).toContain(exit.id);

    // Vault: broker equity moved by exactly the realized amount.
    await e.waitFor(async () => Math.abs(((await snapshot()).account.equity ?? 0) - (100_000 + expected)) < 0.01, 'vault equity updated');
    const after = await snapshot();
    expect(after.account.dayPnl!).toBeCloseTo(expected, 2);

    // Worker stats feed the heatmap; leaderboard ranks by session P&L.
    const ranked = [...after.workers].sort((a, b) => (b.stats.pnlToday ?? 0) - (a.stats.pnlToday ?? 0));
    expect(ranked[0]!.config.id).toBe('qqq-og');
    expect(ranked[0]!.stats.realizedToday).toBeCloseTo(expected, 6);
    // Goal reached → the worker stands down (spec §28).
    if (expected >= 500) expect(['STANDING_DOWN', 'PROFIT']).toContain(ranked[0]!.towerState);
  });

  it('pushed real-time city events only after broker confirmation, and a real-timestamped timeline', async () => {
    const city = e.messages.filter((m): m is Extract<typeof m, { type: 'city.event' }> => m.type === 'city.event').map((m) => m.data as CityEvent);
    const kinds = city.map((c) => c.kind);
    expect(kinds).toContain('ORDER_SUBMITTED');
    expect(kinds).toContain('ORDER_FILLED');
    expect(kinds).toContain('PROFIT_LOCKED');
    expect(kinds.indexOf('ORDER_FILLED')).toBeGreaterThan(kinds.indexOf('ORDER_SUBMITTED'));

    const s = await snapshot();
    const titles = s.timeline.map((x: TimelineEvent) => x.title);
    expect(titles.some((x) => x.includes('VWAP CROSS confirmed'))).toBe(true);
    expect(titles.some((x) => x.includes('signal reached 100%'))).toBe(true);
    expect(titles.some((x) => x.startsWith('Order submitted'))).toBe(true);
    expect(titles.some((x) => x.startsWith('Order filled'))).toBe(true);
    expect(titles.some((x) => x.includes('exit order submitted'))).toBe(true);
    expect(titles.some((x) => x.startsWith('Position closed · +$'))).toBe(true);
    // Sequence numbers on the socket never skip.
    const seqs = e.messages.map((m) => m.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('recorded an immutable, verifiable audit trail', async () => {
    await e.app.audit.flush();
    const rows = (await e.api<{ action: string }[]>('GET', '/api/audit?limit=500')).body.map((r) => r.action);
    for (const a of ['SYSTEM_START', 'LOGIN', 'RECOVERY_COMPLETE', 'AUTOTRADING_ON', 'WORKER_ENABLED', 'ORDER_REQUESTED', 'ORDER_SUBMITTED', 'ORDER_FILLED', 'POSITION_OPENED', 'POSITION_CLOSED']) {
      expect(rows).toContain(a);
    }
    const v = await e.api<{ ok: boolean; checked: number }>('GET', '/api/audit/verify');
    expect(v.body.ok).toBe(true);
    expect(v.body.checked).toBeGreaterThan(10);
  });

  it('counts the round trip toward the PAPER verification required before LIVE', async () => {
    const r = await e.api<{ items: { id: string; ok: boolean }[] }>('GET', '/api/readiness');
    expect(r.body.items.find((i) => i.id === 'paper_e2e')!.ok).toBe(true);
    // …while LIVE itself stays refused: this server runs PAPER and the lock is closed.
    expect(r.body.items.find((i) => i.id === 'environment')!.ok).toBe(false);
    expect(r.body.items.find((i) => i.id === 'server_lock')!.ok).toBe(false);
  });
});
