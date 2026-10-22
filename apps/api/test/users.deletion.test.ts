// Deleting a user (the transition and the job; the operation comes later):
// the user and their agents can do nothing from the start, every credential
// gone and every handle released and held; then the job deletes their
// repositories, retires them from every account (waiting on an organization
// they solely own), deletes their stars, retires their feeds, and finishes
// once every repository is gone.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { beginUserDeletion } from "../src/accounts/deletion.js";
import {
  DELETION_RUN_POLICY,
  deletionRunHooks,
  rearmDeletions,
  runDeletionSlice,
} from "../src/accounts/deletion-runner.js";
import { setMembershipOperation } from "../src/accounts/orgs.js";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { OpContext } from "../src/ops/execute.js";
import { advanceDeletions } from "../src/repos/deletion.js";
import { api, json, user, type Who } from "./helpers/api.js";

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

afterEach(() => {
  delete deletionRunHooks.beforeCheckpoint;
});

const row = <T>(sql: string, ...args: unknown[]) =>
  env.DIRECTORY.prepare(sql)
    .bind(...args)
    .first<T>();

const lifecycleOf = (id: string) =>
  row<{ lifecycle: string; gen: number; handle: string; disabled: number; admin: number }>(
    `SELECT lifecycle, lifecycle_gen AS gen, handle, disabled_at IS NOT NULL AS disabled,
       is_instance_admin AS admin FROM principals WHERE id = ?`,
    id,
  );

const jobOf = (userId: string) =>
  row<{ step: string; blocked: string | null; attempts: number; next_attempt_at: number }>(
    "SELECT step, blocked, attempts, next_attempt_at FROM user_deletions WHERE user_id = ?",
    userId,
  );

/** Begins deleting `who`, as an administrator. */
async function begin(who: Who): Promise<boolean> {
  const now = await lifecycleOf(who.principalId);
  return beginUserDeletion(
    env.DIRECTORY,
    {
      id: who.principalId,
      lifecycle: (now?.lifecycle ?? "active") as "active",
      gen: now?.gen ?? 0,
    },
    { principalId: admin.principalId, act: [] },
    Date.now(),
  );
}

/** Runs the job (and repository deletions) until it is done or `until` says stop. */
async function runJob(
  userId: string,
  until: (step: string) => boolean = (step) => step === "done",
  runs = 60,
) {
  for (let i = 0; i < runs; i++) {
    const job = await jobOf(userId);
    if (!job || until(job.step)) return job;
    await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
      .bind(userId)
      .run();
    await advanceDeletions(env, { limit: 100 });
    await runDeletionSlice(env, userId);
  }
  return jobOf(userId);
}

async function newOrg(owner: Who) {
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  expect(made.status).toBe(201);
  return { login, id: made.body.id, stub: env.ORG.getByName(made.body.id) };
}

const ok = async (res: Promise<Response>) => expect((await res).status).toBeLessThan(300);

describe("beginning a user's deletion", () => {
  it("stops the user and their agents at once, every credential gone and every handle held", async () => {
    const alice = await user();
    const agent = await json<{ id: string; handle: string }>(
      api("POST", "/agents", alice.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    await ok(api("POST", `/agents/${agent.body.handle}/tokens`, alice.token, {}));
    await ok(
      api("POST", "/grants", alice.token, { agent: agent.body.handle, scopes: ["metadata:read"] }),
    );
    const handle = alice.handle;
    expect(await begin(alice)).toBe(true);
    for (const id of [alice.principalId, agent.body.id])
      expect(await lifecycleOf(id)).toMatchObject({
        lifecycle: "deleting",
        disabled: 1,
        handle: id,
      });
    // Refused at once for writes (reads may come from the 30-second token cache).
    expect((await api("POST", "/user/tokens", alice.token, { type: "pat" })).status).toBe(401);
    const live = await row<{ tokens: number; grants: number }>(
      `SELECT (SELECT count(*) FROM tokens WHERE principal_id IN (?1, ?2) AND revoked_at IS NULL)
         AS tokens,
       (SELECT count(*) FROM grants WHERE (grantor_id = ?1 OR agent_id = ?2) AND revoked_at IS NULL)
         AS grants`,
      alice.principalId,
      agent.body.id,
    );
    expect(live).toEqual({ tokens: 0, grants: 0 });
    const held = await row<{ n: number; until: number }>(
      "SELECT count(*) AS n, min(until) AS until FROM handle_reservations WHERE handle IN (?, ?)",
      handle.toUpperCase(),
      agent.body.handle,
    );
    expect(held?.n).toBe(2);
    expect(held?.until).toBeGreaterThan(Date.now() + 89 * 24 * 60 * 60 * 1000);
    expect(await jobOf(alice.principalId)).toMatchObject({ step: "repositories", blocked: null });
    expect(
      await row(
        "SELECT to_state FROM principal_lifecycle WHERE principal_id = ? ORDER BY gen DESC",
        alice.principalId,
      ),
    ).toEqual({ to_state: "deleting" });
    expect(
      await row(
        "SELECT actor_id FROM audit_log WHERE target_id = ? AND action = 'user.delete'",
        alice.principalId,
      ),
    ).toEqual({ actor_id: admin.principalId });
  });

  it("changes nothing for a user who changed meanwhile, or is being deleted already", async () => {
    const bob = await user();
    const stale = await beginUserDeletion(
      env.DIRECTORY,
      { id: bob.principalId, lifecycle: "active", gen: 7 },
      { principalId: admin.principalId, act: [] },
      Date.now(),
    );
    expect(stale).toBe(false);
    expect(await lifecycleOf(bob.principalId)).toMatchObject({ lifecycle: "active" });
    expect(await begin(bob)).toBe(true);
    expect(await begin(bob)).toBe(false);
  });

  it("never deletes the last active administrator", async () => {
    const other = await user(true);
    // These two are the instance's only administrators (this file's earlier ones step down).
    await env.DIRECTORY.prepare(
      "UPDATE principals SET is_instance_admin = 0 WHERE is_instance_admin = 1 AND id NOT IN (?, ?)",
    )
      .bind(admin.principalId, other.principalId)
      .run();
    expect(await begin(other)).toBe(true);
    // Deleting the one left, as a request checked before the other's deletion began would.
    expect(await begin(admin)).toBe(false);
    expect(await lifecycleOf(admin.principalId)).toMatchObject({ lifecycle: "active", admin: 1 });
  });

  it("deletes a suspended user", async () => {
    const carol = await user();
    await ok(api("PUT", `/users/${carol.handle}/suspended`, admin.token, {}));
    expect(await begin(carol)).toBe(true);
    expect(await lifecycleOf(carol.principalId)).toMatchObject({ lifecycle: "deleting" });
  });
});

describe("a user's deletion", () => {
  it("deletes their repositories and retires them everywhere, then finishes", async () => {
    const alice = await user();
    const bob = await user();
    const own = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", alice.token, { name: uniqueId("own") }),
      )
    ).body;
    const theirs = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", bob.token, { name: uniqueId("theirs") }),
      )
    ).body;
    await ok(
      api("PUT", `/repos/${bob.handle}/${theirs.name}/collaborators/${alice.handle}`, bob.token, {
        permission: "push",
      }),
    );
    await ok(api("PUT", `/user/starred/${bob.handle}/${theirs.name}`, alice.token));
    const org = await newOrg(bob);
    await ok(
      api("PUT", `/orgs/${org.login}/memberships/${alice.handle}`, bob.token, { role: "member" }),
    );
    const agent = await json<{ id: string }>(
      api("POST", "/agents", alice.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    expect(await begin(alice)).toBe(true);
    expect(await runJob(alice.principalId)).toMatchObject({ step: "done" });
    expect(await lifecycleOf(alice.principalId)).toMatchObject({ lifecycle: "deleted", admin: 0 });
    expect(await lifecycleOf(agent.body.id)).toMatchObject({ lifecycle: "deleted" });
    expect(await row("SELECT state FROM repos WHERE id = ?", own.id)).toEqual({ state: "deleted" });
    expect(
      await row<{ n: number }>(
        "SELECT count(*) AS n FROM stars WHERE user_id = ?",
        alice.principalId,
      ),
    ).toEqual({ n: 0 });
    expect(await org.stub.accountRole(alice.principalId)).toBeNull();
    const granted = await runInDurableObject(
      env.ORG.getByName(bob.principalId),
      (_: OrgDO, s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM collaborators WHERE principal_id = ?",
            alice.principalId,
          )
          .one().n,
    );
    expect(granted).toBe(0);
    expect(
      await runInDurableObject(
        env.USER.getByName(alice.principalId),
        (_, s) =>
          s.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM feed_retired").one().n,
      ),
    ).toBe(1);
    expect(
      await row(
        "SELECT to_state FROM principal_lifecycle WHERE principal_id = ? ORDER BY gen DESC",
        alice.principalId,
      ),
    ).toEqual({ to_state: "deleted" });
  });

  it("waits on an organization the user solely owns until another owner is added", async () => {
    const alice = await user();
    const bob = await user();
    const org = await newOrg(alice);
    expect(await begin(alice)).toBe(true);
    expect(
      await runJob(alice.principalId, (step) => step === "accounts" || step === "done"),
    ).toMatchObject({
      step: "accounts",
    });
    const blocked = await runJob(alice.principalId, () => false, 5);
    expect(blocked).toMatchObject({ step: "accounts", blocked: `sole_owner:${org.id}` });
    expect(blocked?.next_attempt_at).toBeGreaterThan(Date.now() + DELETION_RUN_POLICY.waitMs);
    expect(await org.stub.accountRole(alice.principalId)).toBe("owner");
    const runner = env.DELETION.getByName(alice.principalId);
    await runInDurableObject(runner, (_, state) =>
      state.storage.setAlarm(blocked?.next_attempt_at ?? 0),
    );
    // Another organization's handoff leaves the job waiting.
    const other = await newOrg(bob);
    expect(
      (await api("PUT", `/admin/organizations/${other.login}/owners/${admin.handle}`, admin.token))
        .status,
    ).toBe(204);
    expect((await jobOf(alice.principalId))?.next_attempt_at).toBe(blocked?.next_attempt_at);
    const before = Date.now();
    expect(
      (await api("PUT", `/admin/organizations/${org.login}/owners/${bob.handle}`, admin.token))
        .status,
    ).toBe(204);
    // Its handoff wakes the job at once, rather than at its next hourly try.
    expect((await jobOf(alice.principalId))?.next_attempt_at).toBeLessThanOrEqual(Date.now());
    const alarm = await runInDurableObject(runner, (_, state) => state.storage.getAlarm());
    expect(alarm).toBeGreaterThanOrEqual(before);
    expect(alarm).toBeLessThanOrEqual(Date.now());
    expect(await runDurableObjectAlarm(runner)).toBe(true);
    expect(await jobOf(alice.principalId)).toMatchObject({ blocked: null });
    expect(await org.stub.accountRole(alice.principalId)).toBeNull();
    expect(await runJob(alice.principalId)).toMatchObject({ step: "done", blocked: null });
    expect(await org.stub.accountRole(alice.principalId)).toBeNull();
  });

  it("goes on at once when a promotion the user asked for before it began makes another owner", async () => {
    const alice = await user();
    const bob = await user();
    const org = await newOrg(alice);
    // Alice's request, checked before her deletion began, lands while it waits.
    const checked = await new D1TokenStore(env.DIRECTORY, {
      clock: () => Date.now(),
      newId: createIdFactory(() => Date.now(), secureRandomBytes),
      randomBytes: secureRandomBytes,
    }).verify(alice.token, "write");
    if (!checked.ok) throw new Error(`the token is refused: ${checked.reason}`);
    expect(await begin(alice)).toBe(true);
    const blocked = await runJob(alice.principalId, (step) => step === "done", 8);
    expect(blocked).toMatchObject({ step: "accounts", blocked: `sole_owner:${org.id}` });
    const stale = {
      env,
      auth: checked.record,
      requestId: "req_test",
      metrics: { count() {} },
      waitUntil() {},
    } as unknown as OpContext;
    await setMembershipOperation(stale, { org: org.login, username: bob.handle, role: "admin" });
    expect(await org.stub.accountRole(bob.principalId)).toBe("owner");
    expect((await jobOf(alice.principalId))?.next_attempt_at).toBeLessThanOrEqual(Date.now());
  });

  it("deletes a repository that became theirs after it began, before finishing", async () => {
    const alice = await user();
    const bob = await user();
    const late = (
      await json<{ id: string }>(api("POST", "/user/repos", bob.token, { name: uniqueId("late") }))
    ).body;
    expect(await begin(alice)).toBe(true);
    expect(
      await runJob(alice.principalId, (step) => step === "finalize" || step === "done"),
    ).toMatchObject({ step: "finalize" });
    // As a transfer that had moved it to her before her deletion began landing now.
    await env.DIRECTORY.prepare("UPDATE repos SET owner_id = ? WHERE id = ?")
      .bind(alice.principalId, late.id)
      .run();
    expect(await runJob(alice.principalId)).toMatchObject({ step: "done" });
    expect(await row("SELECT state FROM repos WHERE id = ?", late.id)).toEqual({
      state: "deleted",
    });
  });

  it("hands its repositories over around one a transfer is moving, then waits for that one", async () => {
    const alice = await user();
    const made = [];
    for (let i = 0; i < 2; i++)
      made.push(
        (
          await json<{ id: string }>(
            api("POST", "/user/repos", alice.token, { name: uniqueId("r") }),
          )
        ).body.id,
      );
    const [moving, ready] = made.sort() as [string, string];
    // The first is being moved away (its transfer stalled before its move).
    await env.DIRECTORY.prepare(
      `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
         step, requested_by, created_at, updated_at)
       SELECT id, 'trf_stalled', owner_id, name, owner_id, name || '-x', 'freeze', owner_id, 1, 1
       FROM repos WHERE id = ?`,
    )
      .bind(moving)
      .run();
    const share = DELETION_RUN_POLICY.reposPerRun;
    DELETION_RUN_POLICY.reposPerRun = 1;
    try {
      expect(await begin(alice)).toBe(true);
      const waiting = await runJob(alice.principalId, () => false, 4);
      expect(waiting).toMatchObject({ step: "repositories" });
      expect(waiting?.next_attempt_at).toBeGreaterThan(Date.now() + 60_000);
    } finally {
      DELETION_RUN_POLICY.reposPerRun = share;
    }
    expect(await row("SELECT state FROM repos WHERE id = ?", ready)).toEqual({ state: "deleted" });
    expect(await row("SELECT state FROM repos WHERE id = ?", moving)).toEqual({ state: "active" });
  });

  it("waits for a repository deleted before it began whose deletion was reopened since", async () => {
    const alice = await user();
    const old = (
      await json<{ id: string; name: string }>(
        api("POST", "/user/repos", alice.token, { name: uniqueId("old") }),
      )
    ).body;
    expect((await api("DELETE", `/repos/${alice.handle}/${old.name}`, alice.token)).status).toBe(
      200,
    );
    await advanceDeletions(env, { limit: 100 });
    expect(await row("SELECT state FROM repos WHERE id = ?", old.id)).toEqual({ state: "deleted" });
    // A restore of its object reopened its deletion.
    await env.DIRECTORY.prepare(
      "UPDATE repo_deletions SET step = 'prepare', gen = gen + 1 WHERE repo_id = ?",
    )
      .bind(old.id)
      .run();
    expect(await begin(alice)).toBe(true);
    // Not past the barrier while that deletion is held (repository deletions not advanced).
    for (let i = 0; i < 20; i++) {
      await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
        .bind(alice.principalId)
        .run();
      await runDeletionSlice(env, alice.principalId);
    }
    expect(await jobOf(alice.principalId)).toMatchObject({ step: "finalize" });
    expect(await lifecycleOf(alice.principalId)).toMatchObject({ lifecycle: "deleting" });
    expect(await runJob(alice.principalId)).toMatchObject({ step: "done" });
  });

  it("does not finish while a repository's deletion is reopened", async () => {
    const alice = await user();
    const own = (
      await json<{ id: string }>(api("POST", "/user/repos", alice.token, { name: uniqueId("own") }))
    ).body;
    expect(await begin(alice)).toBe(true);
    expect(
      await runJob(alice.principalId, (step) => step === "finalize" || step === "done"),
    ).toMatchObject({
      step: "finalize",
    });
    // As a restore of the repository's object reopens its deletion.
    await env.DIRECTORY.prepare(
      "UPDATE repo_deletions SET step = 'prepare', gen = gen + 1 WHERE repo_id = ?",
    )
      .bind(own.id)
      .run();
    await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
      .bind(alice.principalId)
      .run();
    await runDeletionSlice(env, alice.principalId);
    expect(await jobOf(alice.principalId)).toMatchObject({ step: "finalize" });
    expect(await lifecycleOf(alice.principalId)).toMatchObject({ lifecycle: "deleting" });
    expect(await runJob(alice.principalId)).toMatchObject({ step: "done" });
  });
});

describe("a run of a user's deletion", () => {
  it("saves nothing once it lost its lease", async () => {
    const alice = await user();
    expect(await begin(alice)).toBe(true);
    deletionRunHooks.beforeCheckpoint = async () => {
      // Another run took the job meanwhile.
      await env.DIRECTORY.prepare(
        "UPDATE user_deletions SET lease_id = 'another' WHERE user_id = ?",
      )
        .bind(alice.principalId)
        .run();
    };
    expect(await runDeletionSlice(env, alice.principalId)).toEqual({ next: null });
    expect(
      await row("SELECT step, lease_id FROM user_deletions WHERE user_id = ?", alice.principalId),
    ).toEqual({ step: "repositories", lease_id: "another" });
  });

  it("does nothing before the job is due, or while another run holds it", async () => {
    const alice = await user();
    expect(await begin(alice)).toBe(true);
    await env.DIRECTORY.prepare(
      "UPDATE user_deletions SET lease_id = 'another', lease_until = ? WHERE user_id = ?",
    )
      .bind(Date.now() + 60_000, alice.principalId)
      .run();
    await runDeletionSlice(env, alice.principalId);
    expect(await jobOf(alice.principalId)).toMatchObject({ step: "repositories" });
    await env.DIRECTORY.prepare(
      "UPDATE user_deletions SET lease_id = NULL, lease_until = NULL, next_attempt_at = ? WHERE user_id = ?",
    )
      .bind(Date.now() + 60_000, alice.principalId)
      .run();
    await runDeletionSlice(env, alice.principalId);
    expect(await jobOf(alice.principalId)).toMatchObject({ step: "repositories" });
  });

  it("backs off when it fails", async () => {
    const alice = await user();
    // An account recorded before the deletion, for the accounts step to visit.
    await newOrg(await user());
    expect(await begin(alice)).toBe(true);
    await runJob(alice.principalId, (step) => step === "accounts");
    const failing = new Proxy(env, {
      get(target, prop) {
        if (prop !== "ORG") return Reflect.get(target, prop);
        return {
          getByName: () => ({ retirePrincipals: () => Promise.reject(new Error("down")) }),
        };
      },
    });
    await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = 0 WHERE user_id = ?")
      .bind(alice.principalId)
      .run();
    const before = Date.now();
    const { next } = await runDeletionSlice(failing, alice.principalId);
    expect(next).toBeGreaterThanOrEqual(before + DELETION_RUN_POLICY.backoffMs);
    expect(await jobOf(alice.principalId)).toMatchObject({ step: "accounts", attempts: 1 });
  });

  it("is run by the job's alarm, which sets itself for the next run", async () => {
    const alice = await user();
    expect(await begin(alice)).toBe(true);
    const runner = env.DELETION.getByName(alice.principalId);
    await runner.arm(Date.now());
    expect(await runDurableObjectAlarm(runner)).toBe(true);
    expect((await jobOf(alice.principalId))?.step).not.toBe("repositories");
    // The run, ending, set the alarm for the next.
    const next = await runInDurableObject(runner, (_, state) => state.storage.getAlarm());
    expect(next).toBe((await jobOf(alice.principalId))?.next_attempt_at);
  });

  it("keeps a wake that came while it ran, rather than its own later time", async () => {
    const alice = await user();
    expect(await begin(alice)).toBe(true);
    const later = Date.now() + 60 * 60_000;
    await env.DIRECTORY.prepare("UPDATE user_deletions SET next_attempt_at = ? WHERE user_id = ?")
      .bind(later, alice.principalId)
      .run();
    const runner = env.DELETION.getByName(alice.principalId);
    const wake = Date.now();
    const alarm = await runInDurableObject(runner, async (instance, state) => {
      await state.storage.setAlarm(wake);
      await instance.alarm();
      return state.storage.getAlarm();
    });
    expect(alarm).toBe(wake);
  });
});

describe("the deletions' recovery", () => {
  it("re-arms the job it re-armed longest ago first, whatever their ids", async () => {
    const pair = [await user(), await user()].sort((x, y) =>
      x.principalId < y.principalId ? -1 : 1,
    );
    const [first, second] = pair as [Who, Who];
    for (const who of pair) expect(await begin(who)).toBe(true);
    // Only these two are up; the one with the smaller id was re-armed more recently.
    await env.DIRECTORY.prepare(
      "UPDATE user_deletions SET rearm_after = ?3 WHERE user_id NOT IN (?1, ?2)",
    )
      .bind(first.principalId, second.principalId, Date.now() + 1e9)
      .run();
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("UPDATE user_deletions SET rearm_after = 2 WHERE user_id = ?").bind(
        first.principalId,
      ),
      env.DIRECTORY.prepare("UPDATE user_deletions SET rearm_after = 1 WHERE user_id = ?").bind(
        second.principalId,
      ),
    ]);
    expect(await rearmDeletions(env)).toBe(second.principalId);
    expect(await rearmDeletions(env)).toBe(first.principalId);
  });

  it("re-arms a due job whose alarm was lost, each in turn", async () => {
    const [a, b] = [await user(), await user()];
    for (const who of [a, b]) expect(await begin(who)).toBe(true);
    // Earlier tests' jobs may be due too: take turns until both were re-armed.
    const armed = new Set<string>();
    for (let i = 0; i < 100 && !(armed.has(a.principalId) && armed.has(b.principalId)); i++) {
      const id = await rearmDeletions(env);
      if (id === null) break;
      armed.add(id);
    }
    expect(armed.has(a.principalId) && armed.has(b.principalId)).toBe(true);
    const alarm = await runInDurableObject(env.DELETION.getByName(a.principalId), (_, s) =>
      s.storage.getAlarm(),
    );
    expect(alarm).not.toBeNull();
  });
});
