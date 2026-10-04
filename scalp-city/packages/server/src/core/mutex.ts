/**
 * Minimal async mutex. Used to serialize the risk-check → write-ahead
 * section of order submission so concurrent workers can never jointly
 * exceed a limit that each one checked in isolation.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
