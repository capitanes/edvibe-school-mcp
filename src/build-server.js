import { performance } from "node:perf_hooks";
import { Server } from "@modelcontextprotocol/sdk/server";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { classifySafeError, createSafeError } from "./telemetry/errors.js";
import { loadToolDefinitions } from "./tool-definitions.js";
import { callUpstream } from "./upstream.js";

const SERVER_NAME = "edvibe-school-mcp";
const SERVER_VERSION = "0.0.0-experimental";

function flattenDotted(name) {
  if (!name.includes(".")) return name;
  const parts = name.split(".");
  return parts[0].toLowerCase() + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

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
    const paramDef = toolMeta.parameters.find((parameter) =>
      parameter.dotted ? flattenDotted(parameter.name) === inputName : parameter.name === inputName,
    );
    queryParams[paramDef ? paramDef.name : inputName] = value;
  }
  return { queryParams, body };
}

function valueMatchesSchema(value, schema) {
  if (!schema || value === null || value === undefined) return true;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer") return Number.isInteger(value);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (schema.type === "array") return Array.isArray(value);
  if (schema.type === "object") return typeof value === "object" && !Array.isArray(value);
  return true;
}

function validateToolArguments(tool, args) {
  const value = args ?? {};
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const properties = tool.inputSchema?.properties || {};
  for (const field of tool.inputSchema?.required || []) {
    if (!(field in value) || value[field] === null || value[field] === undefined) return false;
  }
  return Object.entries(value).every(([field, fieldValue]) =>
    field in properties && valueMatchesSchema(fieldValue, properties[field]),
  );
}

function recordRejected(telemetry, context, errorCode, durationMs) {
  telemetry?.record("mcp_request_rejected", {
    ...context, mcpMethod: "tools/call", outcome: "rejected", errorCode, durationMs,
  });
}

function recordTool(telemetry, context, tool, outcome, errorCode, metrics, durationMs) {
  telemetry?.record("tool_call_completed", {
    ...context,
    mcpMethod: "tools/call",
    toolName: tool.name,
    toolGroup: tool._meta.group,
    toolRisk: tool._meta.riskClass,
    outcome,
    errorCode: errorCode ?? null,
    upstreamStatus: metrics.upstreamStatus ?? null,
    durationMs,
    upstreamDurationMs: metrics.upstreamDurationMs ?? null,
    limiterWaitMs: metrics.limiterWaitMs ?? null,
  });
}

export function buildServer(credContext, { telemetry = null, telemetryContext = null } = {}) {
  const tools = loadToolDefinitions();
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const started = performance.now();
    const { name, arguments: args } = request.params;
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      if (telemetryContext) recordRejected(telemetry, telemetryContext, "unknown_tool", performance.now() - started);
      return { content: [{ type: "text", text: `Error: ${createSafeError("unknown_tool").message}` }], isError: true };
    }
    if (!validateToolArguments(tool, args)) {
      if (telemetryContext) recordRejected(telemetry, telemetryContext, "invalid_arguments", performance.now() - started);
      return { content: [{ type: "text", text: `Error: ${createSafeError("invalid_arguments").message}` }], isError: true };
    }

    const metrics = {};
    try {
      const { queryParams, body } = mapInputsToUpstream(tool._meta, args);
      const response = await callUpstream(credContext, tool._meta.method, tool._meta.path, {
        queryParams, body: tool._meta.hasBody ? body : undefined, metrics,
      });
      if (telemetryContext) recordTool(telemetry, telemetryContext, tool, "success", null, metrics, performance.now() - started);
      const output = response?.data !== undefined ? response.data : response;
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], isError: false };
    } catch (error) {
      const safe = classifySafeError(error);
      if (telemetryContext) recordTool(telemetry, telemetryContext, tool, "error", safe.code, metrics, performance.now() - started);
      return { content: [{ type: "text", text: `Error: ${safe.publicMessage}` }], isError: true };
    }
  });
  return server;
}

export { SERVER_NAME, SERVER_VERSION, mapInputsToUpstream, validateToolArguments };
