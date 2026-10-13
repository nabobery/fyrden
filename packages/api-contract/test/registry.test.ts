import { isPermission } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { whoami } from "../ops/meta.js";
import { mcpTools } from "../src/mcp.js";
import {
  AUTHENTICATED,
  defineOperation,
  defineRegistry,
  type OperationDef,
  openApiPath,
  pathParams,
  RegistryError,
} from "../src/op.js";
import { openApiDocument } from "../src/openapi.js";
import { registry } from "../src/registry.js";

const base = {
  id: "repo.get",
  method: "GET",
  path: "/repos/{owner}/{repo}",
  summary: "Get a repo",
  input: z.object({ owner: z.string(), repo: z.string() }),
  output: z.object({ id: z.string() }),
  permission: "metadata:read",
  principals: ["user"],
  rateLimit: "read",
  idempotency: "none",
  mcp: { tool: "get_repo", title: "Get repo", description: "Get a repo.", readOnly: true },
} satisfies OperationDef;

describe("defineOperation", () => {
  it("accepts a complete definition", () => {
    expect(defineOperation(base).id).toBe("repo.get");
  });

  it.each([
    ["no permission", { permission: "" }, /permission is required/],
    ["blank permission", { permission: "   " }, /permission is required/],
    ["permission not in the table", { permission: "repo:read" }, /unknown permission repo:read/],
    ["a scope-like name that is no permission", { permission: "admin" }, /unknown permission/],
    [
      "a principal type that cannot hold the permission",
      { permission: "instance:admin", principals: ["agent"] },
      /agent principals cannot hold instance:admin/,
    ],
    ["a GET that needs a write permission", { permission: "contents:write" }, /write permission/],
    ["no principal types", { principals: [] }, /principal type/],
    ["unknown principal type", { principals: ["robot"] }, /unknown principal/],
    ["bad id", { id: "GetRepo" }, /id must/],
    ["bad path", { path: "repos/x" }, /not a valid template/],
    [
      "a greedy parameter before the end",
      { path: "/repos/{owner+}/{repo}" },
      /not a valid template/,
    ],
    ["an empty path", { path: "" }, /not a valid template/],
    ["path param missing from input", { path: "/repos/{owner}/{name}" }, /\{name\} missing/],
    ["GET with an idempotency key", { idempotency: "key" }, /naturally idempotent/],
    [
      "POST without an idempotency key",
      { method: "POST", mcp: false },
      /require an Idempotency-Key/,
    ],
    ["readOnly tool on a POST", { method: "POST", idempotency: "key" }, /readOnly/],
    ["bad tool name", { mcp: { ...base.mcp, tool: "Get Repo" } }, /tool name/],
    ["GET answering 201", { successStatus: 201 }, /cannot answer 201/],
  ])("rejects %s", (_, change, message) => {
    expect(() => defineOperation({ ...base, ...change } as OperationDef)).toThrow(message);
  });
});

describe("greedy path parameters", () => {
  it("take the rest of the path as their last parameter, written plainly in OpenAPI", () => {
    const op = defineOperation({ ...base, path: "/repos/{owner}/{repo+}" } as OperationDef);
    expect(pathParams(op.path)).toEqual(["owner", "repo"]);
    expect(openApiPath(op.path)).toBe("/repos/{owner}/{repo}");
  });
});

describe("defineRegistry", () => {
  it("rejects duplicate ids, routes and tool names", () => {
    const other = { ...base, id: "repo.fetch", mcp: { ...base.mcp, tool: "fetch_repo" } };
    expect(() => defineRegistry([base, base])).toThrow(RegistryError);
    expect(() =>
      defineRegistry([
        base,
        { ...other, path: "/repos/{a}/{b}", input: z.object({ a: z.string(), b: z.string() }) },
      ]),
    ).toThrow(/duplicate route/);
    expect(() =>
      defineRegistry([base, { ...other, path: "/r/{owner}/{repo}", mcp: base.mcp }]),
    ).toThrow(/duplicate MCP tool/);
  });
});

describe("generated artifacts", () => {
  it("produces the OpenAPI document for the whole registry", () => {
    expect(openApiDocument(registry, { version: "0.0.0" })).toMatchSnapshot();
  });

  it("lists whoami as an MCP tool with the same input schema as the operation", () => {
    const tools = mcpTools(registry);
    const tool = tools.find((t) => t.name === "whoami");
    expect(tool?.operationId).toBe("meta.whoami");
    const { $schema: _, ...expected } = z.toJSONSchema(whoami.input, { io: "input" });
    expect(tool?.inputSchema).toEqual(expected);
    expect(tool?.annotations.readOnlyHint).toBe(true);
    expect(tool?.outputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["id", "type", "token"]),
    });
  });

  it("uses the AUTHENTICATED permission for whoami", () => {
    expect(whoami.permission).toBe(AUTHENTICATED);
  });

  it("names a permission from the table for every other operation", () => {
    for (const op of registry) {
      if (op.id === "meta.whoami") continue;
      expect(isPermission(op.permission), op.id).toBe(true);
    }
  });
});
