import { randomUUID, timingSafeEqual } from "node:crypto";

import { loadTelemetryConfig } from "./config.js";
import { normalizeClientInfo } from "./client-info.js";
import {
  createIdentityHasher,
  isTelemetryPseudonym,
  parseClientInstallationId,
} from "./identity.js";
import { createTelemetryStore } from "./store.js";
import { createTelemetryWorkerStore } from "./worker-store.js";

const CLIENT_CACHE_MAX_ITEMS = 10_000;

/**
 * High-level privacy boundary used by the HTTP server and analytics routes.
 * It never retains raw domains, client UUIDs or arbitrary client names.
 */
export class TelemetryService {
  constructor({ config, store, identities = null } = {}) {
    this.config = config;
    this.store = store;
    this.identities = identities;
    this.enabled = config.enabled === true;
    this.dashboardEnabled = config.dashboardEnabled === true;
    this.clientInfo = new Map();
  }

  /**
   * Turn request-local raw identity inputs into safe pseudonyms, then discard
   * them. Invalid optional client IDs simply produce `installationId: null`.
   */
  createRequestContext({ requestId = randomUUID(), schoolDomain, clientIdHeader } = {}) {
    if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) {
      throw new TypeError("Invalid request id.");
    }
    if (!this.enabled || !this.identities) {
      return Object.freeze({
        requestId,
        transport: "streamable_http",
        tenantId: null,
        installationId: null,
      });
    }

    const tenantId = this.identities.tenant(schoolDomain);
    const parsedClientId = parseClientInstallationId(clientIdHeader);
    const installationId = parsedClientId
      ? this.identities.installation(parsedClientId, tenantId)
      : null;
    return Object.freeze({
      requestId,
      transport: "streamable_http",
      tenantId,
      installationId,
    });
  }

  /**
   * Normalize MCP clientInfo and remember only the finite family/safe version.
   * The next tool event for the installation inherits these values.
   */
  rememberClientInfo({ tenantId = null, installationId = null, clientInfo } = {}) {
    const normalized = normalizeClientInfo(clientInfo);
    if (!isTelemetryPseudonym(installationId, "i")) return normalized;
    if (tenantId !== null && !isTelemetryPseudonym(tenantId, "t")) return normalized;

    if (this.clientInfo.has(installationId)) this.clientInfo.delete(installationId);
    this.clientInfo.set(installationId, Object.freeze({
      tenantId,
      family: normalized.family,
      version: normalized.version,
    }));
    while (this.clientInfo.size > CLIENT_CACHE_MAX_ITEMS) {
      this.clientInfo.delete(this.clientInfo.keys().next().value);
    }
    return normalized;
  }

  /**
   * Strict, fail-open event recording. Unknown fields are rejected by the
   * store schema. Safe cached client metadata is filled for installation calls.
   */
  record(eventOrType, fields = undefined) {
    if (!this.enabled) return false;
    const type = typeof eventOrType === "string" ? eventOrType : eventOrType?.type;
    const source = typeof eventOrType === "string" ? fields : eventOrType;
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;

    const candidate = { ...source };
    delete candidate.type;
    const cached = candidate.installationId ? this.#getRememberedClient(candidate.installationId) : null;
    if (cached && (!cached.tenantId || cached.tenantId === candidate.tenantId)) {
      if (candidate.clientFamily === undefined) candidate.clientFamily = cached.family;
      if (candidate.clientVersion === undefined) candidate.clientVersion = cached.version;
    }
    if (type === "mcp_initialize_completed" && candidate.installationId && candidate.clientFamily) {
      this.#rememberNormalizedClient(candidate);
    }
    return this.store.record(type, candidate);
  }

  recordSafe(eventOrType, fields = undefined) {
    return this.record(eventOrType, fields);
  }

  getDashboard(query = {}) {
    return this.store.getDashboard(query);
  }

  getEvents(query = {}) {
    return this.store.getEvents(query);
  }

  getScenarios(query = {}) {
    return this.store.getScenarios(query);
  }

  getStatus() {
    return Object.freeze({
      enabled: this.enabled,
      dashboardEnabled: this.dashboardEnabled,
      ...this.store.getStatus(),
    });
  }

  async maintain() {
    return this.store.runMaintenance();
  }

  /** Constant-time verification for the fixed Basic Auth username. */
  verifyDashboardCredentials(username, password) {
    if (!this.dashboardEnabled || typeof password !== "string") return false;
    if (!constantTimeStringEqual(username, "analytics")) return false;
    return constantTimeStringEqual(password, this.config.dashboardPassword ?? "");
  }

  async close(options) {
    if (this.enabled) this.record("service_stopped", {});
    this.clientInfo.clear();
    return this.store.close(options);
  }

  #getRememberedClient(installationId) {
    const value = this.clientInfo.get(installationId) ?? null;
    if (value) {
      this.clientInfo.delete(installationId);
      this.clientInfo.set(installationId, value);
    }
    return value;
  }

  #rememberNormalizedClient(candidate) {
    if (!isTelemetryPseudonym(candidate.installationId, "i")) return;
    const family = candidate.clientFamily;
    const version = candidate.clientVersion ?? null;
    if (this.clientInfo.has(candidate.installationId)) this.clientInfo.delete(candidate.installationId);
    this.clientInfo.set(candidate.installationId, Object.freeze({
      tenantId: candidate.tenantId ?? null,
      family,
      version,
    }));
  }
}

/**
 * Load config, open fail-open storage, emit startup, and schedule maintenance.
 * The scheduler never blocks startup and uses unref'd timers.
 */
export function createTelemetryService(options = {}) {
  const config = options.config ?? loadTelemetryConfig(options.env ?? process.env, options.configOptions);
  const identities = config.enabled
    ? createIdentityHasher({ secret: config.hmacSecret, epoch: config.identityEpoch })
    : null;
  const storeOptions = {
    collectEnabled: config.enabled,
    storageRequired: config.storageRequired ?? (config.enabled || config.dashboardEnabled),
    databasePath: config.databasePath,
    backupDirectory: config.backupDirectory,
    detailRetentionDays: config.detailRetentionDays,
    aggregateRetentionDays: config.aggregateRetentionDays,
    backupCount: config.backupCount,
    busyTimeoutMs: config.busyTimeoutMs,
    queueMaxItems: config.queueMaxItems,
    batchSize: config.batchSize,
    flushIntervalMs: config.flushIntervalMs,
    stderrEnabled: config.stderrEnabled,
    stderr: options.stderr,
    now: options.now,
    Database: options.Database,
  };
  const useWorker = options.useWorker !== false && !options.Database && !options.now;
  const store = options.store ?? (
    storeOptions.storageRequired && useWorker
      ? createTelemetryWorkerStore(storeOptions)
      : createTelemetryStore(storeOptions)
  );
  const service = new TelemetryService({ config, store, identities });
  if (config.enabled) service.record("service_started", {});
  if ((config.storageRequired ?? (config.enabled || config.dashboardEnabled)) && options.autoMaintenance !== false) {
    store.startMaintenanceScheduler({
      initialDelayMs: config.maintenanceInitialDelayMs ?? 30_000,
      intervalMs: config.maintenanceIntervalMs ?? 86_400_000,
    });
  }
  return service;
}

/** Backwards-compatible concise factory name. */
export const createTelemetry = createTelemetryService;

function constantTimeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    // Perform one fixed comparison even when lengths differ.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
