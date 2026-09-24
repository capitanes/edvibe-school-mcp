// Edvibe School MCP entry point. HTTP telemetry is disabled by default and
// activates only through explicit feature flags plus systemd credentials.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build-server.js";
import { getContext, hasCredentials } from "./credential-context.js";
import { startHttpServer } from "./http-server.js";
import { createTelemetryService } from "./telemetry/index.js";

function disabledTelemetry() {
  const config = Object.freeze({ enabled: false, dashboardEnabled: false });
  return Object.freeze({
    config,
    enabled: false,
    dashboardEnabled: false,
    identities: null,
    record: () => false,
    getDashboard: () => { throw new Error("Telemetry disabled."); },
    getEvents: () => { throw new Error("Telemetry disabled."); },
    getStatus: () => ({ enabled: false, dashboardEnabled: false, state: "disabled" }),
    close: async () => true,
  });
}

function createTelemetryFailOpen() {
  try {
    return createTelemetryService();
  } catch {
    console.error("[edvibe-school-mcp] Telemetry configuration unavailable; continuing with telemetry disabled.");
    return disabledTelemetry();
  }
}

async function closeHttpServer(server, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function runHttp() {
  const telemetry = createTelemetryFailOpen();
  const server = await startHttpServer({ telemetry });
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error("[edvibe-school-mcp] Graceful shutdown started.");
    await closeHttpServer(server);
    await telemetry.close({ drain: true, timeoutMs: 10_000 });
  };

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      shutdown()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}

async function runStdio() {
  if (!hasCredentials()) {
    console.error("[edvibe-school-mcp] WARNING: STDIO credentials are not fully configured.");
  }
  const credentialContext = await getContext().catch(() => {
    console.error("[edvibe-school-mcp] Credential validation failed; tool calls will return a safe error.");
    return null;
  });
  const mcpServer = buildServer(credentialContext);
  await mcpServer.connect(new StdioServerTransport());
  console.error("[edvibe-school-mcp] Server started on STDIO.");
}

async function main() {
  const transport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
  if (transport === "http") return runHttp();
  return runStdio();
}

main().catch(() => {
  console.error("[edvibe-school-mcp] Fatal startup error.");
  process.exit(1);
});

export { closeHttpServer, createTelemetryFailOpen };
