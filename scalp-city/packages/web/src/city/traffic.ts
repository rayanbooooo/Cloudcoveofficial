import { mulberry32, PLAZA_CENTER, RING, ROADS_X, ROADS_Z } from './layout';

/**
 * The city's traffic: a small car-following simulation (each vehicle brakes for the one in front and for a
 * red light) on the grid roads and on the boulevard that circles the plaza.
 *
 * Pure: no rendering, no store, no clock. The caller steps it with the frame time and a flow factor.
 * It is scenery. Nothing here reads or changes trading state; the only things that come from the real
 * system are the flow the caller steps it with (running / night / stopped) and the event vehicles the
 * caller spawns for broker-confirmed events.
 */

export type VehicleKind = 'sedan' | 'taxi' | 'van' | 'bus' | 'truck' | 'armored' | 'police' | 'courier' | 'tow';
/** Vehicles that share one 3D model. */
export type ModelGroup = 'car' | 'van' | 'bus' | 'truck';

export interface KindSpec {
  group: ModelGroup;
  /** Length along the direction of travel, in world units (1 unit is about 4.7 m). */
  len: number;
  label: string;
}

export const KINDS: Record<VehicleKind, KindSpec> = {
  sedan: { group: 'car', len: 0.95, label: 'SEDAN' },
  taxi: { group: 'car', len: 0.95, label: 'TAXI' },
  van: { group: 'van', len: 1.15, label: 'VAN' },
  bus: { group: 'bus', len: 2.3, label: 'BUS' },
  truck: { group: 'truck', len: 1.9, label: 'TRUCK' },
  armored: { group: 'truck', len: 1.9, label: 'ARMORED TRUCK' },
  police: { group: 'car', len: 0.95, label: 'POLICE CAR' },
  courier: { group: 'van', len: 1.15, label: 'COURIER VAN' },
  tow: { group: 'truck', len: 1.9, label: 'TOW TRUCK' },
};

export const EVENT_KINDS: readonly VehicleKind[] = ['armored', 'police', 'courier', 'tow'];
/** At most this many event vehicles drive at once, so a busy trading minute does not jam the boulevard. */
export const MAX_EVENT_VEHICLES = 3;

export interface EventTag {
  text: string;
  sub?: string;
  /** The worker the event belongs to, so the ride can lead to its desk. */
  workerId?: string | null;
  /** CSS colour of the tag and the roof light. */
  color: string;
}

/** What the city's flow stands for right now, so the signals can show it: running, night (market closed), frozen (no data), halt (kill switch). */
export type SimMode = 'run' | 'night' | 'frozen' | 'halt';

export interface Gate {
  x: number;
  z: number;
  /** NS: traffic along the north–south road. EW: along the east–west road. */
  axis: 'NS' | 'EW';
  phase: number;
  /** The other direction's signal at the same crossing. */
  mate: Gate;
  /** Vehicles of the other axis currently inside the crossing: this axis waits for them even on green. */
  crossing: number;
}

export interface Stop {
  /** Where the stop line is, measured along the lane. */
  s: number;
  gate: Gate;
}

export interface Lane {
  id: string;
  ring: boolean;
  length: number;
  /** Free speed in world units per second. */
  limit: number;
  /** Line lanes: where it starts and its unit direction. */
  ax: number;
  az: number;
  dx: number;
  dz: number;
  /** Ring lanes: centre, radius and direction (+1 runs clockwise as seen from the default camera). */
  cx: number;
  cz: number;
  r: number;
  dir: 1 | -1;
  stops: Stop[];
  /** Ordered by `s`; the vehicle ahead of the last one is the first. */
  cars: Vehicle[];
}

export interface Vehicle {
  id: number;
  kind: VehicleKind;
  lane: Lane;
  s: number;
  v: number;
  /** Last acceleration, for brake lights. */
  acc: number;
  len: number;
  /** Personal share of the lane's free speed. */
  pace: number;
  paint: number;
  x: number;
  z: number;
  yaw: number;
  /** Eased 0..1: a vehicle that appears or leaves grows or shrinks instead of popping. */
  fade: number;
  /** Event vehicles: distance left before they leave the city. */
  lap: number | null;
  /** Event vehicles: simulation time after which they leave whether or not they finished the lap. */
  expires: number | null;
  leaving: boolean;
  tag: EventTag | null;
}

export type Light = 0 | 1 | 2; // green, yellow, red

const HALF = 58; // roads run this far either side of the origin
const STOP_BACK = 2.1; // stop line this far before the crossing's centre
const LANE_OFFSET = 0.5;
const GREEN = 7;
const YELLOW = 1.4;
const ALL_RED = 1.2;
const CYCLE = 2 * (GREEN + YELLOW + ALL_RED);
const PAINTS = 7;
/** A crossing is this much of the lane either side of its centre; a vehicle overlapping it is "inside". */
const BOX_HALF = 1.3;
const BOX_CLEAR = 3;
/** An event vehicle that has not finished its lap (the city is stopped) leaves after this long. */
const EVENT_LIFETIME = 90;
const PENDING_SECONDS = 8;
const MAX_PENDING = 4;

// Intelligent-driver model constants.
const ACCEL = 1.5;
const BRAKE = 2.2;
const HEADWAY = 0.8;
const MIN_GAP = 0.35;

export function lightAt(g: Gate, t: number): Light {
  let p = (t + g.phase) % CYCLE;
  if (p < 0) p += CYCLE;
  if (g.axis === 'EW') p = (p + CYCLE / 2) % CYCLE;
  if (p < GREEN) return 0;
  if (p < GREEN + YELLOW) return 1;
  return 2;
}

export interface TrafficOptions {
  /** 1 = the full city, less thins the farthest roads out first. */
  density?: number;
  seed?: number;
}

const RING_KINDS: VehicleKind[] = ['taxi', 'sedan', 'bus', 'van', 'sedan', 'truck'];

export class TrafficSim {
  readonly lanes: Lane[] = [];
  readonly gates: Gate[] = [];
  /** Every vehicle, ambient and event. */
  readonly cars: Vehicle[] = [];
  /** Simulation seconds so far; the signals run on it. */
  time = 0;
  mode: SimMode = 'run';
  private nextId = 1;
  private eventCount = 0;
  /** Event vehicles waiting for room on the boulevard (or for one of the few slots to free up). */
  private pending: { kind: VehicleKind; tag: EventTag; until: number }[] = [];
  private pendingTimer = 0;
  private readonly rnd: () => number;

  constructor(opts: TrafficOptions = {}) {
    const density = opts.density ?? 1;
    this.rnd = mulberry32(opts.seed ?? 42);
    for (const rx of ROADS_X) for (const rz of ROADS_Z) {
      const phase = Math.floor(this.rnd() * CYCLE * 10) / 10;
      const ns = { x: rx, z: rz, axis: 'NS', phase, crossing: 0 } as Gate;
      const ew = { x: rx, z: rz, axis: 'EW', phase, crossing: 0, mate: ns } as Gate;
      ns.mate = ew;
      this.gates.push(ns, ew);
    }
    const gateAt = (x: number, z: number, axis: 'NS' | 'EW') => this.gates.find((g) => g.x === x && g.z === z && g.axis === axis)!;

    for (const rx of ROADS_X) {
      const far = Math.abs(rx) > 20;
      const limit = 3.2 + (far ? 0.5 : 0);
      const count = far ? 3 : 5;
      // Right-hand traffic: heading toward the viewer (+z) keeps to the west side of its road.
      this.addLine(`ns+${rx}`, rx - LANE_OFFSET, -HALF, 0, 1, limit, count, far, ROADS_Z.map((rz) => ({ s: rz - STOP_BACK + HALF, gate: gateAt(rx, rz, 'NS') })), density);
      this.addLine(`ns-${rx}`, rx + LANE_OFFSET, HALF, 0, -1, limit, count, far, ROADS_Z.map((rz) => ({ s: HALF - (rz + STOP_BACK), gate: gateAt(rx, rz, 'NS') })), density);
    }
    for (const rz of ROADS_Z) {
      const far = rz > 0;
      const limit = 3.5;
      const count = far ? 3 : 7;
      this.addLine(`ew+${rz}`, -HALF, rz + LANE_OFFSET, 1, 0, limit, count, far, ROADS_X.map((rx) => ({ s: rx - STOP_BACK + HALF, gate: gateAt(rx, rz, 'EW') })), density);
      this.addLine(`ew-${rz}`, HALF, rz - LANE_OFFSET, -1, 0, limit, count, far, ROADS_X.map((rx) => ({ s: HALF - (rx + STOP_BACK), gate: gateAt(rx, rz, 'EW') })), density);
    }
    // The plaza boulevard. Its cars are what the default view shows most, so it is never thinned out.
    this.addRing('ring-in', RING.inner, 1, 5);
    this.addRing('ring-out', RING.outer, -1, 5);
    for (const lane of this.lanes) for (const c of lane.cars) this.place(c);
  }

  private makeVehicle(kind: VehicleKind, lane: Lane, s: number): Vehicle {
    const c: Vehicle = {
      id: this.nextId++,
      kind,
      lane,
      s,
      v: lane.limit * 0.8,
      acc: 0,
      len: KINDS[kind].len,
      pace: 0.88 + this.rnd() * 0.24,
      paint: Math.floor(this.rnd() * PAINTS),
      x: 0,
      z: 0,
      yaw: 0,
      fade: 1,
      lap: null,
      expires: null,
      leaving: false,
      tag: null,
    };
    return c;
  }

  private pickKind(): VehicleKind {
    const r = this.rnd();
    if (r < 0.52) return 'sedan';
    if (r < 0.64) return 'taxi';
    if (r < 0.78) return 'van';
    if (r < 0.9) return 'truck';
    return 'bus';
  }

  private populate(lane: Lane, n: number, kinds?: VehicleKind[]): void {
    const at: number[] = [];
    for (let k = 0; k < n; k++) {
      let s = ((k + 0.5 + (this.rnd() - 0.5) * 0.4) / n) * lane.length;
      // Nobody starts inside a crossing.
      for (const st of lane.stops) if (Math.abs(s - (st.s + STOP_BACK)) < BOX_CLEAR) s = st.s + STOP_BACK + BOX_CLEAR;
      at.push(s);
    }
    at.sort((a, b) => a - b);
    at.forEach((s, k) => {
      const c = this.makeVehicle(kinds ? kinds[(k + lane.id.length) % kinds.length]! : this.pickKind(), lane, s);
      lane.cars.push(c);
      this.cars.push(c);
    });
  }

  private newLane(id: string, ring: boolean, length: number, limit: number): Lane {
    const lane: Lane = { id, ring, length, limit, ax: 0, az: 0, dx: 0, dz: 0, cx: 0, cz: 0, r: 0, dir: 1, stops: [], cars: [] };
    this.lanes.push(lane);
    return lane;
  }

  private addLine(id: string, ax: number, az: number, dx: number, dz: number, limit: number, count: number, far: boolean, stops: Stop[], density: number): void {
    // Thin density out from the farthest roads first; the near roads keep a car or two to the end.
    const n = far ? Math.round(count * Math.max(0, density * 1.4 - 0.4)) : Math.max(1, Math.round(count * density));
    if (n <= 0) return;
    const lane = this.newLane(id, false, HALF * 2, limit);
    Object.assign(lane, { ax, az, dx, dz });
    lane.stops = stops.sort((a, b) => a.s - b.s);
    this.populate(lane, n);
  }

  private addRing(id: string, r: number, dir: 1 | -1, count: number): void {
    const lane = this.newLane(id, true, Math.PI * 2 * r, 2.4);
    Object.assign(lane, { cx: PLAZA_CENTER.x, cz: PLAZA_CENTER.z, r, dir });
    this.populate(lane, count, RING_KINDS);
  }

  /** Vehicles driving for an event right now. */
  get eventVehicles(): number {
    return this.eventCount;
  }

  /**
   * An event vehicle for the boulevard: now if there is room, otherwise as soon as there is, within a few
   * seconds (a fill is not worth a late arrival, so older requests are dropped).
   */
  requestEvent(kind: VehicleKind, tag: EventTag): void {
    if (this.spawnEvent(kind, tag)) return;
    this.pending.push({ kind, tag, until: this.time + PENDING_SECONDS });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
  }

  /**
   * Put an event vehicle on the boulevard, entering near the front of the plaza (the part the default view
   * does not show) and leaving there after one lap. Returns null when the boulevard has no room right now
   * or too many event vehicles are already driving.
   */
  spawnEvent(kind: VehicleKind, tag: EventTag): Vehicle | null {
    if (this.eventCount >= MAX_EVENT_VEHICLES) return null;
    const len = KINDS[kind].len;
    const lanes = this.lanes.filter((l) => l.ring);
    if (this.rnd() < 0.5) lanes.reverse();
    for (const lane of lanes) {
      for (const off of [0, -1.5, 1.5, -3, 3, -4.5, 4.5, -6, 6, -7.5, 7.5, -9, 9]) {
        const s = (((off % lane.length) + lane.length) % lane.length);
        if (!this.roomAt(lane, s, len)) continue;
        const c = this.makeVehicle(kind, lane, s);
        c.fade = 0;
        c.pace = 1;
        c.lap = lane.length;
        c.expires = this.time + EVENT_LIFETIME;
        c.tag = tag;
        const at = lane.cars.findIndex((o) => o.s > s);
        if (at < 0) lane.cars.push(c);
        else lane.cars.splice(at, 0, c);
        this.cars.push(c);
        this.eventCount++;
        this.place(c);
        return c;
      }
    }
    return null;
  }

  private roomAt(lane: Lane, s: number, len: number): boolean {
    for (const o of lane.cars) {
      let d = Math.abs(o.s - s);
      d = Math.min(d, lane.length - d);
      if (d < (o.len + len) / 2 + 2.8) return false;
    }
    return true;
  }

  /** The light a signal shows right now. */
  light(g: Gate): Light {
    return lightAt(g, this.time);
  }

  /**
   * Advance by `dt` seconds. `flow` scales every vehicle's free speed (0 = stand still), `halt` brakes
   * hard and ignores flow (the kill switch).
   */
  step(dt: number, flow: number, halt: boolean): void {
    if (dt <= 0) return;
    this.time += dt;
    const t = this.time;
    this.measureCrossings();
    for (const lane of this.lanes) this.stepLane(lane, dt, t, flow, halt);
    if (this.pending.length) this.servePending(dt, t);
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i]!;
      if (c.expires !== null && t > c.expires) c.leaving = true;
      const goal = c.leaving ? 0 : 1;
      c.fade += Math.max(-dt * 2.5, Math.min(dt * 2.5, goal - c.fade));
      if (c.leaving && c.fade <= 0) {
        this.cars.splice(i, 1);
        const at = c.lane.cars.indexOf(c);
        if (at >= 0) c.lane.cars.splice(at, 1);
        if (c.tag) this.eventCount--;
      }
    }
  }

  private servePending(dt: number, t: number): void {
    this.pendingTimer += dt;
    if (this.pendingTimer < 0.25) return;
    this.pendingTimer = 0;
    this.pending = this.pending.filter((p) => t <= p.until);
    const next = this.pending[0];
    if (next && this.spawnEvent(next.kind, next.tag)) this.pending.shift();
  }

  /** Count, per signal, the vehicles of the other axis sitting in its crossing. */
  private measureCrossings(): void {
    for (const g of this.gates) g.crossing = 0;
    for (const lane of this.lanes) {
      if (lane.ring) continue;
      for (const c of lane.cars) {
        for (const st of lane.stops) {
          if (Math.abs(c.s - (st.s + STOP_BACK)) < BOX_HALF + c.len / 2) st.gate.mate.crossing++;
        }
      }
    }
  }

  private stepLane(lane: Lane, dt: number, t: number, flow: number, halt: boolean): void {
    const cars = lane.cars;
    const n = cars.length;
    for (let i = 0; i < n; i++) {
      const c = cars[i]!;
      let gap = Infinity;
      let leadV = 0;
      if (n > 1) {
        const l = cars[(i + 1) % n]!;
        let d = l.s - c.s;
        if (d <= 0) d += lane.length;
        gap = d - (l.len + c.len) / 2;
        leadV = l.v;
      }
      const front = c.s + c.len / 2;
      for (const st of lane.stops) {
        const sg = st.s - front;
        if (sg < 0 || sg > 18) continue;
        // A green light still waits for a car that is in the way inside the crossing.
        const light = st.gate.crossing > 0 ? 2 : lightAt(st.gate, t);
        if (light === 0) continue;
        // Too close to stop in comfort on yellow, or at all on red: carry on through.
        if (light === 1 && sg < (c.v * c.v) / (2 * BRAKE) * 0.85 + 0.2) continue;
        if (light === 2 && sg < (c.v * c.v) / (2 * 4.5)) continue;
        if (sg < gap) {
          gap = Math.max(0.05, sg);
          leadV = 0;
        }
      }
      const v0 = Math.max(0.05, lane.limit * c.pace * flow);
      const sStar = MIN_GAP + Math.max(0, c.v * HEADWAY + (c.v * (c.v - leadV)) / (2 * Math.sqrt(ACCEL * BRAKE)));
      let acc = ACCEL * (1 - Math.pow(c.v / v0, 4) - (gap === Infinity ? 0 : (sStar / Math.max(gap, 0.05)) ** 2));
      if (halt) acc = Math.min(acc, -4.5);
      else if (flow < 0.02) acc = Math.min(acc, -BRAKE);
      acc = Math.max(acc, -6);
      c.acc = acc;
      c.v = Math.max(0, c.v + acc * dt);
      let ds = c.v * dt;
      if (gap !== Infinity && ds > gap - 0.05) {
        ds = Math.max(0, gap - 0.05);
        c.v = Math.min(c.v, ds / dt);
      }
      c.s += ds;
      if (c.lap !== null) {
        c.lap -= ds;
        if (c.lap <= 0) c.leaving = true;
      }
    }
    // Whoever passed the lane's end re-enters at its start, ahead of the first.
    while (cars.length > 1 && cars[cars.length - 1]!.s >= lane.length) {
      const c = cars.pop()!;
      c.s -= lane.length;
      cars.unshift(c);
    }
    for (const c of cars) this.place(c);
  }

  /** World position and heading of a vehicle from where it is on its lane. */
  place(c: Vehicle): void {
    const l = c.lane;
    if (!l.ring) {
      c.x = l.ax + l.dx * c.s;
      c.z = l.az + l.dz * c.s;
      c.yaw = Math.atan2(-l.dz, l.dx);
      return;
    }
    const phi = Math.PI / 2 + (l.dir * c.s) / l.r;
    const sin = Math.sin(phi);
    const cos = Math.cos(phi);
    c.x = l.cx + l.r * cos;
    c.z = l.cz + l.r * sin;
    const tx = l.dir > 0 ? -sin : sin;
    const tz = l.dir > 0 ? cos : -cos;
    c.yaw = Math.atan2(-tz, tx);
  }
}
