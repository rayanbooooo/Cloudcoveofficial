import { describe, expect, it } from 'vitest';
import { ROADS_X, ROADS_Z } from '../src/city/layout';
import { EVENT_KINDS, KINDS, lightAt, MAX_EVENT_VEHICLES, TrafficSim, type EventTag, type Vehicle } from '../src/city/traffic';

const tag: EventTag = { text: 'FILLED @ 300.00', sub: '2 × GLD', color: '#2ee6a6' };
const DT = 1 / 30;

/** Run the city for `seconds`, calling `each` after every step. */
function run(sim: TrafficSim, seconds: number, flow: (t: number) => number, each: () => void, halt: (t: number) => boolean = () => false): void {
  for (let i = 0; i < seconds / DT; i++) {
    const t = i * DT;
    sim.step(DT, flow(t), halt(t));
    each();
  }
}

function overlaps(sim: TrafficSim): number {
  let n = 0;
  for (const lane of sim.lanes) {
    const cars = lane.cars;
    for (let i = 0; i < cars.length && cars.length > 1; i++) {
      const c = cars[i]!;
      const lead = cars[(i + 1) % cars.length]!;
      let d = lead.s - c.s;
      if (d <= 0) d += lane.length;
      if (d - (lead.len + c.len) / 2 < 0) n++;
    }
  }
  return n;
}

describe('city traffic simulation', () => {
  it('never shows green to both directions of a crossing, and every signal cycles through all three lights', () => {
    for (const g of new TrafficSim().gates.filter((x) => x.axis === 'NS')) {
      const seen = new Set<number>();
      for (let t = 0; t < 60; t += 0.1) {
        const ns = lightAt(g, t);
        const ew = lightAt(g.mate, t);
        expect(ns === 0 && ew === 0).toBe(false);
        // Nobody gets yellow while the other side is green or yellow either.
        expect(ns !== 2 && ew !== 2 && (ns === 1 || ew === 1)).toBe(false);
        seen.add(ns);
      }
      expect([...seen].sort()).toEqual([0, 1, 2]);
    }
  });

  it('keeps vehicles apart, on their roads, under the speed limit, and out of each other’s way at crossings', () => {
    for (const density of [1, 0.4]) {
      const sim = new TrafficSim({ density });
      let overlap = 0;
      let bad = 0;
      let conflict = 0;
      run(
        sim,
        240,
        // Open market, then no data, then night traffic, then a kill switch, then open again.
        (t) => (t < 80 ? 1 : t < 110 ? 0 : t < 170 ? 0.55 : t < 190 ? 0 : 1),
        () => {
          overlap += overlaps(sim);
          for (const lane of sim.lanes) {
            for (const c of lane.cars) {
              if (!Number.isFinite(c.x + c.z + c.yaw + c.v) || c.s < 0 || c.s >= lane.length || c.v > lane.limit * c.pace * 1.15 + 0.01) bad++;
            }
          }
          for (const g of sim.gates) if (g.axis === 'NS' && g.crossing > 0 && g.mate.crossing > 0) conflict++;
        },
        (t) => t >= 170 && t < 190,
      );
      expect({ density, overlap, bad, conflict }).toEqual({ density, overlap: 0, bad: 0, conflict: 0 });
    }
  });

  it('keeps every vehicle moving over a long run (no gridlock)', () => {
    const sim = new TrafficSim();
    const travelled = new Map<number, number>();
    const last = new Map<number, number>();
    run(sim, 1200, () => 1, () => {
      for (const c of sim.cars) {
        const before = last.get(c.id);
        if (before !== undefined) travelled.set(c.id, (travelled.get(c.id) ?? 0) + (c.s >= before ? c.s - before : c.s + c.lane.length - before));
        last.set(c.id, c.s);
      }
    });
    for (const [, d] of travelled) expect(d / 1200).toBeGreaterThan(0.5); // units per second, red lights included
  });

  it('stands still when the flow is zero and brakes hard when halted', () => {
    const sim = new TrafficSim();
    run(sim, 20, () => 1, () => undefined);
    run(sim, 12, () => 0, () => undefined);
    expect(Math.max(...sim.cars.map((c) => c.v))).toBeLessThan(0.05);
    const moving = new TrafficSim();
    run(moving, 20, () => 1, () => undefined);
    run(moving, 3, () => 1, () => undefined, () => true);
    expect(Math.max(...moving.cars.map((c) => c.v))).toBeLessThan(0.05);
  });

  it('is repeatable: the same seed gives the same city', () => {
    const a = new TrafficSim({ seed: 9 });
    const b = new TrafficSim({ seed: 9 });
    run(a, 30, () => 1, () => undefined);
    run(b, 30, () => 1, () => undefined);
    expect(a.cars.map((c) => [c.kind, c.s.toFixed(6)])).toEqual(b.cars.map((c) => [c.kind, c.s.toFixed(6)]));
  });

  it('puts event vehicles on the plaza boulevard, never more than the cap, and removes them after a lap', () => {
    const sim = new TrafficSim();
    run(sim, 5, () => 1, () => undefined);
    // Six requests in a row: only a few fit at once, the rest wait for room and for a free slot.
    for (let i = 0; i < 6; i++) sim.requestEvent(EVENT_KINDS[i % EVENT_KINDS.length]!, tag);
    let most = 0;
    let overlap = 0;
    let offBoulevard = 0;
    let tagged = 0;
    run(sim, 150, () => 1, () => {
      most = Math.max(most, sim.eventVehicles);
      overlap += overlaps(sim);
      for (const c of sim.cars) {
        if (c.tag) {
          tagged++;
          if (!c.lane.ring || c.tag !== tag || !KINDS[c.kind].label) offBoulevard++;
        }
      }
    });
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(MAX_EVENT_VEHICLES);
    expect(tagged).toBeGreaterThan(0);
    expect(offBoulevard).toBe(0);
    expect(overlap).toBe(0);
    // Everything that was asked for within the waiting time has come and gone.
    expect(sim.eventVehicles).toBe(0);
    expect(sim.cars.every((c) => c.tag === null)).toBe(true);
  });

  it('waits a few seconds for room on the boulevard, then gives the request up', () => {
    // Park the boulevard's cars in a row around the front of the plaza, where event vehicles join, so there is no room.
    const jam = (sim: TrafficSim) => {
      for (const lane of sim.lanes.filter((l) => l.ring)) {
        lane.cars.forEach((c, i) => (c.s = (((i - 2) * 4.5) % lane.length + lane.length) % lane.length));
        lane.cars.sort((x, y) => x.s - y.s);
        for (const c of lane.cars) sim.place(c);
      }
    };
    const open = (sim: TrafficSim) => {
      for (const lane of sim.lanes.filter((l) => l.ring)) {
        lane.cars.forEach((c, i) => (c.s = lane.length * (0.3 + (i * 0.7) / lane.cars.length)));
        lane.cars.sort((x, y) => x.s - y.s);
        for (const c of lane.cars) sim.place(c);
      }
    };
    // Room appears in time: the vehicle comes.
    const early = new TrafficSim();
    jam(early);
    expect(early.spawnEvent('police', tag)).toBeNull();
    early.requestEvent('police', tag);
    run(early, 3, () => 0, () => undefined);
    expect(early.eventVehicles).toBe(0);
    open(early);
    run(early, 2, () => 0, () => undefined);
    expect(early.eventVehicles).toBe(1);

    // Room appears too late: the request has lapsed and nothing comes.
    const late = new TrafficSim();
    jam(late);
    late.requestEvent('police', tag);
    run(late, 12, () => 0, () => undefined);
    open(late);
    run(late, 5, () => 0, () => undefined);
    expect(late.eventVehicles).toBe(0);
  });

  it('retires an event vehicle that cannot finish its lap because the city has stopped', () => {
    const sim = new TrafficSim();
    run(sim, 3, () => 1, () => undefined);
    expect(sim.spawnEvent('armored', tag)).not.toBeNull();
    run(sim, 100, () => 0, () => undefined);
    expect(sim.eventVehicles).toBe(0);
  });

  it('has a signal at every crossing of the grid roads', () => {
    const sim = new TrafficSim();
    expect(sim.gates).toHaveLength(ROADS_X.length * ROADS_Z.length * 2);
  });
});
