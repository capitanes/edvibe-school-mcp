import { createHmac, timingSafeEqual } from "node:crypto";
import { domainToASCII } from "node:url";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PSEUDONYM = /^(?:t|i)_[A-Za-z0-9_-]{22}$/;

/** Return true only for a canonical UUID v4 client installation identifier. */
export function isUuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

/** Parse the optional X-Edvibe-Client-Id value without retaining invalid input. */
export function parseClientInstallationId(value) {
  if (Array.isArray(value)) return null;
  if (!isUuidV4(value)) return null;
  return value.toLowerCase();
}

/**
 * Validate and canonicalize a bare school hostname for identity derivation.
 * Throws a fixed error without echoing the input.
 */
export function canonicalizeSchoolDomain(value) {
  if (typeof value !== "string") throw new TypeError("Invalid school domain.");
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    candidate.length < 1 ||
    candidate.length > 253 ||
    candidate.includes("://") ||
    /[\/@:?#\s]/.test(candidate)
  ) {
    throw new TypeError("Invalid school domain.");
  }

  const ascii = domainToASCII(candidate).toLowerCase();
  if (!ascii || ascii.length > 253) throw new TypeError("Invalid school domain.");
  const labels = ascii.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    throw new TypeError("Invalid school domain.");
  }
  return ascii;
}

/** Return true for a value shaped like an emitted tenant/installation pseudonym. */
export function isTelemetryPseudonym(value, prefix) {
  if (typeof value !== "string" || !PSEUDONYM.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}

/**
 * Create tenant-scoped HMAC identity helpers.
 *
 * Installation identities include the tenant pseudonym in their HMAC input,
 * preventing the same client UUID from linking activity across two schools.
 * The first 22 base64url characters provide 132 bits of pseudonymous identity.
 */
export function createIdentityHasher({ secret, epoch = 1 } = {}) {
  const key = normalizeSecret(secret);
  const normalizedEpoch = normalizeEpoch(epoch);

  function digest(prefix, namespace, value) {
    const mac = createHmac("sha256", key)
      .update(`edvibe-telemetry:v1:${normalizedEpoch}:${namespace}:`, "utf8")
      .update(value, "utf8")
      .digest("base64url")
      .slice(0, 22);
    return `${prefix}_${mac}`;
  }

  return Object.freeze({
    epoch: normalizedEpoch,

    /** Derive a `t_` pseudonym from a validated canonical school domain. */
    tenant(domain) {
      return digest("t", "tenant", canonicalizeSchoolDomain(domain));
    },

    /**
     * Derive an `i_` pseudonym from a valid UUID v4 and tenant identity/domain.
     * Returns null for a missing or invalid optional client id.
     */
    installation(clientId, tenantOrDomain) {
      const parsed = parseClientInstallationId(clientId);
      if (!parsed) return null;
      const tenantId = isTelemetryPseudonym(tenantOrDomain, "t")
        ? tenantOrDomain
        : digest("t", "tenant", canonicalizeSchoolDomain(tenantOrDomain));
      return digest("i", "installation", `${tenantId}:${parsed}`);
    },

    /** Constant-time comparison helper for already-pseudonymized values. */
    equals(left, right) {
      if (typeof left !== "string" || typeof right !== "string") return false;
      const leftBuffer = Buffer.from(left);
      const rightBuffer = Buffer.from(right);
      return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
    },
  });
}

function normalizeSecret(secret) {
  const value = Buffer.isBuffer(secret) || secret instanceof Uint8Array
    ? Buffer.from(secret)
    : typeof secret === "string"
      ? Buffer.from(secret, "utf8")
      : null;
  if (!value || value.length < 32) {
    throw new TypeError("Telemetry HMAC credential must contain at least 32 bytes.");
  }
  return value;
}

function normalizeEpoch(epoch) {
  const value = typeof epoch === "string" && /^\d+$/.test(epoch) ? Number(epoch) : epoch;
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError("Telemetry identity epoch must be a positive integer.");
  }
  return value;
}

