const VERSION_PATTERN = /^(v?\d{1,4}(?:\.\d{1,4}){0,3})(?:[-+][0-9A-Za-z.-]{1,48})?$/;

export const CLIENT_FAMILIES = Object.freeze(["cursor", "codex", "devin", "other", "unknown"]);

/**
 * Normalize MCP initialize clientInfo without preserving an arbitrary name.
 * Unknown names become `other`; malformed/free-form versions become null.
 */
export function normalizeClientInfo(clientInfo) {
  if (!clientInfo || typeof clientInfo !== "object" || Array.isArray(clientInfo)) {
    return Object.freeze({ family: "unknown", version: null });
  }

  const name = typeof clientInfo.name === "string" ? clientInfo.name.trim().toLowerCase() : "";
  let family = "unknown";
  if (name) {
    if (/(^|[^a-z])cursor([^a-z]|$)/.test(name)) family = "cursor";
    else if (/(^|[^a-z])codex([^a-z]|$)|openai/.test(name)) family = "codex";
    else if (/(^|[^a-z])devin([^a-z]|$)|cognition/.test(name)) family = "devin";
    else family = "other";
  }

  const rawVersion = typeof clientInfo.version === "string" ? clientInfo.version.trim() : "";
  const versionMatch = rawVersion.length <= 72 ? rawVersion.match(VERSION_PATTERN) : null;
  // Persist only the finite numeric core. Pre-release/build suffixes can carry
  // arbitrary customer text, so they are deliberately discarded.
  const version = versionMatch ? versionMatch[1] : null;
  return Object.freeze({ family, version });
}

/** Return true only for a normalized, finite client family. */
export function isClientFamily(value) {
  return CLIENT_FAMILIES.includes(value);
}
