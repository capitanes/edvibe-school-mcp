// Credential context for STDIO transport.
//
// For STDIO, credentials come from environment variables:
//   EDVIBE_API_KEY     — raw API key (no Bearer prefix)
//   EDVIBE_SCHOOL_DOMAIN — school hostname (bare, no scheme/port/path)
//
// Credentials are request-scoped: each call to getContext() returns a fresh
// object. No global mutable state. The key and domain never leave the
// credential context except as the upstream Authorization header.

import { validateHostname } from "./upstream.js";

let cachedDomain = null;
let cachedDomainValidated = null;

/**
 * Get the current credential context from environment variables.
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

  // Cache validated hostname
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
