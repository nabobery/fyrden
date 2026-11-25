// The operations that choose which jobs a runner may be given: on a
// registration token, on a runner, and one repository at a time. Owners
// only; every change is audited, and a widening makes idle runners search
// again.
import { env } from "cloudflare:workers";
import { hashToken } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { cancelRegistrations, listRunners } from "../src/runner/registry.js";
import { agentFor } from "./helpers/agents.js";
import { api, user, type Who } from "./helpers/api.js";
import { countingD1, rowCountingD1 } from "./helpers/d1.js";
import { ORIGIN } from "./helpers/git-http.js";
import { callTool } from "./helpers/mcp.js";
import { scopedToken } from "./helpers/principals.js";
import { decodeRunnerResponse, encodeRegisterRequest } from "./helpers/runner-proto.js";
import {
  allow,
  call,
  connectError,
  fetchTask,
  ON,
  type OrgFixture,
  orgRepo,
  pendingOf,
  proto,
  type RegisteredRunner,
  registerRunner,
  runnerCall,
  selectRepos,
  siblingRepo,
  tasksVersionOf,
} from "./helpers/runners.js";
import { advance, job, started, workflow } from "./helpers/runs.js";

interface Runner {
  id: number;
  repository_access: string;
  allows_public: boolean;
  allows_forks: boolean;
  selected_count: number;
  task_assigned_at: number | null;
  revoked_at: number | null;
  repositories?: { id: string; full_name: string; visibility: string }[];
}

const DEFAULT = {
  repository_access: "all",
  allows_public: false,
  allows_forks: false,
  selected_count: 0,
};

const base = (f: { org: { login: string } }) => `/orgs/${f.org.login}/actions/runners`;

async function body<T = Runner>(res: Promise<Response>, status = 200): Promise<T> {
  const answer = await res;
  if (answer.status !== status)
    throw new Error(`expected ${status}, got ${answer.status}: ${await answer.text()}`);
  return answer.json<T>();
}

async function refused(res: Promise<Response>, status: number, code: string) {
  const answer = await res;
  expect([answer.status, (await answer.json<{ code: string }>()).code]).toEqual([status, code]);
}

const get = (f: OrgFixture, runner: { id: number }, who: Who = f.owner) =>
  api("GET", `${base(f)}/${runner.id}`, who.token);

const patch = (f: OrgFixture, runner: { id: number }, change: unknown, token = f.owner.token) =>
  api("PATCH", `${base(f)}/${runner.id}/access`, token, change);

const repoPath = (f: OrgFixture, runner: { id: number }, id: string) =>
  `${base(f)}/${runner.id}/repositories/${id}`;

const mint = (f: OrgFixture, access: unknown) =>
  call(
    `/api${base(f)}/registration-token`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(access),
    },
    ON,
  );

const register = (token: string, ephemeral: boolean, overrides: Partial<Env> = ON) =>
  runnerCall(
    "Register",
    encodeRegisterRequest({
      name: uniqueId("runner"),
      token,
      agentLabels: [],
      customLabels: [],
      version: "v6.0.0",
      labels: ["ubuntu-latest"],
      ephemeral,
      capabilities: [],
    }),
    { overrides },
  );

async function registered(token: string, ephemeral: boolean): Promise<RegisteredRunner> {
  const { runner } = decodeRunnerResponse(await proto(await register(token, ephemeral)));
  if (!runner) throw new Error("no runner");
  return { id: runner.id, uuid: runner.uuid, token: runner.token };
}

interface Audit {
  actor_id: string | null;
  act_chain: string | null;
  action: string;
  details: string;
  request_id: string | null;
}

const auditOf = async (target: string | number, action: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT * FROM audit_log WHERE target_id = ? AND action = ? ORDER BY rowid",
    )
      .bind(String(target), action)
      .all<Audit>()
  ).results.map((row) => ({ ...row, details: JSON.parse(row.details) }));

describe("a registration token's access", () => {
  it("is the default's without any, and nothing of it is the token", async () => {
    const f = await orgRepo();
    const { token } = await body<{ token: string }>(mint(f, {}), 201);
    const runner = await registered(token, false);
    expect(await body(get(f, runner))).toMatchObject({ ...DEFAULT, repositories: [] });
    const [minted] = await auditOf(f.org.id, "ci.runner.registration.create");
    expect(minted).toMatchObject({
      actor_id: f.owner.principalId,
      request_id: expect.any(String),
      details: {
        repository_access: "all",
        selected_repository_ids: [],
        allows_public: false,
        allows_forks: false,
      },
    });
    const [row] = await auditOf(runner.id, "ci.runner.register");
    expect(row).toMatchObject({
      actor_id: f.owner.principalId,
      details: { account_id: f.org.id, ephemeral: false, repository_access: "all" },
    });
    const written = JSON.stringify([minted, row]);
    for (const secret of [token, runner.token, await hashToken(token)])
      expect(written).not.toContain(secret);
  });

  it("is what its runner starts with, so an ephemeral one's first job is the fork's", async () => {
    const f = await orgRepo();
    const yaml = `name: ci\non: pull_request\njobs:\n${job("a")}`;
    const { token } = await body<{ token: string }>(
      mint(f, {
        repository_access: "selected",
        selected_repository_ids: [f.repo.id, f.repo.id],
        allows_forks: true,
      }),
      201,
    );
    const runner = await registered(token, true);
    expect(await body(get(f, runner))).toMatchObject({
      repository_access: "selected",
      allows_public: false,
      allows_forks: true,
      selected_count: 1,
      repositories: [{ id: f.repo.id, full_name: `${f.org.login}/${f.repo.name}` }],
    });
    const runId = await started(f, yaml, {
      event: "pull_request",
      ref: "refs/pull/1/head",
      github: { event_name: "pull_request", workflow: "ci" },
      trust: "untrusted",
      fork: true,
    });
    expect(await pendingOf(runId)).toHaveLength(1);
    expect((await fetchTask(runner, 0)).task).toBeDefined();
    expect(await body(get(f, runner))).toMatchObject({ task_assigned_at: expect.any(Number) });
  });

  it("with fork jobs, registers no long-lived runner, and the refusal spends nothing", async () => {
    const f = await orgRepo();
    const { token } = await body<{ token: string }>(mint(f, { allows_forks: true }), 201);
    expect(await connectError(await register(token, false), "failed_precondition", 400)).toMatch(
      /--ephemeral/,
    );
    const runner = await registered(token, true);
    expect(await body(get(f, runner))).toMatchObject({ allows_forks: true });
    // Spent, and unknown: as before, whatever the token's access was.
    for (const bad of [token, `${token.slice(0, -4)}AAAA`])
      for (const ephemeral of [false, true])
        await connectError(await register(bad, ephemeral), "permission_denied", 403);
  });

  it("names only repositories the organization owns, and drops one that left before Register", async () => {
    const f = await orgRepo();
    const other = await orgRepo();
    await refused(
      mint(f, { repository_access: "selected", selected_repository_ids: [other.repo.id] }),
      422,
      "unknown_repository",
    );
    expect(await auditOf(f.org.id, "ci.runner.registration.create")).toEqual([]);
    await refused(mint(f, { selected_repository_ids: [f.repo.id] }), 422, "invalid_input");
    const sibling = await siblingRepo(f);
    const { token } = await body<{ token: string }>(
      mint(f, {
        repository_access: "selected",
        selected_repository_ids: [f.repo.id, sibling.repo.id],
      }),
      201,
    );
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleting' WHERE id = ?")
      .bind(sibling.repo.id)
      .run();
    const runner = await registered(token, false);
    const { results } = await env.DIRECTORY.prepare(
      "SELECT repo_id FROM ci_runner_repos WHERE runner_id = ?",
    )
      .bind(runner.id)
      .all();
    expect(results).toEqual([{ repo_id: f.repo.id }]);
    expect((await auditOf(runner.id, "ci.runner.register"))[0]?.details).toMatchObject({
      repository_access: "selected",
      selected_repository_ids: [f.repo.id],
    });
  });

  it("given back for want of room, still has its access", async () => {
    const f = await orgRepo();
    const { token } = await body<{ token: string }>(
      mint(f, { allows_forks: true, allows_public: true }),
      201,
    );
    const full = { ...ON, FYRDEN_CI_FLEET: "0" } as Partial<Env>;
    await connectError(await register(token, true, full), "resource_exhausted", 429);
    expect(await body(get(f, await registered(token, true)))).toMatchObject({
      allows_forks: true,
      allows_public: true,
    });
  });

  it("a registration that loses its token's race registers and audits nothing", async () => {
    const f = await orgRepo();
    const { token } = await body<{ token: string }>(mint(f, { allows_public: true }), 201);
    const answers = await Promise.all([register(token, true), register(token, true)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 403]);
    const { results } = await env.DIRECTORY.prepare(
      "SELECT id FROM ci_runners WHERE account_id = ?",
    )
      .bind(f.org.id)
      .all<{ id: number }>();
    expect(results).toHaveLength(1);
    expect(await auditOf(results[0]?.id ?? 0, "ci.runner.register")).toHaveLength(1);
  });
});

describe("cancelling registration tokens", () => {
  const cancel = (f: OrgFixture, token = f.owner.token) =>
    api("DELETE", `${base(f)}/registration-token`, token);
  const minted = async (f: OrgFixture, access: unknown = {}) =>
    (await body<{ token: string }>(mint(f, access), 201)).token;

  it("ends every unused token of the organization, whatever its access, and no other's", async () => {
    const f = await orgRepo();
    const other = await orgRepo();
    const unused = [
      await minted(f),
      await minted(f, { allows_forks: true, allows_public: true }),
      await minted(f, { repository_access: "selected", selected_repository_ids: [f.repo.id] }),
    ];
    const used = await minted(f);
    const runner = await registered(used, false);
    const theirs = await minted(other);
    expect(await body(cancel(f))).toEqual({ cancelled: 3 });
    for (const token of [...unused, used])
      for (const ephemeral of [false, true])
        await connectError(await register(token, ephemeral), "permission_denied", 403);
    // What registered before stays, as does another organization's token; a new one registers.
    expect(await body(get(f, runner))).toMatchObject({ revoked_at: null });
    await registered(theirs, false);
    await registered(await minted(f), false);
  });

  it("is audited with how many, and audits nothing when there is none", async () => {
    const f = await orgRepo();
    expect(await body(cancel(f))).toEqual({ cancelled: 0 });
    expect(await auditOf(f.org.id, "ci.runner.registration.cancel")).toEqual([]);
    const token = await minted(f);
    const expired = await minted(f);
    await env.DIRECTORY.prepare(
      "UPDATE ci_runner_registrations SET expires_at = 1 WHERE token_hash = ?",
    )
      .bind(await hashToken(expired))
      .run();
    expect(await body(cancel(f))).toEqual({ cancelled: 1 });
    const rows = await auditOf(f.org.id, "ci.runner.registration.cancel");
    expect(rows).toMatchObject([
      {
        actor_id: f.owner.principalId,
        request_id: expect.any(String),
        details: { cancelled: 1 },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(await hashToken(token));
    expect(await body(cancel(f))).toEqual({ cancelled: 0 });
    expect(await auditOf(f.org.id, "ci.runner.registration.cancel")).toHaveLength(1);
  });

  it("ends a token given back for want of room", async () => {
    const f = await orgRepo();
    const token = await minted(f);
    const full = { ...ON, FYRDEN_CI_FLEET: "0" } as Partial<Env>;
    await connectError(await register(token, false, full), "resource_exhausted", 429);
    expect(await body(cancel(f))).toEqual({ cancelled: 1 });
    await connectError(await register(token, false), "permission_denied", 403);
  });

  it("repeated with its idempotency key, ends no token made since and audits nothing more", async () => {
    const f = await orgRepo();
    await minted(f);
    const key = crypto.randomUUID();
    const keyed = () =>
      call(`/api${base(f)}/registration-token`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${f.owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
      });
    expect(await body(keyed())).toEqual({ cancelled: 1 });
    const later = await minted(f);
    expect(await body(keyed())).toEqual({ cancelled: 1 });
    expect(await auditOf(f.org.id, "ci.runner.registration.cancel")).toHaveLength(1);
    await registered(later, false);
  });

  it("is an owner's: a member, an agent and an outsider change nothing", async () => {
    const f = await orgRepo();
    const token = await minted(f);
    const member = await user();
    await api("PUT", `/orgs/${f.org.login}/memberships/${member.handle}`, f.owner.token, {
      role: "member",
    });
    const agent = await agentFor(f.owner, ["self_hosted_runners:read"]);
    for (const [who, status] of [
      [member.token, 403],
      [(await user()).token, 404],
      [agent.own, 403],
      [agent.delegated, 403],
    ] as const)
      expect((await cancel(f, who)).status).toBe(status);
    await registered(token, false);
  });

  it("reads no used or expired token", async () => {
    const f = await orgRepo();
    const rows = { read: 0, written: 0 };
    const counted = rowCountingD1(env.DIRECTORY, rows);
    const run = () =>
      cancelRegistrations(counted, {
        accountId: f.org.id,
        now: 1_000,
        actor: { principalId: "usr_test", requestId: "req_test" },
      });
    await run();
    const before = rows.read;
    await env.DIRECTORY.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO ci_runner_registrations (token_hash, account_id, created_by, created_at, expires_at, consumed_at)
       SELECT ?1 || i, ?1, 'u', 1, CASE i % 2 WHEN 0 THEN 999 ELSE 5000 END, CASE i % 2 WHEN 0 THEN NULL ELSE 2 END FROM n`,
    )
      .bind(f.org.id)
      .run();
    await run();
    expect(rows.read - before).toBeLessThanOrEqual(before + 2);
  });
});

describe("changing a runner's access", () => {
  it("changes what is given, keeps the rest, and audits before and after", async () => {
    const f = await orgRepo();
    const sibling = await siblingRepo(f);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    expect(await body(patch(f, runner, { allows_public: true }))).toMatchObject({
      ...DEFAULT,
      allows_public: true,
    });
    const both = [f.repo.id, sibling.repo.id];
    expect(
      await body(
        patch(f, runner, {
          repository_access: "selected",
          selected_repository_ids: both,
          allows_forks: true,
        }),
      ),
    ).toMatchObject({
      repository_access: "selected",
      allows_public: true,
      allows_forks: true,
      selected_count: 2,
    });
    expect(
      await body(patch(f, runner, { selected_repository_ids: [sibling.repo.id] })),
    ).toMatchObject({ selected_count: 1, repositories: [{ id: sibling.repo.id }] });
    expect(
      await body(patch(f, runner, { repository_access: "all", allows_forks: false })),
    ).toMatchObject({ ...DEFAULT, allows_public: true, repositories: [] });

    const rows = await auditOf(runner.id, "ci.runner.access");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.actor_id === f.owner.principalId && r.request_id)).toBe(true);
    expect(rows[1]?.details).toEqual({
      account_id: f.org.id,
      before: {
        repository_access: "all",
        allows_public: true,
        allows_forks: false,
        selected_repository_ids: [],
      },
      after: {
        repository_access: "selected",
        allows_public: true,
        allows_forks: true,
        selected_repository_ids: both,
      },
    });
    expect(rows[3]?.details.after).toEqual({
      repository_access: "all",
      allows_public: true,
      allows_forks: false,
      selected_repository_ids: [],
    });
  });

  it("refuses what a runner cannot have, changing and auditing nothing", async () => {
    const f = await orgRepo();
    const other = await orgRepo();
    const longLived = await registerRunner(f.org.login, f.owner);
    const ephemeral = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const version = await tasksVersionOf(f.org.id);
    await refused(
      patch(f, longLived, { allows_forks: true, allows_public: true }),
      422,
      "forks_need_ephemeral",
    );
    await refused(
      patch(f, ephemeral, { selected_repository_ids: [f.repo.id] }),
      409,
      "access_not_selected",
    );
    await refused(
      patch(f, ephemeral, { repository_access: "all", selected_repository_ids: [f.repo.id] }),
      409,
      "access_not_selected",
    );
    await refused(
      patch(f, ephemeral, {
        repository_access: "selected",
        selected_repository_ids: [f.repo.id, other.repo.id],
      }),
      422,
      "unknown_repository",
    );
    await refused(patch(f, ephemeral, {}), 422, "invalid_input");
    await refused(
      patch(f, ephemeral, {
        repository_access: "selected",
        selected_repository_ids: Array.from({ length: 101 }, (_, i) => `r${i}`),
      }),
      422,
      "invalid_input",
    );
    await refused(patch(f, { id: 2 ** 40 }, { allows_public: true }), 404, "runner_not_found");
    await refused(patch(other, ephemeral, { allows_public: true }), 404, "runner_not_found");
    for (const runner of [longLived, ephemeral]) {
      expect(await body(get(f, runner))).toMatchObject(DEFAULT);
      expect(await auditOf(runner.id, "ci.runner.access")).toEqual([]);
    }
    expect(await tasksVersionOf(f.org.id)).toBe(version);
  });

  it.each([
    ["deleted", "revoked_at = 5, revoked_reason = 'deleted'"],
    ["past its end", "expires_at = 5"],
  ])("refuses one that is %s, so its access stays cleared", async (_, gone) => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    await env.DIRECTORY.prepare(`UPDATE ci_runners SET ${gone} WHERE id = ?`).bind(runner.id).run();
    await refused(patch(f, runner, { allows_public: true }), 409, "runner_revoked");
    await refused(api("PUT", repoPath(f, runner, f.repo.id), f.owner.token), 409, "runner_revoked");
    await refused(
      api("DELETE", repoPath(f, runner, f.repo.id), f.owner.token),
      409,
      "runner_revoked",
    );
    expect(await body(get(f, runner))).toMatchObject(DEFAULT);
  });

  it("makes idle runners search again when it widens, and not when it narrows", async () => {
    const f = await orgRepo();
    const sibling = await siblingRepo(f);
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    let version = await tasksVersionOf(f.org.id);
    const bumps = async (change: unknown) => {
      await body(patch(f, runner, change));
      const now = await tasksVersionOf(f.org.id);
      const bumped = now - version;
      version = now;
      return bumped;
    };
    expect(await bumps({ allows_public: true })).toBe(1);
    expect(await bumps({ allows_public: true })).toBe(0);
    expect(await bumps({ allows_public: false })).toBe(0);
    expect(await bumps({ allows_forks: true })).toBe(1);
    expect(
      await bumps({ repository_access: "selected", selected_repository_ids: [f.repo.id] }),
    ).toBe(0);
    expect(await bumps({ selected_repository_ids: [f.repo.id, sibling.repo.id] })).toBe(1);
    expect(await bumps({ selected_repository_ids: [sibling.repo.id] })).toBe(0);
    expect(await bumps({ selected_repository_ids: [f.repo.id] })).toBe(1);
    expect(await bumps({ repository_access: "selected", allows_forks: false })).toBe(0);
    expect(await bumps({ repository_access: "all" })).toBe(1);
  });

  it("an idle runner that was narrowed out of a published job takes it once widened", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    await selectRepos(runner, []);
    const runId = await started(f, workflow(job("a")));
    expect(await pendingOf(runId)).toHaveLength(1);
    const idle = await fetchTask(runner, 0);
    expect(idle.task).toBeUndefined();
    expect((await fetchTask(runner, idle.tasksVersion)).task).toBeUndefined();
    await body(patch(f, runner, { repository_access: "all" }));
    expect((await fetchTask(runner, idle.tasksVersion)).task).toBeDefined();
  });

  it("a public repository's waiting job is published within five minutes of the opt-in", async () => {
    const f = await orgRepo();
    await env.DIRECTORY.prepare("UPDATE repos SET visibility = 'public' WHERE id = ?")
      .bind(f.repo.id)
      .run();
    const runner = await registerRunner(f.org.login, f.owner);
    const runId = await started(f, workflow(job("a")));
    expect(await pendingOf(runId)).toEqual([]);
    await body(patch(f, runner, { allows_public: true }));
    await advance(runId, 5 * 60_000);
    expect(await pendingOf(runId)).toHaveLength(1);
    expect((await fetchTask(runner, 0)).task).toBeDefined();
  });
});

describe("one repository of a selected runner", () => {
  it("is added and removed, once each, audited, and only an addition wakes runners", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    await refused(
      api("PUT", repoPath(f, runner, f.repo.id), f.owner.token),
      409,
      "access_not_selected",
    );
    await refused(
      api("DELETE", repoPath(f, runner, f.repo.id), f.owner.token),
      409,
      "access_not_selected",
    );
    await body(patch(f, runner, { repository_access: "selected" }));
    const version = await tasksVersionOf(f.org.id);
    for (let i = 0; i < 2; i++)
      expect((await api("PUT", repoPath(f, runner, f.repo.id), f.owner.token)).status).toBe(204);
    expect(await body(get(f, runner))).toMatchObject({ selected_count: 1 });
    expect(await tasksVersionOf(f.org.id)).toBe(version + 1);
    for (let i = 0; i < 2; i++)
      expect((await api("DELETE", repoPath(f, runner, f.repo.id), f.owner.token)).status).toBe(204);
    expect(await body(get(f, runner))).toMatchObject({ selected_count: 0 });
    expect(await tasksVersionOf(f.org.id)).toBe(version + 1);
    const rows = await auditOf(runner.id, "ci.runner.access");
    const snapshot = (ids: string[]) => ({
      repository_access: "selected",
      allows_public: false,
      allows_forks: false,
      selected_repository_ids: ids,
    });
    expect(rows.map((r) => r.details).slice(1)).toEqual([
      { account_id: f.org.id, before: snapshot([]), after: snapshot([f.repo.id]) },
      { account_id: f.org.id, before: snapshot([f.repo.id]), after: snapshot([]) },
    ]);
  });

  it("is one of the organization's, and there are 100 at most", async () => {
    const f = await orgRepo();
    const other = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    await selectRepos(runner, []);
    for (const id of [other.repo.id, "rep_none"])
      await refused(api("PUT", repoPath(f, runner, id), f.owner.token), 422, "unknown_repository");
    await env.DIRECTORY.batch(
      Array.from({ length: 100 }, (_, i) => [
        env.DIRECTORY.prepare(
          `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at, updated_at)
           VALUES (?1, ?2, ?1, ?1, 's', 'private', 'active', 1, 1)`,
        ).bind(`${f.repo.id}-${i}`, f.org.id),
        env.DIRECTORY.prepare("INSERT INTO ci_runner_repos VALUES (?, ?)").bind(
          runner.id,
          `${f.repo.id}-${i}`,
        ),
      ]).flat(),
    );
    await refused(
      api("PUT", repoPath(f, runner, f.repo.id), f.owner.token),
      422,
      "too_many_repositories",
    );
    // One already listed is there; a deleted one takes no room.
    expect((await api("PUT", repoPath(f, runner, `${f.repo.id}-3`), f.owner.token)).status).toBe(
      204,
    );
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleted' WHERE id = ?")
      .bind(`${f.repo.id}-7`)
      .run();
    expect((await api("PUT", repoPath(f, runner, f.repo.id), f.owner.token)).status).toBe(204);
    // Its row went with the change, so what is stored, and audited, stays within the limit.
    const stored = () =>
      env.DIRECTORY.prepare("SELECT count(*) AS n FROM ci_runner_repos WHERE runner_id = ?")
        .bind(runner.id)
        .first<number>("n");
    expect(await stored()).toBe(100);
    await env.DIRECTORY.prepare("UPDATE repos SET state = 'deleted' WHERE id LIKE ?")
      .bind(`${f.repo.id}-1%`)
      .run();
    await body(patch(f, runner, { allows_public: true }));
    const left = await stored();
    expect(left).toBeLessThan(100);
    const audited = (await auditOf(runner.id, "ci.runner.access")).at(-1)?.details;
    expect(audited.before.selected_repository_ids).toHaveLength(left ?? 0);
    expect(audited.after.selected_repository_ids).toHaveLength(left ?? 0);
  });

  it("that left the organization shows in no runner", async () => {
    const f = await orgRepo();
    const other = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    await selectRepos(runner, [f.repo.id]);
    await env.DIRECTORY.prepare("UPDATE repos SET owner_id = ? WHERE id = ?")
      .bind(other.org.id, f.repo.id)
      .run();
    expect(await body(get(f, runner))).toMatchObject({ selected_count: 0, repositories: [] });
  });
});

describe("listing, reading and deleting", () => {
  it("lists serving or revoked runners alone, with their access", async () => {
    const f = await orgRepo();
    const ids = [];
    for (let i = 0; i < 5; i++)
      ids.push((await registerRunner(f.org.login, f.owner, { ephemeral: true })).id);
    await allow({ id: ids[4] as number }, { public: true, forks: true });
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        "UPDATE ci_runners SET revoked_at = 5, revoked_reason = 'deleted' WHERE id = ?",
      ).bind(ids[1]),
      env.DIRECTORY.prepare("UPDATE ci_runners SET expires_at = 5 WHERE id = ?").bind(ids[2]),
    ]);
    const list = async (query: string) =>
      body<{ runners: Runner[]; next_cursor: string | null }>(
        api("GET", `${base(f)}?${query}`, f.owner.token),
      );
    const idsOf = async (query: string) => (await list(query)).runners.map((r) => r.id);
    expect(await idsOf("")).toEqual(ids);
    expect(await idsOf("status=all")).toEqual(ids);
    expect(await idsOf("status=serving")).toEqual([ids[0], ids[3], ids[4]]);
    expect(await idsOf("status=revoked")).toEqual([ids[1], ids[2]]);
    const page = await list("status=serving&per_page=2");
    expect(page.runners.map((r) => r.id)).toEqual([ids[0], ids[3]]);
    const rest = await list(`status=serving&per_page=2&cursor=${page.next_cursor}`);
    expect(rest.runners).toMatchObject([
      { id: ids[4], allows_public: true, allows_forks: true, task_assigned_at: null },
    ]);
    expect(rest.next_cursor).toBeNull();
    await refused(api("GET", `${base(f)}?status=online`, f.owner.token), 422, "invalid_input");
  });

  it("serving runners are found without reading revoked history", async () => {
    const f = await orgRepo();
    await registerRunner(f.org.login, f.owner);
    const rows = { read: 0, written: 0 };
    const counted = rowCountingD1(env.DIRECTORY, rows);
    const page = { accountId: f.org.id, afterId: 0, limit: 31, now: Date.now() };
    await listRunners(counted, { ...page, status: "serving" });
    const before = rows.read;
    await env.DIRECTORY.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
       INSERT INTO ci_runners (uuid, account_id, token_hash, name, ephemeral, created_at, revoked_at)
       SELECT ?1 || i, ?1, 'h', 'r', 1, 1, 2 FROM n`,
    )
      .bind(f.org.id)
      .run();
    await listRunners(counted, { ...page, status: "serving" });
    expect(rows.read - before).toBe(before);
  });

  it("a delete is audited once, a runner of another organization never shown or deleted", async () => {
    const f = await orgRepo();
    const other = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    await allow(runner, { public: true });
    await refused(get(other, runner), 404, "runner_not_found");
    await refused(
      api("DELETE", `${base(other)}/${runner.id}`, other.owner.token),
      404,
      "runner_not_found",
    );
    expect(await auditOf(runner.id, "ci.runner.delete")).toEqual([]);
    for (let i = 0; i < 2; i++)
      expect((await api("DELETE", `${base(f)}/${runner.id}`, f.owner.token)).status).toBe(204);
    expect(await auditOf(runner.id, "ci.runner.delete")).toMatchObject([
      { actor_id: f.owner.principalId, details: { account_id: f.org.id } },
    ]);
    expect(await body(get(f, runner))).toMatchObject({
      ...DEFAULT,
      revoked_at: expect.any(Number),
    });
  });
});

describe("who may", () => {
  it("owners alone: no member, repository admin, outsider, agent, delegated or under-scoped token", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner, { ephemeral: true });
    const member = await user();
    expect(
      (
        await api("PUT", `/orgs/${f.org.login}/memberships/${member.handle}`, f.owner.token, {
          role: "member",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api("PUT", `${f.path}/collaborators/${member.handle}`, f.owner.token, {
          permission: "admin",
        })
      ).status,
    ).toBeLessThan(300);
    const outsider = await user();
    const instanceAdmin = await user(true);
    const agent = await agentFor(f.owner, ["metadata:read"]);
    const unscoped = await scopedToken(f.owner.principalId, ["metadata:read"]);
    const calls: [string, string, unknown?][] = [
      ["GET", base(f)],
      ["GET", `${base(f)}/${runner.id}`],
      ["POST", `${base(f)}/registration-token`, { allows_public: true }],
      ["DELETE", `${base(f)}/registration-token`],
      ["PATCH", `${base(f)}/${runner.id}/access`, { allows_public: true }],
      ["PUT", repoPath(f, runner, f.repo.id)],
      ["DELETE", repoPath(f, runner, f.repo.id)],
      ["DELETE", `${base(f)}/${runner.id}`],
    ];
    for (const [who, token, statuses] of [
      ["member and repository admin", member.token, [403]],
      ["outsider", outsider.token, [404]],
      ["instance admin", instanceAdmin.token, [404]],
      // Its own token acts for nobody: no runner operation but a read is an agent's at all.
      ["agent", agent.own, [403, 404]],
      ["delegated token", agent.delegated, [403]],
      ["under-scoped token", unscoped, [403]],
    ] as const)
      for (const [method, path, input] of calls) {
        const answer = await api(method, path, token, input);
        expect([who, method, path, statuses.some((s) => s === answer.status)]).toEqual([
          who,
          method,
          path,
          true,
        ]);
      }
    for (const token of [
      agent.own,
      (await agentFor(f.owner, ["metadata:read"], undefined, `${ORIGIN}/mcp`)).delegated,
    ])
      for (const [tool, input] of [
        ["list_org_runners", {}],
        ["get_org_runner", { runner_id: runner.id }],
        ["update_org_runner_access", { runner_id: runner.id, allows_public: true }],
        ["add_org_runner_repo", { runner_id: runner.id, repository_id: f.repo.id }],
        ["remove_org_runner_repo", { runner_id: runner.id, repository_id: f.repo.id }],
        ["delete_org_runner", { runner_id: runner.id }],
        ["cancel_org_runner_registration_tokens", {}],
      ] as const)
        expect([
          tool,
          (await callTool(token, tool, { org: f.org.login, ...input })).isError,
        ]).toEqual([tool, true]);
    expect(await body(get(f, runner))).toMatchObject({ ...DEFAULT, revoked_at: null });
    expect(await auditOf(runner.id, "ci.runner.access")).toEqual([]);
  });

  it("an agent acting for an owner who granted it may read runners, and change nothing", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const scopes = ["self_hosted_runners:read"];
    const agent = await agentFor(f.owner, scopes);
    const overMcp = (await agentFor(f.owner, scopes, undefined, `${ORIGIN}/mcp`)).delegated;
    const list = await body<{ runners: Runner[] }>(api("GET", base(f), agent.delegated));
    expect(list.runners.map((r) => r.id)).toEqual([runner.id]);
    expect(await body(api("GET", `${base(f)}/${runner.id}`, agent.delegated))).toMatchObject(
      DEFAULT,
    );
    for (const [tool, input] of [
      ["list_org_runners", {}],
      ["get_org_runner", { runner_id: runner.id }],
    ] as const) {
      const answer = await callTool(overMcp, tool, { org: f.org.login, ...input });
      expect([tool, answer.isError]).toEqual([tool, false]);
      expect(answer.text).not.toContain(runner.token);
    }
    for (const [method, path, input] of [
      ["POST", `${base(f)}/registration-token`, {}],
      ["DELETE", `${base(f)}/registration-token`],
      ["PATCH", `${base(f)}/${runner.id}/access`, { allows_public: true }],
      ["PUT", repoPath(f, runner, f.repo.id)],
      ["DELETE", repoPath(f, runner, f.repo.id)],
      ["DELETE", `${base(f)}/${runner.id}`],
    ] as const)
      expect((await api(method, path, agent.delegated, input)).status, `${method} ${path}`).toBe(
        403,
      );
    expect(await body(get(f, runner))).toMatchObject({ ...DEFAULT, revoked_at: null });
  });

  it("an agent reads no more than the person it acts for", async () => {
    const f = await orgRepo();
    await registerRunner(f.org.login, f.owner);
    const member = await user();
    await api("PUT", `/orgs/${f.org.login}/memberships/${member.handle}`, f.owner.token, {
      role: "member",
    });
    const scopes = ["self_hosted_runners:read"];
    expect((await api("GET", base(f), (await agentFor(member, scopes)).delegated)).status).toBe(
      403,
    );
    expect(
      (await api("GET", base(f), (await agentFor(await user(), scopes)).delegated)).status,
    ).toBe(404);
    // Its own token acts for nobody, so it belongs to no organization.
    expect((await api("GET", base(f), (await agentFor(f.owner, scopes)).own)).status).not.toBe(200);
  });

  it("an owner over MCP reads and changes access, and no tool makes a registration token", async () => {
    const f = await orgRepo();
    const runner = await registerRunner(f.org.login, f.owner);
    const changed = await callTool(f.owner.token, "update_org_runner_access", {
      org: f.org.login,
      runner_id: runner.id,
      allows_public: true,
    });
    expect(changed.isError ?? false).toBe(false);
    expect(await body(get(f, runner))).toMatchObject({ allows_public: true });
    expect(await auditOf(runner.id, "ci.runner.access")).toHaveLength(1);
  });

  it("a user's namespace has no runners to read or change", async () => {
    const owner = await user();
    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/1"],
      ["PATCH", "/1/access"],
    ] as const)
      await refused(
        api(
          method,
          `/orgs/${owner.handle}/actions/runners${path}`,
          owner.token,
          method === "PATCH" ? { allows_public: true } : undefined,
        ),
        404,
        "org_not_found",
      );
  });
});

describe("what Register costs", () => {
  it("an ephemeral or default registration asks no more than one batch", async () => {
    const f = await orgRepo();
    const { token } = await body<{ token: string }>(mint(f, {}), 201);
    const count = { queries: 0, calls: 0 };
    await proto(
      await register(token, true, {
        ...ON,
        DIRECTORY: countingD1(env.DIRECTORY, count),
      } as Partial<Env>),
    );
    expect(count.calls).toBe(1);
  });
});
