import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  createIdentityHasher,
  createTelemetryStore,
} from "../src/telemetry/index.js";

const IDENTITY_SECRET = Buffer.alloc(32, 0x53);
const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "b6c2b1e5-82ef-4b87-8b8d-bbdc6c0a769a";

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-store-test-"));
  const databasePath = path.join(root, "telemetry.sqlite");
  const backupDirectory = path.join(root, "backups");
  const journal = [];
  const nowValue = options.now ?? new Date("2026-09-24T12:00:00.000Z");
  const store = createTelemetryStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath,
    backupDirectory,
    queueMaxItems: options.queueMaxItems ?? 100,
    batchSize: options.batchSize ?? 100,
    flushIntervalMs: 60_000,
    detailRetentionDays: options.detailRetentionDays ?? 90,
    aggregateRetentionDays: options.aggregateRetentionDays ?? 365,
    backupCount: options.backupCount ?? 7,
    stderrEnabled: true,
    stderr: { write: (line) => journal.push(String(line)) },
    now: () => new Date(nowValue),
    Database: options.Database,
  });
  t.after(async () => {
    await store.close({ drain: false });
    await rm(root, { recursive: true, force: true });
  });
  return { root, databasePath, backupDirectory, journal, nowValue, store };
}

function toolEvent({
  occurredAt,
  requestId,
  tenantId,
  installationId,
  toolName,
  outcome = "success",
  errorCode = null,
  upstreamStatus = 200,
  durationMs = 10,
  upstreamDurationMs = 8,
  limiterWaitMs = 0,
  clientFamily = "cursor",
} = {}) {
  return {
    type: "tool_call_completed",
    occurredAt,
    requestId,
    transport: "streamable_http",
    tenantId,
    ...(installationId ? { installationId } : {}),
    clientFamily,
    clientVersion: "1.2.3",
    mcpMethod: "tools/call",
    toolName,
    toolGroup: "school",
    toolRisk: "read",
    outcome,
    errorCode,
    upstreamStatus,
    durationMs,
    upstreamDurationMs,
    limiterWaitMs,
  };
}

test("SQLite store records only strict events and calculates product metrics", async (t) => {
  const { databasePath, journal, store } = await fixture(t);
  assert.equal(store.getStatus().state, "ready");

  const ids = createIdentityHasher({ secret: IDENTITY_SECRET, epoch: 1 });
  const tenantA = ids.tenant("alpha-school.example");
  const tenantB = ids.tenant("beta-school.example");
  const installationA = ids.installation(UUID_A, tenantA);
  const installationB = ids.installation(UUID_B, tenantB);

  assert.equal(store.record({
    type: "mcp_initialize_completed",
    occurredAt: "2026-09-24T06:00:00.000Z",
    requestId: "request_init_001",
    transport: "streamable_http",
    tenantId: tenantA,
    installationId: installationA,
    clientFamily: "cursor",
    clientVersion: "1.2.3",
    mcpMethod: "initialize",
    outcome: "success",
    durationMs: 2,
  }), true);

  const events = [
    toolEvent({
      occurredAt: "2026-09-24T06:01:00.000Z",
      requestId: "request_tool_001",
      tenantId: tenantA,
      installationId: installationA,
      toolName: "GetGroups",
      durationMs: 10,
    }),
    toolEvent({
      occurredAt: "2026-09-24T06:20:00.000Z",
      requestId: "request_tool_002",
      tenantId: tenantA,
      installationId: installationA,
      toolName: "GetStudents",
      durationMs: 20,
    }),
    toolEvent({
      occurredAt: "2026-09-24T06:51:00.000Z",
      requestId: "request_tool_003",
      tenantId: tenantA,
      installationId: installationA,
      toolName: "GetLessons",
      durationMs: 30,
    }),
    toolEvent({
      occurredAt: "2026-09-24T07:00:00.000Z",
      requestId: "request_tool_004",
      tenantId: tenantB,
      installationId: installationB,
      toolName: "GetTeachers",
      outcome: "error",
      errorCode: "upstream_429",
      upstreamStatus: 429,
      durationMs: 40,
    }),
    toolEvent({
      occurredAt: "2026-09-24T08:00:00.000Z",
      requestId: "request_tool_005",
      tenantId: tenantB,
      toolName: "GetHomework",
      durationMs: 50,
      clientFamily: "unknown",
    }),
  ];
  for (const event of events) assert.equal(store.record(event), true);

  const rawCanaries = {
    apiKey: "API-KEY-CANARY-095a",
    domain: "raw-private-school-canary.example",
    arguments: { login: "PII-LOGIN-CANARY", password: "PASSWORD-CANARY" },
    responseBody: "UPSTREAM-BODY-CANARY",
    stack: "STACK-CANARY",
  };
  assert.equal(store.record({ ...events[0], requestId: "request_bad_001", ...rawCanaries }), false);
  assert.equal(await store.queue.flush({ timeoutMs: 2_000 }), true);

  const dashboard = store.getDashboard({
    period: "24h",
    to: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(dashboard.range.timezone, "Europe/Moscow");
  assert.equal(dashboard.totals.initializations, 1);
  assert.equal(dashboard.totals.toolCalls, 5);
  assert.equal(dashboard.totals.successfulToolCalls, 4);
  assert.equal(dashboard.totals.failedToolCalls, 1);
  assert.equal(dashboard.totals.activeTenants, 2);
  assert.equal(dashboard.totals.activeInstallations, 1);
  assert.equal(dashboard.totals.identifiedToolCalls, 4);
  assert.equal(dashboard.totals.identifiedShare, 0.8);
  assert.equal(dashboard.totals.successRate, 0.8);
  assert.equal(dashboard.totals.averageDurationMs, 30);
  assert.equal(dashboard.totals.p95DurationMs, 50);
  assert.deepEqual(dashboard.errors, [{ errorCode: "upstream_429", count: 1 }]);
  assert.deepEqual(
    dashboard.moscowHours.map(({ hour, calls }) => [hour, calls]),
    [[9, 3], [10, 1], [11, 1]],
  );
  assert.equal(dashboard.activityWindows["24h"].activeTenants, 2);

  const scenarios = store.getScenarios({
    period: "24h",
    to: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(scenarios.sessionIdleMinutes, 30);
  assert.deepEqual(scenarios.items, [{ tools: ["GetGroups", "GetStudents"], count: 1 }]);

  const firstPage = store.getEvents({
    period: "24h",
    to: "2026-09-24T12:00:00.000Z",
    page: 1,
    pageSize: 2,
  });
  assert.equal(firstPage.total, 6);
  assert.equal(firstPage.pages, 3);
  assert.equal(firstPage.items.length, 2);
  assert.equal(firstPage.items[0].requestId, "request_tool_005");
  assert.equal("arguments" in firstPage.items[0], false);
  assert.equal("responseBody" in firstPage.items[0], false);

  const tenantPage = store.getEvents({
    period: "24h",
    to: "2026-09-24T12:00:00.000Z",
    tenantId: tenantA,
    pageSize: 100,
  });
  assert.equal(tenantPage.total, 4);
  assert.throws(() => store.getEvents({
    period: "24h",
    to: "2026-09-24T12:00:00.000Z",
    toolGroup: "school' OR 1=1 --",
  }));

  const aggregateIdentities = store.database.prepare(
    "SELECT DISTINCT tenant_id AS tenantId, installation_id AS installationId FROM telemetry_daily",
  ).all();
  assert.deepEqual(aggregateIdentities, [{ tenantId: "", installationId: "" }]);

  const allJournal = journal.join("");
  const journalLines = allJournal.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(journalLines.length, 6);
  assert.equal(journalLines.every((event) => !Object.keys(event).some((key) => Object.hasOwn(rawCanaries, key))), true);
  for (const value of [
    rawCanaries.apiKey,
    rawCanaries.domain,
    rawCanaries.arguments.login,
    rawCanaries.arguments.password,
    rawCanaries.responseBody,
    rawCanaries.stack,
    UUID_A,
    UUID_B,
  ]) {
    assert.equal(allJournal.includes(value), false, value);
  }

  const files = await readdir(path.dirname(databasePath));
  const databaseBytes = await Promise.all(
    files.filter((name) => name.startsWith("telemetry.sqlite")).map((name) => readFile(path.join(path.dirname(databasePath), name))),
  );
  const databaseText = Buffer.concat(databaseBytes).toString("utf8");
  for (const value of Object.values(rawCanaries).flatMap((item) => typeof item === "object" ? Object.values(item) : [item])) {
    assert.equal(databaseText.includes(String(value)), false, String(value));
  }

  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(databasePath))).mode & 0o077, 0);
});

test("maintenance applies 90/365 day retention, private backups, and identity-free aggregates", async (t) => {
  const { backupDirectory, store } = await fixture(t, { backupCount: 7 });
  const ids = createIdentityHasher({ secret: IDENTITY_SECRET, epoch: 1 });
  const tenantId = ids.tenant("retention.example");
  const installationId = ids.installation(UUID_A, tenantId);
  const dayMs = 86_400_000;
  const reference = new Date("2026-09-24T12:00:00.000Z").getTime();
  const timestamp = (daysAgo) => new Date(reference - daysAgo * dayMs).toISOString();

  for (const [daysAgo, suffix] of [[1, "recent"], [100, "old_detail"], [400, "expired"]]) {
    assert.equal(store.record(toolEvent({
      occurredAt: timestamp(daysAgo),
      requestId: `request_${suffix}_001`,
      tenantId,
      installationId,
      toolName: "GetGroups",
    })), true);
  }
  assert.equal(await store.queue.flush({ timeoutMs: 2_000 }), true);

  await import("node:fs/promises").then(({ mkdir }) => mkdir(backupDirectory, { recursive: true, mode: 0o700 }));
  const retainedBackup = path.join(backupDirectory, "telemetry-2026-09-20.sqlite");
  await store.database.backup(retainedBackup);
  for (let day = 1; day <= 8; day += 1) {
    await writeFile(
      path.join(backupDirectory, `telemetry-2026-08-${String(day).padStart(2, "0")}.sqlite`),
      "synthetic-old-backup",
      { mode: 0o600 },
    );
  }

  assert.equal(await store.runMaintenance(), true);
  const detailRows = store.database.prepare(
    "SELECT request_id AS requestId FROM telemetry_events ORDER BY request_id",
  ).all();
  assert.deepEqual(detailRows, [{ requestId: "request_recent_001" }]);

  const dailyRows = store.database.prepare(
    "SELECT day_utc AS dayUtc, tenant_id AS tenantId, installation_id AS installationId FROM telemetry_daily ORDER BY day_utc",
  ).all();
  assert.equal(dailyRows.some((row) => row.dayUtc === timestamp(100).slice(0, 10)), true);
  assert.equal(dailyRows.some((row) => row.dayUtc === timestamp(400).slice(0, 10)), false);
  assert.equal(dailyRows.every((row) => row.tenantId === "" && row.installationId === ""), true);

  const backups = (await readdir(backupDirectory)).filter((name) => /^telemetry-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name));
  assert.equal(backups.length, 7);
  const currentBackup = path.join(backupDirectory, "telemetry-2026-09-24.sqlite");
  assert.equal(backups.includes(path.basename(currentBackup)), true);
  assert.equal((await stat(currentBackup)).mode & 0o777, 0o600);
  assert.equal((await stat(backupDirectory)).mode & 0o077, 0);

  const retainedDatabase = new Database(retainedBackup, { readonly: true, fileMustExist: true });
  const retainedRequests = retainedDatabase.prepare(
    "SELECT request_id AS requestId FROM telemetry_events ORDER BY request_id",
  ).all();
  retainedDatabase.close();
  assert.deepEqual(retainedRequests, [{ requestId: "request_recent_001" }]);
  assert.equal((await readFile(retainedBackup)).includes(Buffer.from("request_old_detail_001")), false);
});

test("dropped-event counters survive a clean service restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-counter-restart-test-"));
  const databasePath = path.join(root, "telemetry.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = createTelemetryStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath,
    stderrEnabled: false,
  });
  assert.equal(first.record({ type: "tool_call_completed", apiKey: "FORBIDDEN-CANARY" }), false);
  assert.equal(first.getStatus().counters.invalidEvents, 1);
  await first.close({ drain: true });

  const second = createTelemetryStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath,
    stderrEnabled: false,
  });
  t.after(() => second.close({ drain: false }));
  assert.equal(second.getStatus().counters.invalidEvents, 1);
  assert.equal(second.getStatus().droppedEvents, 1);
});

test("active days and daily activity use Europe/Moscow calendar boundaries", async (t) => {
  const { store } = await fixture(t);
  const ids = createIdentityHasher({ secret: IDENTITY_SECRET, epoch: 1 });
  const tenantId = ids.tenant("moscow-boundary.example");
  const installationId = ids.installation(UUID_A, tenantId);
  for (const [occurredAt, requestId] of [
    ["2026-09-23T20:30:00.000Z", "request_moscow_001"],
    ["2026-09-23T21:30:00.000Z", "request_moscow_002"],
  ]) {
    assert.equal(store.record(toolEvent({
      occurredAt,
      requestId,
      tenantId,
      installationId,
      toolName: "GetGroups",
    })), true);
  }
  await store.queue.flush({ timeoutMs: 2_000 });

  const dashboard = store.getDashboard({ period: "7d", to: "2026-09-24T12:00:00.000Z" });
  assert.equal(dashboard.activityWindows["7d"].activeDays, 2);
  assert.deepEqual(
    dashboard.activity.map((item) => item.bucket),
    ["2026-09-23T00:00:00+03:00", "2026-09-24T00:00:00+03:00"],
  );
});

test("unavailable SQLite is fail-open and never prints the underlying exception", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-fail-open-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const canary = "DATABASE-EXCEPTION-CANARY-21f6";
  const journal = [];
  class BrokenDatabase {
    constructor() {
      throw new Error(canary);
    }
  }

  const store = createTelemetryStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath: path.join(root, "telemetry.sqlite"),
    stderrEnabled: true,
    stderr: { write: (line) => journal.push(String(line)) },
    now: () => new Date("2026-09-24T12:00:00.000Z"),
    Database: BrokenDatabase,
  });
  t.after(() => store.close({ drain: false }));

  assert.equal(store.getStatus().state, "degraded");
  assert.equal(store.getStatus().storageAvailable, false);
  assert.equal(store.getStatus().lastErrorCode, "telemetry_database_unavailable");
  assert.doesNotThrow(() => store.record("service_started", {}));
  assert.equal(store.record("service_started", {}), false);
  assert.throws(() => store.getDashboard(), (error) => error.code === "telemetry_database_unavailable");

  const text = journal.join("");
  assert.equal(text.includes(canary), false);
  const events = text.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(events.some((event) => event.type === "telemetry_storage_degraded" && event.errorCode === "telemetry_database_unavailable"), true);
  assert.equal(events.every((event) => ["telemetry_storage_degraded", "service_started"].includes(event.type)), true);
});
