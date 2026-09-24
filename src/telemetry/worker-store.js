import { Worker } from "node:worker_threads";

import { BoundedAsyncQueue } from "./queue.js";
import { createTelemetryEvent, validateTelemetryEvent } from "./schema.js";

const RPC_TIMEOUT_MS = 30_000;

/**
 * Production storage proxy. Event validation and enqueueing stay cheap on the
 * HTTP thread; every SQLite operation and journald write runs in a worker.
 */
export class TelemetryWorkerStore {
  constructor(options = {}) {
    this.collectEnabled = options.collectEnabled ?? options.enabled ?? true;
    this.storageRequired = options.storageRequired ?? this.collectEnabled;
    this.now = options.now ?? (() => new Date());
    this.closed = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.pendingDropCount = 0;
    this.maintenanceTimer = null;
    this.status = Object.freeze({
      enabled: this.collectEnabled,
      state: this.storageRequired ? "initializing" : "disabled",
      storageAvailable: false,
      lastErrorCode: null,
      lastWriteAt: null,
      lastEventAt: null,
      lastMaintenanceAt: null,
      dbSizeBytes: 0,
      droppedEvents: 0,
      counters: Object.freeze({}),
      queue: null,
    });

    this.worker = this.storageRequired
      ? new Worker(new URL("./store-worker.js", import.meta.url), {
          workerData: serializableOptions(options),
        })
      : null;
    if (this.worker) {
      this.worker.on("message", (message) => this.#handleMessage(message));
      this.worker.on("error", () => this.#handleWorkerFailure());
      this.worker.on("exit", (code) => {
        if (!this.closed && code !== 0) this.#handleWorkerFailure();
      });
    }

    this.queue = this.collectEnabled && this.worker
      ? new BoundedAsyncQueue({
          maxItems: options.queueMaxItems ?? 10_000,
          batchSize: options.batchSize ?? 100,
          flushIntervalMs: options.flushIntervalMs ?? 250,
          processBatch: async (events) => {
            const response = await this.#request("write_batch", { events });
            this.#updateStatus(response.status);
          },
          onDrop: ({ reason, count }) => this.#noteDrop(reason, count),
          onFailure: ({ count }) => this.#noteDrop("processing_failed", count),
        })
      : null;
  }

  record(eventOrType, fields = undefined) {
    if (!this.collectEnabled || this.closed || !this.queue) return false;
    let event;
    try {
      event = typeof eventOrType === "string"
        ? createTelemetryEvent(eventOrType, fields ?? {}, { now: this.now })
        : validateTelemetryEvent(eventOrType);
    } catch {
      this.#noteDrop("invalid", 1);
      return false;
    }
    return this.queue.enqueue(event);
  }

  recordSafe(eventOrType, fields = undefined) {
    return this.record(eventOrType, fields);
  }

  async getDashboard(query = {}) {
    const response = await this.#request("dashboard", { query });
    this.#updateStatus(response.status);
    return response.result;
  }

  async getEvents(query = {}) {
    const response = await this.#request("events", { query });
    this.#updateStatus(response.status);
    return response.result;
  }

  async getScenarios(query = {}) {
    const response = await this.#request("scenarios", { query });
    this.#updateStatus(response.status);
    return response.result;
  }

  async runMaintenance() {
    if (!this.worker || this.closed) return false;
    if (this.queue) await this.queue.flush({ timeoutMs: RPC_TIMEOUT_MS });
    const response = await this.#request("maintenance", {});
    this.#updateStatus(response.status);
    return response.result === true;
  }

  async maintain() {
    return this.runMaintenance();
  }

  startMaintenanceScheduler({ initialDelayMs = 30_000, intervalMs = 86_400_000 } = {}) {
    if (!this.worker || this.closed || this.maintenanceTimer) return false;
    const schedule = (delay) => {
      this.maintenanceTimer = setTimeout(async () => {
        this.maintenanceTimer = null;
        try {
          await this.runMaintenance();
        } catch {
          // Worker failures are reflected in status and remain fail-open.
        }
        if (!this.closed && this.worker) schedule(intervalMs);
      }, delay);
      this.maintenanceTimer.unref?.();
    };
    schedule(initialDelayMs);
    return true;
  }

  getStatus() {
    const workerDropped = Number(this.status.droppedEvents || 0);
    return Object.freeze({
      ...this.status,
      droppedEvents: workerDropped + this.pendingDropCount,
      queue: this.queue?.getStats() ?? null,
    });
  }

  async close({ drain = true, timeoutMs = 10_000 } = {}) {
    if (this.closed) return true;
    if (this.maintenanceTimer) clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
    const drained = this.queue ? await this.queue.close({ drain, timeoutMs }) : true;
    if (this.worker) {
      try {
        const response = await this.#request("close", { drain, timeoutMs }, timeoutMs + 1_000);
        this.#updateStatus(response.status);
      } catch {
        // Termination below is the bounded fallback.
      }
      this.closed = true;
      await this.worker.terminate().catch(() => {});
      this.worker = null;
    } else {
      this.closed = true;
    }
    this.status = Object.freeze({ ...this.status, state: "closed", storageAvailable: false });
    this.#rejectPending();
    return drained;
  }

  #request(command, payload, timeoutMs = RPC_TIMEOUT_MS) {
    if (!this.worker || this.closed) return Promise.reject(fixedWorkerError());
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.#markDegraded();
        reject(fixedWorkerError());
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, command, payload });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        this.#markDegraded();
        reject(fixedWorkerError());
      }
    });
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      this.#updateStatus(message.status);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(message.id);
    if (message.ok === true) request.resolve(message.payload ?? {});
    else {
      this.#markDegraded(message.status);
      request.reject(fixedWorkerError());
    }
  }

  #handleWorkerFailure() {
    this.#markDegraded();
    this.#rejectPending();
  }

  #markDegraded(status = null) {
    if (status) this.#updateStatus(status);
    this.status = Object.freeze({
      ...this.status,
      state: "degraded",
      storageAvailable: false,
      lastErrorCode: "telemetry_database_unavailable",
    });
  }

  #rejectPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(fixedWorkerError());
    }
    this.pending.clear();
  }

  #updateStatus(status) {
    if (!status || typeof status !== "object") return;
    this.status = Object.freeze({ ...status, queue: null });
  }

  #noteDrop(reason, count) {
    if (!Number.isSafeInteger(count) || count < 1) return;
    this.pendingDropCount += count;
    if (!this.worker || this.closed) return;
    void this.#request("record_drop", { reason, count }, 5_000)
      .then((response) => {
        this.pendingDropCount = Math.max(0, this.pendingDropCount - count);
        this.#updateStatus(response.status);
      })
      .catch(() => {});
  }
}

export function createTelemetryWorkerStore(options = {}) {
  return new TelemetryWorkerStore(options);
}

function serializableOptions(options) {
  const keys = [
    "collectEnabled", "storageRequired", "databasePath", "backupDirectory",
    "detailRetentionDays", "aggregateRetentionDays", "backupCount", "busyTimeoutMs",
    "queueMaxItems", "batchSize", "flushIntervalMs", "stderrEnabled", "testWriteDelayMs",
  ];
  return Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]));
}

function fixedWorkerError() {
  const error = new Error("Telemetry storage is unavailable.");
  error.code = "telemetry_database_unavailable";
  return error;
}
