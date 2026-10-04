import WebSocket from 'ws';
import type { ConnectionState } from '@scalp-city/shared';
import type { StreamStatus } from '../broker/types.js';
import type { Logger } from './logger.js';

export interface ReconnectingStreamOptions {
  name: string;
  url: string;
  logger: Logger;
  headers?: Record<string, string>;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a connection may take to finish its handshake before it's dropped. */
  handshakeTimeoutMs?: number;
}

/**
 * A WebSocket client that stays connected (spec §11):
 *  - heartbeat via ping/pong; a missing pong terminates the socket
 *  - exponential backoff with jitter between reconnect attempts
 *  - subclasses re-authenticate and re-subscribe on every (re)connect
 *  - status transitions are published for the UI and the risk engine
 *
 * Subclasses implement the protocol handshake in `onOpen`/`onData` and call
 * `markReady()` once authenticated and subscribed.
 */
export abstract class ReconnectingStream {
  protected ws: WebSocket | null = null;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<(s: StreamStatus) => void>();
  /** Set by subclasses to stretch the next backoff (e.g. connection-limit errors). */
  protected nextBackoffFloorMs = 0;
  /** Set by subclasses for errors that retrying cannot fix (e.g. no subscription). */
  protected fatalError: string | null = null;

  protected status: StreamStatus = {
    state: 'DISCONNECTED',
    since: Date.now(),
    lastMessageAt: null,
    reconnectAttempts: 0,
    lastError: null,
  };

  constructor(protected readonly opts: ReconnectingStreamOptions) {}

  protected get log(): Logger {
    return this.opts.logger;
  }

  getStatus(): StreamStatus {
    return { ...this.status };
  }

  onStatus(cb: (s: StreamStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected setState(state: ConnectionState, error: string | null = this.status.lastError): void {
    if (state === this.status.state && error === this.status.lastError) return;
    this.status = { ...this.status, state, since: Date.now(), lastError: error, reconnectAttempts: this.attempts };
    this.log.info({ stream: this.opts.name, state, error: error ?? undefined }, 'stream state');
    for (const l of this.listeners) {
      try {
        l(this.getStatus());
      } catch (err) {
        this.log.error({ err, stream: this.opts.name }, 'stream status listener failed');
      }
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.fatalError = null;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      await new Promise<void>((resolve) => {
        if (ws.readyState === WebSocket.CLOSED) return resolve();
        ws.once('close', () => resolve());
        try {
          ws.close(1000, 'shutdown');
        } catch {
          resolve();
        }
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2000).unref();
      });
    }
    this.setState('DISCONNECTED', null);
  }

  /** Drop the current socket and reconnect (e.g. a connected-but-mute feed). */
  forceReconnect(reason: string): void {
    if (this.stopped) return;
    this.log.warn({ stream: this.opts.name, reason }, 'forcing reconnect');
    this.ws?.terminate();
  }

  protected send(data: string | Buffer | Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  /** Called once the protocol handshake (auth + subscribe) has succeeded. */
  protected markReady(): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.attempts = 0;
    this.setState('CONNECTED', null);
  }

  protected noteMessage(): void {
    this.status.lastMessageAt = Date.now();
  }

  /** Protocol hooks. */
  protected abstract onOpen(): void;
  protected abstract onData(data: Buffer, isBinary: boolean): void;

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.attempts === 0 ? 'CONNECTING' : 'RECONNECTING');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, { headers: this.opts.headers, perMessageDeflate: false, handshakeTimeout: 10_000 });
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }
    this.ws = ws;
    this.handshakeTimer = setTimeout(() => {
      this.log.warn({ stream: this.opts.name }, 'handshake timed out');
      ws.terminate();
    }, this.opts.handshakeTimeoutMs ?? 15_000);

    ws.on('open', () => {
      this.startHeartbeat(ws);
      try {
        this.onOpen();
      } catch (err) {
        this.log.error({ err, stream: this.opts.name }, 'onOpen failed');
        ws.terminate();
      }
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.noteMessage();
      try {
        this.onData(data, isBinary);
      } catch (err) {
        this.log.error({ err, stream: this.opts.name }, 'stream message handling failed');
      }
    });
    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });
    ws.on('error', (err) => {
      this.status.lastError = err.message;
      this.log.warn({ stream: this.opts.name, err: err.message }, 'stream socket error');
    });
    ws.on('close', (code, reasonBuf) => {
      if (this.ws === ws) this.ws = null;
      this.clearTimers();
      const reason = reasonBuf.toString() || `closed (${code})`;
      if (this.stopped) return;
      if (this.fatalError) {
        this.setState('ERROR', this.fatalError);
        this.stopped = true;
        return;
      }
      this.scheduleReconnect(this.status.lastError ?? reason);
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    const every = this.opts.pingIntervalMs ?? 10_000;
    const timeout = this.opts.pongTimeoutMs ?? 15_000;
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        /* close handler deals with it */
      }
      if (!this.pongTimer) {
        this.pongTimer = setTimeout(() => {
          this.log.warn({ stream: this.opts.name }, 'heartbeat lost (no pong); reconnecting');
          this.status.lastError = 'heartbeat lost';
          ws.terminate();
        }, timeout);
      }
    }, every);
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.pingTimer = null;
    this.pongTimer = null;
    this.handshakeTimer = null;
  }

  private scheduleReconnect(error: string | null): void {
    if (this.stopped) return;
    this.attempts++;
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const base = Math.min(max, min * 2 ** (this.attempts - 1));
    const jitter = base * (0.8 + Math.random() * 0.4);
    const delay = Math.max(jitter, this.nextBackoffFloorMs);
    this.nextBackoffFloorMs = 0;
    this.status.reconnectAttempts = this.attempts;
    this.setState('RECONNECTING', error);
    this.log.info({ stream: this.opts.name, attempt: this.attempts, delayMs: Math.round(delay) }, 'reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
