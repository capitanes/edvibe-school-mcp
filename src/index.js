// Edvibe School MCP Server — STDIO transport.
//
// Exposes all 78 Edvibe School API operations as MCP tools.
// Credentials come from EDVIBE_API_KEY and EDVIBE_SCHOOL_DOMAIN env vars.
//
// Usage:
//   EDVIBE_API_KEY=<key> EDVIBE_SCHOOL_DOMAIN=<hostname> node src/index.js
//
// Experimental/unofficial — not an official Edvibe product.

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadToolDefinitions } from "./tool-definitions.js";
import { callUpstream, RateLimiter } from "./upstream.js";
import { getContext, hasCredentials } from "./credential-context.js";

const SERVER_NAME = "edvibe-school-mcp";
const SERVER_VERSION = "0.0.0-experimental";

// Shared rate limiter per server process (per credential context)
const limiter = new RateLimiter();

/** Flatten a dotted parameter name to camelCase. */
function flattenDotted(name) {
  if (!name.includes(".")) return name;
  const parts = name.split(".");
  return parts[0].toLowerCase() + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

/**
 * Map MCP tool input parameters to upstream query params and body.
 * Dotted parameters (pageSkip → Page.Skip) are restored.
 * Body parameters (bodyFoo → foo) are extracted and placed in request body.
 */
function mapInputsToUpstream(toolMeta, args) {
  const queryParams = {};
  const body = {};

  for (const [inputName, value] of Object.entries(args || {})) {
    if (value === undefined || value === null) continue;

    // Check if this is a body parameter (prefixed with "body")
    if (inputName.startsWith("body") && inputName.length > 4) {
      const bodyKey = inputName[4].toLowerCase() + inputName.slice(5);
      body[bodyKey] = value;
      continue;
    }

    // Check if this is a flattened dotted parameter
    const paramDef = toolMeta.parameters.find((p) => {
      if (!p.dotted) return p.name === inputName;
      return flattenDotted(p.name) === inputName;
    });

    if (paramDef) {
      queryParams[paramDef.name] = value; // Use original (dotted) name for upstream
    } else {
      queryParams[inputName] = value;
    }
  }

  return { queryParams, body };
}

async function main() {
  const tools = loadToolDefinitions();
  console.error(`[edvibe-school-mcp] Loaded ${tools.length} tool definitions.`);

  if (!hasCredentials()) {
    console.error(
      "[edvibe-school-mcp] WARNING: EDVIBE_API_KEY and/or EDVIBE_SCHOOL_DOMAIN not set. " +
        "Tools will fail until credentials are provided."
    );
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    };
  });

  // Register tools/call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      const ctx = await getContext();
      const { queryParams, body } = mapInputsToUpstream(tool._meta, args);

      const response = await callUpstream(ctx, tool._meta.method, tool._meta.path, {
        queryParams,
        body: tool._meta.hasBody ? body : undefined,
        limiter,
      });

      // Return only the data field if present, otherwise the full response
      const output = response?.data !== undefined ? response.data : response;

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });

  // Start STDIO transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[edvibe-school-mcp] Server started on STDIO. ${tools.length} tools available.`);
}

main().catch((err) => {
  console.error("[edvibe-school-mcp] Fatal error:", err.message);
  process.exit(1);
});
