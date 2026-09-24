import crypto from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleAnalyticsRequest } from "./analytics-dashboard.js";
import { buildServer } from "./build-server.js";
import { getContextFromHeaders } from "./credential-context.js";
import { normalizeClientInfo } from "./telemetry/client-info.js";
import { classifySafeError, createSafeError } from "./telemetry/errors.js";
import { parseClientInstallationId } from "./telemetry/identity.js";

const DEFAULT_PORT = 9000;
const MAX_BODY_BYTES = 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        raw = "";
        reject(createSafeError("request_body_too_large"));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(createSafeError("malformed_json"));
      }
    });
    req.on("error", () => {
      if (!settled) reject(createSafeError("invalid_request"));
    });
  });
}

function sendJson(res, status, payload, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function mcpMethod(parsedBody) {
  const method = parsedBody && !Array.isArray(parsedBody) ? parsedBody.method : null;
  if (["initialize", "tools/list", "tools/call", "ping"].includes(method)) return method;
  return "other";
}

function safeTelemetryContext(telemetry, credentialContext, clientIdHeader, requestId) {
  if (!telemetry?.enabled || !telemetry.identities) return null;
  try {
    if (typeof telemetry.createRequestContext === "function") {
      return telemetry.createRequestContext({
        requestId,
        schoolDomain: credentialContext.schoolDomain,
        clientIdHeader,
      });
    }
    const tenantId = telemetry.identities.tenant(credentialContext.schoolDomain);
    const clientId = parseClientInstallationId(clientIdHeader);
    return {
      requestId,
      transport: "streamable_http",
      tenantId,
      installationId: clientId ? telemetry.identities.installation(clientId, tenantId) : null,
    };
  } catch {
    return null;
  }
}

function recordRejection(telemetry, context, method, classification, started, requestId) {
  telemetry?.record("mcp_request_rejected", {
    ...(context || { requestId, transport: "streamable_http" }),
    mcpMethod: method,
    outcome: "rejected",
    errorCode: classification.code,
    durationMs: performance.now() - started,
  });
}

function parsePort(optionsPort, envPort) {
  if (optionsPort === 0) return 0;
  const candidate = optionsPort ?? (envPort === undefined ? DEFAULT_PORT : Number(envPort));
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65_535) return DEFAULT_PORT;
  return candidate;
}

export async function startHttpServer(options = {}) {
  const port = parsePort(options.port, process.env.PORT);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const telemetry = options.telemetry ?? null;
  const resolveCredentialContext = options.resolveCredentialContext ?? getContextFromHeaders;

  const handleRequest = async (req, res) => {
    const started = performance.now();
    const requestId = crypto.randomUUID();
    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (await handleAnalyticsRequest(req, res, url, telemetry)) return;

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not Found. Use POST /mcp." });
      return;
    }
    if (req.method !== "POST") {
      const error = createSafeError("method_not_allowed");
      const safe = classifySafeError(error);
      recordRejection(telemetry, null, "other", safe, started, requestId);
      sendJson(res, 405, { error: safe.publicMessage }, { Allow: "POST" });
      return;
    }

    let credentialContext;
    try {
      credentialContext = await resolveCredentialContext(req.headers);
    } catch (error) {
      const safe = classifySafeError(error);
      recordRejection(telemetry, null, "other", safe, started, requestId);
      sendJson(res, safe.httpStatus, { error: safe.publicMessage });
      return;
    }

    const context = safeTelemetryContext(
      telemetry,
      credentialContext,
      req.headers["x-edvibe-client-id"],
      requestId,
    );

    let parsedBody;
    try {
      parsedBody = await readJsonBody(req);
    } catch (error) {
      const safe = classifySafeError(error);
      recordRejection(telemetry, context, "other", safe, started, requestId);
      sendJson(res, safe.httpStatus, { error: safe.publicMessage });
      return;
    }

    const method = mcpMethod(parsedBody);
    let transport;
    let mcpServer;
    const cleanup = () => {
      Promise.resolve(transport?.close()).catch(() => {});
      Promise.resolve(mcpServer?.close()).catch(() => {});
    };
    try {
      mcpServer = buildServer(credentialContext, { telemetry, telemetryContext: context });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.once("close", cleanup);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);

      if (method === "initialize" && context && res.statusCode >= 200 && res.statusCode < 300) {
        const client = normalizeClientInfo(parsedBody?.params?.clientInfo);
        telemetry.record("mcp_initialize_completed", {
          ...context,
          clientFamily: client.family,
          clientVersion: client.version,
          mcpMethod: "initialize",
          outcome: "success",
          durationMs: performance.now() - started,
        });
      } else if (res.statusCode < 200 || res.statusCode >= 300) {
        recordRejection(
          telemetry,
          context,
          method,
          classifySafeError(createSafeError("invalid_request")),
          started,
          requestId,
        );
      }
    } catch (error) {
      const safe = classifySafeError(error);
      recordRejection(telemetry, context, method, safe, started, requestId);
      sendJson(res, safe.httpStatus, { error: safe.publicMessage });
    }
  };

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      sendJson(res, 500, { error: "Internal Server Error." });
    });
  });

  return new Promise((resolve, reject) => {
    const onStartupError = (error) => reject(error);
    server.once("error", onStartupError);
    server.listen(port, host, () => {
      server.off("error", onStartupError);
      const address = server.address();
      const listeningPort = typeof address === "object" && address ? address.port : port;
      console.error(`[edvibe-school-mcp] Streamable HTTP listening on port ${listeningPort} (stateless).`);
      resolve(server);
    });
  });
}

export { mcpMethod, parsePort, readJsonBody, safeTelemetryContext };
