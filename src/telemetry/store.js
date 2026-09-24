import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { BoundedAsyncQueue } from "./queue.js";
import { applyTelemetryMigrations } from "./migrations.js";
import { createSafeError } from "./errors.js";
import { createTelemetryEvent, serializeTelemetryEvent, validateTelemetryEvent } from "./schema.js";
import {
  queryDashboard as runDashboardQuery,
  queryEvents as runEventsQuery,
  queryScenarios as runScenariosQuery,
} from "./queries.js";

const STORAGE_DEGRADED_COOLDOWN_MS = 60_000;

/**
 * SQLite-backed, fail-open telemetry store.
 *
 * `record` validates and journals synchronously, then only enqueues the safe
 * object. SQLite work runs later in bounded batches and cannot change an MCP
 * response when storage is slow or unavailable.
 */
export class TelemetryStore {
  constructor(options = {}) {
    this.collectEnabled = options.collectEnabled ?? options.enabled ?? true;
    this.storageRequired = options.storageRequired ?? this.collectEnabled;
    this.databasePath = options.databasePath;
    this.backupDirectory = options.backupDirectory ?? (
      this.databasePath ? path.join(path.dirname(this.databasePath), "backups") : null
    );
    this.detailRetentionDays = options.detailRetentionDays ?? 90;
    this.aggregateRetentionDays = options.aggregateRetentionDays ?? 365;
    this.backupCount = options.backupCount ?? 7;
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    this.queueOptions = {
      maxItems: options.queueMaxItems ?? 10_000,
      batchSize: options.batchSize ?? 100,
      flushIntervalMs: options.flushIntervalMs ?? 250,
    };
    this.stderrEnabled = options.stderrEnabled ?? true;
    this.stderr = options.stderr ?? process.stderr;
    this.now = options.now ?? (() => new Date());
    this.Database = options.Database ?? Database;

    this.database = null;
    this.queue = null;
    this.statements = null;
    this.opened = false;
    this.closed = false;
    this.state = this.storageRequired ? "initializing" : "disabled";
    this.lastErrorCode = null;
    this.lastWriteAt = null;
    this.lastEventAt = null;
    this.lastMaintenanceAt = null;
    this.maintenanceTimer = null;
    this.maintenancePromise = null;
    this.lastDegradedJournalAt = 0;
    this.counters = {
      invalidEvents: 0,
      droppedQueueFull: 0,
      droppedQueueClosed: 0,
      droppedWriteFailure: 0,
      droppedDatabaseUnavailable: 0,
      journaldFailures: 0,
    };
  }

  /** Open/migrate storage. Failure degrades telemetry instead of throwing. */
  open() {
    if (this.opened || this.closed) return this;
    this.opened = true;
    if (!this.storageRequired) return this;

    try {
      if (typeof this.databasePath !== "string" || !path.isAbsolute(this.databasePath)) {
        throw new Error("Telemetry database path is invalid.");
      }
      ensurePrivateDirectory(path.dirname(this.databasePath));
      this.database = new this.Database(this.databasePath);
      fs.chmodSync(this.databasePath, 0o600);
      this.database.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("auto_vacuum = INCREMENTAL");
      this.database.pragma("secure_delete = FAST");
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = NORMAL");
      applyTelemetryMigrations(this.database, { now: this.now });
      this.#prepareStatements();
      this.#restoreCounters();
      this.lastEventAt = this.database.prepare(
        "SELECT MAX(occurred_at) AS last_event_at FROM telemetry_events",
      ).get()?.last_event_at ?? null;

      if (this.collectEnabled) {
        this.queue = new BoundedAsyncQueue({
          ...this.queueOptions,
          processBatch: (batch) => this.#writeBatch(batch),
          onDrop: ({ reason, count }) => this.#handleQueueDrop(reason, count),
          onFailure: ({ count }) => this.#markDegraded("telemetry_write_failed", count),
        });
      }
      this.state = "ready";
    } catch {
      this.#closeDatabaseSilently();
      this.state = "degraded";
      this.#markDegraded("telemetry_database_unavailable", 1);
    }
    return this;
  }

  /**
   * Validate, write the same allow-list event to stderr, and enqueue it.
   * Supports `record(type, fields)` or `record({type, ...safeFields})`.
   * Never throws and never serializes a rejected object.
   */
  record(eventOrType, fields = undefined) {
    if (!this.collectEnabled || this.closed) return false;
    let event;
    try {
      event = typeof eventOrType === "string"
        ? createTelemetryEvent(eventOrType, fields ?? {}, { now: this.now })
        : validateTelemetryEvent(eventOrType);
    } catch {
      this.counters.invalidEvents += 1;
      this.lastErrorCode = "telemetry_invalid_event";
      return false;
    }

    this.#writeJournal(event);
    if (!this.queue || !this.database) {
      this.#markDegraded("telemetry_database_unavailable", 1);
      return false;
    }
    return this.queue.enqueue(event);
  }

  /** Explicit alias used by runtime integration to emphasize fail-open writes. */
  recordSafe(eventOrType, fields = undefined) {
    return this.record(eventOrType, fields);
  }

  /** Persist safe drop counters reported by the main-thread worker proxy. */
  recordExternalDrop(reason, count = 1) {
    if (!Number.isSafeInteger(count) || count < 1) return false;
    if (reason === "invalid") {
      this.counters.invalidEvents += count;
    } else if (reason === "full") {
      this.counters.droppedQueueFull += count;
      this.#markDegraded("telemetry_queue_full", 0);
    } else if (reason === "closed") {
      this.counters.droppedQueueClosed += count;
      this.#markDegraded("telemetry_queue_closed", 0);
    } else if (reason === "processing_failed") {
      this.counters.droppedWriteFailure += count;
      this.#markDegraded("telemetry_write_failed", 0);
    } else {
      return false;
    }
    this.#persistCounters();
    return true;
  }

  /** Safe dashboard aggregate query. */
  getDashboard(query = {}) {
    this.#requireDatabase();
    return runDashboardQuery(this.database, query, { now: this.now });
  }

  /** Safe paginated event query. */
  getEvents(query = {}) {
    this.#requireDatabase();
    return runEventsQuery(this.database, query, { now: this.now });
  }

  /** Safe estimated scenario query. */
  getScenarios(query = {}) {
    this.#requireDatabase();
    return runScenariosQuery(this.database, query, { now: this.now });
  }

  /** Flush pending writes, rebuild completed aggregates, retain and back up. */
  async runMaintenance() {
    if (!this.database || this.closed) return false;
    if (this.maintenancePromise) return this.maintenancePromise;
    this.maintenancePromise = this.#performMaintenance()
      .catch(() => {
        this.#markDegraded("telemetry_maintenance_failed", 0);
        return false;
      })
      .finally(() => {
        this.maintenancePromise = null;
      });
    return this.maintenancePromise;
  }

  /** Alias matching the high-level service API. */
  async maintain() {
    return this.runMaintenance();
  }

  /**
   * Schedule recurring maintenance. First run defaults to 30 seconds after
   * startup; subsequent runs default to every 24 hours. Timers are unref'd.
   */
  startMaintenanceScheduler({ initialDelayMs = 30_000, intervalMs = 86_400_000 } = {}) {
    if (!this.database || this.closed || this.maintenanceTimer) return false;
    const schedule = (delay) => {
      this.maintenanceTimer = setTimeout(async () => {
        this.maintenanceTimer = null;
        await this.runMaintenance();
        if (!this.closed && this.database) schedule(intervalMs);
      }, delay);
      this.maintenanceTimer.unref?.();
    };
    schedule(initialDelayMs);
    return true;
  }

  /** Safe storage/queue health with no paths, credentials, SQL or exceptions. */
  getStatus() {
    const queue = this.queue?.getStats() ?? null;
    const dropped =
      this.counters.invalidEvents +
      this.counters.droppedQueueFull +
      this.counters.droppedQueueClosed +
      this.counters.droppedWriteFailure +
      this.counters.droppedDatabaseUnavailable;
    return Object.freeze({
      enabled: this.collectEnabled,
      state: this.state,
      storageAvailable: Boolean(this.database),
      lastErrorCode: this.lastErrorCode,
      lastWriteAt: this.lastWriteAt,
      lastEventAt: this.lastEventAt,
      lastMaintenanceAt: this.lastMaintenanceAt,
      dbSizeBytes: this.database ? databaseSizeBytes(this.databasePath) : 0,
      droppedEvents: dropped,
      counters: Object.freeze({ ...this.counters }),
      queue,
    });
  }

  /** Flush, stop maintenance and close SQLite. */
  async close({ drain = true, timeoutMs = 10_000 } = {}) {
    if (this.closed) return true;
    this.closed = true;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
    const drained = this.queue ? await this.queue.close({ drain, timeoutMs }) : true;
    if (this.maintenancePromise) await this.maintenancePromise;
    this.#persistCounters();
    this.#closeDatabaseSilently();
    this.state = "closed";
    return drained;
  }

  #prepareStatements() {
    this.statements = {
      insertEvent: this.database.prepare(`
        INSERT INTO telemetry_events (
          occurred_at, occurred_at_ms, event_type, request_id, transport, tenant_id,
          installation_id, client_family, client_version, mcp_method,
          tool_name, tool_group, tool_risk, outcome, error_code, upstream_status,
          duration_ms, upstream_duration_ms, limiter_wait_ms
        ) VALUES (
          @occurredAt, @occurredAtMs, @eventType, @requestId, @transport, @tenantId,
          @installationId, @clientFamily, @clientVersion, @mcpMethod,
          @toolName, @toolGroup, @toolRisk, @outcome, @errorCode, @upstreamStatus,
          @durationMs, @upstreamDurationMs, @limiterWaitMs
        )
      `),
      upsertInstallation: this.database.prepare(`
        INSERT INTO telemetry_installations (
          installation_id, tenant_id, first_seen_at, last_seen_at, client_family,
          client_version, initialize_count, tool_call_count,
          successful_tool_call_count, last_tool_at
        ) VALUES (
          @installationId, @tenantId, @occurredAt, @occurredAt, @clientFamily,
          @clientVersion, @initializeCount, @toolCallCount,
          @successfulToolCallCount, @lastToolAt
        )
        ON CONFLICT(installation_id) DO UPDATE SET
          last_seen_at = MAX(telemetry_installations.last_seen_at, excluded.last_seen_at),
          client_family = COALESCE(excluded.client_family, telemetry_installations.client_family),
          client_version = COALESCE(excluded.client_version, telemetry_installations.client_version),
          initialize_count = telemetry_installations.initialize_count + excluded.initialize_count,
          tool_call_count = telemetry_installations.tool_call_count + excluded.tool_call_count,
          successful_tool_call_count = telemetry_installations.successful_tool_call_count + excluded.successful_tool_call_count,
          last_tool_at = CASE
            WHEN excluded.last_tool_at IS NULL THEN telemetry_installations.last_tool_at
            ELSE MAX(COALESCE(telemetry_installations.last_tool_at, excluded.last_tool_at), excluded.last_tool_at)
          END
      `),
      upsertHourly: this.database.prepare(aggregateUpsertSql("telemetry_hourly", "hour_utc", "hourUtc")),
      upsertDaily: this.database.prepare(aggregateUpsertSql("telemetry_daily", "day_utc", "dayUtc")),
      upsertMeta: this.database.prepare(`
        INSERT INTO telemetry_meta(key, value, updated_at) VALUES (@key, @value, @updatedAt)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `),
      getMeta: this.database.prepare("SELECT value FROM telemetry_meta WHERE key = ?"),
    };

    this.writeTransaction = this.database.transaction((events) => {
      for (const event of events) this.#insertEvent(event);
      this.statements.upsertMeta.run({
        key: "drop_counters",
        value: JSON.stringify(this.counters),
        updatedAt: this.now().toISOString(),
      });
    });
  }

  #writeBatch(events) {
    if (!this.database || !this.writeTransaction) throw new Error("Telemetry database unavailable.");
    this.writeTransaction(events);
    this.lastWriteAt = this.now().toISOString();
    for (const event of events) {
      if (!this.lastEventAt || event.occurredAt > this.lastEventAt) this.lastEventAt = event.occurredAt;
    }
    if (this.state === "degraded") this.state = "ready";
  }

  #restoreCounters() {
    try {
      const raw = this.statements.getMeta.get("drop_counters")?.value;
      const saved = raw ? JSON.parse(raw) : null;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
      for (const key of Object.keys(this.counters)) {
        const value = saved[key];
        if (Number.isSafeInteger(value) && value >= 0) this.counters[key] = value;
      }
    } catch {
      // Corrupt operational counters must never make telemetry unavailable.
    }
  }

  #persistCounters() {
    if (!this.database || !this.statements || this.database.open === false) return;
    try {
      this.statements.upsertMeta.run({
        key: "drop_counters",
        value: JSON.stringify(this.counters),
        updatedAt: this.now().toISOString(),
      });
    } catch {
      // Counter persistence is diagnostic and remains fail-open.
    }
  }

  #insertEvent(event) {
    const row = eventRow(event);
    this.statements.insertEvent.run(row);

    const aggregate = aggregateRow(event);
    this.statements.upsertHourly.run(aggregate);
    this.statements.upsertDaily.run(aggregate);

    if (event.installationId && event.tenantId) {
      const isInitialize = event.type === "mcp_initialize_completed";
      const isTool = event.type === "tool_call_completed";
      this.statements.upsertInstallation.run({
        installationId: event.installationId,
        tenantId: event.tenantId,
        occurredAt: event.occurredAt,
        clientFamily: event.clientFamily ?? null,
        clientVersion: event.clientVersion ?? null,
        initializeCount: isInitialize ? 1 : 0,
        toolCallCount: isTool ? 1 : 0,
        successfulToolCallCount: isTool && event.outcome === "success" ? 1 : 0,
        lastToolAt: isTool ? event.occurredAt : null,
      });
    }
  }

  async #performMaintenance() {
    if (this.queue) await this.queue.flush({ timeoutMs: 30_000 });
    if (!this.database || this.closed) return false;

    const current = this.now();
    const currentDay = startOfUtcDay(current);
    const detailCutoff = new Date(current.getTime() - this.detailRetentionDays * 86_400_000);
    const aggregateCutoff = new Date(current.getTime() - this.aggregateRetentionDays * 86_400_000);
    const rebuildFrom = startOfUtcDay(detailCutoff);

    const maintainTransaction = this.database.transaction(() => {
      this.database.prepare(
        "DELETE FROM telemetry_hourly WHERE hour_utc >= ? AND hour_utc < ?",
      ).run(rebuildFrom.toISOString(), currentDay.toISOString());
      this.database.prepare(
        "DELETE FROM telemetry_daily WHERE day_utc >= ? AND day_utc < ?",
      ).run(dayKey(rebuildFrom), dayKey(currentDay));

      rebuildAggregates(
        this.database,
        "telemetry_hourly",
        "hour_utc",
        "substr(occurred_at, 1, 13) || ':00:00.000Z'",
        rebuildFrom.toISOString(),
        currentDay.toISOString(),
      );
      rebuildAggregates(
        this.database,
        "telemetry_daily",
        "day_utc",
        "substr(occurred_at, 1, 10)",
        rebuildFrom.toISOString(),
        currentDay.toISOString(),
      );
      rebuildDailySummary(
        this.database,
        rebuildFrom.toISOString(),
        currentDay.toISOString(),
      );

      this.database.prepare("DELETE FROM telemetry_events WHERE occurred_at_ms < ?").run(detailCutoff.getTime());
      this.database.prepare("DELETE FROM telemetry_hourly WHERE hour_utc < ?").run(hourKey(aggregateCutoff));
      this.database.prepare("DELETE FROM telemetry_daily WHERE day_utc < ?").run(dayKey(aggregateCutoff));
      this.database.prepare("DELETE FROM telemetry_daily_summary WHERE day_utc < ?").run(dayKey(aggregateCutoff));
      this.database.prepare("DELETE FROM telemetry_installations WHERE last_seen_at < ?").run(detailCutoff.toISOString());
      this.statements.upsertMeta.run({
        key: "last_maintenance_at",
        value: current.toISOString(),
        updatedAt: current.toISOString(),
      });
    });
    maintainTransaction();
    this.database.pragma("incremental_vacuum(2000)");
    await this.#createDailyBackup(current, detailCutoff, aggregateCutoff);
    this.lastMaintenanceAt = current.toISOString();
    return true;
  }

  async #createDailyBackup(current, detailCutoff, aggregateCutoff) {
    if (!this.backupDirectory) return;
    const today = dayKey(current);
    const previous = this.statements.getMeta.get("last_backup_day")?.value;
    if (previous === today) return;

    ensurePrivateDirectory(this.backupDirectory);
    const target = path.join(this.backupDirectory, `telemetry-${today}.sqlite`);
    this.database.pragma("wal_checkpoint(PASSIVE)");
    await this.database.backup(target);
    fs.chmodSync(target, 0o600);

    const backups = fs.readdirSync(this.backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^telemetry-\d{4}-\d{2}-\d{2}\.sqlite$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const obsolete of backups.slice(this.backupCount)) {
      fs.unlinkSync(path.join(this.backupDirectory, obsolete));
    }
    for (const retained of backups.slice(0, this.backupCount)) {
      const retainedPath = path.join(this.backupDirectory, retained);
      if (retainedPath !== target) {
        this.#pruneBackupRetention(retainedPath, detailCutoff, aggregateCutoff);
      }
    }
    const timestamp = this.now().toISOString();
    this.statements.upsertMeta.run({ key: "last_backup_day", value: today, updatedAt: timestamp });
  }

  #pruneBackupRetention(backupPath, detailCutoff, aggregateCutoff) {
    let backup = null;
    try {
      backup = new this.Database(backupPath);
      backup.pragma("journal_mode = DELETE");
      backup.pragma("secure_delete = FAST");
      const prune = backup.transaction(() => {
        backup.prepare("DELETE FROM telemetry_events WHERE occurred_at_ms < ?").run(detailCutoff.getTime());
        backup.prepare("DELETE FROM telemetry_installations WHERE last_seen_at < ?").run(detailCutoff.toISOString());
        backup.prepare("DELETE FROM telemetry_hourly WHERE hour_utc < ?").run(hourKey(aggregateCutoff));
        backup.prepare("DELETE FROM telemetry_daily WHERE day_utc < ?").run(dayKey(aggregateCutoff));
        const hasSummary = backup.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_daily_summary'",
        ).get();
        if (hasSummary) {
          backup.prepare("DELETE FROM telemetry_daily_summary WHERE day_utc < ?").run(dayKey(aggregateCutoff));
        }
      });
      prune();
      backup.pragma("incremental_vacuum(2000)");
      fs.chmodSync(backupPath, 0o600);
    } catch {
      // A damaged legacy backup must not make live telemetry unavailable.
    } finally {
      try {
        backup?.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  #handleQueueDrop(reason, count) {
    if (reason === "full") {
      this.counters.droppedQueueFull += count;
      this.#markDegraded("telemetry_queue_full", 0);
    } else {
      this.counters.droppedQueueClosed += count;
      this.#markDegraded("telemetry_queue_closed", 0);
    }
  }

  #markDegraded(code, droppedCount) {
    if (code === "telemetry_write_failed") this.counters.droppedWriteFailure += droppedCount;
    if (code === "telemetry_database_unavailable") this.counters.droppedDatabaseUnavailable += droppedCount;
    this.lastErrorCode = code;
    if (this.state !== "closed" && this.state !== "disabled") this.state = "degraded";

    const nowMs = this.now().getTime();
    if (nowMs - this.lastDegradedJournalAt < STORAGE_DEGRADED_COOLDOWN_MS) return;
    this.lastDegradedJournalAt = nowMs;
    try {
      const event = createTelemetryEvent("telemetry_storage_degraded", {
        outcome: "error",
        errorCode: code,
      }, { now: this.now });
      this.#writeJournal(event);
    } catch {
      // A fixed internally-created event should validate; stay fail-open if not.
    }
  }

  #writeJournal(event) {
    if (!this.stderrEnabled || !this.stderr || typeof this.stderr.write !== "function") return;
    try {
      this.stderr.write(serializeTelemetryEvent(event));
    } catch {
      this.counters.journaldFailures += 1;
    }
  }

  #requireDatabase() {
    if (!this.database || this.closed) throw createSafeError("telemetry_database_unavailable");
  }

  #closeDatabaseSilently() {
    try {
      this.database?.close();
    } catch {
      // Closing diagnostics must remain fail-open and contain no raw error.
    }
    this.database = null;
    this.statements = null;
    this.writeTransaction = null;
  }
}

/** Create and open a store from explicit safe configuration. */
export function createTelemetryStore(options = {}) {
  return new TelemetryStore(options).open();
}

function eventRow(event) {
  return {
    occurredAt: event.occurredAt,
    occurredAtMs: new Date(event.occurredAt).getTime(),
    eventType: event.type,
    requestId: event.requestId ?? null,
    transport: event.transport ?? null,
    tenantId: event.tenantId ?? null,
    installationId: event.installationId ?? null,
    clientFamily: event.clientFamily ?? null,
    clientVersion: event.clientVersion ?? null,
    mcpMethod: event.mcpMethod ?? null,
    toolName: event.toolName ?? null,
    toolGroup: event.toolGroup ?? null,
    toolRisk: event.toolRisk ?? null,
    outcome: event.outcome ?? null,
    errorCode: event.errorCode ?? null,
    upstreamStatus: event.upstreamStatus ?? null,
    durationMs: event.durationMs ?? null,
    upstreamDurationMs: event.upstreamDurationMs ?? null,
    limiterWaitMs: event.limiterWaitMs ?? null,
  };
}

function aggregateRow(event) {
  const duration = event.durationMs ?? null;
  const upstreamDuration = event.upstreamDurationMs ?? null;
  const limiterWait = event.limiterWaitMs ?? null;
  return {
    hourUtc: `${event.occurredAt.slice(0, 13)}:00:00.000Z`,
    dayUtc: event.occurredAt.slice(0, 10),
    eventType: event.type,
    // Aggregate tables never persist even pseudonymous tenant/installation IDs.
    tenantId: "",
    installationId: "",
    clientFamily: event.clientFamily ?? "",
    clientVersion: event.clientVersion ?? "",
    mcpMethod: event.mcpMethod ?? "",
    toolName: event.toolName ?? "",
    toolGroup: event.toolGroup ?? "",
    toolRisk: event.toolRisk ?? "",
    outcome: event.outcome ?? "",
    errorCode: event.errorCode ?? "",
    upstreamStatus: event.upstreamStatus ?? 0,
    eventCount: 1,
    durationSum: duration ?? 0,
    durationCount: duration === null ? 0 : 1,
    upstreamDurationSum: upstreamDuration ?? 0,
    upstreamDurationCount: upstreamDuration === null ? 0 : 1,
    limiterWaitSum: limiterWait ?? 0,
    limiterWaitCount: limiterWait === null ? 0 : 1,
  };
}

function aggregateUpsertSql(table, bucketColumn, bucketParameter) {
  return `
    INSERT INTO ${table} (
      ${bucketColumn}, event_type, tenant_id, installation_id, client_family,
      client_version, mcp_method, tool_name, tool_group, tool_risk, outcome,
      error_code, upstream_status, event_count, duration_sum, duration_count,
      upstream_duration_sum, upstream_duration_count, limiter_wait_sum,
      limiter_wait_count
    ) VALUES (
      @${bucketParameter}, @eventType, @tenantId, @installationId, @clientFamily,
      @clientVersion, @mcpMethod, @toolName, @toolGroup, @toolRisk, @outcome,
      @errorCode, @upstreamStatus, @eventCount, @durationSum, @durationCount,
      @upstreamDurationSum, @upstreamDurationCount, @limiterWaitSum,
      @limiterWaitCount
    )
    ON CONFLICT DO UPDATE SET
      event_count = event_count + excluded.event_count,
      duration_sum = duration_sum + excluded.duration_sum,
      duration_count = duration_count + excluded.duration_count,
      upstream_duration_sum = upstream_duration_sum + excluded.upstream_duration_sum,
      upstream_duration_count = upstream_duration_count + excluded.upstream_duration_count,
      limiter_wait_sum = limiter_wait_sum + excluded.limiter_wait_sum,
      limiter_wait_count = limiter_wait_count + excluded.limiter_wait_count
  `;
}

function rebuildAggregates(database, table, bucketColumn, bucketExpression, from, to) {
  database.prepare(`
    INSERT INTO ${table} (
      ${bucketColumn}, event_type, tenant_id, installation_id, client_family,
      client_version, mcp_method, tool_name, tool_group, tool_risk, outcome,
      error_code, upstream_status, event_count, duration_sum, duration_count,
      upstream_duration_sum, upstream_duration_count, limiter_wait_sum,
      limiter_wait_count
    )
    SELECT
      ${bucketExpression}, event_type, '', '',
      COALESCE(client_family, ''), COALESCE(client_version, ''), COALESCE(mcp_method, ''),
      COALESCE(tool_name, ''), COALESCE(tool_group, ''), COALESCE(tool_risk, ''),
      COALESCE(outcome, ''), COALESCE(error_code, ''), COALESCE(upstream_status, 0),
      COUNT(*), COALESCE(SUM(duration_ms), 0), COUNT(duration_ms),
      COALESCE(SUM(upstream_duration_ms), 0), COUNT(upstream_duration_ms),
      COALESCE(SUM(limiter_wait_ms), 0), COUNT(limiter_wait_ms)
    FROM telemetry_events
    WHERE occurred_at >= ? AND occurred_at < ?
    GROUP BY
      ${bucketExpression}, event_type, client_family,
      client_version, mcp_method, tool_name, tool_group, tool_risk, outcome,
      error_code, upstream_status
  `).run(from, to);
}

function rebuildDailySummary(database, from, to) {
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);
  database.prepare(
    "DELETE FROM telemetry_daily_summary WHERE day_utc >= ? AND day_utc < ?",
  ).run(fromDay, toDay);
  database.prepare(`
    INSERT INTO telemetry_daily_summary (
      day_utc, initializations, tool_calls, successful_tool_calls,
      failed_tool_calls, identified_tool_calls, active_tenants,
      active_installations, duration_sum, duration_count,
      upstream_duration_sum, upstream_duration_count, limiter_wait_sum,
      limiter_wait_count
    )
    SELECT
      substr(occurred_at, 1, 10),
      SUM(CASE WHEN event_type = 'mcp_initialize_completed' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event_type = 'tool_call_completed' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event_type = 'tool_call_completed' AND outcome != 'success' THEN 1 ELSE 0 END),
      SUM(CASE WHEN event_type = 'tool_call_completed' AND installation_id IS NOT NULL THEN 1 ELSE 0 END),
      COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN tenant_id END),
      COUNT(DISTINCT CASE WHEN event_type = 'tool_call_completed' AND outcome = 'success' THEN installation_id END),
      COALESCE(SUM(CASE WHEN event_type = 'tool_call_completed' THEN duration_ms END), 0),
      COUNT(CASE WHEN event_type = 'tool_call_completed' THEN duration_ms END),
      COALESCE(SUM(CASE WHEN event_type = 'tool_call_completed' THEN upstream_duration_ms END), 0),
      COUNT(CASE WHEN event_type = 'tool_call_completed' THEN upstream_duration_ms END),
      COALESCE(SUM(CASE WHEN event_type = 'tool_call_completed' THEN limiter_wait_ms END), 0),
      COUNT(CASE WHEN event_type = 'tool_call_completed' THEN limiter_wait_ms END)
    FROM telemetry_events
    WHERE occurred_at >= ? AND occurred_at < ?
    GROUP BY substr(occurred_at, 1, 10)
  `).run(from, to);
}

function ensurePrivateDirectory(directory) {
  const existed = fs.existsSync(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existed) fs.chmodSync(directory, 0o700);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error("Telemetry directory permissions must be 0700.");
  }
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function hourKey(date) {
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

function databaseSizeBytes(databasePath) {
  let total = 0;
  for (const candidate of [databasePath, `${databasePath}-wal`]) {
    try {
      total += fs.statSync(candidate).size;
    } catch {
      // Missing/rotating WAL files are normal.
    }
  }
  return total;
}
