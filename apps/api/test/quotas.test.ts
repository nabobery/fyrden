// Quotas: how many repositories an account may have and how many bytes its
// repositories' pushes may store. Storage is reserved before a push is
// stored and charged at its commit; a push that commits nothing gives it
// back, and a deleted repository's storage is free again.

import { createScheduledController, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it, vi } from "vitest";
import { OrgDO } from "../src/do/OrgDO.js";
import { QUOTA_DEFAULTS } from "../src/do/org/quotas.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import worker from "../src/index.js";
import { forkRepository } from "../src/network/fork.js";
import {
  heldBack,
  newRepoStatements,
  type RepoEntry,
  resolveRepo,
} from "../src/repos/directory.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { holdAfterRunPush, type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Quota = {
  account: string;
  max_repos: number;
  repos: number;
  max_storage_bytes: number;
  storage_bytes: number;
  reserved_bytes: number;
};

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

const quota = async (who: Who) => (await json<Quota>(api("GET", "/user/quota", who.token))).body;

const setQuota = (who: Who, limits: Record<string, number | null>) =>
  json<Quota>(api("PUT", `/admin/accounts/${who.handle}/quota`, admin.token, limits));

const createRepo = (who: Who, name = uniqueId("q")) =>
  json<{ id: string; name: string; code?: string }>(
    api("POST", "/user/repos", who.token, { name }),
  );

async function target(who: Who, repo: { id: string; name: string }): Promise<PushTarget> {
  return {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: { principalId: who.principalId, token: await scopedToken(who.principalId, [], "git") },
    path: `/${who.handle}/${repo.name}.git`,
  };
}

const firstPush = () =>
  pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 });

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("repository quota", () => {
  it("defaults to the instance's limits and counts active repositories", async () => {
    const owner = await user();
    await createRepo(owner);
    expect(await quota(owner)).toEqual({
      account: owner.handle,
      max_repos: QUOTA_DEFAULTS.maxRepos,
      repos: 1,
      max_storage_bytes: QUOTA_DEFAULTS.maxStorageBytes,
      storage_bytes: 0,
      reserved_bytes: 0,
    });
  });

  it("refuses a create or fork past the limit, and counts a deleted repository no more", async () => {
    const owner = await user();
    const first = await createRepo(owner);
    expect(await setQuota(owner, { max_repos: 1 })).toMatchObject({
      status: 200,
      body: { max_repos: 1, repos: 1 },
    });
    expect(await createRepo(owner)).toMatchObject({
      status: 403,
      body: { code: "quota_exceeded" },
    });
    const fork = await json<{ code: string }>(
      api("POST", `/repos/${owner.handle}/${first.body.name}/forks`, owner.token, {
        name: uniqueId("f"),
      }),
    );
    expect(fork).toMatchObject({ status: 403, body: { code: "quota_exceeded" } });
    expect(
      (await api("DELETE", `/repos/${owner.handle}/${first.body.name}`, owner.token)).status,
    ).toBe(200);
    expect((await createRepo(owner)).status).toBe(201);
    // Back to the default.
    expect((await setQuota(owner, { max_repos: null })).body.max_repos).toBe(
      QUOTA_DEFAULTS.maxRepos,
    );
  });

  it("hands a fork that loses the race for the last slot to the deletion", async () => {
    const owner = await user();
    const parent = (await createRepo(owner)).body;
    const entry = await resolveRepo(env, owner.handle, parent.name, { consistency: "primary" });
    // As if another create took the last slot after the fork's own check.
    const result = await forkRepository(env, {
      parent: entry as RepoEntry,
      ownerId: owner.principalId,
      ownerHandle: owner.handle,
      name: uniqueId("f"),
      maxRepos: 1,
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: "quota_exceeded" });
    const forkId = (
      await env.DIRECTORY.prepare("SELECT id FROM repos WHERE owner_id = ? AND id = name")
        .bind(owner.principalId)
        .first<{ id: string }>()
    )?.id as string;
    const deletion = await env.DIRECTORY.prepare(
      "SELECT r.state, d.step FROM repos r JOIN repo_deletions d ON d.repo_id = r.id WHERE r.id = ?",
    )
      .bind(forkId)
      .first<{ state: string; step: string }>();
    expect(deletion).toEqual({ state: "deleted", step: "done" });
    expect((await quota(owner)).repos).toBe(1);
  });

  it("hands a fork that loses the race for its name to the deletion", async () => {
    const owner = await user();
    const parent = (await createRepo(owner)).body;
    const taken = (await createRepo(owner)).body.name;
    const entry = await resolveRepo(env, owner.handle, parent.name, { consistency: "primary" });
    const result = await forkRepository(env, {
      parent: entry as RepoEntry,
      ownerId: owner.principalId,
      ownerHandle: owner.handle,
      name: taken.toUpperCase(),
      maxRepos: 100,
    });
    expect(result).toMatchObject({ ok: false, status: 409, code: "name_taken" });
    const discarded = await env.DIRECTORY.prepare(
      "SELECT r.state FROM repos r JOIN repo_deletions d ON d.repo_id = r.id WHERE r.owner_id = ? AND r.id = r.name",
    )
      .bind(owner.principalId)
      .first<{ state: string }>();
    expect(discarded?.state).toBe("deleted");
    expect((await quota(owner)).repos).toBe(2);
  });

  it("says why a create was held back as its own batch saw it", async () => {
    const owner = await user();
    const contender = (await createRepo(owner)).body;
    const attempt = (name: string, maxRepos: number) =>
      env.DIRECTORY.batch(
        newRepoStatements(
          env.DIRECTORY,
          {
            id: `rep_${crypto.randomUUID()}`,
            ownerId: owner.principalId,
            name,
            networkId: `net_${crypto.randomUUID()}`,
            orgShard: "default",
            visibility: "private",
            parentId: null,
            expiresAt: null,
            now: Date.now(),
          },
          { actorId: owner.principalId, action: "repo.create", details: {} },
          maxRepos,
        ),
      );
    const taken = await attempt(contender.name.toUpperCase(), 10);
    // The contender goes before the caller looks: the answer is still the batch's.
    expect(
      (await api("DELETE", `/repos/${owner.handle}/${contender.name}`, owner.token)).status,
    ).toBe(200);
    expect(heldBack(taken)).toBe("name_taken");
    await createRepo(owner);
    expect(heldBack(await attempt(uniqueId("q"), 1))).toBe("quota_exceeded");
    expect(heldBack(await attempt(uniqueId("q"), 10))).toBeUndefined();
  });

  it("holds against concurrent creates", async () => {
    const owner = await user();
    await createRepo(owner);
    await setQuota(owner, { max_repos: 2 });
    const results = await Promise.all(Array.from({ length: 5 }, () => createRepo(owner)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(4);
    expect((await quota(owner)).repos).toBe(2);
  });

  it("of an organization is shown to its members and set for it", async () => {
    const owner = await user();
    const login = uniqueId("org").slice(0, 39);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }))
        .status,
    ).toBe(201);
    expect(
      (await api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("o") })).status,
    ).toBe(201);
    expect(
      (await json(api("PUT", `/admin/accounts/${login}/quota`, admin.token, { max_repos: 1 })))
        .body,
    ).toMatchObject({ account: login, max_repos: 1, repos: 1 });
    expect((await json<Quota>(api("GET", `/orgs/${login}/quota`, owner.token))).body).toMatchObject(
      { account: login, max_repos: 1, repos: 1 },
    );
    const refused = await json<{ code: string }>(
      api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("o") }),
    );
    expect(refused).toMatchObject({ status: 403, body: { code: "quota_exceeded" } });
    const stranger = await user();
    expect((await api("GET", `/orgs/${login}/quota`, stranger.token)).status).toBe(404);
  });

  it("is set by instance administrators only, and audited with what changed", async () => {
    const owner = await user();
    await setQuota(owner, { max_storage_bytes: 100 });
    await setQuota(owner, { max_repos: 5 });
    await setQuota(owner, { max_storage_bytes: null });
    const { results } = await env.DIRECTORY.prepare(
      "SELECT actor_id, details FROM audit_log WHERE target_id = ? AND action = 'quota.set' ORDER BY seq",
    )
      .bind(owner.principalId)
      .all<{ actor_id: string; details: string }>();
    expect(results.map((r) => [r.actor_id, JSON.parse(r.details)])).toEqual([
      [admin.principalId, { max_storage_bytes: 100 }],
      [admin.principalId, { max_repos: 5 }],
      [admin.principalId, { max_storage_bytes: null }],
    ]);
    expect(await quota(owner)).toMatchObject({
      max_repos: 5,
      max_storage_bytes: QUOTA_DEFAULTS.maxStorageBytes,
    });
    const res = await json<{ code: string }>(
      api("PUT", `/admin/accounts/${owner.handle}/quota`, owner.token, { max_repos: 5 }),
    );
    expect(res.status).toBe(403);
    expect(
      (await json(api("PUT", "/admin/accounts/no-such-account/quota", admin.token, {}))).body,
    ).toMatchObject({ code: "account_not_found" });
  });
});

describe("storage quota", () => {
  it("charges a committed push its stored bytes, and refuses one that does not fit", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const body = firstPush();
    // Too small: refused before anything is stored, with a message git shows.
    await setQuota(owner, { max_storage_bytes: body.length - 1 });
    const refused = await postPush(await target(owner, repo), body);
    expect(text(refused.bytes)).toContain("storage quota");
    expect(await quota(owner)).toMatchObject({ storage_bytes: 0, reserved_bytes: 0 });
    expect(
      (await api("GET", `/repos/${owner.handle}/${repo.name}/branches`, owner.token)).status,
    ).toBe(200);
    // Exactly enough: committed and charged.
    await setQuota(owner, { max_storage_bytes: body.length });
    const pushed = await postPush(await target(owner, repo), body);
    expect(pushed.report).toContain("ok refs/heads/main\n");
    expect(await quota(owner)).toMatchObject({ storage_bytes: body.length, reserved_bytes: 0 });
  });

  it("confirms a committed push's bytes later when the account cannot be told at once", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const body = firstPush();
    await setQuota(owner, { max_storage_bytes: 10 * body.length });
    // The account's object fails the first confirmation, as a lost call would.
    const confirm = OrgDO.prototype.confirmStorage;
    let failures = 1;
    const spy = vi.spyOn(OrgDO.prototype, "confirmStorage").mockImplementation(function (
      this: OrgDO,
      ...args
    ) {
      if (failures-- > 0) return Promise.reject(new Error("the call was lost")) as never;
      return confirm.apply(this, args);
    });
    try {
      const pushed = await postPush(await target(owner, repo), body);
      expect(pushed.report).toContain("ok refs/heads/main\n");
      // Owed, not counted yet; the repository's alarm tells the account.
      expect(await quota(owner)).toMatchObject({ storage_bytes: 0 });
      // Told once: nothing is owed any more, and it is counted once.
      expect((await runConfirmJob(repo.id)).owed).toEqual([]);
      expect(await quota(owner)).toMatchObject({ storage_bytes: body.length, reserved_bytes: 0 });
      await runConfirmJob(repo.id);
      expect(await quota(owner)).toMatchObject({ storage_bytes: body.length });
    } finally {
      spy.mockRestore();
    }
  });

  /** Runs the repository's confirmation job now; the job's state after. */
  const runConfirmJob = (repoId: string) =>
    // The object's alarm itself, whether or not one is set: run as the test asks, never
    // depending on what earlier work left scheduled.
    runInDurableObject(env.REPO.getByName(repoId), async (instance: RepoDO, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE jobs SET next_run_at = 1 WHERE kind = 'storage_confirm'");
      await instance.alarm();
      return {
        owed: sql
          .exec<{ upload_id: string }>("SELECT upload_id FROM storage_owed ORDER BY upload_id")
          .toArray()
          .map((r) => r.upload_id),
        state:
          sql
            .exec<{ state: string }>("SELECT state FROM jobs WHERE kind = 'storage_confirm'")
            .toArray()[0]?.state ?? null,
      };
    });

  /** Owes the account `bytes` for upload `uploadId` (at `at`), with the job to tell it. */
  const owe = (repoId: string, uploadId: string, bytes: number, at = Date.now()) =>
    inRepo(env.REPO.getByName(repoId), ({ git }) => {
      git.context.storage.sql.exec(
        "INSERT INTO storage_owed (upload_id, bytes, owed_at) VALUES (?, ?, ?)",
        uploadId,
        bytes,
        at,
      );
      git.jobs.ensure("storage_confirm", "storage-confirm");
    });

  it("keeps its confirmation job going for what a push owed while it ran", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    await owe(repo.id, "a", 3);
    const outcome = await runInDurableObject(
      env.REPO.getByName(repo.id),
      async (instance: RepoDO, state) => {
        const sql = state.storage.sql;
        const told: string[] = [];
        // While the job waits on the account, another push owes it more.
        const account = {
          confirmStorage: async (input: { uploadId: string }) => {
            if (told.length === 0)
              sql.exec(
                "INSERT INTO storage_owed (upload_id, bytes, owed_at) VALUES ('b', 4, ?)",
                Date.now(),
              );
            told.push(input.uploadId);
            return true;
          },
        };
        const self = instance as unknown as { env: Env };
        const real = self.env;
        self.env = { ...real, ORG: { getByName: () => account } as unknown as Env["ORG"] };
        const run = async () => {
          sql.exec("UPDATE jobs SET next_run_at = 1 WHERE kind = 'storage_confirm'");
          await instance.alarm();
          return sql
            .exec<{ state: string }>("SELECT state FROM jobs WHERE kind = 'storage_confirm'")
            .one().state;
        };
        try {
          const first = await run();
          const afterFirst = told.slice();
          const second = await run();
          return { first, afterFirst, second, told };
        } finally {
          self.env = real;
        }
      },
    );
    expect(outcome).toEqual({
      first: "queued",
      afterFirst: ["a"],
      second: "done",
      told: ["a", "b"],
    });
  });

  it("keeps owing what an account would not take while the repository moved", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const org = uniqueId("qorg").slice(0, 39);
    await api("POST", "/admin/organizations", admin.token, { login: org, admin: owner.handle });
    const moved = await api("POST", `/repos/${owner.handle}/${repo.name}/transfer`, owner.token, {
      new_owner: org,
    });
    expect(moved.status).toBe(200);
    const orgId = (
      await env.DIRECTORY.prepare("SELECT id FROM principals WHERE handle = ?")
        .bind(org)
        .first<{ id: string }>()
    )?.id as string;
    // As between the old account handing it over and the repository landing: its object
    // still names the old account, which no longer counts it.
    const setAccount = (id: string) =>
      inRepo(env.REPO.getByName(repo.id), ({ git }) =>
        git.context.storage.sql.exec("UPDATE repo_meta SET org_id = ?1, owner_id = ?1", id),
      );
    await setAccount(owner.principalId);
    await owe(repo.id, "moving", 5);
    expect((await runConfirmJob(repo.id)).owed).toEqual(["moving"]);
    expect(await quota(owner)).toMatchObject({ storage_bytes: 0 });
    // Landed: the new account takes it.
    await setAccount(orgId);
    expect((await runConfirmJob(repo.id)).owed).toEqual([]);
    expect(
      (await json<Quota>(api("GET", `/orgs/${org}/quota`, owner.token))).body.storage_bytes,
    ).toBe(5);
  });

  it("counts a confirmation once, and drops a hold made for it after it was counted", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const accountId = owner.principalId;
    const account = env.ORG.getByName(accountId);
    const confirm = () => account.confirmStorage({ uploadId: "dup", repoId: repo.id, bytes: 5 });
    expect(await confirm()).toBe(true);
    // As a transfer back would charge it again.
    await runInDurableObject(account, (_: unknown, state) => {
      state.storage.sql.exec(
        `INSERT INTO quota_holds (upload_id, repo_id, kind, bytes, expires_at)
         VALUES ('dup', ?, 'charged', 5, ?)`,
        repo.id,
        Date.now() + 60_000,
      );
    });
    expect(await quota(owner)).toMatchObject({ storage_bytes: 5, reserved_bytes: 5 });
    expect(await confirm()).toBe(true);
    expect(await quota(owner)).toMatchObject({ storage_bytes: 5, reserved_bytes: 0 });
  });

  it("gives up a confirmation owed past the account's memory of the ones it took", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    await owe(repo.id, "old", 9, Date.now() - 7 * 24 * 60 * 60 * 1000);
    expect(await runConfirmJob(repo.id)).toEqual({ owed: [], state: "done" });
    expect(await quota(owner)).toMatchObject({ storage_bytes: 0 });
  });

  it("stops a push without a declared length at the space left", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const body = firstPush();
    await setQuota(owner, { max_storage_bytes: Math.floor(body.length / 2) });
    const refused = await postPush(await target(owner, repo), body, { chunked: true });
    expect(text(refused.bytes)).toContain("storage quota");
    expect(await quota(owner)).toMatchObject({ storage_bytes: 0, reserved_bytes: 0 });
  });

  it("frees what a push refused before its commit reserved", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    // The branch does not exist at the old value given: the ref update fails.
    const body = pushBody([{ old: fx.c1, new: fx.c2, ref: "refs/heads/main" }], {
      pack: fx.packC2,
    });
    const reply = await postPush(await target(owner, repo), body);
    expect(reply.report.some((line) => line.startsWith("ng refs/heads/main"))).toBe(true);
    expect(await quota(owner)).toMatchObject({ storage_bytes: 0, reserved_bytes: 0 });
  });

  it("refuses a write the repository makes itself when it does not fit, at its commit", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    await setQuota(owner, { max_storage_bytes: 10 });
    const write = await json<{ code: string; message?: string }>(
      api("PUT", `/repos/${owner.handle}/${repo.name}/contents/a.txt`, owner.token, {
        message: "add",
        content: btoa("x".repeat(100)),
      }),
    );
    expect(write.status).toBe(422);
    expect(write.body.code).toBe("write_refused");
    expect(
      (await api("GET", `/repos/${owner.handle}/${repo.name}/contents/a.txt`, owner.token)).status,
    ).toBe(409);
    expect(await quota(owner)).toMatchObject({ storage_bytes: 0, reserved_bytes: 0 });
  });

  it("frees a deleted repository's storage once its deletion finishes", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const body = firstPush();
    expect((await postPush(await target(owner, repo), body)).report).toContain(
      "ok refs/heads/main\n",
    );
    expect((await quota(owner)).storage_bytes).toBe(body.length);
    expect((await api("DELETE", `/repos/${owner.handle}/${repo.name}`, owner.token)).status).toBe(
      200,
    );
    for (let run = 0; run < 5 && (await quota(owner)).storage_bytes > 0; run++)
      await worker.scheduled?.(createScheduledController({ cron: "*/5 * * * *" }), env);
    expect((await quota(owner)).storage_bytes).toBe(0);
  });

  it("is held one upload at a time, never past the limit, and counted once per committed upload", async () => {
    const accountId = `usr_${crypto.randomUUID()}`;
    const stub = env.ORG.getByName(accountId);
    const actor = { accountId, actor: { principalId: admin.principalId } };
    await stub.setQuotaLimits({ maxStorageBytes: 100 }, actor);
    const hold = { repoId: "rep_x", ttlMs: 60_000 };
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        stub.reserveStorage({ ...hold, uploadId: `u${i}`, bytes: 30 }),
      ),
    );
    const won = results.flatMap((r, i) => (r.reserved === 30 ? [`u${i}`] : []));
    expect(won).toHaveLength(3);
    expect((await stub.quotaStatus()).reservedBytes).toBe(90);
    // A lapsed hold counts nothing and is dropped by the next one.
    await stub.reserveStorage({ ...hold, uploadId: "lapsed", bytes: 10, ttlMs: 0 });
    expect((await stub.quotaStatus()).reservedBytes).toBe(90);
    // A charge takes the reservation's place; charging again changes nothing.
    const [first, second, third] = won as [string, string, string];
    expect(await stub.chargeStorage({ ...hold, uploadId: first, bytes: 30 })).toBe(true);
    expect(await stub.chargeStorage({ ...hold, uploadId: first, bytes: 30 })).toBe(true);
    expect(await stub.quotaStatus()).toMatchObject({ usedBytes: 0, reservedBytes: 90 });
    // Confirmed once: usage; a repeated confirmation or charge counts nothing more.
    await stub.confirmStorage({ uploadId: first, repoId: "rep_x", bytes: 30 });
    await stub.confirmStorage({ uploadId: first, repoId: "rep_x", bytes: 30 });
    expect(await stub.chargeStorage({ ...hold, uploadId: first, bytes: 30 })).toBe(true);
    expect(await stub.quotaStatus()).toMatchObject({ usedBytes: 30, reservedBytes: 60 });
    // More than it reserved, beyond what is free: refused, and its hold is dropped.
    expect(await stub.chargeStorage({ ...hold, uploadId: second, bytes: 50 })).toBe(false);
    expect(await stub.quotaStatus()).toMatchObject({ usedBytes: 30, reservedBytes: 30 });
    // Released: free again; a lapsed charge counts nothing.
    await stub.releaseStorage(third);
    await stub.chargeStorage({ ...hold, uploadId: "late", bytes: 20, ttlMs: 0 });
    expect(await stub.quotaStatus()).toMatchObject({ usedBytes: 30, reservedBytes: 0 });
  });

  it("gives back a charge whose commit then failed", async () => {
    const owner = await user();
    const repo = (await createRepo(owner)).body;
    const body = firstPush();
    // The first push waits after indexing; the second creates the branch meanwhile.
    const held = holdAfterRunPush();
    const pending = postPush(await target(owner, repo), body, { bindings: { REPO: held.REPO } });
    await held.accepted();
    expect((await postPush(await target(owner, repo), body)).report).toContain(
      "ok refs/heads/main\n",
    );
    held.resume();
    const late = await pending;
    expect(late.report.some((line) => line.startsWith("ng refs/heads/main"))).toBe(true);
    expect(await quota(owner)).toMatchObject({ storage_bytes: body.length, reserved_bytes: 0 });
  });
});
