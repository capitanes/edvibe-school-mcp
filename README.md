# Edvibe School MCP

> **Status: experimental / unofficial.** This is Ruslan Sungurov's private pilot, not an official Edvibe product. Do not deploy, publish, enable telemetry, or connect live schools without the approvals described in `PLAN.md`.

A stateless [Model Context Protocol](https://modelcontextprotocol.io) server over the official Edvibe School API. The v1 audience is Edvibe/ProgressMe schools on the **Pro** plan where the School API module is available.

## Current state

- The MCP contract contains exactly **78 tools**: `35 read + 24 write + 17 high-risk + 2 sensitive`.
- Local STDIO and stateless Streamable HTTP transports are implemented.
- The private HTTP pilot is currently served at `https://edvibe.sungurov.com/mcp`.
- A privacy-bounded HTTP telemetry pipeline and Russian internal dashboard are implemented locally.
- Telemetry and `/admin/analytics` are **disabled by default and have not been enabled on the pilot server**. Deployment and activation require separate approval.
- Central telemetry intentionally excludes STDIO and never receives the user's original prompt.

The public tool names, arguments and responses remain unchanged. `LoginPupil` and `LoginTeacher` remain in the 78-tool contract; their actual public disablement and a tenant allowlist are separate security tasks.

## Contract at a glance

| Class | Count | Meaning | `readOnlyHint` | `destructiveHint` |
|---|---:|---|---|---|
| read | 35 | Read-only | `true` | `false` |
| write | 24 | Ordinary state change | `false` | `false` |
| high-risk | 17 | Destructive / hard to reverse | `false` | `true` |
| sensitive | 2 | Returns a login token | `false` | `false` + explicit warning |
| **Total** | **78** | | | |

Risk is determined by operation semantics, not only by the HTTP method.

## HTTP connection

`POST /mcp` requires two headers and accepts a third optional header:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <EDVIBE_API_KEY>` |
| `X-Edvibe-School-Domain` | Bare school hostname |
| `X-Edvibe-Client-Id` | Optional persistent UUID v4 for this client installation |

Old configurations without `X-Edvibe-Client-Id` continue to work. Invalid IDs are ignored. A valid ID enables installation coverage and anonymous scenario metrics; the raw UUID is never persisted.

`GET /healthz` remains unauthenticated and is excluded from product metrics. All other non-MCP paths return a generic error, except the separately protected analytics routes when enabled.

## Local workflow

Requirements: Node.js 20+.

```bash
npm ci
npm run ci
```

`npm run ci` runs both the immutable 78-tool contract validator and the `node:test` runtime/privacy suite.

Run STDIO (no centralized telemetry):

```bash
MCP_TRANSPORT=stdio node src/index.js
```

Run HTTP locally with telemetry and analytics disabled:

```bash
MCP_TRANSPORT=http TELEMETRY_ENABLED=false ANALYTICS_DASHBOARD_ENABLED=false node src/index.js
```

Credentials for School API access come from the MCP client configuration. Never put real API keys in Git, examples, test fixtures or shell command history.

## Safe HTTP telemetry

The telemetry API accepts only a strict event schema:

- `service_started`
- `mcp_initialize_completed`
- `mcp_request_rejected`
- `tool_call_completed`
- `service_stopped`
- `telemetry_storage_degraded`

Allowed data is limited to UTC time, a server request ID, transport, HMAC pseudonyms, normalized client family/version, MCP method, tool/group/risk, outcome, a fixed safe error code, upstream status and numeric timings.

The logger rejects headers, IP/User-Agent, URLs/query strings, arguments/results, bodies, API keys, raw domains, raw UUIDs, tokens, passwords, JSON-RPC body/ID, arbitrary error messages, stacks and unknown fields.

School and installation identities use HMAC-SHA256; installation identities are tenant-scoped. The HMAC key and dashboard password are read only from systemd `LoadCredential` files:

- `telemetry_hmac_key`
- `analytics_password`

Do not store these values in `.env`, the unit file, process arguments, Git or logs. Increment `TELEMETRY_IDENTITY_EPOCH` whenever the HMAC key is rotated.

### Storage

- SQLite: `/var/lib/edvibe-mcp/telemetry.sqlite` by default.
- WAL, prepared statements, `busy_timeout`, private `0700` directories and `0600` files.
- A bounded asynchronous queue accepts events on the HTTP thread; SQLite, journald and dashboard queries run in a dedicated worker thread. Storage failure never changes an MCP response.
- Detailed events use a hard 90-day maximum. Identity-free hourly/daily aggregates use a hard 365-day maximum; cleanup runs daily.
- Daily retention, incremental vacuum and at most seven local backups. Retained backup databases are pruned to the same detail/aggregate cutoffs.
- The same allow-listed events are written as one JSON line to stderr/journald. Journald is not the annual analytics source; activation must verify a host journald retention policy no longer than 90 days.

### Dashboard

When separately enabled, the Russian internal dashboard is available at `GET /admin/analytics`. It uses Basic Auth with the fixed username `analytics` and a password from the systemd credential. Its API is read-only:

- `GET /admin/analytics/api/dashboard`
- `GET /admin/analytics/api/events`

Responses use `Cache-Control: no-store`, a restrictive CSP, frame denial and no external scripts. HTTPS forwarded by a proxy is trusted only from loopback/private proxy addresses, so port 9000 must remain firewalled from public access. Time is stored in UTC and displayed in `Europe/Moscow`. Identity drill-down is limited to the 90-day detail window; annual analytics uses identity-free aggregates.

The relevant non-secret flags are:

| Variable | Default | Purpose |
|---|---|---|
| `TELEMETRY_ENABLED` | `false` | Collect safe HTTP events |
| `ANALYTICS_DASHBOARD_ENABLED` | `false` | Serve the protected dashboard/API |
| `TELEMETRY_IDENTITY_EPOCH` | `1` | Pseudonym generation epoch |
| `TELEMETRY_DATABASE_PATH` | `/var/lib/edvibe-mcp/telemetry.sqlite` | SQLite path |
| `TELEMETRY_BACKUP_DIRECTORY` | `/var/lib/edvibe-mcp/backups` | Local backup directory |

See `deploy/systemd/telemetry.conf.example`. The example intentionally keeps both feature flags off and the `LoadCredential`/`StateDirectory` directives commented for the first rollout. Provision the private state directory and credential files, then uncomment those directives only during the separately approved activation stage.

## Security status

Implemented in this change:

- fixed safe error taxonomy; no raw upstream body in exceptions;
- process-keyed HMAC identifiers in the rate-limiter registry instead of raw API keys;
- bounded limiter/DNS registries with expiry;
- public-address DNS validation with the validated IPv4 result pinned into the upstream connection, plus a bounded response body;
- strict telemetry allowlist and fail-open storage;
- pseudonymous analytics and protected read-only UI.

Still separate from this change:

- an Edvibe-controlled tenant/White Label allowlist before sending `Authorization` upstream;
- actual public disablement of `LoginPupil` and `LoginTeacher` until product/security approval.

## Repository layout

```text
manifest/                 authoritative 78-operation inventory
openapi/                  immutable snapshot and generated normalized copy
scripts/                  contract generation, validation and deployment helper
src/                      MCP transports, upstream client and telemetry runtime
src/telemetry/            schema, identities, bounded queue, worker-thread SQLite store and queries
test/                     node:test runtime and privacy checks
web/                      landing page and self-contained analytics UI
deploy/systemd/           non-secret systemd drop-in example
README.md CONTEXT.md PLAN.md AGENTS.md
```

Generated OpenAPI and manifest files must not be edited manually. See `CONTEXT.md` for decisions, `PLAN.md` for rollout gates and `AGENTS.md` for repository rules.

## Rollout boundary

The safe sequence is: deploy code with both flags `false`; verify `/healthz` and the 78-tool contract; inspect Node/systemd/disk/firewall/proxy logging read-only; only after separate approval provision credentials and private directories, enable collection, run one controlled read-only canary and observe it for 24 hours.

Rollback is to set both feature flags to `false` and restart the service. The MCP continues to work and the existing database remains private. This repository change does not itself commit, push or deploy anything.
