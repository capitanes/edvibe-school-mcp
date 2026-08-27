// Streamable HTTP transport for the Edvibe School MCP server.
//
// Stateless mode (per MCP spec 2026-07-28): a fresh Server + Transport instance
// is created for each POST /mcp request, and torn down when the response closes.
// No session ID is minted, no server-side session registry, no sticky routing.
//
// Auth model (variant A, see CONTEXT.md → "Авторизация доступа к HTTP-endpoint"):
//   - Authorization: Bearer <EDVIBE_API_KEY>      (the school's Edvibe API key)
//   - X-Edvibe-School-Domain: <hostname>          (the school's hostname)
// The same key is used both as the access credential to this endpoint and as
// the upstream Edvibe API key. An invalid key is rejected upstream by Edvibe
// (401), which propagates back to the client.
//
// Endpoints:
//   POST /mcp      — JSON-RPC over Streamable HTTP (stateless)
//   GET  /mcp      — 405 Method Not Allowed (stateless, no SSE stream)
//   DELETE /mcp    — 405 Method Not Allowed (stateless, no session to delete)
//   GET  /healthz  — 200 OK (no config leak)

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./build-server.js";
import { getContextFromHeaders } from "./credential-context.js";

const DEFAULT_PORT = 9000;

/**
 * Read and parse the JSON body of an IncomingMessage.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    const MAX = 1 * 1024 * 1024; // 1 MiB cap — JSON-RPC payloads are small.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(new Error("Request body too large (max 1 MiB)."));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Malformed JSON body."));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send a JSON error response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendJsonError(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Start the Streamable HTTP server.
 *
 * @param {object} [options]
 * @param {number} [options.port] — defaults to process.env.PORT or 9000.
 * @param {string} [options.host] — defaults to "0.0.0.0" (NPM reverse-proxies in).
 * @returns {Promise<import('node:http').Server>}
 */
export async function startHttpServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT) ?? DEFAULT_PORT;
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    // --- Health check: no auth, no config leak ---
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // --- MCP endpoint: only /mcp is handled ---
    if (url.pathname !== "/mcp") {
      sendJsonError(res, 404, "Not Found. Use POST /mcp.");
      return;
    }

    // Stateless Streamable HTTP: only POST is meaningful.
    // GET (SSE) and DELETE (session teardown) are 405 per stateless spec.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Method ${req.method} Not Allowed on /mcp (stateless server).` }));
      return;
    }

    // --- Auth: extract credentials from headers BEFORE touching upstream ---
    let credContext;
    try {
      credContext = await getContextFromHeaders(req.headers);
    } catch (e) {
      sendJsonError(res, e.httpStatus || 401, e.message);
      return;
    }

    // --- Parse body ---
    let parsedBody;
    try {
      parsedBody = await readJsonBody(req);
    } catch (e) {
      sendJsonError(res, 400, e.message);
      return;
    }

    // --- Handle request: fresh server + transport per request (stateless) ---
    try {
      const mcpServer = buildServer(credContext);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: never mint a session id
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);

      // Tear down when the client disconnects or the response finishes.
      res.on("close", () => {
        try {
          transport.close();
          mcpServer.close();
        } catch {
          /* noop */
        }
      });
    } catch (e) {
      console.error("[edvibe-school-mcp] HTTP handler error:", e.message);
      sendJsonError(res, 500, "Internal Server Error.");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      console.error(`[edvibe-school-mcp] Streamable HTTP listening on http://${host}:${port}/mcp (stateless).`);
      resolve(server);
    });
  });
}
