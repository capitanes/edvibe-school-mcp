// Generates MCP tool definitions from the manifest and normalized OpenAPI spec.
//
// Each tool definition contains:
//   - name: operationId
//   - description: English description with risk warning
//   - inputSchema: JSON Schema for query + body parameters
//   - annotations: MCP tool annotations from manifest
//
// Dotted query parameters (e.g. "Page.Skip") are flattened to camelCase
// (e.g. "pageSkip") in the input schema and mapped back to upstream form
// at call time.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest", "operations.json");
const NORMALIZED_PATH = path.join(ROOT, "openapi", "normalized", "edvibe-school-api.normalized.json");

/** Convert a dotted parameter name to a flat camelCase MCP input name. */
export function flattenDotted(name) {
  if (!name.includes(".")) return name;
  const parts = name.split(".");
  return parts[0].toLowerCase() + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
}

/** Convert OpenAPI schema property to a JSON Schema fragment for MCP input. */
function schemaToInputSchema(schema, components, depth = 0) {
  if (!schema) return { type: "string" };
  if (schema.$ref) {
    const refName = schema.$ref.replace("#/components/schemas/", "");
    const resolved = components?.schemas?.[refName];
    if (!resolved || depth > 5) return { type: "object" };
    return schemaToInputSchema(resolved, components, depth + 1);
  }
  const result = { type: schema.type || "string" };
  if (schema.description) result.description = schema.description;
  if (schema.format) result.format = schema.format;
  if (schema.enum) result.enum = schema.enum;
  if (schema.items) result.items = schemaToInputSchema(schema.items, components, depth + 1);
  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      result.properties[key] = schemaToInputSchema(val, components, depth + 1);
    }
  }
  if (schema.additionalProperties === false) result.additionalProperties = false;
  if (Array.isArray(schema.required)) result.required = [...schema.required];
  return result;
}

/** Build input schema for a single operation. */
function buildInputSchema(op, spec) {
  const properties = {};
  const required = [];

  // Query parameters
  for (const param of op.parameters || []) {
    if (param.in !== "query") continue;
    const inputName = param.dotted ? flattenDotted(param.name) : param.name;
    const propSchema = schemaToInputSchema(param.schema, spec.components);
    if (param.schema?.description) {
      propSchema.description = param.schema.description;
    } else {
      propSchema.description = `${param.schema?.type || "string"} ${param.required ? "(required)" : "(optional)"}`;
    }
    properties[inputName] = propSchema;
    if (param.required) required.push(inputName);
  }

  // Body parameters (resolve from OpenAPI requestBody schema)
  if (op.hasBody) {
    const pathItem = spec.paths[op.path];
    if (pathItem) {
      const methodOp = pathItem[op.method.toLowerCase()];
      if (methodOp?.requestBody?.content?.["application/json"]?.schema) {
        const bodySchema = methodOp.requestBody.content["application/json"].schema;
        const resolved = schemaToInputSchema(bodySchema, spec.components);
        // Body fields empirically required by the live API but not declared
        // as such in upstream OpenAPI. See scripts/required-overrides.cjs and
        // CONTEXT.md → "Расхождения upstream OpenAPI vs live-поведение".
        const overrideRequired = new Set(op.bodyRequiredFields || []);
        if (resolved.properties) {
          for (const [key, val] of Object.entries(resolved.properties)) {
            // Prefix body params with "body" to avoid collisions with query params
            const inputName = `body${key[0].toUpperCase()}${key.slice(1)}`;
            // Mark empirically required fields as required in the MCP input
            // schema so the client knows they must be supplied.
            if (overrideRequired.has(key)) {
              val.description = `${val.description || ""} (empirically required by live API)`.trim();
            }
            properties[inputName] = val;
            if (overrideRequired.has(key)) required.push(inputName);
          }
        }
        // Also honor any required fields the upstream schema itself declares.
        if (Array.isArray(resolved.required)) {
          for (const key of resolved.required) {
            const inputName = `body${key[0].toUpperCase()}${key.slice(1)}`;
            if (properties[inputName] && !required.includes(inputName)) {
              required.push(inputName);
            }
          }
        }
      }
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

/** Load manifest and normalized spec, return array of 78 tool definitions. */
export function loadToolDefinitions() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const normalized = JSON.parse(fs.readFileSync(NORMALIZED_PATH, "utf8"));
  const spec = normalized.openapi;

  return manifest.operations.map((op) => {
    const inputSchema = buildInputSchema(op, spec);
    return {
      name: op.operationId,
      description: op.description,
      inputSchema,
      annotations: op.annotations,
      // Internal metadata for upstream call (not exposed to MCP client)
      _meta: {
        method: op.method,
        path: op.path,
        riskClass: op.riskClass,
        hasBody: op.hasBody,
        bodyRequiredFields: op.bodyRequiredFields || [],
        parameters: op.parameters || [],
        group: op.group,
      },
    };
  });
}
