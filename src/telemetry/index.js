/** Public core API for privacy-safe Edvibe MCP telemetry. */

export {
  DEFAULT_DASHBOARD_PASSWORD_CREDENTIAL_NAME,
  DEFAULT_HMAC_CREDENTIAL_NAME,
  DEFAULT_TELEMETRY_DATABASE_PATH,
  loadTelemetryConfig,
  readSystemdCredential,
} from "./config.js";

export {
  CLIENT_FAMILIES,
  isClientFamily,
  normalizeClientInfo,
} from "./client-info.js";

export {
  ERROR_CODES,
  ERROR_DEFINITIONS,
  SafeMcpError,
  classifySafeError,
  createSafeError,
  isSafeErrorCode,
  upstreamStatusToErrorCode,
} from "./errors.js";

export {
  canonicalizeSchoolDomain,
  createIdentityHasher,
  isTelemetryPseudonym,
  isUuidV4,
  parseClientInstallationId,
} from "./identity.js";

export {
  EVENT_OUTCOMES,
  EVENT_TYPES,
  MCP_METHODS,
  TOOL_RISKS,
  TRANSPORTS,
  createTelemetryEvent,
  serializeTelemetryEvent,
  validateTelemetryEvent,
} from "./schema.js";

export { BoundedAsyncQueue } from "./queue.js";
export { TelemetryWorkerStore, createTelemetryWorkerStore } from "./worker-store.js";
export { LATEST_TELEMETRY_SCHEMA_VERSION, applyTelemetryMigrations } from "./migrations.js";
export {
  normalizeTelemetryQuery,
  queryDashboard,
  queryEvents,
  queryScenarios,
} from "./queries.js";
export { TelemetryStore, createTelemetryStore } from "./store.js";
export {
  TelemetryService,
  createTelemetry,
  createTelemetryService,
} from "./service.js";
