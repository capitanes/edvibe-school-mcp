import { isClientFamily } from "./client-info.js";
import { isSafeErrorCode } from "./errors.js";
import { isTelemetryPseudonym } from "./identity.js";

export const EVENT_TYPES = Object.freeze([
  "service_started",
  "mcp_initialize_completed",
  "mcp_request_rejected",
  "tool_call_completed",
  "service_stopped",
  "telemetry_storage_degraded",
]);

export const EVENT_OUTCOMES = Object.freeze(["success", "error", "rejected", "cancelled"]);
export const TRANSPORTS = Object.freeze(["streamable_http"]);
export const TOOL_RISKS = Object.freeze(["read", "write", "high-risk", "sensitive"]);
export const MCP_METHODS = Object.freeze(["initialize", "tools/list", "tools/call", "ping", "other"]);

const COMMON_FIELDS = new Set([
  "occurredAt",
  "requestId",
  "transport",
  "tenantId",
  "installationId",
  "clientFamily",
  "clientVersion",
  "mcpMethod",
  "toolName",
  "toolGroup",
  "toolRisk",
  "outcome",
  "errorCode",
  "upstreamStatus",
  "durationMs",
  "upstreamDurationMs",
  "limiterWaitMs",
]);

const TYPE_FIELDS = Object.freeze({
  service_started: new Set(["occurredAt"]),
  mcp_initialize_completed: new Set([
    "occurredAt", "requestId", "transport", "tenantId", "installationId",
    "clientFamily", "clientVersion", "mcpMethod", "outcome", "durationMs",
  ]),
  mcp_request_rejected: new Set([
    "occurredAt", "requestId", "transport", "tenantId", "installationId",
    "clientFamily", "clientVersion", "mcpMethod", "outcome", "errorCode", "durationMs",
  ]),
  tool_call_completed: new Set(COMMON_FIELDS),
  service_stopped: new Set(["occurredAt"]),
  telemetry_storage_degraded: new Set(["occurredAt", "outcome", "errorCode"]),
});

/** Build and validate a strict event; arbitrary keys are rejected, not redacted. */
export function createTelemetryEvent(type, fields = {}, { now = () => new Date() } = {}) {
  if (!EVENT_TYPES.includes(type)) throw invalidEvent();
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw invalidEvent();
  const occurredAt = fields.occurredAt ?? now().toISOString();
  return validateTelemetryEvent({ ...fields, type, occurredAt });
}

/**
 * Validate an event and return a fresh frozen object containing only allowlist
 * keys. Error messages never echo rejected key names or values.
 */
export function validateTelemetryEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidEvent();
  const { type } = input;
  if (!EVENT_TYPES.includes(type)) throw invalidEvent();
  const allowed = TYPE_FIELDS[type];
  for (const key of Object.keys(input)) {
    if (key !== "type" && !allowed.has(key)) throw invalidEvent();
  }

  const event = { type, occurredAt: timestamp(input.occurredAt) };
  copyOptional(event, input, "requestId", requestId);
  copyOptional(event, input, "transport", enumValue(TRANSPORTS));
  copyOptional(event, input, "tenantId", (value) => pseudonym(value, "t"));
  copyOptional(event, input, "installationId", (value) => pseudonym(value, "i"));
  copyOptional(event, input, "clientFamily", (value) => isClientFamily(value) ? value : fail());
  copyNullable(event, input, "clientVersion", version);
  copyOptional(event, input, "mcpMethod", enumValue(MCP_METHODS));
  copyOptional(event, input, "toolName", identifier);
  copyOptional(event, input, "toolGroup", identifier);
  copyOptional(event, input, "toolRisk", enumValue(TOOL_RISKS));
  copyOptional(event, input, "outcome", enumValue(EVENT_OUTCOMES));
  copyNullable(event, input, "errorCode", (value) => isSafeErrorCode(value) ? value : fail());
  copyNullable(event, input, "upstreamStatus", httpStatus);
  copyNullable(event, input, "durationMs", duration);
  copyNullable(event, input, "upstreamDurationMs", duration);
  copyNullable(event, input, "limiterWaitMs", duration);

  assertRequiredFields(event);
  return Object.freeze(event);
}

/** Serialize only an already-validated event as a single journald-safe line. */
export function serializeTelemetryEvent(event) {
  return `${JSON.stringify(validateTelemetryEvent(event))}\n`;
}

function assertRequiredFields(event) {
  if (event.type === "service_started" || event.type === "service_stopped") return;
  if (event.type === "telemetry_storage_degraded") {
    if (event.outcome !== "error" || !event.errorCode?.startsWith("telemetry_")) throw invalidEvent();
    return;
  }

  if (!event.requestId || event.transport !== "streamable_http" || !event.outcome) throw invalidEvent();
  if (event.type === "mcp_initialize_completed") {
    if (event.mcpMethod !== "initialize" || event.outcome !== "success") throw invalidEvent();
  }
  if (event.type === "mcp_request_rejected") {
    if (event.outcome !== "rejected" || !event.errorCode) throw invalidEvent();
  }
  if (event.type === "tool_call_completed") {
    if (
      !event.tenantId ||
      event.mcpMethod !== "tools/call" ||
      !event.toolName ||
      !event.toolGroup ||
      !event.toolRisk ||
      event.durationMs === undefined
    ) throw invalidEvent();
    if (event.outcome === "success" && event.errorCode) throw invalidEvent();
    if (event.outcome !== "success" && !event.errorCode) throw invalidEvent();
  }
}

function copyOptional(target, source, key, validator) {
  if (source[key] !== undefined && source[key] !== null) target[key] = validator(source[key]);
}

function copyNullable(target, source, key, validator) {
  if (!(key in source) || source[key] === undefined) return;
  target[key] = source[key] === null ? null : validator(source[key]);
}

function timestamp(value) {
  if (typeof value !== "string" || value.length > 32) throw invalidEvent();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw invalidEvent();
  return value;
}

function requestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) throw invalidEvent();
  return value;
}

function pseudonym(value, prefix) {
  if (!isTelemetryPseudonym(value, prefix)) throw invalidEvent();
  return value;
}

function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value)) throw invalidEvent();
  return value;
}

function version(value) {
  if (typeof value !== "string" || !/^v?\d{1,4}(?:\.\d{1,4}){0,3}(?:[-+][0-9A-Za-z.-]{1,24})?$/.test(value)) {
    throw invalidEvent();
  }
  return value;
}

function httpStatus(value) {
  if (!Number.isInteger(value) || value < 100 || value > 599) throw invalidEvent();
  return value;
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) throw invalidEvent();
  return Math.round(value * 1_000) / 1_000;
}

function enumValue(values) {
  return (value) => values.includes(value) ? value : fail();
}

function fail() {
  throw invalidEvent();
}

function invalidEvent() {
  const error = new TypeError("Telemetry event does not match the safe schema.");
  error.code = "telemetry_invalid_event";
  return error;
}
