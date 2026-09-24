import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BoundedAsyncQueue,
  TelemetryService,
  canonicalizeSchoolDomain,
  classifySafeError,
  createIdentityHasher,
  createSafeError,
  createTelemetryEvent,
  isTelemetryPseudonym,
  isUuidV4,
  loadTelemetryConfig,
  normalizeClientInfo,
  parseClientInstallationId,
  serializeTelemetryEvent,
  upstreamStatusToErrorCode,
  validateTelemetryEvent,
} from "../src/telemetry/index.js";

const SECRET_A = Buffer.alloc(32, 0x41);
const SECRET_B = Buffer.alloc(32, 0x42);
const UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const UUID_B = "b6c2b1e5-82ef-4b87-8b8d-bbdc6c0a769a";

test("identity: UUID v4 is strict and optional invalid values are discarded", () => {
  assert.equal(isUuidV4(UUID_A), true);
  assert.equal(isUuidV4(UUID_A.toUpperCase()), true);
  assert.equal(isUuidV4("550e8400-e29b-11d4-a716-446655440000"), false);
  assert.equal(isUuidV4("not-a-uuid"), false);
  assert.equal(isUuidV4([UUID_A]), false);

  assert.equal(parseClientInstallationId(UUID_A.toUpperCase()), UUID_A);
  assert.equal(parseClientInstallationId(" " + UUID_A), null);
  assert.equal(parseClientInstallationId(UUID_B.replace("4b87", "5b87")), null);
  assert.equal(parseClientInstallationId(undefined), null);
});

test("identity: canonical domain HMAC is deterministic, epoch-bound and tenant-scoped", () => {
  const epochOne = createIdentityHasher({ secret: SECRET_A, epoch: 1 });
  const epochTwo = createIdentityHasher({ secret: SECRET_A, epoch: 2 });
  const otherSecret = createIdentityHasher({ secret: SECRET_B, epoch: 1 });

  assert.equal(canonicalizeSchoolDomain("  SCHOOl.Example. "), "school.example");
  assert.throws(() => canonicalizeSchoolDomain("https://school.example/private?token=x"));
  assert.throws(() => canonicalizeSchoolDomain("localhost"));

  const tenant = epochOne.tenant("School.Example");
  const sameTenant = epochOne.tenant("school.example.");
  const otherTenant = epochOne.tenant("other.example");
  assert.equal(tenant, sameTenant);
  assert.match(tenant, /^t_[A-Za-z0-9_-]{22}$/);
  assert.equal(isTelemetryPseudonym(tenant, "t"), true);
  assert.notEqual(tenant, epochTwo.tenant("school.example"));
  assert.notEqual(tenant, otherSecret.tenant("school.example"));

  const installation = epochOne.installation(UUID_A, tenant);
  assert.match(installation, /^i_[A-Za-z0-9_-]{22}$/);
  assert.equal(isTelemetryPseudonym(installation, "i"), true);
  assert.equal(installation, epochOne.installation(UUID_A, "school.example"));
  assert.notEqual(installation, epochOne.installation(UUID_A, otherTenant));
  assert.notEqual(installation, epochOne.installation(UUID_B, tenant));
  assert.notEqual(installation, epochTwo.installation(UUID_A, "school.example"));
  assert.equal(epochOne.installation("invalid-client-id", tenant), null);

  const serialized = JSON.stringify({ tenant, installation });
  assert.equal(serialized.includes("school.example"), false);
  assert.equal(serialized.includes(UUID_A), false);
});

test("identity: short secrets and invalid epochs are rejected without echoing input", () => {
  const canary = "short-canary-secret";
  assert.throws(
    () => createIdentityHasher({ secret: canary, epoch: 1 }),
    (error) => !String(error).includes(canary),
  );
  assert.throws(() => createIdentityHasher({ secret: SECRET_A, epoch: 0 }));
  assert.throws(() => createIdentityHasher({ secret: SECRET_A, epoch: "abc" }));
});

test("clientInfo normalization keeps only finite families and safe versions", () => {
  assert.deepEqual(normalizeClientInfo({ name: "Cursor", version: "0.49.6" }), {
    family: "cursor",
    version: "0.49.6",
  });
  assert.deepEqual(normalizeClientInfo({ name: "OpenAI Codex CLI", version: "v1.2.3-beta.1" }), {
    family: "codex",
    version: "v1.2.3",
  });
  assert.deepEqual(normalizeClientInfo({ name: "Cognition Devin", version: "2" }), {
    family: "devin",
    version: "2",
  });
  assert.deepEqual(normalizeClientInfo({ name: "Cursor", version: "1.2.3-password-canary" }), {
    family: "cursor",
    version: "1.2.3",
  });
  assert.deepEqual(normalizeClientInfo({ name: "Private Customer Name", version: "release from Alice" }), {
    family: "other",
    version: null,
  });
  assert.deepEqual(normalizeClientInfo(null), { family: "unknown", version: null });
  assert.deepEqual(normalizeClientInfo([]), { family: "unknown", version: null });
});

test("schema emits only the allowlist and rejects every sensitive/free-form field", () => {
  const ids = createIdentityHasher({ secret: SECRET_A, epoch: 7 });
  const tenantId = ids.tenant("privacy.example");
  const installationId = ids.installation(UUID_A, tenantId);
  const safe = {
    type: "tool_call_completed",
    occurredAt: "2026-09-24T08:00:00.000Z",
    requestId: "request_12345678",
    transport: "streamable_http",
    tenantId,
    installationId,
    clientFamily: "cursor",
    clientVersion: "1.2.3",
    mcpMethod: "tools/call",
    toolName: "GetGroups",
    toolGroup: "groups",
    toolRisk: "read",
    outcome: "success",
    errorCode: null,
    upstreamStatus: 200,
    durationMs: 12.34567,
    upstreamDurationMs: 10,
    limiterWaitMs: 0,
  };

  const event = validateTelemetryEvent(safe);
  assert.equal(event.durationMs, 12.346);
  assert.equal(Object.isFrozen(event), true);
  assert.deepEqual(Object.keys(event), Object.keys(safe));

  const forbidden = [
    "headers", "ip", "userAgent", "url", "query", "arguments", "results",
    "requestBody", "responseBody", "apiKey", "domain", "token", "password",
    "jsonRpcId", "errorMessage", "stack", "arbitrary",
  ];
  for (const key of forbidden) {
    const canary = `PII-CANARY-${key}-8c5d7b`;
    assert.throws(
      () => validateTelemetryEvent({ ...safe, [key]: canary }),
      (error) => error?.code === "telemetry_invalid_event" && !String(error).includes(canary) && !String(error).includes(key),
      key,
    );
  }

  assert.throws(() => validateTelemetryEvent({ ...safe, errorCode: "made_up_code" }));
  assert.throws(() => validateTelemetryEvent({ ...safe, tenantId: "privacy.example" }));
  assert.throws(() => validateTelemetryEvent({ ...safe, installationId: UUID_A }));
  assert.throws(() => validateTelemetryEvent({ ...safe, outcome: "success", errorCode: "internal_error" }));
  assert.throws(() => validateTelemetryEvent({ ...safe, outcome: "error", errorCode: null }));
});

test("schema serialization is one JSON line and never derives arbitrary error content", () => {
  const event = createTelemetryEvent("mcp_request_rejected", {
    requestId: "request_87654321",
    transport: "streamable_http",
    mcpMethod: "tools/call",
    outcome: "rejected",
    errorCode: "invalid_arguments",
    durationMs: 1,
  }, { now: () => new Date("2026-09-24T08:00:00.000Z") });
  const line = serializeTelemetryEvent(event);
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.deepEqual(JSON.parse(line), event);
});

test("safe errors collapse arbitrary causes and map upstream statuses to fixed codes", () => {
  const canary = "UPSTREAM-BODY-CANARY-71d2";
  const safe = createSafeError("upstream_401", { cause: new Error(canary) });
  assert.equal(safe.code, "upstream_401");
  assert.equal(safe.upstreamStatus, 401);
  assert.equal(Object.keys(safe).includes("cause"), false);
  assert.equal(JSON.stringify(safe).includes(canary), false);
  assert.equal(classifySafeError(safe).code, "upstream_401");

  const arbitrary = classifySafeError(new Error(canary));
  assert.equal(arbitrary.code, "internal_error");
  assert.equal(JSON.stringify(arbitrary).includes(canary), false);
  assert.equal(upstreamStatusToErrorCode(401), "upstream_401");
  assert.equal(upstreamStatusToErrorCode(403), "upstream_403");
  assert.equal(upstreamStatusToErrorCode(429), "upstream_429");
  assert.equal(upstreamStatusToErrorCode(418), "upstream_4xx");
  assert.equal(upstreamStatusToErrorCode(503), "upstream_5xx");
});

test("config reads secrets only from the credential reader and keeps them non-enumerable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-config-test-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const dbPath = path.join(root, "telemetry.sqlite");
  const hmacCanary = Buffer.from("HMAC-CREDENTIAL-CANARY-1234567890-abcd", "utf8");
  const passwordCanary = "DASHBOARD-PASSWORD-CANARY-123456";
  const requested = [];
  const config = loadTelemetryConfig({
    TELEMETRY_ENABLED: "true",
    ANALYTICS_DASHBOARD_ENABLED: "true",
    TELEMETRY_DATABASE_PATH: dbPath,
    TELEMETRY_IDENTITY_EPOCH: "9",
  }, {
    credentialsDirectory: root,
    readCredential(name, options) {
      requested.push({ name, encoding: options.encoding });
      return options.encoding === "utf8" ? passwordCanary : hmacCanary;
    },
  });

  assert.deepEqual(requested, [
    { name: "telemetry_hmac_key", encoding: null },
    { name: "analytics_password", encoding: "utf8" },
  ]);
  assert.equal(config.identityEpoch, 9);
  assert.equal(config.hmacSecret, hmacCanary);
  assert.equal(config.dashboardPassword, passwordCanary);
  assert.equal(Object.keys(config).includes("hmacSecret"), false);
  assert.equal(Object.keys(config).includes("dashboardPassword"), false);
  assert.equal(JSON.stringify(config).includes(hmacCanary.toString("utf8")), false);
  assert.equal(JSON.stringify(config).includes(passwordCanary), false);

  await writeFile(path.join(root, "empty"), "", { mode: 0o600 });
  assert.throws(() => loadTelemetryConfig({ TELEMETRY_ENABLED: "yes" }));
  assert.throws(() => loadTelemetryConfig({ TELEMETRY_DATABASE_PATH: "relative.sqlite" }));
  assert.throws(() => loadTelemetryConfig({ TELEMETRY_DETAIL_RETENTION_DAYS: "91" }));
  assert.throws(() => loadTelemetryConfig({ TELEMETRY_AGGREGATE_RETENTION_DAYS: "366" }));
  assert.throws(() => loadTelemetryConfig({ TELEMETRY_BACKUP_COUNT: "8" }));
  assert.throws(() => loadTelemetryConfig({ TELEMETRY_MAINTENANCE_INTERVAL_MS: "86400001" }));
});

test("service context never retains raw identity and client metadata cannot cross tenants", async () => {
  const calls = [];
  const store = {
    record(type, fields) {
      calls.push({ type, fields });
      return true;
    },
    getStatus: () => ({ state: "ready" }),
    close: async () => true,
  };
  const config = { enabled: true, dashboardEnabled: true };
  Object.defineProperty(config, "dashboardPassword", {
    value: "SYNTHETIC-PASSWORD-123456",
    enumerable: false,
  });
  const identities = createIdentityHasher({ secret: SECRET_A, epoch: 3 });
  const service = new TelemetryService({ config, store, identities });
  const school = "private-school.example";
  const context = service.createRequestContext({
    requestId: "request_service_1",
    schoolDomain: school,
    clientIdHeader: UUID_A,
  });
  assert.equal(JSON.stringify(context).includes(school), false);
  assert.equal(JSON.stringify(context).includes(UUID_A), false);
  assert.match(context.tenantId, /^t_/);
  assert.match(context.installationId, /^i_/);

  service.rememberClientInfo({
    tenantId: context.tenantId,
    installationId: context.installationId,
    clientInfo: { name: "Cursor with Alice's school", version: "1.2.3" },
  });
  service.record("tool_call_completed", {
    ...context,
    mcpMethod: "tools/call",
    toolName: "GetGroups",
    toolGroup: "groups",
    toolRisk: "read",
    outcome: "success",
    durationMs: 4,
  });
  assert.equal(calls[0].fields.clientFamily, "cursor");
  assert.equal(calls[0].fields.clientVersion, "1.2.3");
  assert.equal(JSON.stringify(calls).includes("Alice"), false);

  const otherTenant = identities.tenant("other-school.example");
  service.record("tool_call_completed", {
    ...context,
    tenantId: otherTenant,
    mcpMethod: "tools/call",
    toolName: "GetGroups",
    toolGroup: "groups",
    toolRisk: "read",
    outcome: "success",
    durationMs: 4,
  });
  assert.equal(calls[1].fields.clientFamily, undefined);
  assert.equal(service.verifyDashboardCredentials("analytics", "SYNTHETIC-PASSWORD-123456"), true);
  assert.equal(service.verifyDashboardCredentials("Analytics", "SYNTHETIC-PASSWORD-123456"), false);
  assert.equal(service.verifyDashboardCredentials("analytics", "wrong"), false);
});

test("bounded queue is non-blocking, bounded and fail-open on processor errors", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const failures = [];
  const drops = [];
  const queue = new BoundedAsyncQueue({
    maxItems: 2,
    batchSize: 1,
    flushIntervalMs: 60_000,
    processBatch: async () => {
      await gate;
      throw new Error("PROCESSOR-CANARY-MUST-NOT-ESCAPE");
    },
    onDrop: (value) => drops.push(value),
    onFailure: (value) => failures.push(value),
  });

  const start = process.hrtime.bigint();
  assert.equal(queue.enqueue({ id: 1 }), true);
  assert.equal(queue.enqueue({ id: 2 }), true);
  assert.equal(queue.enqueue({ id: 3 }), false);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 50, `enqueue should not block (${elapsedMs.toFixed(3)} ms)`);
  assert.deepEqual(drops, [{ reason: "full", count: 1 }]);

  release();
  assert.equal(await queue.flush({ timeoutMs: 2_000 }), true);
  assert.equal(queue.getStats().processingFailures, 2);
  assert.equal(queue.getStats().droppedProcessing, 2);
  assert.equal(failures.length, 2);
  assert.equal(await queue.close(), true);
  assert.equal(queue.enqueue({ id: 4 }), false);
  assert.equal(drops.at(-1).reason, "closed");
});
