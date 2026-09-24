import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";

import {
  callUpstream,
  getLimiter,
  getUpstreamCacheStats,
} from "../src/upstream.js";

const API_KEY = "SYNTHETIC-API-KEY-CANARY-274f";
const SCHOOL_DOMAIN = "school-canary.example";
const UPSTREAM_CONTEXT = Object.freeze({
  apiKey: API_KEY,
  schoolDomain: SCHOOL_DOMAIN,
  resolvedAddresses: Object.freeze(["93.184.216.34"]),
});

function installRequestMock(t, scenario) {
  const original = https.request;
  const captured = {};
  https.request = (url, options, callback) => {
    captured.url = String(url);
    captured.options = options;
    captured.body = "";
    const req = new EventEmitter();
    req.write = (chunk) => {
      captured.body += String(chunk);
    };
    req.destroy = (error) => queueMicrotask(() => req.emit("error", error));
    req.end = () => queueMicrotask(() => {
      if (scenario.networkError) {
        req.emit("error", scenario.networkError);
        return;
      }
      if (scenario.timeout) {
        req.emit("timeout");
        return;
      }
      const response = new EventEmitter();
      response.statusCode = scenario.statusCode ?? 200;
      callback(response);
      for (const chunk of scenario.chunks ?? [scenario.body ?? "{}"] ) response.emit("data", chunk);
      response.emit("end");
    });
    return req;
  };
  t.after(() => {
    https.request = original;
  });
  return captured;
}

test("upstream success preserves product data but strips errorStackTrace", async (t) => {
  const stackCanary = "UPSTREAM-STACK-CANARY-5fd1";
  const captured = installRequestMock(t, {
    body: JSON.stringify({ isSuccess: true, data: { id: 42 }, errorStackTrace: stackCanary }),
  });
  const metrics = {};
  const result = await callUpstream(
    UPSTREAM_CONTEXT,
    "post",
    "/v1/example",
    {
      queryParams: { page: 2, marker: "QUERY-CANARY" },
      body: { login: "LOGIN-CANARY", password: "PASSWORD-CANARY" },
      metrics,
    },
  );

  assert.deepEqual(result, { isSuccess: true, data: { id: 42 } });
  assert.match(captured.url, /^https:\/\/school-canary\.example\/school-api\/v1\/example\?/);
  assert.equal(captured.options.headers.Authorization, API_KEY);
  await new Promise((resolve, reject) => {
    captured.options.lookup(SCHOOL_DOMAIN, {}, (error, address, family) => {
      if (error) return reject(error);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
      resolve();
    });
  });
  assert.equal(JSON.parse(captured.body).password, "PASSWORD-CANARY");
  assert.equal(metrics.upstreamStatus, 200);
  assert.equal(Number.isFinite(metrics.limiterWaitMs), true);
  assert.equal(Number.isFinite(metrics.upstreamDurationMs), true);
  assert.deepEqual(Object.keys(metrics).sort(), ["limiterWaitMs", "upstreamDurationMs", "upstreamStatus"]);
  assert.equal(JSON.stringify(metrics).includes(API_KEY), false);
  assert.equal(JSON.stringify(metrics).includes(SCHOOL_DOMAIN), false);
  assert.equal(JSON.stringify(metrics).includes("LOGIN-CANARY"), false);
  assert.equal(JSON.stringify(metrics).includes("PASSWORD-CANARY"), false);
  assert.equal(JSON.stringify(metrics).includes(stackCanary), false);
});

for (const [statusCode, expectedCode] of [
  [401, "upstream_401"],
  [403, "upstream_403"],
  [429, "upstream_429"],
  [422, "upstream_4xx"],
  [503, "upstream_5xx"],
]) {
  test(`upstream HTTP ${statusCode} is reduced to ${expectedCode} without response body`, async (t) => {
    const bodyCanary = `UPSTREAM-BODY-CANARY-${statusCode}`;
    installRequestMock(t, { statusCode, body: bodyCanary });
    const metrics = {};
    await assert.rejects(
      () => callUpstream(
        UPSTREAM_CONTEXT,
        "get",
        "/v1/example",
        { metrics },
      ),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.upstreamStatus, statusCode);
        assert.equal(String(error).includes(bodyCanary), false);
        assert.equal(JSON.stringify(error).includes(bodyCanary), false);
        return true;
      },
    );
    assert.equal(metrics.upstreamStatus, statusCode);
  });
}

test("non-JSON and business failures expose fixed error codes only", async (t) => {
  const nonJsonCanary = "NON-JSON-UPSTREAM-CANARY-88cd";
  installRequestMock(t, { body: nonJsonCanary });
  await assert.rejects(
    () => callUpstream(
      UPSTREAM_CONTEXT,
      "get",
      "/v1/non-json",
    ),
    (error) => error.code === "upstream_non_json" && !String(error).includes(nonJsonCanary),
  );
});

test("oversized successful upstream responses are rejected without retaining their body", async (t) => {
  const canary = "OVERSIZED-UPSTREAM-CANARY";
  installRequestMock(t, {
    chunks: [Buffer.alloc(5 * 1024 * 1024, 0x58), Buffer.from(canary)],
  });
  await assert.rejects(
    () => callUpstream(UPSTREAM_CONTEXT, "get", "/v1/oversized"),
    (error) => error.code === "upstream_non_json" && !String(error).includes(canary),
  );
});

test("a supplied private DNS address is rejected before opening an upstream request", async () => {
  await assert.rejects(
    () => callUpstream({
      apiKey: API_KEY,
      schoolDomain: SCHOOL_DOMAIN,
      resolvedAddresses: ["127.0.0.1"],
    }, "get", "/v1/private"),
    (error) => error.code === "unsupported_school_domain",
  );
});

test("business error body and upstream stack are never copied into the exception", async (t) => {
  const bodyCanary = "BUSINESS-ERROR-CANARY-620b";
  installRequestMock(t, {
    body: JSON.stringify({
      isSuccess: false,
      message: bodyCanary,
      errorStackTrace: `STACK-${bodyCanary}`,
      token: `TOKEN-${bodyCanary}`,
    }),
  });
  await assert.rejects(
    () => callUpstream(
      UPSTREAM_CONTEXT,
      "post",
      "/v1/business-error",
      { body: { password: "REQUEST-PASSWORD-CANARY" } },
    ),
    (error) => {
      assert.equal(error.code, "upstream_business_error");
      assert.equal(String(error).includes(bodyCanary), false);
      assert.equal(JSON.stringify(error).includes(bodyCanary), false);
      assert.equal(JSON.stringify(error).includes("REQUEST-PASSWORD-CANARY"), false);
      return true;
    },
  );
});

test("network and timeout causes are reduced to safe fixed errors", async (t) => {
  const networkCanary = "NETWORK-CAUSE-CANARY-fd04";
  installRequestMock(t, { networkError: new Error(networkCanary) });
  await assert.rejects(
    () => callUpstream(
      UPSTREAM_CONTEXT,
      "get",
      "/v1/network",
    ),
    (error) => error.code === "upstream_network" && !String(error).includes(networkCanary),
  );
});

test("timeout uses its own safe classification", async (t) => {
  installRequestMock(t, { timeout: true });
  await assert.rejects(
    () => callUpstream(
      UPSTREAM_CONTEXT,
      "get",
      "/v1/timeout",
    ),
    (error) => error.code === "upstream_timeout",
  );
});

test("missing credentials fail before creating a request", async () => {
  await assert.rejects(
    () => callUpstream({ schoolDomain: SCHOOL_DOMAIN }, "get", "/v1/example"),
    (error) => error.code === "missing_authorization",
  );
  await assert.rejects(
    () => callUpstream({ apiKey: API_KEY }, "get", "/v1/example"),
    (error) => error.code === "missing_school_domain",
  );
});

test("rate limiter registry is stable per key and exposes only counts", () => {
  const before = getUpstreamCacheStats();
  const first = getLimiter("REGISTRY-API-KEY-CANARY-A");
  const again = getLimiter("REGISTRY-API-KEY-CANARY-A");
  const second = getLimiter("REGISTRY-API-KEY-CANARY-B");
  assert.equal(first, again);
  assert.notEqual(first, second);
  const after = getUpstreamCacheStats();
  assert.equal(after.limiterEntries >= before.limiterEntries + 2, true);
  assert.deepEqual(Object.keys(after).sort(), ["dnsEntries", "limiterEntries"]);
  assert.equal(JSON.stringify(after).includes("REGISTRY-API-KEY-CANARY"), false);
});
