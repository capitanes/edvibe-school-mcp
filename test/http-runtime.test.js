import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { getContextFromHeaders } from "../src/credential-context.js";
import {
  mcpMethod,
  parsePort,
  readJsonBody,
  safeTelemetryContext,
} from "../src/http-server.js";
import { createIdentityHasher } from "../src/telemetry/index.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

function bodyRequest(chunks, { emitError } = {}) {
  const request = new EventEmitter();
  queueMicrotask(() => {
    for (const chunk of chunks) request.emit("data", chunk);
    if (emitError) request.emit("error", emitError);
    else request.emit("end");
  });
  return request;
}

test("HTTP JSON reader accepts valid/empty payloads without retaining raw text", async () => {
  assert.deepEqual(
    await readJsonBody(bodyRequest([Buffer.from('{"method":"ping"}')])),
    { method: "ping" },
  );
  assert.equal(await readJsonBody(bodyRequest([])), undefined);
});

test("malformed, oversized and stream-error bodies receive only fixed safe errors", async () => {
  const malformedCanary = "MALFORMED-BODY-CANARY-09aa";
  await assert.rejects(
    () => readJsonBody(bodyRequest([Buffer.from(`{"value":"${malformedCanary}`)])),
    (error) => error.code === "malformed_json" && !String(error).includes(malformedCanary),
  );

  const oversized = Buffer.alloc(1024 * 1024 + 1, 0x58);
  await assert.rejects(
    () => readJsonBody(bodyRequest([oversized])),
    (error) => error.code === "request_body_too_large" && !String(error).includes("XXXXX"),
  );

  const streamCanary = "STREAM-ERROR-CANARY-78a1";
  await assert.rejects(
    () => readJsonBody(bodyRequest([], { emitError: new Error(streamCanary) })),
    (error) => error.code === "invalid_request" && !String(error).includes(streamCanary),
  );
});

test("authorization/domain rejections are typed and never echo header values", async () => {
  await assert.rejects(
    () => getContextFromHeaders({}),
    (error) => error.code === "missing_authorization",
  );
  await assert.rejects(
    () => getContextFromHeaders({ authorization: ["array-is-invalid"] }),
    (error) => error.code === "missing_authorization",
  );
  await assert.rejects(
    () => getContextFromHeaders({ authorization: "Bearer    " }),
    (error) => error.code === "invalid_authorization",
  );
  const apiKeyCanary = "AUTHORIZATION-CANARY-6f9e";
  await assert.rejects(
    () => getContextFromHeaders({ authorization: `Bearer ${apiKeyCanary}` }),
    (error) => error.code === "missing_school_domain" && !String(error).includes(apiKeyCanary),
  );
});

test("old HTTP config has tenant only; valid UUID v4 adds tenant-scoped installation", () => {
  const telemetry = {
    enabled: true,
    identities: createIdentityHasher({ secret: Buffer.alloc(32, 0x48), epoch: 12 }),
  };
  const credentialContext = {
    apiKey: "REQUEST-SCOPED-API-KEY-CANARY",
    schoolDomain: "school-context.example",
  };
  const oldContext = safeTelemetryContext(
    telemetry,
    credentialContext,
    undefined,
    "request_context_old",
  );
  assert.match(oldContext.tenantId, /^t_[A-Za-z0-9_-]{22}$/);
  assert.equal(oldContext.installationId, null);
  assert.equal("identityEpoch" in oldContext, false);

  const newContext = safeTelemetryContext(
    telemetry,
    credentialContext,
    UUID,
    "request_context_new",
  );
  assert.equal(newContext.tenantId, oldContext.tenantId);
  assert.match(newContext.installationId, /^i_[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newContext.installationId, UUID);

  const invalidContext = safeTelemetryContext(
    telemetry,
    credentialContext,
    "invalid-client-id",
    "request_context_invalid",
  );
  assert.equal(invalidContext.installationId, null);
  assert.equal(safeTelemetryContext({ enabled: false }, credentialContext, UUID, "request_disabled_1"), null);

  const serialized = JSON.stringify([oldContext, newContext, invalidContext]);
  assert.equal(serialized.includes(credentialContext.apiKey), false);
  assert.equal(serialized.includes(credentialContext.schoolDomain), false);
  assert.equal(serialized.includes(UUID), false);
});

test("HTTP helper normalization is finite and health-related methods do not become product methods", () => {
  assert.equal(mcpMethod({ method: "initialize" }), "initialize");
  assert.equal(mcpMethod({ method: "tools/list" }), "tools/list");
  assert.equal(mcpMethod({ method: "tools/call" }), "tools/call");
  assert.equal(mcpMethod({ method: "ping" }), "ping");
  assert.equal(mcpMethod({ method: "notifications/initialized" }), "other");
  assert.equal(mcpMethod([{ method: "tools/call" }]), "other");
  assert.equal(mcpMethod(undefined), "other");

  assert.equal(parsePort(undefined, undefined), 9000);
  assert.equal(parsePort(9876, "1234"), 9876);
  assert.equal(parsePort(undefined, "1234"), 1234);
  assert.equal(parsePort(undefined, "invalid"), 9000);
  assert.equal(parsePort(0, undefined), 0);
  assert.equal(parsePort(65_536, undefined), 9000);
});
