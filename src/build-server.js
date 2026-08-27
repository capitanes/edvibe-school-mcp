// Factory: build an MCP Server instance bound to a specific credential context.
//
// Used by both transports:
//   - STDIO: credContext is built once from env vars (EDVIBE_API_KEY / EDVIBE_SCHOOL_DOMAIN).
//   - HTTP:  a fresh credContext is built per request from request headers
//            (Authorization: Bearer <key>, X-Edvibe-School-Domain: <hostname>).
//
// Stateless by design: no global mutable key/domain. Each Server instance owns
// its own credContext and is torn down with the request (HTTP) or process (STDIO).

import { Server } from "@modelcontextprotocol/sdk/server";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadToolDefinitions } from "./tool-definitions.js";
import { callUpstream } from "./upstream.js";

const SERVER_NAME = "edvibe-school-mcp";
const SERVER_VERSION = "0.0.0-experimental";

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

    if (inputName.startsWith("body") && inputName.length > 4) {
      const bodyKey = inputName[4].toLowerCase() + inputName.slice(5);
      body[bodyKey] = value;
      continue;
    }

    const paramDef = toolMeta.parameters.find((p) => {
      if (!p.dotted) return p.name === inputName;
      return flattenDotted(p.name) === inputName;
    });

    if (paramDef) {
      queryParams[paramDef.name] = value;
    } else {
      queryParams[inputName] = value;
    }
  }

  return { queryParams, body };
}

/**
 * Build a fresh MCP Server bound to the given credential context.
 *
 * @param {{apiKey: string, schoolDomain: string}} credContext
 * @returns {Server}
 */
export function buildServer(credContext) {
  const tools = loadToolDefinitions();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
  }));

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
      const { queryParams, body } = mapInputsToUpstream(tool._meta, args);
      const response = await callUpstream(credContext, tool._meta.method, tool._meta.path, {
        queryParams,
        body: tool._meta.hasBody ? body : undefined,
      });

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

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
