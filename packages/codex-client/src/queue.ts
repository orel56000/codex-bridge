/**
 * A single-consumer async queue used to turn push-style notifications into an
 * `AsyncIterable`. Backpressure is intentionally absent: Codex events are small
 * and dropping one would corrupt the stream.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;
  private failure: unknown = null;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined as never, done: true });
  }

  fail(err: unknown): void {
    if (this.ended) return;
    this.failure = err;
    this.end();
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Terminate any iterator that is currently waiting, without ending the queue.
   *
   * A consumer that stops mid-stream (the gateway closes an Anthropic message
   * because Codex parked on a tool call) would otherwise leave an orphaned
   * waiter behind, and the next pushed event would be delivered to nobody.
   * Releasing waiters lets the abandoned iterator finish cleanly while later
   * events queue up for whoever attaches next.
   */
  releaseWaiters(): void {
    while (this.waiters.length) this.waiters.shift()?.({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (next.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}

/** A promise whose resolve/reject are exposed, for parking a Codex tool call. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => {
      if (d.settled) return;
      d.settled = true;
      resolve(v);
    },
    reject: (e) => {
      if (d.settled) return;
      d.settled = true;
      reject(e);
    },
  };
  // Nothing else awaits this promise until the gateway does; avoid an
  // unhandled-rejection warning in the window before that happens.
  promise.catch(() => undefined);
  return d;
}
