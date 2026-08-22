# Edvibe School MCP

> **Status: experimental / unofficial.** This repository is a private pilot by Ruslan Sungurov. It is **not** an official Edvibe product yet. Do not deploy, publish, or connect to live schools without explicit approval from Ruslan and Edvibe. See `PLAN.md` for approval gates A–F.

A stateless [Model Context Protocol](https://modelcontextprotocol.io) server over the official [Edvibe School API](https://edvibe.com/school-api/swagger/index.html). The v1 audience is Edvibe/ProgressMe schools on the **Pro** plan where the API module is available. MCP cannot open the API on plans without it; broader availability is a product decision for Edvibe.

## What exists right now

- Immutable upstream OpenAPI snapshot (`openapi/snapshots/swagger-2026-08-22.json`) with SHA-256 `68342121d2fd…`.
- Authoritative operation manifest (`manifest/operations.json`) with all **78** operations, stable English `operationId`, risk class, and MCP tool annotations.
- Normalized MCP-oriented OpenAPI copy (`openapi/normalized/edvibe-school-api.normalized.json`) generated from the snapshot + manifest.
- CI validator (`scripts/validate.js`) that enforces the 78-operation contract, the `35 + 24 + 17 + 2` risk classification, snapshot/manifest/normalized parity, annotation matrix, immutability, and a secret scan.

What does **not** exist yet: Postman collection, MCP server code, deployment, public listing. Those are later stages in `PLAN.md`.

## Contract at a glance

| Class | Count | Meaning | `readOnlyHint` | `destructiveHint` |
|---|---:|---|---|---|
| read | 35 | Read-only | `true` | `false` |
| write | 24 | Ordinary state change | `false` | `false` |
| high-risk | 17 | Destructive / hard to reverse | `false` | `true` |
| sensitive | 2 | Returns a login token | `false` | `false` + explicit warning |
| **Total** | **78** | | | |

Risk is determined by actual operation semantics, not by HTTP method. Notably, `GET /api/Marathon/AddMarathonNewStudents` mutates state and is classified as `write`; eight read-only operations use `POST`.

## Repository layout

```
openapi/
  snapshots/            # immutable upstream OpenAPI (never edit)
  normalized/           # generated MCP-oriented copy (never edit by hand)
manifest/
  operations.json       # generated authoritative inventory (never edit by hand)
scripts/
  risk-classification.js  # human-authored risk map (single input)
  operation-meta.js       # human-authored English descriptions + warnings
  generate-manifest.js    # snapshot + risk map -> manifest/operations.json
  normalize.js            # snapshot + manifest -> normalized spec
  validate.js             # CI checks
.github/workflows/
  contract.yml           # regenerates + validates + fails if artifacts stale
README.md  CONTEXT.md  PLAN.md  AGENTS.md  package.json
```

## Local workflow

Requirements: Node.js 20+.

```bash
npm run build:contract   # generate manifest + normalized spec
npm run validate         # run all CI checks
```

Never edit files under `openapi/snapshots/`, `openapi/normalized/`, or `manifest/`. Change `scripts/risk-classification.js` or `scripts/operation-meta.js` and rerun `npm run build:contract`.

## Security posture (v1)

- Stateless server: no global mutable key/domain. Credential context is request/session-scoped.
- API key is never returned in tool results, logs, fixtures, examples, or cache.
- `errorStackTrace` is stripped from all client-facing errors.
- `HTTP 200` with `BaseResponse.isSuccess=false` is treated as an MCP error.
- School domain is validated against an Edvibe-controlled allowlist before any upstream call; for the private pilot, only an explicit test-school hostname is allowed.
- HTTPS only, port 443, fixed upstream path `/school-api`, no redirects, no IP literals, no private/reserved targets, DNS rebinding protection.
- Internal rate limit: 10 rps per key (below the upstream 15 rps), max 4 concurrent requests per key.
- No automatic retry for writes/high-risk/sensitive operations.
- `LoginPupil` and `LoginTeacher` stay in the 78-tool contract but are disabled on the public endpoint until a recorded product/security approval (Gate F).

## Approval gates

Public Postman, live writes, repository transfer, deployment, publication, and public enablement of login tools each require explicit approval from Ruslan. See `PLAN.md` → "Approval gates".

## Supported clients (v1)

- Local Cursor (auto-run off).
- Local Codex (`default_tools_approval_mode = "writes"`; high-risk/sensitive tools per-tool `approval_mode = "prompt"`).

Cursor Cloud, Cursor auto-run, and ChatGPT are **not** supported in v1.

## Origin

This repository was seeded from the Edvibe MCP handoff package in the ProgressMe Obsidian vault (`Instruments/Edvibe MCP/`). `CONTEXT.md`, `PLAN.md`, and `AGENTS.md` are the project context, plan, and agent instructions respectively.
