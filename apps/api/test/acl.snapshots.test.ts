import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { ACL_POLICY } from "../src/do/repo/acl.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { ACCESS_LOST } from "../src/git/push/reauthorize.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const ORIGIN = "https://fyrden.test";

type Who = { principalId: string; token: string; handle: string };

async function who(admin = false): Promise<Who> {
  const p = await principalWithToken("user", "pat", { admin });
  return { ...p, handle: p.principalId.toLowerCase().replace("_", "-") };
}

function api(method: string, path: string, token: string, body?: unknown) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method !== "GET" && { "Idempotency-Key": crypto.randomUUID() }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

let admin: Who;

beforeAll(async () => {
  admin = await who(true);
});

/** An organization with `owner`, a second owner and a member, and one repository of it. */
async function orgWithRepo() {
  const owner = await who();
  const second = await who();
  const member = await who();
  const login = uniqueId("acl").slice(0, 39);
  const created = await api("POST", "/admin/organizations", admin.token, {
    login,
    admin: owner.handle,
  });
  expect(created.status).toBe(201);
  const org = await created.json<{ id: string }>();
  for (const [user, role] of [
    [second, "admin"],
    [member, "member"],
  ] as const)
    expect(
      (await api("PUT", `/orgs/${login}/memberships/${user.handle}`, owner.token, { role })).status,
    ).toBe(200);
  const repoRes = await api("POST", `/orgs/${login}/repos`, member.token, { name: "shared" });
  expect(repoRes.status).toBe(201);
  const repo = await repoRes.json<{ id: string; name: string; full_name: string }>();
  return { login, orgId: org.id, owner, second, member, repo, stub: env.REPO.getByName(repo.id) };
}

/** Makes the repository's snapshot `ageMs` old, as if that long had passed since its pull. */
function ageSnapshot(stub: DurableObjectStub<RepoDO>, ageMs: number) {
  return runInDurableObject(stub, (_: RepoDO, state) => {
    state.storage.sql.exec("UPDATE acl_snapshot SET pulled_at = ?", Date.now() - ageMs);
  });
}

/** A ref commit by `principal`, as a push's commit point makes it. */
function commitAs(stub: DurableObjectStub<RepoDO>, principal: string, n: number) {
  return inRepo(stub, async (repo) => {
    await repo.checkEpoch();
    const result = repo.git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [{ name: `refs/heads/b${n}`, oldOid: null, newOid: oidFromHex("1".repeat(40)) }],
      expectedVersion: repo.git.refStore.readRefsSync().version,
      actor: { principal, via: "push" },
    });
    // A refusal is the commit's answer, as for any other refused commit.
    if (!result.ok) expect(result).toMatchObject({ reason: "refused", message: ACCESS_LOST });
    return result.ok;
  });
}

describe("organization repositories", () => {
  it("are created by members, administered by owners and read by members", async () => {
    const { login, owner, member, repo } = await orgWithRepo();
    expect(repo.full_name).toBe(`${login}/shared`);
    const path = `/repos/${login}/shared`;
    expect((await api("GET", path, member.token)).status).toBe(200);
    // A member reads; it may not administer.
    expect((await api("PATCH", path, member.token, { description: "no" })).status).toBe(404);
    expect((await api("PATCH", path, owner.token, { description: "yes" })).status).toBe(200);
    const stranger = await who();
    expect((await api("GET", path, stranger.token)).status).toBe(404);
  });

  it("are listed for members only", async () => {
    const { login, member } = await orgWithRepo();
    const list = await api("GET", `/orgs/${login}/repos`, member.token);
    expect((await list.json<{ repos: { name: string }[] }>()).repos.map((r) => r.name)).toEqual([
      "shared",
    ]);
    const stranger = await who();
    expect((await api("GET", `/orgs/${login}/repos`, stranger.token)).status).toBe(404);
  });
});

describe("ACL snapshots", () => {
  it("let a write within the window use a snapshot that missed a revocation, and deny after it", async () => {
    const { orgId, owner, second, stub } = await orgWithRepo();
    // The second owner writes: a snapshot is pulled.
    expect(await commitAsAfterCheck(stub, second.principalId, 1)).toBe(true);
    // Removed without the repository hearing of it (a lost invalidation).
    const removed = await env.ORG.getByName(orgId).removeMember(
      { principalId: owner.principalId },
      second.principalId,
    );
    expect(removed).toMatchObject({ ok: true });
    // Within the 60 s window the cached snapshot still allows the write.
    expect(await commitAsAfterCheck(stub, second.principalId, 2)).toBe(true);
    // Past the window the snapshot is pulled again: denied.
    await ageSnapshot(stub, ACL_POLICY.writeWindowMs + 1);
    expect(await commitAsAfterCheck(stub, second.principalId, 3)).toBe(false);
  });

  it("deny the next write at once once the repository acknowledged the invalidation", async () => {
    const { orgId, owner, second, stub } = await orgWithRepo();
    expect(await commitAsAfterCheck(stub, second.principalId, 1)).toBe(true);
    const removed = await env.ORG.getByName(orgId).removeMember(
      { principalId: owner.principalId },
      second.principalId,
    );
    if (!removed.ok) throw new Error(removed.error);
    await stub.invalidateAcl(orgId, removed.epochGen, removed.version);
    expect(await commitAsAfterCheck(stub, second.principalId, 2)).toBe(false);
  });

  it("never take back a snapshot pulled before an invalidation it raced", async () => {
    const { orgId, owner, second, stub } = await orgWithRepo();
    const before = await env.ORG.getByName(orgId).snapshotFor("x");
    // A pull that answers only after the revocation's invalidation arrived.
    await inRepo(stub, (repo) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (globalThis as { releasePull?: () => void }).releasePull = release;
      repo.pullAcl = async () => {
        await gate;
        return before;
      };
    });
    const decision = stub.roleOf(second.principalId, "write");
    const removed = await env.ORG.getByName(orgId).removeMember(
      { principalId: owner.principalId },
      second.principalId,
    );
    if (!removed.ok) throw new Error(removed.error);
    await stub.invalidateAcl(orgId, removed.epochGen, removed.version);
    await inRepo(stub, () => (globalThis as { releasePull?: () => void }).releasePull?.());
    expect(await decision).toBeNull();
    // Nor is it used later: the next decision pulls the current snapshot.
    await inRepo(stub, (repo) => {
      repo.pullAcl = (accountId) => env.ORG.getByName(accountId).snapshotFor("x");
    });
    expect(await stub.roleOf(second.principalId, "write")).toBeNull();
    expect(await stub.roleOf(owner.principalId, "write")).toBe("admin");
  });

  it("never take a snapshot pulled before the repository was transferred, even back", async () => {
    const { orgId, member, stub } = await orgWithRepo();
    const before = await env.ORG.getByName(orgId).snapshotFor("x");
    await inRepo(stub, (repo) => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const shared = globalThis as { releasePull?: () => void; pullStarted?: boolean };
      shared.releasePull = release;
      shared.pullStarted = false;
      repo.pullAcl = async () => {
        shared.pullStarted = true;
        await gate;
        return before;
      };
    });
    const decision = stub.roleOf(member.principalId, "read");
    // Only once the pull is out: a decision that starts after the move pulls a
    // current snapshot, which this fake would not return.
    await vi.waitFor(
      async () => {
        const started = await inRepo(
          stub,
          () => (globalThis as { pullStarted?: boolean }).pullStarted,
        );
        if (!started) throw new Error("the pull has not started");
      },
      { timeout: 5_000 },
    );
    // Transferred away and back while the pull was out: the same account, another ownership.
    await runInDurableObject(stub, (_: RepoDO, state) => {
      state.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 2 WHERE id = 1");
    });
    await inRepo(stub, () => (globalThis as { releasePull?: () => void }).releasePull?.());
    expect(await decision).toBeNull();
  });

  it("refuse a settings change by an owner removed since the API checked", async () => {
    const { orgId, owner, second, stub } = await orgWithRepo();
    const actor = { principal: second.principalId, via: "api" as const };
    expect(await stub.updateSettings({ description: "before", actor })).toMatchObject({ ok: true });
    const removed = await env.ORG.getByName(orgId).removeMember(
      { principalId: owner.principalId },
      second.principalId,
    );
    if (!removed.ok) throw new Error(removed.error);
    await stub.invalidateAcl(orgId, removed.epochGen, removed.version);
    expect(await stub.updateSettings({ description: "after", actor })).toEqual({
      ok: false,
      code: "access_lost",
    });
  });

  it("fail closed for writes when the account cannot be reached, and serve reads until the read TTL", async () => {
    const { second, member, stub } = await orgWithRepo();
    expect(await stub.roleOf(member.principalId, "read")).toBe("read");
    await inRepo(stub, (repo) => {
      repo.pullAcl = () => Promise.reject(new Error("account unreachable"));
    });
    await ageSnapshot(stub, ACL_POLICY.writeWindowMs + 1);
    expect(await stub.roleOf(second.principalId, "write")).toBeNull();
    expect(await stub.roleOf(member.principalId, "read")).toBe("read");
    await ageSnapshot(stub, ACL_POLICY.readTtlMs + 1);
    expect(await stub.roleOf(member.principalId, "read")).toBeNull();
  });

  it("refuse a snapshot from an older restore generation or older than the one cached", async () => {
    const { member, stub } = await orgWithRepo();
    expect(await stub.roleOf(member.principalId, "read")).toBe("read");
    const cached = await runInDurableObject(stub, (_: RepoDO, state) =>
      state.storage.sql
        .exec<{ account_id: string; epoch_gen: number; version: number }>(
          "SELECT account_id, epoch_gen, version FROM acl_snapshot",
        )
        .one(),
    );
    for (const stale of [
      { epochGen: cached.epoch_gen - 1, version: cached.version + 5 },
      { epochGen: cached.epoch_gen, version: cached.version - 1 },
    ]) {
      await inRepo(stub, (repo) => {
        repo.pullAcl = async () => ({
          accountId: cached.account_id,
          ...stale,
          roles: { [member.principalId]: "admin" },
        });
      });
      await ageSnapshot(stub, ACL_POLICY.readTtlMs + 1);
      expect(await stub.roleOf(member.principalId, "read")).toBeNull();
    }
  });

  it("take the account's newer restore generation, which repositories accept over a higher old version", async () => {
    const { orgId, member, stub } = await orgWithRepo();
    expect(await stub.roleOf(member.principalId, "read")).toBe("read");
    // The repository has seen a version the restored account will not reach soon.
    await stub.invalidateAcl(orgId, 1, 1_000);
    expect(await stub.roleOf(member.principalId, "read")).toBeNull();
    // The restore runbook takes the next generation; the restored object restarts.
    const epoch = await allocateEpoch(env.DIRECTORY, orgId);
    await runInDurableObject(env.ORG.getByName(orgId), (_: unknown, state) => state.abort()).catch(
      () => {},
    );
    expect((await env.ORG.getByName(orgId).snapshotFor("x")).epochGen).toBe(epoch);
    expect(await stub.roleOf(member.principalId, "read")).toBe("read");
  });

  it("record the age of the snapshot each decision used", async () => {
    const { member, stub } = await orgWithRepo();
    const points: AnalyticsEngineDataPoint[] = [];
    await inRepo(stub, (repo) => {
      repo.metricsDataset = { writeDataPoint: (p) => void points.push(p ?? {}) };
    });
    await stub.roleOf(member.principalId, "read");
    await stub.roleOf(member.principalId, "read");
    const ages = points.filter((p) => p.indexes?.[0] === "acl.snapshot_age_ms");
    expect(ages.length).toBeGreaterThan(0);
  });
});

/** Pulls a snapshot for a write first (as a push's commit point does), then commits. */
async function commitAsAfterCheck(stub: DurableObjectStub<RepoDO>, principal: string, n: number) {
  await stub.roleOf(principal, "write");
  return commitAs(stub, principal, n);
}
