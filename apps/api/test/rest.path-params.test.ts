// A body field named like a path parameter must name the same thing as the
// path: a handle or an Actions secret or variable name ignoring case, as the
// operations compare them, and anything else (a file path, a ref) exactly.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { AUTHENTICATED, defineOperation, type OperationDef } from "@fyrden/api-contract";
import { uniqueId } from "@fyrden/testing";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthVariables } from "../src/middleware/auth.js";
import { obs } from "../src/middleware/obs.js";
import type { OpHandler } from "../src/ops/execute.js";
import { mountOperation } from "../src/rest/mount.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";

const fileOp = defineOperation({
  id: "test.files.put",
  method: "PUT",
  path: "/test-files/{owner}/{name}/{path+}",
  summary: "Write a file",
  input: z.object({ owner: z.string(), name: z.string(), path: z.string() }),
  output: z.object({ ok: z.boolean() }),
  permission: AUTHENTICATED,
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: false,
});

const putFile = vi.fn(async () => ({ ok: true }));

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use(requestId());
app.use(obs);
mountOperation(app, fileOp as OperationDef, putFile as unknown as OpHandler<OperationDef>);

let owner: Who;

beforeAll(async () => {
  owner = await user();
});

async function put(path: string, body: Record<string, unknown>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`${ORIGIN}/api/test-files/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("a body field named like a path parameter", () => {
  it("must name a file path exactly: another case is another file", async () => {
    putFile.mockClear();
    const refused = await put("Octo/SECRET_A/README.md", { path: "readme.md" });
    expect(refused).toMatchObject({ status: 422, body: { code: "invalid_input" } });
    expect(putFile).not.toHaveBeenCalled();
    expect(await put("Octo/SECRET_A/README.md", { path: "README.md" })).toMatchObject({
      status: 200,
    });
  });

  it("may name an owner or a secret or variable name in another case", async () => {
    putFile.mockClear();
    expect(await put("Octo/SECRET_A/README.md", { owner: "octo", name: "secret_a" })).toMatchObject(
      { status: 200 },
    );
    expect(putFile).toHaveBeenCalledOnce();
    expect(await put("Octo/SECRET_A/README.md", { name: "SECRET_B" })).toMatchObject({
      status: 422,
    });
  });
});

describe("a body field named like a path parameter, on the API's own routes", () => {
  it("may name an account in another case (an administrator's quota)", async () => {
    const admin = await user(true);
    const target = await user();
    const set = await api(
      "PUT",
      `/admin/accounts/${target.handle.toUpperCase()}/quota`,
      admin.token,
      { account: target.handle, max_repos: 5 },
    );
    expect(set.status).toBe(200);
  });

  it("may name an agent in another case", async () => {
    const owner = await user();
    const handle = uniqueId("bot").slice(0, 39);
    expect((await api("POST", "/agents", owner.token, { handle })).status).toBe(201);
    const minted = await api("POST", `/agents/${handle.toUpperCase()}/tokens`, owner.token, {
      agent: handle,
    });
    expect(minted.status).toBe(201);
  });

  it("names a label ignoring the case of ASCII letters only, as labels compare", async () => {
    const owner = await user();
    const repo = await json<{ name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    const path = `/repos/${owner.handle}/${repo.body.name}`;
    for (const name of ["ready", "é"])
      expect(
        await json(api("POST", `${path}/labels`, owner.token, { name, color: "00ff00" })),
      ).toMatchObject({ status: 201 });
    expect(
      await json(
        api("PATCH", `${path}/labels/ready`, owner.token, { name: "READY", color: "ff0000" }),
      ),
    ).toMatchObject({ status: 200 });
    // `É` and `é` are two labels: the body names another one than the path.
    expect(
      await json(
        api("PATCH", `${path}/labels/${encodeURIComponent("é")}`, owner.token, {
          name: "É",
          color: "ff0000",
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "invalid_input" } });
  });

  it("names a file path exactly", async () => {
    const owner = await user();
    const repo = await json<{ name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    expect(
      await json(
        api("PUT", `/repos/${owner.handle}/${repo.body.name}/contents/README.md`, owner.token, {
          path: "readme.md",
          message: "a",
          content: btoa("a"),
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "invalid_input" } });
  });
});
