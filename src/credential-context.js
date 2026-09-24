// Credential context for both STDIO and HTTP transports.
// Credentials are request-scoped and are never exposed to telemetry.

import { resolveValidatedHostname } from "./upstream.js";
import { createSafeError } from "./telemetry/errors.js";

let cachedDomain = null;
let cachedDomainValidated = null;
let cachedAddresses = null;
let cachedResolvedAt = null;

/** Get the credential context from STDIO environment variables. */
export async function getContext() {
  const apiKey = process.env.EDVIBE_API_KEY;
  const schoolDomain = process.env.EDVIBE_SCHOOL_DOMAIN;

  if (!apiKey) throw createSafeError("missing_authorization");
  if (!schoolDomain) throw createSafeError("missing_school_domain");

  if (schoolDomain !== cachedDomain) {
    cachedDomain = schoolDomain;
    const resolved = await resolveValidatedHostname(schoolDomain);
    cachedDomainValidated = resolved.hostname;
    cachedAddresses = resolved.addresses;
    cachedResolvedAt = resolved.resolvedAt;
  }

  return {
    apiKey,
    schoolDomain: cachedDomainValidated,
    resolvedAddresses: cachedAddresses,
    resolvedAt: cachedResolvedAt,
  };
}

/** Check if STDIO credentials are configured without exposing their values. */
export function hasCredentials() {
  return !!(process.env.EDVIBE_API_KEY && process.env.EDVIBE_SCHOOL_DOMAIN);
}

/** Build a fresh HTTP credential context from request headers. */
export async function getContextFromHeaders(headers) {
  const authHeader = headers["authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    throw createSafeError("missing_authorization");
  }

  let apiKey = authHeader.trim();
  if (/^bearer(?:\s|$)/i.test(apiKey)) apiKey = apiKey.slice(6).trim();
  if (!apiKey) throw createSafeError("invalid_authorization");

  const schoolDomain = headers["x-edvibe-school-domain"];
  if (!schoolDomain || typeof schoolDomain !== "string" || !schoolDomain.trim()) {
    throw createSafeError("missing_school_domain");
  }

  const resolved = await resolveValidatedHostname(schoolDomain.trim());
  return {
    apiKey,
    schoolDomain: resolved.hostname,
    resolvedAddresses: resolved.addresses,
    resolvedAt: resolved.resolvedAt,
  };
}
