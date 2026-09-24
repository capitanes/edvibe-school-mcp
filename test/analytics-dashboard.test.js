import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleAnalyticsRequest } from "../src/analytics-dashboard.js";

const PASSWORD = "SYNTHETIC:DASHBOARD:PASSWORD-123456";
const AUTHORIZATION = `Basic ${Buffer.from(`analytics:${PASSWORD}`).toString("base64")}`;
const TENANT_ID = `t_${"A".repeat(22)}`;
const INSTALLATION_ID = `i_${"B".repeat(22)}`;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

class MockResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.body = Buffer.alloc(0);
    this.headersSent = false;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    this.headersSent = true;
  }

  end(value = "") {
    const next = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    this.body = Buffer.concat([this.body, next]);
  }

  json() {
    return JSON.parse(this.body.toString("utf8"));
  }
}

function request({ method = "GET", authorization, https = true, remoteAddress = "172.17.0.2" } = {}) {
  return {
    method,
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...(https ? { "x-forwarded-proto": "https" } : {}),
    },
    socket: { encrypted: false, remoteAddress },
  };
}

function rawDashboard() {
  return {
    range: {
      from: "2026-09-17T12:00:00.000Z",
      to: "2026-09-24T12:00:00.000Z",
      timezone: "Europe/Moscow",
    },
    totals: {
      activeTenants: 2,
      activeInstallations: 1,
      initializations: 3,
      toolCalls: 4,
      successfulToolCalls: 3,
      failedToolCalls: 1,
      successRate: 0.75,
      identifiedShare: 0.5,
      averageDurationMs: 20,
      p50DurationMs: 15,
      p95DurationMs: 40,
    },
    activityWindows: {
      "24h": { activeTenants: 1, activeInstallations: 1, toolCalls: 2, activeDays: 1 },
      "7d": { activeTenants: 2, activeInstallations: 1, toolCalls: 4, activeDays: 2 },
      "30d": { activeTenants: 2, activeInstallations: 1, toolCalls: 4, activeDays: 2 },
      "90d": { activeTenants: 2, activeInstallations: 1, toolCalls: 4, activeDays: 2 },
    },
    daily: [{ dayUtc: "2026-09-24", calls: 4, successes: 3 }],
    moscowHours: [{ hour: 15, calls: 4 }],
    heatmap: [{ weekday: 4, hour: 15, calls: 4 }],
    tools: [{ toolName: "GetGroups", toolGroup: "school", toolRisk: "read", calls: 4, successes: 3 }],
    groups: [{ toolGroup: "school", calls: 4, successes: 3 }],
    errors: [{ errorCode: "upstream_429", count: 1 }],
    scenarios: { items: [{ tools: ["GetGroups", "GetStudents"], count: 1 }] },
    clients: [{ tenantId: TENANT_ID, installationId: INSTALLATION_ID, calls: 3 }],
  };
}

function telemetryStub(overrides = {}) {
  const calls = { credentials: [], dashboard: [], events: [] };
  const telemetry = {
    enabled: false,
    dashboardEnabled: true,
    config: { dashboardEnabled: true, analyticsRequireHttps: true },
    verifyDashboardCredentials(username, password) {
      calls.credentials.push({ username, password });
      return username === "analytics" && password === PASSWORD;
    },
    getDashboard(query) {
      calls.dashboard.push(query);
      return rawDashboard();
    },
    getEvents(query) {
      calls.events.push(query);
      return {
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 50,
        total: 3,
        pages: 3,
        items: [{
          type: "tool_call_completed",
          occurredAt: "2026-09-24T12:00:00.000Z",
          requestId: "request_event_003",
          tenantId: TENANT_ID,
          outcome: "success",
        }],
      };
    },
    getStatus() {
      return {
        state: "ready",
        droppedEvents: 0,
        dbSizeBytes: 4096,
        lastEventAt: "2026-09-24T12:00:00.000Z",
      };
    },
    ...overrides,
  };
  return { calls, telemetry };
}

function assertSecurityHeaders(response) {
  assert.equal(response.headers["cache-control"].includes("no-store"), true);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(response.headers["content-security-policy"], /script-src 'self'/);
}

test("non-dashboard paths are ignored", async () => {
  const { telemetry } = telemetryStub();
  const response = new MockResponse();
  const handled = await handleAnalyticsRequest(
    request(),
    response,
    new URL("https://mcp.example/healthz"),
    telemetry,
  );
  assert.equal(handled, false);
  assert.equal(response.headersSent, false);
});

test("dashboard script references only element ids present in its HTML", () => {
  const html = fs.readFileSync(path.resolve(TEST_DIR, "../web/admin/analytics.html"), "utf8");
  const script = fs.readFileSync(path.resolve(TEST_DIR, "../web/admin/analytics.js"), "utf8");
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = [...script.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.equal(referencedIds.includes("activity-windows-table"), true);
  assert.deepEqual(referencedIds.filter((id) => !htmlIds.has(id)), []);
});

test("dashboard remains available read-only when collection is disabled", async () => {
  const { telemetry } = telemetryStub({ enabled: false, dashboardEnabled: true });
  const response = new MockResponse();
  const handled = await handleAnalyticsRequest(
    request({ authorization: AUTHORIZATION }),
    response,
    new URL("https://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /^text\/html/);
  assertSecurityHeaders(response);
  assert.equal(response.body.toString("utf8").includes("<script src="), true);
  assert.equal(response.body.toString("utf8").includes("<script>"), false);
});

test("disabled dashboard is indistinguishable from a missing route", async () => {
  const { telemetry } = telemetryStub({ dashboardEnabled: false, config: { dashboardEnabled: false } });
  const response = new MockResponse();
  await handleAnalyticsRequest(
    request({ authorization: AUTHORIZATION }),
    response,
    new URL("https://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "Not Found." });
  assertSecurityHeaders(response);
});

test("HTTPS and Basic Auth are mandatory and credentials are delegated to the service", async () => {
  const { calls, telemetry } = telemetryStub();

  const insecure = new MockResponse();
  await handleAnalyticsRequest(
    request({ authorization: AUTHORIZATION, https: false }),
    insecure,
    new URL("http://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(insecure.statusCode, 403);
  assert.equal(calls.credentials.length, 0);

  const missing = new MockResponse();
  await handleAnalyticsRequest(
    request(),
    missing,
    new URL("https://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(missing.statusCode, 401);
  assert.match(missing.headers["www-authenticate"], /^Basic /);
  assertSecurityHeaders(missing);

  const wrong = new MockResponse();
  await handleAnalyticsRequest(
    request({ authorization: `Basic ${Buffer.from("analytics:wrong").toString("base64")}` }),
    wrong,
    new URL("https://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(wrong.statusCode, 401);

  const valid = new MockResponse();
  await handleAnalyticsRequest(
    request({ authorization: AUTHORIZATION }),
    valid,
    new URL("https://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(valid.statusCode, 200);
  assert.deepEqual(calls.credentials.at(-1), { username: "analytics", password: PASSWORD });

  const spoofedProxy = new MockResponse();
  await handleAnalyticsRequest(
    request({ authorization: AUTHORIZATION, remoteAddress: "203.0.113.25" }),
    spoofedProxy,
    new URL("https://mcp.example/admin/analytics"),
    telemetry,
  );
  assert.equal(spoofedProxy.statusCode, 403);
});

test("dashboard accepts GET only, including API endpoints", async () => {
  const { telemetry } = telemetryStub();
  for (const pathname of ["/admin/analytics", "/admin/analytics/api/dashboard", "/admin/analytics/api/events"]) {
    const response = new MockResponse();
    await handleAnalyticsRequest(
      request({ method: "POST", authorization: AUTHORIZATION }),
      response,
      new URL(`https://mcp.example${pathname}`),
      telemetry,
    );
    assert.equal(response.statusCode, 405, pathname);
    assert.equal(response.headers.allow, "GET", pathname);
    assertSecurityHeaders(response);
  }
});

test("dashboard API maps validated filters and rejects injection by omission", async () => {
  const { calls, telemetry } = telemetryStub();
  const response = new MockResponse();
  const url = new URL("https://mcp.example/admin/analytics/api/dashboard");
  url.searchParams.set("range", "30d");
  url.searchParams.set("tenant_id", TENANT_ID);
  url.searchParams.set("installation_id", INSTALLATION_ID);
  url.searchParams.set("client_family", "cursor");
  url.searchParams.set("tool_group", "school");
  url.searchParams.set("outcome", "success");
  await handleAnalyticsRequest(request({ authorization: AUTHORIZATION }), response, url, telemetry);

  assert.equal(response.statusCode, 200);
  assertSecurityHeaders(response);
  assert.deepEqual(calls.dashboard, [{
    period: "30d",
    tenantId: TENANT_ID,
    installationId: INSTALLATION_ID,
    clientFamily: "cursor",
    toolGroup: "school",
    outcome: "success",
  }]);
  const payload = response.json();
  assert.equal(payload.summary.activeTenants, 2);
  assert.equal(payload.summary.toolCalls, 4);
  assert.equal(payload.operational.storageStatus, "ready");
  assert.equal(payload.operational.dbSizeBytes, 4096);

  const injection = new MockResponse();
  const injectedUrl = new URL("https://mcp.example/admin/analytics/api/dashboard");
  injectedUrl.searchParams.set("tenant_id", `${TENANT_ID}' OR 1=1 --`);
  injectedUrl.searchParams.set("tool_group", "school' OR 1=1 --");
  injectedUrl.searchParams.set("client_family", "<script>alert(1)</script>");
  injectedUrl.searchParams.set("outcome", "made_up");
  await handleAnalyticsRequest(request({ authorization: AUTHORIZATION }), injection, injectedUrl, telemetry);
  assert.equal(injection.statusCode, 200);
  assert.equal(calls.dashboard.at(-1).period, "7d");
  assert.equal(calls.dashboard.at(-1).tenantId, undefined);
  assert.equal(calls.dashboard.at(-1).toolGroup, undefined);
  assert.equal(injection.body.toString("utf8").includes("<script>alert(1)</script>"), false);
});

test("annual dashboard rejects identity drill-down beyond detail retention", async () => {
  const { calls, telemetry } = telemetryStub();
  const response = new MockResponse();
  const url = new URL("https://mcp.example/admin/analytics/api/dashboard?range=365d&tenant_id=" + encodeURIComponent(TENANT_ID));
  await handleAnalyticsRequest(request({ authorization: AUTHORIZATION }), response, url, telemetry);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Identity filters are available for up to 90 days." });
  assert.equal(calls.dashboard.length, 0);
  assertSecurityHeaders(response);
});

test("events API converts cursor pagination and returns only a next cursor", async () => {
  const { calls, telemetry } = telemetryStub();
  const response = new MockResponse();
  const url = new URL("https://mcp.example/admin/analytics/api/events?range=24h&limit=25&cursor=2");
  await handleAnalyticsRequest(request({ authorization: AUTHORIZATION }), response, url, telemetry);

  assert.equal(response.statusCode, 200);
  assert.equal(calls.events.length, 1);
  assert.equal(calls.events[0].period, "24h");
  assert.equal(calls.events[0].page, 2);
  assert.equal(calls.events[0].pageSize, 25);
  const payload = response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].requestId, "request_event_003");
  assert.equal(payload.total, 3);
  assert.equal(payload.nextCursor, "3");
});

test("unexpected analytics errors return a fixed response without leaking exception text", async () => {
  const canary = "SQL-EXCEPTION-CANARY-9f61";
  const { telemetry } = telemetryStub({
    getDashboard() {
      throw new Error(canary);
    },
  });
  const response = new MockResponse();
  await handleAnalyticsRequest(
    request({ authorization: AUTHORIZATION }),
    response,
    new URL("https://mcp.example/admin/analytics/api/dashboard"),
    telemetry,
  );
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.toString("utf8").includes(canary), false);
  assert.deepEqual(response.json(), { error: "Analytics dashboard is temporarily unavailable." });
  assertSecurityHeaders(response);
});
