import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer } from "../src/build-server.js";

const API_KEY = "SYNTHETIC-BUILD-SERVER-API-KEY-c1a4";
const SCHOOL_DOMAIN = "build-server-private.example";
const PUPIL_TOKEN = "LOGIN-PUPIL-TOKEN-CANARY-7dd1";
const TEACHER_TOKEN = "LOGIN-TEACHER-TOKEN-CANARY-a19f";
const UPSTREAM_BODY = "UPSTREAM-503-BODY-CANARY-5f22";
const ARGUMENT_CANARY = "INVALID-ARGUMENT-PASSWORD-CANARY-6e1c";
const UNKNOWN_TOOL_CANARY = "UnknownTool_TOKEN-CANARY-80ab";

function installUpstreamMock(t) {
  const original = https.request;
  const requests = [];
  https.request = (url, options, callback) => {
    const entry = { url: String(url), options, body: "" };
    requests.push(entry);
    const req = new EventEmitter();
    req.write = (chunk) => { entry.body += String(chunk); };
    req.destroy = (error) => queueMicrotask(() => req.emit("error", error));
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      if (entry.url.endsWith("/api/UserAuth/LoginPupil")) {
        response.statusCode = 200;
        callback(response);
        response.emit("data", JSON.stringify({ isSuccess: true, data: { token: PUPIL_TOKEN } }));
      } else if (entry.url.endsWith("/api/UserAuth/LoginTeacher")) {
        response.statusCode = 200;
        callback(response);
        response.emit("data", JSON.stringify({ isSuccess: true, data: { token: TEACHER_TOKEN } }));
      } else {
        response.statusCode = 503;
        callback(response);
        response.emit("data", UPSTREAM_BODY);
      }
      response.emit("end");
    });
    return req;
  };
  t.after(() => { https.request = original; });
  return requests;
}

async function createMcpFixture(t, telemetry) {
  const telemetryContext = {
    requestId: "request_buildserver_001",
    transport: "streamable_http",
    tenantId: `t_${"T".repeat(22)}`,
    installationId: `i_${"I".repeat(22)}`,
  };
  const server = buildServer(
    { apiKey: API_KEY, schoolDomain: SCHOOL_DOMAIN, resolvedAddresses: ["93.184.216.34"] },
    { telemetry, telemetryContext },
  );
  const client = new Client({ name: "runtime-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });
  return client;
}

test("build server logs only safe metadata for rejections, upstream errors and login-token success", async (t) => {
  const requests = installUpstreamMock(t);
  const telemetryCalls = [];
  const telemetry = {
    record(type, fields) {
      telemetryCalls.push({ type, fields: structuredClone(fields) });
      return true;
    },
  };
  const client = await createMcpFixture(t, telemetry);

  const listed = await client.listTools();
  assert.equal(listed.tools.length, 78);
  assert.equal(listed.tools.some((tool) => tool.name === "UserAuthLoginPupil"), true);
  assert.equal(listed.tools.some((tool) => tool.name === "UserAuthLoginTeacher"), true);

  const unknown = await client.callTool({ name: UNKNOWN_TOOL_CANARY, arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.content[0].text, "Error: Unknown tool.");
  assert.equal(unknown.content[0].text.includes(UNKNOWN_TOOL_CANARY), false);

  const invalid = await client.callTool({
    name: "UserAuthLoginPupil",
    arguments: { bodyPupilId: ARGUMENT_CANARY, password: ARGUMENT_CANARY },
  });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content[0].text, "Error: Tool arguments are invalid.");
  assert.equal(invalid.content[0].text.includes(ARGUMENT_CANARY), false);

  const pupil = await client.callTool({
    name: "UserAuthLoginPupil",
    arguments: { bodyPupilId: 123 },
  });
  assert.equal(pupil.isError, false);
  assert.equal(pupil.content[0].text.includes(PUPIL_TOKEN), true);

  const teacher = await client.callTool({
    name: "UserAuthLoginTeacher",
    arguments: { bodyTeacherId: 456 },
  });
  assert.equal(teacher.isError, false);
  assert.equal(teacher.content[0].text.includes(TEACHER_TOKEN), true);

  const upstreamError = await client.callTool({
    name: "UserAuthCheckAuthToken",
    arguments: { bodySessionToken: "550e8400-e29b-41d4-a716-446655440000" },
  });
  assert.equal(upstreamError.isError, true);
  assert.equal(upstreamError.content[0].text, "Error: Upstream service failed.");
  assert.equal(upstreamError.content[0].text.includes(UPSTREAM_BODY), false);

  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[0].body).pupilId, 123);
  assert.equal(JSON.parse(requests[1].body).teacherId, 456);

  assert.equal(telemetryCalls.length, 5);
  assert.deepEqual(
    telemetryCalls.slice(0, 2).map(({ type, fields }) => [type, fields.errorCode]),
    [
      ["mcp_request_rejected", "unknown_tool"],
      ["mcp_request_rejected", "invalid_arguments"],
    ],
  );
  const pupilTelemetry = telemetryCalls.find(({ fields }) => fields.toolName === "UserAuthLoginPupil");
  const teacherTelemetry = telemetryCalls.find(({ fields }) => fields.toolName === "UserAuthLoginTeacher");
  const errorTelemetry = telemetryCalls.find(({ fields }) => fields.toolName === "UserAuthCheckAuthToken");
  assert.equal(pupilTelemetry.type, "tool_call_completed");
  assert.equal(pupilTelemetry.fields.toolRisk, "sensitive");
  assert.equal(pupilTelemetry.fields.outcome, "success");
  assert.equal(teacherTelemetry.fields.toolRisk, "sensitive");
  assert.equal(teacherTelemetry.fields.outcome, "success");
  assert.equal(errorTelemetry.fields.outcome, "error");
  assert.equal(errorTelemetry.fields.errorCode, "upstream_5xx");
  assert.equal(errorTelemetry.fields.upstreamStatus, 503);

  const serializedTelemetry = JSON.stringify(telemetryCalls);
  for (const canary of [
    API_KEY,
    SCHOOL_DOMAIN,
    PUPIL_TOKEN,
    TEACHER_TOKEN,
    UPSTREAM_BODY,
    ARGUMENT_CANARY,
    UNKNOWN_TOOL_CANARY,
    "550e8400-e29b-41d4-a716-446655440000",
  ]) {
    assert.equal(serializedTelemetry.includes(canary), false, canary);
  }
  for (const { fields } of telemetryCalls) {
    for (const forbidden of ["arguments", "args", "result", "response", "body", "token", "password", "apiKey", "schoolDomain"] ) {
      assert.equal(Object.hasOwn(fields, forbidden), false, forbidden);
    }
  }
});
