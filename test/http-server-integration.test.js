import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startHttpServer } from "../src/http-server.js";
import {
  TelemetryService,
  createIdentityHasher,
  createTelemetryStore,
} from "../src/telemetry/index.js";

const CLIENT_ID = "550e8400-e29b-41d4-a716-446655440000";

test("real HTTP initialize keeps tenant contexts isolated and leaves health uncounted", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "edvibe-http-integration-"));
  const journal = [];
  const store = createTelemetryStore({
    collectEnabled: true,
    storageRequired: true,
    databasePath: path.join(root, "telemetry.sqlite"),
    backupDirectory: path.join(root, "backups"),
    batchSize: 20,
    flushIntervalMs: 60_000,
    stderrEnabled: true,
    stderr: { write: (line) => journal.push(String(line)) },
  });
  const telemetry = new TelemetryService({
    config: { enabled: true, dashboardEnabled: false },
    store,
    identities: createIdentityHasher({ secret: Buffer.alloc(32, 0x5a), epoch: 5 }),
  });
  const server = await startHttpServer({
    port: 0,
    host: "127.0.0.1",
    telemetry,
    resolveCredentialContext: async (headers) => ({
      apiKey: "SYNTHETIC-INTEGRATION-API-KEY",
      schoolDomain: String(headers["x-edvibe-school-domain"]),
    }),
  });

  t.after(async () => {
    if (server.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await telemetry.close({ drain: false });
    await rm(root, { recursive: true, force: true });
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  async function initialize(domain, clientId, clientName) {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer SYNTHETIC-INTEGRATION-API-KEY",
        "X-Edvibe-School-Domain": domain,
        ...(clientId ? { "X-Edvibe-Client-Id": clientId } : {}),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: clientName, version: "1.2.3" },
        },
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body.includes("edvibe-school-mcp"), true);
  }

  await Promise.all([
    initialize("alpha.integration.example", CLIENT_ID, "Cursor"),
    initialize("beta.integration.example", CLIENT_ID, "OpenAI Codex CLI"),
    initialize("legacy.integration.example", null, "Devin"),
  ]);
  const rejectedClientCanary = "RejectedClient-PII-CANARY";
  const rejected = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: "Bearer SYNTHETIC-INTEGRATION-API-KEY",
      "X-Edvibe-School-Domain": "rejected.integration.example",
      "Content-Type": "text/plain",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: rejectedClientCanary, version: "1.2.3-secret-suffix" },
      },
    }),
  });
  assert.equal(rejected.status, 415);
  await rejected.text();
  assert.equal(await store.queue.flush({ timeoutMs: 2_000 }), true);

  const events = store.getEvents({ period: "24h", pageSize: 20 });
  assert.equal(events.total, 4);
  const initialized = events.items.filter((event) => event.type === "mcp_initialize_completed");
  assert.equal(initialized.length, 3);
  assert.equal(new Set(initialized.map((event) => event.tenantId)).size, 3);
  const rejectedEvents = events.items.filter((event) => event.type === "mcp_request_rejected");
  assert.equal(rejectedEvents.length, 1);
  assert.equal(rejectedEvents[0].errorCode, "invalid_request");
  assert.equal("clientFamily" in rejectedEvents[0], false);

  const identified = initialized.filter((event) => event.installationId);
  assert.equal(identified.length, 2);
  assert.equal(new Set(identified.map((event) => event.installationId)).size, 2);
  assert.equal(initialized.some((event) => !event.installationId), true);
  assert.deepEqual(
    new Set(initialized.map((event) => event.clientFamily)),
    new Set(["cursor", "codex", "devin"]),
  );

  const persisted = JSON.stringify(events);
  const journalText = journal.join("");
  for (const canary of [
    "SYNTHETIC-INTEGRATION-API-KEY",
    CLIENT_ID,
    "alpha.integration.example",
    "beta.integration.example",
    "legacy.integration.example",
    "rejected.integration.example",
    rejectedClientCanary,
    "secret-suffix",
  ]) {
    assert.equal(persisted.includes(canary), false, canary);
    assert.equal(journalText.includes(canary), false, canary);
  }
});
