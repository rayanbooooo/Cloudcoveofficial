import type { ServerMessage } from '@scalp-city/shared';
import { useStore } from '../store/store';

/**
 * Real-time connection to the server. The server is authoritative: on any
 * sequence gap the client discards its view and asks for a fresh snapshot
 * instead of patching over missing events.
 */
export class Realtime {
  private ws: WebSocket | null = null;
  private attempts = 0;
  private timer: number | null = null;
  private stopped = false;
  private awaitingSnapshot = true;

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const store = useStore.getState();
    store.setConn({ state: this.attempts === 0 ? 'connecting' : 'reconnecting' });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    this.awaitingSnapshot = true;
    ws.onopen = () => {
      this.attempts = 0;
      useStore.getState().setConn({ state: 'open' });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (this.awaitingSnapshot && msg.type !== 'snapshot') return;
      if (msg.type === 'snapshot') this.awaitingSnapshot = false;
      const r = useStore.getState().apply(msg);
      if (r === 'gap') {
        // Lost state: never patch over a gap — resync from a snapshot.
        this.awaitingSnapshot = true;
        ws.send(JSON.stringify({ type: 'resync' }));
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (this.stopped) {
        useStore.getState().setConn({ state: 'closed' });
        return;
      }
      this.attempts++;
      useStore.getState().setConn({ state: 'reconnecting' });
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts, 5)) * (0.8 + Math.random() * 0.4);
      this.timer = window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }
}

export const realtime = new Realtime();
