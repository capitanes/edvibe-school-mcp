import assert from "node:assert/strict";
import test from "node:test";

import { BoundedAsyncQueue } from "../src/telemetry/index.js";

test("telemetry enqueue p95 stays below 2 ms and never waits for storage", async () => {
  const queue = new BoundedAsyncQueue({
    maxItems: 2_000,
    batchSize: 2_000,
    flushIntervalMs: 60_000,
    processBatch: async () => {},
  });
  const durations = [];
  for (let index = 0; index < 1_000; index += 1) {
    const started = process.hrtime.bigint();
    assert.equal(queue.enqueue({ index }), true);
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 <= 2, `enqueue p95 ${p95.toFixed(3)} ms exceeds 2 ms`);
  assert.equal(queue.getStats().pending, 1_000);
  assert.equal(await queue.close({ drain: false }), true);
});

test("flush immediately drains a long-delay queue without another active handle", async () => {
  const processed = [];
  const queue = new BoundedAsyncQueue({
    maxItems: 10,
    batchSize: 10,
    flushIntervalMs: 60_000,
    processBatch: async (items) => processed.push(...items),
  });
  queue.enqueue("queued-event");
  assert.equal(await queue.flush({ timeoutMs: 1_000 }), true);
  assert.deepEqual(processed, ["queued-event"]);
  assert.equal(queue.getStats().pending, 0);
  await queue.close();
});
