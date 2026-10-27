import { z } from "zod";
import { answersNothing, type OperationDef, openApiPath, pathParams, type Registry } from "./op.js";
import { Problem } from "./problem.js";

type JsonSchema = Record<string, unknown>;

const toSchema = (schema: z.ZodType, io: "input" | "output"): JsonSchema =>
  z.toJSONSchema(schema, { io, unrepresentable: "throw", target: "draft-2020-12" }) as JsonSchema;

function stripMeta(schema: JsonSchema): JsonSchema {
  const { $schema: _, id: __, ...rest } = schema;
  return rest;
}

function operationObject(op: OperationDef): JsonSchema {
  const input = stripMeta(toSchema(op.input, "input"));
  const properties = (input.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((input.required as string[] | undefined) ?? []);
  const inPath = new Set(pathParams(op.path));
  const parameters = Object.entries(properties)
    .filter(([name]) => inPath.has(name) || op.method === "GET")
    .map(([name, schema]) => ({
      name,
      in: inPath.has(name) ? "path" : "query",
      required: inPath.has(name) || required.has(name),
      schema,
    }));
  const bodyProps = Object.fromEntries(
    Object.entries(properties).filter(([name]) => !inPath.has(name)),
  );
  const hasBody = op.method !== "GET" && Object.keys(bodyProps).length > 0;
  const problem = { $ref: "#/components/schemas/Problem" };
  return {
    operationId: op.id,
    summary: op.summary,
    ...(op.description && { description: op.description }),
    ...(parameters.length > 0 && { parameters }),
    ...(op.idempotency === "key" && {
      "x-idempotency": "Idempotency-Key header",
    }),
    ...(hasBody && {
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: bodyProps,
              required: [...required].filter((r) => !inPath.has(r)),
            },
          },
        },
      },
    }),
    responses: {
      [String(op.successStatus ?? 200)]: answersNothing(op)
        ? { description: op.successStatus === 205 ? "Reset Content" : "No Content" }
        : {
            description:
              op.successStatus === 201 ? "Created" : op.successStatus === 202 ? "Accepted" : "OK",
            content: { "application/json": { schema: stripMeta(toSchema(op.output, "output")) } },
            ...(op.etag && { headers: { ETag: { schema: { type: "string" } } } }),
          },
      ...(op.etag && { "304": { description: "Not Modified: the If-None-Match ETag matches" } }),
      default: {
        description: "Error",
        content: { "application/problem+json": { schema: problem } },
      },
    },
    security: [{ bearer: [] }],
    "x-fyrden-permission": op.permission,
    "x-fyrden-principals": op.principals,
  };
}

/** OpenAPI 3.1 document for the REST API, served at /api/openapi.json. */
export function openApiDocument(
  registry: Registry,
  info: { version: string; serverUrl?: string },
): JsonSchema {
  // A Map, so no path (not even "__proto__") can reach an object's prototype.
  const byPath = new Map<string, Record<string, JsonSchema>>();
  for (const op of registry) {
    const path = openApiPath(op.path);
    const item = byPath.get(path) ?? {};
    item[op.method.toLowerCase()] = operationObject(op);
    byPath.set(path, item);
  }
  const paths = Object.fromEntries(byPath);
  return {
    openapi: "3.1.1",
    info: { title: "Fyrden API", version: info.version },
    ...(info.serverUrl && { servers: [{ url: info.serverUrl }] }),
    paths,
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas: { Problem: stripMeta(toSchema(Problem, "output")) },
    },
  };
}
