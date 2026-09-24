import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIdentityHasher, createTelemetryStore } from "../src/telemetry/index.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const DAY_MS = 86_400_000;

function event({ daysAgo, requestId, tenantId, installationId }) {
  return {
    type: "tool_call_completed",
    occurredAt: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    requestId,
    transport: "streamable_http",
    tenantId,
    installationId,
    clientFamily: "codex",
    clientVersion: "1.2.3",
    mcpMethod: "tools/call",
    toolName: "GetGroups",
    toolGroup: "school",
    toolRisk: "read",
    outcome: "success",
    errorCode: null,
    upstreamStatus: 200,
    durationMs: daysAgo,
    upstreamDurationMs: daysAgo / 2,
    limiterWaitMs: 0,
  };
}

test("365-day dashboard uses anonymous aggregates after detail retention", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-aggregate-test-"));
  const store = createTelemetryStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath: path.join(root, "telemetry.sqlite"),
    backupDirectory: path.join(root, "backups"),
    batchSize: 100,
    flushIntervalMs: 60_000,
    stderrEnabled: false,
    now: () => new Date(NOW),
  });
  t.after(async () => {
    await store.close({ drain: false });
    await rm(root, { recursive: true, force: true });
  });

  const identities = createIdentityHasher({ secret: Buffer.alloc(32, 0x64), epoch: 4 });
  const tenantId = identities.tenant("aggregate-private.example");
  const installationId = identities.installation("550e8400-e29b-41d4-a716-446655440000", tenantId);
  store.record(event({ daysAgo: 1, requestId: "request_recent_365", tenantId, installationId }));
  store.record(event({ daysAgo: 100, requestId: "request_old_365xx", tenantId, installationId }));
  await store.queue.flush({ timeoutMs: 2_000 });
  await store.runMaintenance();

  const dashboard = store.getDashboard({ period: "365d", to: NOW.toISOString() });
  assert.equal(dashboard.range.aggregation, "anonymous_daily");
  assert.equal(dashboard.range.timezone, "Europe/Moscow");
  assert.equal(dashboard.totals.toolCalls, 2);
  assert.equal(dashboard.totals.successfulToolCalls, 2);
  assert.equal(dashboard.totals.successRate, 1);
  assert.equal(dashboard.totals.activeTenants, null);
  assert.equal(dashboard.totals.activeInstallations, null);
  assert.equal(dashboard.tools[0].toolName, "GetGroups");
  assert.equal(dashboard.tools[0].calls, 2);
  assert.equal(dashboard.scenarios.unavailableReason, "detail_retention_exceeded");
  assert.deepEqual(dashboard.scenarios.items, []);

  const serialized = JSON.stringify(dashboard);
  assert.equal(serialized.includes(tenantId), false);
  assert.equal(serialized.includes(installationId), false);
  assert.equal(serialized.includes("aggregate-private.example"), false);
  assert.equal(serialized.includes("550e8400-e29b-41d4-a716-446655440000"), false);

  assert.throws(
    () => store.getDashboard({ period: "365d", to: NOW.toISOString(), tenantId }),
    /Identity filters are limited to detail retention/,
  );
  const events = store.getEvents({ period: "365d", to: NOW.toISOString() });
  assert.equal(events.total, 1);
  assert.equal(events.items[0].requestId, "request_recent_365");

  const tenantEvents = store.getEvents({
    period: "365d",
    to: NOW.toISOString(),
    tenantId,
  });
  assert.equal(tenantEvents.total, 1);
  assert.equal(tenantEvents.items[0].tenantId, tenantId);
});
