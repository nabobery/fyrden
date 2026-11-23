// An operation whose outcome decides its status (201 when it creates, 204
// when it updates, as GitHub's secret PUT): REST answers 201 with an empty
// JSON object, as GitHub does (clients such as `gh` decode every answer but
// a 204's), and 204 with no body, and replays each with its own status; MCP
// answers it as any operation that answers nothing.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { createLogger, createMetrics } from "@fyrden/adapters-cloudflare/obs";
import { createFakeDataset } from "@fyrden/adapters-cloudflare/obs/testing";
import { AUTHENTICATED, defineOperation, NoContent, type OperationDef } from "@fyrden/api-contract";
import { uniqueId } from "@fyrden/testing";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runTool } from "../src/mcp/mount.js";
import type { AuthVariables } from "../src/middleware/auth.js";
import { obs } from "../src/middleware/obs.js";
import { type OpContext, type OpHandler, statusResult } from "../src/ops/execute.js";
import { mountOperation } from "../src/rest/mount.js";
import { user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";

const putOp = defineOperation({
  id: "test.things.put",
  method: "PUT",
  path: "/test-things/{name}",
  summary: "Create or update a thing",
  input: z.object({ name: z.string() }),
  output: NoContent,
  successStatuses: [201, 204],
  permission: AUTHENTICATED,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: { tool: "put_test_thing", title: "Put a thing", description: "Put.", readOnly: false },
});

const createOp = defineOperation({
  id: "test.things.create",
  method: "POST",
  path: "/test-things",
  summary: "Create a thing",
  input: z.object({}),
  output: NoContent,
  successStatus: 201,
  permission: AUTHENTICATED,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});
const createThing = vi.fn(async () => null);

const things = new Set<string>();
const putThing = vi.fn(async (_ctx: OpContext, input: { name: string }) => {
  const created = !things.has(input.name);
  things.add(input.name);
  return statusResult(created ? 201 : 204, null);
});

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use(requestId());
app.use(obs);
mountOperation(app, putOp as OperationDef, putThing as unknown as OpHandler<OperationDef>);
mountOperation(app, createOp as OperationDef, createThing as unknown as OpHandler<OperationDef>);

let owner: Who;

beforeAll(async () => {
  owner = await user();
});

async function put(name: string, key: string) {
  return send("PUT", `/test-things/${name}`, key);
}

async function send(method: string, path: string, key: string) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: "{}",
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return {
    status: res.status,
    replayed: res.headers.get("Idempotent-Replayed"),
    contentType: res.headers.get("Content-Type"),
    body: await res.text(),
  };
}

describe("REST, an operation answering 201 or 204", () => {
  it("answers 201 with {} when it creates and 204 with no body when it updates", async () => {
    const name = uniqueId("thing");
    expect(await put(name, uniqueId("key"))).toEqual({
      status: 201,
      replayed: null,
      contentType: "application/json",
      body: "{}",
    });
    expect(await put(name, uniqueId("key"))).toEqual({
      status: 204,
      replayed: null,
      contentType: null,
      body: "",
    });
  });

  it("replays each answer with its own status", async () => {
    const name = uniqueId("thing");
    const createKey = uniqueId("key");
    const updateKey = uniqueId("key");
    await put(name, createKey);
    await put(name, updateKey);
    const calls = putThing.mock.calls.length;
    expect(await put(name, createKey)).toEqual({
      status: 201,
      replayed: "true",
      contentType: "application/json",
      body: "{}",
    });
    expect(await put(name, updateKey)).toEqual({
      status: 204,
      replayed: "true",
      contentType: null,
      body: "",
    });
    expect(putThing.mock.calls.length).toBe(calls);
  });
});

describe("REST, an operation answering a fixed 201 and nothing else", () => {
  it("answers 201 with {}, and replays it so", async () => {
    const key = uniqueId("key");
    const answer = { status: 201, contentType: "application/json", body: "{}" };
    expect(await send("POST", "/test-things", key)).toEqual({ ...answer, replayed: null });
    const calls = createThing.mock.calls.length;
    expect(await send("POST", "/test-things", key)).toEqual({ ...answer, replayed: "true" });
    expect(createThing.mock.calls.length).toBe(calls);
  });
});

describe("MCP, an operation answering 201 or 204", () => {
  const ctx = (): OpContext => {
    const auth = {
      id: uniqueId("tok"),
      principalType: "user",
      scopes: [],
    } as unknown as TokenRecord;
    return {
      env,
      auth,
      authState: { record: auth, mode: "write", verifyForWrite: vi.fn() },
      log: createLogger({}, () => {}),
      metrics: createMetrics(createFakeDataset().dataset),
      requestId: "req-mcp",
      requestHost: "api.fyrden.test",
      requestOrigin: "https://api.fyrden.test",
      waitUntil: () => {},
    };
  };

  it("answers either status as done, with no structured content", async () => {
    for (const status of [201, 204] as const) {
      const result = await runTool(
        putOp as OperationDef,
        (async () => statusResult(status, null)) as OpHandler<OperationDef>,
        ctx(),
        { name: uniqueId("thing") },
      );
      expect(result).toEqual({ content: [{ type: "text", text: "Done." }] });
    }
  });

  it("answers a status the operation does not declare as an internal error", async () => {
    const result = await runTool(
      putOp as OperationDef,
      (async () => statusResult(205, null)) as OpHandler<OperationDef>,
      ctx(),
      { name: uniqueId("thing") },
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      status: 500,
      code: "internal_error",
    });
  });
});
