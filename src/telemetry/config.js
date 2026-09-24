import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TELEMETRY_DATABASE_PATH = "/var/lib/edvibe-mcp/telemetry.sqlite";
export const DEFAULT_HMAC_CREDENTIAL_NAME = "telemetry_hmac_key";
export const DEFAULT_DASHBOARD_PASSWORD_CREDENTIAL_NAME = "analytics_password";

/**
 * Read one systemd LoadCredential file from CREDENTIALS_DIRECTORY.
 * Secret values are never read from ordinary environment variables.
 */
export function readSystemdCredential(name, {
  credentialsDirectory = process.env.CREDENTIALS_DIRECTORY,
  encoding = null,
  maxBytes = 16 * 1024,
  required = true,
} = {}) {
  if (!isCredentialName(name)) throw new TypeError("Invalid systemd credential name.");
  if (!credentialsDirectory) {
    if (!required) return null;
    throw new Error("Systemd credentials directory is unavailable.");
  }

  const directory = path.resolve(credentialsDirectory);
  const credentialPath = path.join(directory, name);
  if (path.dirname(credentialPath) !== directory) throw new TypeError("Invalid systemd credential path.");

  let stat;
  try {
    stat = fs.statSync(credentialPath, { throwIfNoEntry: false });
  } catch {
    stat = null;
  }
  if (!stat?.isFile()) {
    if (!required) return null;
    throw new Error("Required systemd credential is unavailable.");
  }
  if (stat.size < 1 || stat.size > maxBytes) throw new Error("Systemd credential has an invalid size.");

  const value = fs.readFileSync(credentialPath);
  if (value.includes(0)) throw new Error("Systemd credential has an invalid format.");
  if (encoding === null) return stripFinalLineBreak(value);
  return stripFinalLineBreak(value).toString(encoding);
}

/**
 * Parse telemetry flags, limits and systemd credentials.
 * Sensitive properties are deliberately non-enumerable to reduce accidental
 * logging through object spreads or JSON.stringify(config).
 */
export function loadTelemetryConfig(env = process.env, {
  credentialsDirectory = env.CREDENTIALS_DIRECTORY,
  readCredential = readSystemdCredential,
} = {}) {
  const enabled = parseBoolean(env.TELEMETRY_ENABLED, false, "TELEMETRY_ENABLED");
  const dashboardEnabled = parseBoolean(
    env.ANALYTICS_DASHBOARD_ENABLED,
    false,
    "ANALYTICS_DASHBOARD_ENABLED",
  );
  const storageRequired = enabled || dashboardEnabled;
  const databasePath = absolutePath(
    env.TELEMETRY_DATABASE_PATH || DEFAULT_TELEMETRY_DATABASE_PATH,
    "TELEMETRY_DATABASE_PATH",
  );
  const backupDirectory = absolutePath(
    env.TELEMETRY_BACKUP_DIRECTORY || path.join(path.dirname(databasePath), "backups"),
    "TELEMETRY_BACKUP_DIRECTORY",
  );

  const config = {
    enabled,
    dashboardEnabled,
    storageRequired,
    databasePath,
    backupDirectory,
    identityEpoch: integer(env.TELEMETRY_IDENTITY_EPOCH, 1, 1, 2_147_483_647, "TELEMETRY_IDENTITY_EPOCH"),
    queueMaxItems: integer(env.TELEMETRY_QUEUE_MAX_ITEMS, 10_000, 100, 1_000_000, "TELEMETRY_QUEUE_MAX_ITEMS"),
    batchSize: integer(env.TELEMETRY_BATCH_SIZE, 100, 1, 5_000, "TELEMETRY_BATCH_SIZE"),
    flushIntervalMs: integer(env.TELEMETRY_FLUSH_INTERVAL_MS, 250, 10, 60_000, "TELEMETRY_FLUSH_INTERVAL_MS"),
    maintenanceInitialDelayMs: integer(
      env.TELEMETRY_MAINTENANCE_INITIAL_DELAY_MS,
      30_000,
      1_000,
      86_400_000,
      "TELEMETRY_MAINTENANCE_INITIAL_DELAY_MS",
    ),
    maintenanceIntervalMs: integer(
      env.TELEMETRY_MAINTENANCE_INTERVAL_MS,
      86_400_000,
      60_000,
      86_400_000,
      "TELEMETRY_MAINTENANCE_INTERVAL_MS",
    ),
    detailRetentionDays: integer(
      env.TELEMETRY_DETAIL_RETENTION_DAYS,
      90,
      7,
      90,
      "TELEMETRY_DETAIL_RETENTION_DAYS",
    ),
    aggregateRetentionDays: integer(
      env.TELEMETRY_AGGREGATE_RETENTION_DAYS,
      365,
      30,
      365,
      "TELEMETRY_AGGREGATE_RETENTION_DAYS",
    ),
    backupCount: integer(env.TELEMETRY_BACKUP_COUNT, 7, 1, 7, "TELEMETRY_BACKUP_COUNT"),
    busyTimeoutMs: integer(env.TELEMETRY_BUSY_TIMEOUT_MS, 5_000, 100, 60_000, "TELEMETRY_BUSY_TIMEOUT_MS"),
    stderrEnabled: parseBoolean(env.TELEMETRY_STDERR_ENABLED, true, "TELEMETRY_STDERR_ENABLED"),
    hmacCredentialName: credentialName(
      env.TELEMETRY_HMAC_CREDENTIAL || DEFAULT_HMAC_CREDENTIAL_NAME,
      "TELEMETRY_HMAC_CREDENTIAL",
    ),
    dashboardPasswordCredentialName: credentialName(
      env.ANALYTICS_PASSWORD_CREDENTIAL || DEFAULT_DASHBOARD_PASSWORD_CREDENTIAL_NAME,
      "ANALYTICS_PASSWORD_CREDENTIAL",
    ),
  };

  let hmacSecret = null;
  let dashboardPassword = null;
  if (enabled) {
    hmacSecret = readCredential(config.hmacCredentialName, {
      credentialsDirectory,
      required: true,
      encoding: null,
      maxBytes: 4_096,
    });
    if (!Buffer.isBuffer(hmacSecret) || hmacSecret.length < 32) {
      throw new Error("Telemetry HMAC credential must contain at least 32 bytes.");
    }
  }
  if (dashboardEnabled) {
    dashboardPassword = readCredential(config.dashboardPasswordCredentialName, {
      credentialsDirectory,
      required: true,
      encoding: "utf8",
      maxBytes: 4_096,
    });
    if (typeof dashboardPassword !== "string" || dashboardPassword.length < 16) {
      throw new Error("Analytics password credential must contain at least 16 characters.");
    }
  }

  Object.defineProperties(config, {
    hmacSecret: { value: hmacSecret, enumerable: false, writable: false },
    dashboardPassword: { value: dashboardPassword, enumerable: false, writable: false },
  });
  return Object.freeze(config);
}

function stripFinalLineBreak(buffer) {
  let end = buffer.length;
  if (end > 0 && buffer[end - 1] === 0x0a) end -= 1;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  return Buffer.from(buffer.subarray(0, end));
}

function parseBoolean(raw, fallback, name) {
  if (raw === undefined || raw === "") return fallback;
  if (raw === true || raw === "true" || raw === "1") return true;
  if (raw === false || raw === "false" || raw === "0") return false;
  throw new TypeError(`${name} must be true/false or 1/0.`);
}

function integer(raw, fallback, min, max, name) {
  if (raw === undefined || raw === "") return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function absolutePath(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${name} must be an absolute path.`);
  }
  return path.normalize(value);
}

function isCredentialName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
}

function credentialName(value, name) {
  if (!isCredentialName(value)) throw new TypeError(`${name} is invalid.`);
  return value;
}
