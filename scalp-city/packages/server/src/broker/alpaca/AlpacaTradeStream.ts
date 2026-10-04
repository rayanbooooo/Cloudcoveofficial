import type { Credentials } from '../../config/env.js';
import type { Logger } from '../../core/logger.js';
import { ReconnectingStream } from '../../core/ReconnectingStream.js';
import type { BrokerTradeUpdate } from '../types.js';
import { mapTradeUpdate } from './mappers.js';

/**
 * Alpaca `trade_updates` stream: the authoritative source of order state
 * changes and fills (spec §12). Frames may arrive as text or binary; both
 * carry JSON.
 */
export class AlpacaTradeStream extends ReconnectingStream {
  private handlers = new Set<(u: BrokerTradeUpdate) => void>();

  constructor(
    url: string,
    private readonly credentials: Credentials,
    logger: Logger,
  ) {
    super({ name: 'alpaca-trade-updates', url, logger, minBackoffMs: 1000, maxBackoffMs: 30_000 });
  }

  onUpdate(handler: (u: BrokerTradeUpdate) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  protected onOpen(): void {
    this.send(
      JSON.stringify({
        action: 'authenticate',
        data: { key_id: this.credentials.keyId, secret_key: this.credentials.secretKey },
      }),
    );
  }

  protected onData(data: Buffer): void {
    let msg: { stream?: string; data?: Record<string, unknown> };
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      this.log.warn('trade stream: non-JSON frame ignored');
      return;
    }
    switch (msg.stream) {
      case 'authorization': {
        const status = msg.data?.status;
        if (status === 'authorized') {
          this.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } }));
        } else {
          this.status.lastError = 'trade stream authentication failed';
          this.nextBackoffFloorMs = 30_000;
          this.ws?.close(4001, 'unauthorized');
        }
        return;
      }
      case 'listening': {
        const streams = (msg.data?.streams as string[] | undefined) ?? [];
        if (streams.includes('trade_updates')) this.markReady();
        return;
      }
      case 'trade_updates': {
        if (!msg.data) return;
        const update = mapTradeUpdate(msg.data);
        for (const h of this.handlers) {
          try {
            h(update);
          } catch (err) {
            this.log.error({ err }, 'trade update handler failed');
          }
        }
        return;
      }
      default:
        return;
    }
  }
}
