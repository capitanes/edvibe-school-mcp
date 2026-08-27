// Credential context for both STDIO and HTTP transports.
//
// STDIO: credentials come from environment variables
//   EDVIBE_API_KEY       — raw API key (no Bearer prefix)
//   EDVIBE_SCHOOL_DOMAIN — school hostname (bare, no scheme/port/path)
//
// HTTP: credentials come from request headers
//   Authorization: Bearer <EDVIBE_API_KEY>
//   X-Edvibe-School-Domain: <hostname>
//
// Credentials are request-scoped: each call returns a fresh object. No global
// mutable state. The key and domain never leave the credential context except
// as the upstream Authorization header.

import { validateHostname } from "./upstream.js";

// --- STDIO: env-based context (cached, validated once) ---

let cachedDomain = null;
let cachedDomainValidated = null;

/**
 * Get the credential context from environment variables (STDIO transport).
 * Validates the school domain on first use and caches the result.
 *
 * @returns {Promise<{apiKey: string, schoolDomain: string}>}
 */
export async function getContext() {
  const apiKey = process.env.EDVIBE_API_KEY;
  const schoolDomain = process.env.EDVIBE_SCHOOL_DOMAIN;

  if (!apiKey) {
    throw new Error(
      "EDVIBE_API_KEY environment variable is not set. " +
        "Set it to your Edvibe School API key (raw value, no Bearer prefix)."
    );
  }
  if (!schoolDomain) {
    throw new Error(
      "EDVIBE_SCHOOL_DOMAIN environment variable is not set. " +
        "Set it to your school hostname (e.g. my-school.edvibe.com)."
    );
  }

  if (schoolDomain !== cachedDomain) {
    cachedDomain = schoolDomain;
    cachedDomainValidated = await validateHostname(schoolDomain);
  }

  return {
    apiKey,
    schoolDomain: cachedDomainValidated,
  };
}

/**
 * Check if credentials are configured (without validating or exposing values).
 * Used for startup diagnostics.
 */
export function hasCredentials() {
  return !!(process.env.EDVIBE_API_KEY && process.env.EDVIBE_SCHOOL_DOMAIN);
}

// --- HTTP: per-request context from headers ---

/**
 * Build a credential context from HTTP request headers.
 *
 * Expected headers:
 *   Authorization: Bearer <EDVIBE_API_KEY>
 *   X-Edvibe-School-Domain: <hostname>
 *
 * The "Bearer " prefix is stripped before returning the raw key (upstream
 * expects the raw key, no prefix). If the prefix is missing, the value is
 * used as-is — but a missing/empty Authorization header throws 401-style.
 *
 * @param {import('http').IncomingMessage['headers']} headers
 * @returns {Promise<{apiKey: string, schoolDomain: string}>}
 * @throws {Error} with `.httpStatus` attached for the Express layer to use.
 */
export async function getContextFromHeaders(headers) {
  const authHeader = headers["authorization"];
  if (!authHeader || typeof authHeader !== "string") {
    const err = new Error("Missing Authorization header. Expected: Authorization: Bearer <EDVIBE_API_KEY>");
    err.httpStatus = 401;
    throw err;
  }

  let apiKey = authHeader.trim();
  // Strip optional "Bearer " prefix. Upstream expects the raw key.
  if (apiKey.toLowerCase().startsWith("bearer ")) {
    apiKey = apiKey.slice(7).trim();
  }
  if (!apiKey) {
    const err = new Error("Empty Authorization header. Expected: Authorization: Bearer <EDVIBE_API_KEY>");
    err.httpStatus = 401;
    throw err;
  }

  const schoolDomain = headers["x-edvibe-school-domain"];
  if (!schoolDomain || typeof schoolDomain !== "string" || !schoolDomain.trim()) {
    const err = new Error(
      "Missing X-Edvibe-School-Domain header. Expected: X-Edvibe-School-Domain: <hostname>"
    );
    err.httpStatus = 401;
    throw err;
  }

  const validatedDomain = await validateHostname(schoolDomain.trim());

  return {
    apiKey,
    schoolDomain: validatedDomain,
  };
}
