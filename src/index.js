// Edvibe School MCP Server — entry point.
//
// Selects transport based on MCP_TRANSPORT env var:
//   - "stdio" (default): STDIO transport, credentials from env vars
//     (EDVIBE_API_KEY, EDVIBE_SCHOOL_DOMAIN). Used by local Cursor/Codex.
//   - "http": Streamable HTTP transport, credentials per-request from headers
//     (Authorization: Bearer <key>, X-Edvibe-School-Domain: <hostname>).
//     Used by the personal staging endpoint on edvibe.sungurov.com.
//
// NEVER pass EDVIBE_API_KEY on the command line — it leaks into logs and `ps`.
//
// Experimental/unofficial — not an official Edvibe product.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./build-server.js";
import { getContext, hasCredentials } from "./credential-context.js";
import { startHttpServer } from "./http-server.js";

async function main() {
  const transport = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

  if (transport === "http") {
    await startHttpServer();
    return;
  }

  // --- STDIO transport (default) ---
  // For STDIO, credentials come from env vars set by the MCP client.
  if (!hasCredentials()) {
    console.error(
      "[edvibe-school-mcp] WARNING: EDVIBE_API_KEY and/or EDVIBE_SCHOOL_DOMAIN not set. " +
        "Tools will fail until credentials are provided."
    );
  }

  // Build cred context once for the lifetime of the STDIO process.
  // Validation happens lazily on first tool call inside getContext().
  const credContext = await getContext().catch((e) => {
    console.error(`[edvibe-school-mcp] Credential error at startup: ${e.message}`);
    console.error("[edvibe-school-mcp] Continuing — tools/call will surface the error to the client.");
    return null;
  });

  const mcpServer = buildServer(credContext);
  const stdioTransport = new StdioServerTransport();
  await mcpServer.connect(stdioTransport);
  console.error(`[edvibe-school-mcp] Server started on STDIO.`);
}

main().catch((err) => {
  console.error("[edvibe-school-mcp] Fatal error:", err.message);
  process.exit(1);
});
