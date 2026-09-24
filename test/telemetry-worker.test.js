import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIdentityHasher, createTelemetryWorkerStore } from "../src/telemetry/index.js";

test("production worker keeps slow SQLite work off the HTTP event loop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-worker-store-test-"));
  const store = createTelemetryWorkerStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath: path.join(root, "telemetry.sqlite"),
    backupDirectory: path.join(root, "backups"),
    batchSize: 1,
    flushIntervalMs: 10,
    stderrEnabled: false,
    testWriteDelayMs: 250,
  });
  t.after(async () => {
    await store.close({ drain: false });
    await rm(root, { recursive: true, force: true });
  });

  const identities = createIdentityHasher({ secret: Buffer.alloc(32, 0x41), epoch: 1 });
  const tenantId = identities.tenant("worker-test.example");
  assert.equal(store.record({
    type: "tool_call_completed",
    occurredAt: new Date().toISOString(),
    requestId: "request_worker_001",
    transport: "streamable_http",
    tenantId,
    mcpMethod: "tools/call",
    toolName: "GetGroups",
    toolGroup: "school",
    toolRisk: "read",
    outcome: "success",
    errorCode: null,
    upstreamStatus: 200,
    durationMs: 5,
    upstreamDurationMs: 4,
    limiterWaitMs: 0,
  }), true);

  let flushed = false;
  const flush = store.queue.flush({ timeoutMs: 2_000 }).then((value) => {
    flushed = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(flushed, false);
  assert.equal(await flush, true);

  const dashboard = await store.getDashboard({ period: "24h" });
  assert.equal(dashboard.totals.toolCalls, 1);
});
