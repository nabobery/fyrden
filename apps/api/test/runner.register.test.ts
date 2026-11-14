// Registering self-hosted runners: the registration-token operation, the
// runner protocol's Register and Declare, runner authentication, revocation
// and the deployment switch. The switch is a Worker variable, so each call
// runs the app against the test env with it set (or not) for that call.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { generateToken, hashToken, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { countingD1 } from "./helpers/d1.js";
import { principalWithToken } from "./helpers/principals.js";
import {
  decodeFetchTaskResponse,
  decodePingResponse,
  decodeRunnerResponse,
  encodeDeclareRequest,
  encodeFetchTaskRequest,
  encodePingRequest,
  encodeRegisterRequest,
  encodeUpdateLogRequest,
  encodeUpdateTaskRequest,
} from "./helpers/runner-proto.js";
import { logs } from "./setup/log-capture.js";

const ORIGIN = "https://fyrden.test";
const ON: Partial<Env> = { FYRDEN_CI_RUNNERS: "on" } as Partial<Env>;

type Who = { principalId: string; token: string; handle: string };

/** Runs the app against the test env with some bindings replaced. */
async function call(path: string, init: RequestInit, overrides: Partial<Env> = {}) {
  const ctx = createExecutionContext();
  const res = await createApp().fetch(
    new Request(`${ORIGIN}${path}`, init),
    { ...env, ...overrides },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function rest(
  method: string,
  path: string,
  token: string,
  overrides: Partial<Env> = ON,
  body?: unknown,
) {
  return call(
    `/api${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method !== "GET" && {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    overrides,
  );
}

type Credentials = { uuid: string; token: string };

/** A runner protocol call, as the pinned runner sends it. */
function rpc(
  service: string,
  body: Uint8Array,
  options: { credentials?: Credentials; overrides?: Partial<Env>; address?: string } = {},
) {
  return call(
    `/api/actions/${service}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        "CF-Connecting-IP": options.address ?? "198.51.100.20",
        ...(options.credentials && {
          "x-runner-uuid": options.credentials.uuid,
          "x-runner-token": options.credentials.token,
        }),
      },
      body,
    },
    options.overrides ?? ON,
  );
}

const runnerCall = (method: string, body: Uint8Array, options: Parameters<typeof rpc>[2] = {}) =>
  rpc(`runner.v1.RunnerService/${method}`, body, options);

async function connectError(res: Response, code: string, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/json");
  const body = await res.json<{ code: string; message: string }>();
  expect(body.code).toBe(code);
  return body.message;
}

const proto = async (res: Response) => {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/proto");
  return new Uint8Array(await res.arrayBuffer());
};

let admin: Who;

async function who(isAdmin = false): Promise<Who> {
  const p = await principalWithToken("user", "pat", { admin: isAdmin });
  return { ...p, handle: p.principalId.toLowerCase().replace("_", "-") };
}

/** A new organization owned by `owner`, with `members` as members. */
async function newOrg(owner: Who, members: Who[] = []): Promise<{ id: string; login: string }> {
  const login = uniqueId("org").slice(0, 39);
  const res = await rest(
    "POST",
    "/admin/organizations",
    admin.token,
    {},
    {
      login,
      admin: owner.handle,
    },
  );
  expect(res.status).toBe(201);
  for (const member of members)
    expect(
      (
        await rest(
          "PUT",
          `/orgs/${login}/memberships/${member.handle}`,
          owner.token,
          {},
          {
            role: "member",
          },
        )
      ).status,
    ).toBe(200);
  return res.json<{ id: string; login: string }>();
}

async function registrationToken(org: string, owner: Who): Promise<string> {
  const res = await rest("POST", `/orgs/${org}/actions/runners/registration-token`, owner.token);
  expect(res.status).toBe(201);
  const body = await res.json<{ token: string; expires_at: number }>();
  expect(body.token).toMatch(/^fyrden_run_/);
  return body.token;
}

const registerBody = (token: string, more: { labels?: string[]; ephemeral?: boolean } = {}) =>
  encodeRegisterRequest({
    name: uniqueId("runner"),
    token,
    agentLabels: [],
    customLabels: [],
    version: "v6.0.0",
    labels: more.labels ?? ["ubuntu-latest"],
    ephemeral: more.ephemeral ?? false,
    capabilities: ["cancelling"],
  });

async function register(
  org: string,
  owner: Who,
  more: { labels?: string[]; ephemeral?: boolean } = {},
) {
  const res = await runnerCall("Register", registerBody(await registrationToken(org, owner), more));
  const { runner } = decodeRunnerResponse(await proto(res));
  if (!runner) throw new Error("no runner in the answer");
  return runner;
}

const declareBody = (labels: string[]) =>
  encodeDeclareRequest({ version: "v6.0.1", labels, capabilities: ["cancelling"] });

/** Every method a registered runner calls with its credentials, with a valid body for each. */
const AUTHENTICATED: [string, Uint8Array][] = [
  ["Declare", declareBody(["ubuntu-latest"])],
  ["FetchTask", encodeFetchTaskRequest({ tasksVersion: 0 })],
  ["UpdateTask", encodeUpdateTaskRequest({ outputs: new Map() })],
  ["UpdateLog", encodeUpdateLogRequest({ taskId: 1, index: 0, rows: [], noMore: false })],
];

const runnerRows = async (accountId: string) =>
  (
    await env.DIRECTORY.prepare("SELECT * FROM ci_runners WHERE account_id = ? ORDER BY id")
      .bind(accountId)
      .all<Record<string, unknown>>()
  ).results;

beforeAll(async () => {
  admin = await who(true);
});

describe("the deployment switch", () => {
  it("off: Register is failed_precondition and the operation answers 409", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const minted = await rest(
      "POST",
      `/orgs/${org.login}/actions/runners/registration-token`,
      owner.token,
      {},
    );
    expect(minted.status).toBe(409);
    expect((await minted.json<{ code: string; detail: string }>()).detail).toMatch(
      /runner registration is turned off/i,
    );

    // A token minted while the switch was on is refused once it is off.
    const token = await registrationToken(org.login, owner);
    const res = await runnerCall("Register", registerBody(token), { overrides: {} });
    expect(await connectError(res, "failed_precondition", 400)).toBe(
      "runner registration is turned off on this deployment",
    );
    expect(await runnerRows(org.id)).toEqual([]);
  });

  it("Ping answers with the switch off", async () => {
    const res = await rpc("ping.v1.PingService/Ping", encodePingRequest({ data: "my-runner" }), {
      overrides: {},
    });
    expect(decodePingResponse(await proto(res))).toEqual({ data: "Hello, my-runner!" });
  });

  it("off: FetchTask answers no task with the runner's own version", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    const res = await runnerCall("FetchTask", encodeFetchTaskRequest({ tasksVersion: 7 }), {
      credentials: runner,
      overrides: {},
    });
    expect(decodeFetchTaskResponse(await proto(res))).toEqual({ tasksVersion: 7 });
  });
});

describe("registration", () => {
  it("a token the operation mints registers one runner, once", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const token = await registrationToken(org.login, owner);
    const body = registerBody(token, { labels: ["ubuntu-latest", "self-hosted"] });
    const { runner } = decodeRunnerResponse(await proto(await runnerCall("Register", body)));
    expect(runner).toMatchObject({
      name: expect.stringMatching(/^runner/),
      version: "v6.0.0",
      labels: ["ubuntu-latest", "self-hosted"],
      ephemeral: false,
    });
    expect(runner?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(runner?.token).toMatch(/^fyrden_rnr_/);

    const rows = await runnerRows(org.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: runner?.id,
      uuid: runner?.uuid,
      token_hash: await hashToken(runner?.token ?? ""),
      labels: JSON.stringify(["ubuntu-latest", "self-hosted"]),
      declared_at: null,
      revoked_at: null,
    });
    const registration = await env.DIRECTORY.prepare(
      "SELECT account_id, created_by, consumed_at FROM ci_runner_registrations WHERE token_hash = ?",
    )
      .bind(await hashToken(token))
      .first<{ account_id: string; created_by: string; consumed_at: number | null }>();
    expect(registration).toMatchObject({ account_id: org.id, created_by: owner.principalId });
    expect(registration?.consumed_at).not.toBeNull();

    const again = await runnerCall("Register", body);
    await connectError(again, "permission_denied", 403);
    expect(await runnerRows(org.id)).toHaveLength(1);
  });

  it("echoes ephemeral", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner, { ephemeral: true });
    expect(runner.ephemeral).toBe(true);
    expect((await runnerRows(org.id))[0]?.ephemeral).toBe(1);
  });

  it("refuses a token past its hour", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const token = await registrationToken(org.login, owner);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    await connectError(await runnerCall("Register", registerBody(token)), "permission_denied", 403);
    expect(await runnerRows(org.id)).toEqual([]);
  });

  it("refuses a token that expires while its Register body is still arriving", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const token = await registrationToken(org.login, owner);
    // The body is held until the clock has passed the token's hour. With no
    // queue (high-water mark 0) the first pull comes from the handler's read,
    // the signal that it is already reading the body.
    let reading!: () => void;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = registerBody(token);
    let sent = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          if (sent) return controller.close();
          reading();
          await released;
          sent = true;
          controller.enqueue(body);
        },
      },
      { highWaterMark: 0 },
    );
    const answer = call(
      "/api/actions/runner.v1.RunnerService/Register",
      { method: "POST", headers: { "content-type": "application/proto" }, body: stream },
      ON,
    );
    await started;
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    release();
    await connectError(await answer, "permission_denied", 403);
    expect(await runnerRows(org.id)).toEqual([]);
    const registration = await env.DIRECTORY.prepare(
      "SELECT consumed_at FROM ci_runner_registrations WHERE account_id = ?",
    )
      .bind(org.id)
      .first<{ consumed_at: number | null }>();
    expect(registration?.consumed_at).toBeNull();
  });

  it.each([
    ["an unknown registration token", () => generateToken("run", secureRandomBytes)],
    ["a token of another type", () => generateToken("pat", secureRandomBytes)],
    ["a runner credential", () => generateToken("rnr", secureRandomBytes)],
    ["a malformed token", () => "fyrden_run_not-a-token"],
    ["no token", () => ""],
  ])("refuses %s", async (_what, token) => {
    await connectError(
      await runnerCall("Register", registerBody(token())),
      "permission_denied",
      403,
    );
  });

  it("registers exactly one runner when two Register calls race for one token", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const token = await registrationToken(org.login, owner);
    const answers = await Promise.all([
      runnerCall("Register", registerBody(token)),
      runnerCall("Register", registerBody(token)),
    ]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 403]);
    expect(await runnerRows(org.id)).toHaveLength(1);
  });

  it("refuses a Register with no runner name", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const body = encodeRegisterRequest({
      name: "",
      token: await registrationToken(org.login, owner),
      agentLabels: [],
      customLabels: [],
      version: "v6.0.0",
      labels: [],
      ephemeral: false,
      capabilities: [],
    });
    await connectError(await runnerCall("Register", body), "invalid_argument", 400);
    expect(await runnerRows(org.id)).toEqual([]);
  });

  it("refuses a body that is not a protobuf message", async () => {
    await connectError(
      await runnerCall("Register", new Uint8Array([0x0a, 0x7f])),
      "invalid_argument",
      400,
    );
  });
});

describe("Declare", () => {
  it("records the runner's version and labels", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    const res = await runnerCall("Declare", declareBody(["linux", "x64"]), {
      credentials: runner,
    });
    const declared = decodeRunnerResponse(await proto(res)).runner;
    expect(declared).toMatchObject({
      id: runner.id,
      uuid: runner.uuid,
      name: runner.name,
      version: "v6.0.1",
      labels: ["linux", "x64"],
      token: "",
    });
    const [row] = await runnerRows(org.id);
    expect(row).toMatchObject({ version: "v6.0.1", labels: JSON.stringify(["linux", "x64"]) });
    expect(row?.declared_at).not.toBeNull();
  });
});

describe("runner authentication", () => {
  it.each(AUTHENTICATED)(
    "%s refuses missing, unknown and wrong credentials",
    async (method, body) => {
      const owner = await who();
      const org = await newOrg(owner);
      const runner = await register(org.login, owner);
      const refused: (Credentials | undefined)[] = [
        undefined,
        { uuid: crypto.randomUUID(), token: runner.token },
        { uuid: runner.uuid, token: generateToken("rnr", secureRandomBytes) },
        { uuid: runner.uuid, token: "not a token" },
        { uuid: "not-a-uuid", token: runner.token },
      ];
      for (const credentials of refused)
        await connectError(
          await runnerCall(method, body, credentials ? { credentials } : {}),
          "unauthenticated",
          401,
        );
    },
  );

  it("every authenticated method answers unauthenticated once the runner is deleted", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    const deleted = await rest(
      "DELETE",
      `/orgs/${org.login}/actions/runners/${runner.id}`,
      owner.token,
    );
    expect(deleted.status).toBe(204);
    expect((await runnerRows(org.id))[0]?.revoked_at).not.toBeNull();
    for (const [method, body] of AUTHENTICATED)
      for (const overrides of [ON, {}])
        await connectError(
          await runnerCall(method, body, { credentials: runner, overrides }),
          "unauthenticated",
          401,
        );
  });

  it("refuses a runner past its end", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner, { ephemeral: true });
    await env.DIRECTORY.prepare("UPDATE ci_runners SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, runner.id)
      .run();
    for (const [method, body] of AUTHENTICATED)
      await connectError(
        await runnerCall(method, body, { credentials: runner }),
        "unauthenticated",
        401,
      );
  });

  it("answers the methods not served yet as unimplemented after authenticating", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    for (const [method, body] of AUTHENTICATED.slice(1))
      await connectError(
        await runnerCall(method, body, { credentials: runner }),
        "unimplemented",
        501,
      );
  });

  it("over the runner limiter: resource_exhausted before any D1 lookup", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    const count = { queries: 0 };
    const limiter = { limit: vi.fn(async () => ({ success: false })) };
    const overrides = {
      ...ON,
      DIRECTORY: countingD1(env.DIRECTORY, count),
      RATE_LIMIT_RUNNER: limiter as unknown as RateLimit,
    };
    const token = await registrationToken(org.login, owner);
    const calls: [string, Uint8Array, Credentials | undefined][] = [
      ["Register", registerBody(token), undefined],
      ...AUTHENTICATED.map(([m, b]): [string, Uint8Array, Credentials] => [m, b, runner]),
    ];
    for (const [method, body, credentials] of calls)
      await connectError(
        await runnerCall(method, body, {
          overrides,
          address: "203.0.113.9",
          ...(credentials && { credentials }),
        }),
        "resource_exhausted",
        429,
      );
    expect(count.queries).toBe(0);
    expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    expect(limiter.limit).toHaveBeenCalledTimes(calls.length);
    // The token was not spent.
    await proto(await runnerCall("Register", registerBody(token)));
  });

  it("Register spends the sign-in limiter too", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const count = { queries: 0 };
    const token = await registrationToken(org.login, owner);
    const res = await runnerCall("Register", registerBody(token), {
      overrides: {
        ...ON,
        DIRECTORY: countingD1(env.DIRECTORY, count),
        RATE_LIMIT_AUTH: { limit: async () => ({ success: false }) } as unknown as RateLimit,
      },
    });
    await connectError(res, "resource_exhausted", 429);
    expect(count.queries).toBe(0);
  });

  it("logs no token, and names the runner by id and uuid", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    await runnerCall("Declare", declareBody(["linux"]), { credentials: runner });
    const lines = logs.entries().filter((e) => e.runnerUuid === runner.uuid);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((e) => e.runnerId === runner.id)).toBe(true);
    expect(logs.lines.some((line) => line.includes(runner.token))).toBe(false);
  });
});

describe("the runner operations", () => {
  it("list an account's runners, never their tokens, a page at a time", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const first = await register(org.login, owner, { labels: ["a"] });
    const second = await register(org.login, owner, { labels: ["b"], ephemeral: true });
    await runnerCall("Declare", declareBody(["linux"]), { credentials: first });

    const page1 = await rest("GET", `/orgs/${org.login}/actions/runners?per_page=1`, owner.token);
    expect(page1.status).toBe(200);
    const one = await page1.json<{ runners: Record<string, unknown>[]; next_cursor: string }>();
    expect(one.runners).toEqual([
      {
        id: first.id,
        name: first.name,
        labels: ["linux"],
        version: "v6.0.1",
        ephemeral: false,
        created_at: expect.any(Number),
        declared_at: expect.any(Number),
        revoked_at: null,
      },
    ]);
    const page2 = await rest(
      "GET",
      `/orgs/${org.login}/actions/runners?per_page=1&cursor=${one.next_cursor}`,
      owner.token,
    );
    const two = await page2.json<{ runners: Record<string, unknown>[]; next_cursor: null }>();
    expect(two.runners.map((r) => [r.id, r.ephemeral, r.declared_at])).toEqual([
      [second.id, true, null],
    ]);
    expect(two.next_cursor).toBeNull();
    const text = JSON.stringify([one, two]);
    for (const runner of [first, second]) {
      expect(text).not.toContain(runner.token);
      expect(text).not.toContain(runner.uuid);
      expect(text).not.toContain(await hashToken(runner.token));
    }
  });

  it("are refused to a member who is not an owner", async () => {
    const owner = await who();
    const member = await who();
    const org = await newOrg(owner, [member]);
    const runner = await register(org.login, owner);
    const base = `/orgs/${org.login}/actions/runners`;
    for (const [method, path] of [
      ["POST", `${base}/registration-token`],
      ["GET", base],
      ["DELETE", `${base}/${runner.id}`],
    ] as const)
      expect((await rest(method, path, member.token)).status, `${method} ${path}`).toBe(403);
    expect((await runnerRows(org.id))[0]?.revoked_at).toBeNull();
  });

  it("never show or delete another account's runner", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const other = await newOrg(owner);
    const runner = await register(org.login, owner);
    const listed = await rest("GET", `/orgs/${other.login}/actions/runners`, owner.token);
    expect((await listed.json<{ runners: unknown[] }>()).runners).toEqual([]);
    const deleted = await rest(
      "DELETE",
      `/orgs/${other.login}/actions/runners/${runner.id}`,
      owner.token,
    );
    expect(deleted.status).toBe(404);
    expect((await runnerRows(org.id))[0]?.revoked_at).toBeNull();
    // An outsider learns nothing of the organization.
    const outsider = await who();
    expect((await rest("GET", `/orgs/${org.login}/actions/runners`, outsider.token)).status).toBe(
      404,
    );
  });

  it("delete is idempotent and keeps the first revocation time", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    const path = `/orgs/${org.login}/actions/runners/${runner.id}`;
    expect((await rest("DELETE", path, owner.token)).status).toBe(204);
    const revokedAt = (await runnerRows(org.id))[0]?.revoked_at;
    expect((await rest("DELETE", path, owner.token)).status).toBe(204);
    expect((await runnerRows(org.id))[0]?.revoked_at).toBe(revokedAt);
  });

  it("a runner credential is no API token", async () => {
    const owner = await who();
    const org = await newOrg(owner);
    const runner = await register(org.login, owner);
    expect((await rest("GET", "/user", runner.token)).status).toBe(401);
  });
});
