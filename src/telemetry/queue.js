/**
 * Single-consumer, bounded, non-blocking queue for fail-open telemetry writes.
 * Enqueue never waits for storage. Failed batches are counted and discarded so
 * telemetry cannot backpressure MCP requests indefinitely.
 */
export class BoundedAsyncQueue {
  constructor({
    processBatch,
    maxItems = 10_000,
    batchSize = 100,
    flushIntervalMs = 250,
    onDrop = () => {},
    onFailure = () => {},
  } = {}) {
    if (typeof processBatch !== "function") throw new TypeError("processBatch is required.");
    this.processBatch = processBatch;
    this.maxItems = positiveInteger(maxItems, "maxItems");
    this.batchSize = positiveInteger(batchSize, "batchSize");
    this.flushIntervalMs = positiveInteger(flushIntervalMs, "flushIntervalMs");
    this.onDrop = typeof onDrop === "function" ? onDrop : () => {};
    this.onFailure = typeof onFailure === "function" ? onFailure : () => {};

    this.items = [];
    this.timer = null;
    this.processing = false;
    this.closed = false;
    this.waiters = new Set();
    this.counters = {
      accepted: 0,
      processed: 0,
      batches: 0,
      droppedFull: 0,
      droppedClosed: 0,
      droppedProcessing: 0,
      processingFailures: 0,
    };
  }

  /** Enqueue immediately; returns false rather than blocking or throwing. */
  enqueue(item) {
    if (this.closed) {
      this.counters.droppedClosed += 1;
      safeNotify(this.onDrop, "closed", 1);
      return false;
    }
    if (this.items.length >= this.maxItems) {
      this.counters.droppedFull += 1;
      safeNotify(this.onDrop, "full", 1);
      return false;
    }

    this.items.push(item);
    this.counters.accepted += 1;
    if (this.items.length >= this.batchSize) this.#schedule(0);
    else this.#schedule(this.flushIntervalMs);
    return true;
  }

  /** Resolve when all currently queued work finishes, or false on timeout. */
  async flush({ timeoutMs = 10_000 } = {}) {
    if (!this.processing && this.items.length === 0) return true;
    const completion = new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(false);
      }, positiveInteger(timeoutMs, "timeoutMs"));
      this.waiters.add(waiter);
    });
    // A flush/close caller is explicitly awaiting durability. Start draining
    // directly and keep the timeout referenced; do not depend on the normal
    // unref'd batching timer, which may not keep Node alive during shutdown.
    if (!this.processing) void this.#drain();
    return completion;
  }

  /** Stop accepting work and optionally drain the queue. */
  async close({ drain = true, timeoutMs = 10_000 } = {}) {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!drain) {
      const dropped = this.items.length;
      this.items.length = 0;
      this.counters.droppedClosed += dropped;
      if (dropped > 0) safeNotify(this.onDrop, "closed", dropped);
      this.#resolveWaiters();
      return true;
    }
    return this.flush({ timeoutMs });
  }

  /** Safe operational counters; queued items themselves are never exposed. */
  getStats() {
    return Object.freeze({
      ...this.counters,
      pending: this.items.length,
      processing: this.processing,
      closed: this.closed,
      capacity: this.maxItems,
    });
  }

  #schedule(delay) {
    if (this.timer || this.processing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#drain();
    }, delay);
    this.timer.unref?.();
  }

  async #drain() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.items.length > 0) {
        const batch = this.items.splice(0, this.batchSize);
        try {
          await this.processBatch(batch);
          this.counters.processed += batch.length;
          this.counters.batches += 1;
        } catch {
          this.counters.processingFailures += 1;
          this.counters.droppedProcessing += batch.length;
          safeNotify(this.onFailure, "processing_failed", batch.length);
        }

        // Yield so a large backlog cannot monopolize the event loop.
        if (this.items.length > 0) await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      this.processing = false;
      if (this.items.length > 0) this.#schedule(0);
      else this.#resolveWaiters();
    }
  }

  #resolveWaiters() {
    if (this.processing || this.items.length > 0) return;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(true);
    }
    this.waiters.clear();
  }
}

function safeNotify(callback, reason, count) {
  try {
    callback(Object.freeze({ reason, count }));
  } catch {
    // Observability callbacks must not affect queue behavior.
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
  return value;
}
