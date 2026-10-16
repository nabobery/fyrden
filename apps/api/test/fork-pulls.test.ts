// Pull requests from forks: the head's revision is imported into the base
// (its packs borrowed, its commit graph copied) when the pull request
// opens and after each push to the fork's branch, in order, and only for
// the branch the pull request follows.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { DEFAULT_JOB_POLICY, JobQueue } from "@fyrden/adapters-cloudflare/git";
import { currentInvocation, measureInvocation } from "@fyrden/adapters-cloudflare/obs";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { PULL_REFOLLOW_JOB } from "../src/network/pull-source.js";
import {
  scheduleViewCompaction,
  VIEW_COMPACT_JOB,
  viewCompactionHandler,
} from "../src/network/view-cap.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { packStates, runJob } from "./helpers/maintenance.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Pull = {
  number: number;
  state: string;
  merged: boolean;
  head_repo_id: string | null;
  head: { ref: string; sha: string };
  head_ref_deleted: boolean;
  mergeable: boolean | null;
  code?: string;
};

let owner: Who;
let contributor: Who;
let base: { id: string; name: string; path: string };
let fork: { id: string; name: string; path: string };

const commitOn = async (
  who: Who,
  path: string,
  branch: string,
  changes: Record<string, unknown>[],
) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, who.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
/** Moves the fork's branch `name` from `from` to `to` (objects it has), as a push does. */
async function moveForkBranch(name: string, from: string, to: string) {
  const target: PushTarget = {
    repo: { id: fork.id, name: fork.name, stub: env.REPO.getByName(fork.id) },
    owner: {
      principalId: contributor.principalId,
      token: await scopedToken(contributor.principalId, [], "git"),
    },
    path: `/${contributor.handle}/${fork.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: from, new: to, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}
const open = (who: Who, head: string, extra: Record<string, unknown> = {}) =>
  json<Pull>(
    api("POST", `${base.path}/pulls`, who.token, {
      title: "From a fork",
      head,
      base: "main",
      ...extra,
    }),
  );
const pull = async (number = 1) =>
  (await json<Pull>(api("GET", `${base.path}/pulls/${number}`, owner.token))).body;
const runJobs = async (repoId: string) => {
  // A few rounds: an import goes one step per slice, and a notice may follow another.
  for (let i = 0; i < 3; i++) await inRepo(env.REPO.getByName(repoId), (r: RepoDO) => r.alarm());
};
/** The base tells the fork what to follow, the fork tells it of pushes, the base imports them. */
const sync = async () => {
  await runJobs(base.id);
  await runJobs(fork.id);
  await runJobs(base.id);
};
const notify = (notice: Partial<Parameters<RepoDO["receiveRevision"]>[0]>) =>
  env.REPO.getByName(base.id).receiveRevision({
    headRepoId: fork.id,
    number: 1,
    generation: 1,
    refVersion: 0,
    sha: null,
    pusher: null,
    pusherGrant: null,
    pushed: true,
    ...notice,
  });
/** A ref-state version past any the fork has told (they count from its restore generation). */
const ahead = (n: number) => 2 ** 40 + n;
const outgoing = () =>
  inRepo(env.REPO.getByName(fork.id), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ generation: number }>("SELECT generation FROM outgoing_pulls")
      .toArray(),
  );

beforeEach(async () => {
  owner = await user();
  contributor = await user();
  const made = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("base") }),
  );
  base = { ...made.body, path: `/repos/${owner.handle}/${made.body.name}` };
  await commitOn(owner, base.path, "main", [{ path: "a.txt", content: "one\ntwo\n" }]);
  await api("PUT", `${base.path}/collaborators/${contributor.handle}`, owner.token, {
    permission: "pull",
  });
  const forked = await json<{ id: string; name: string }>(
    api("POST", `${base.path}/forks`, contributor.token, { name: uniqueId("fork") }),
  );
  expect(forked.status).toBe(201);
  fork = { ...forked.body, path: `/repos/${contributor.handle}/${forked.body.name}` };
  await commitOn(contributor, fork.path, "main", [{ path: "b.txt", content: "from the fork\n" }]);
});

describe("pull requests from forks", () => {
  it("open on the fork's revision, list its files and merge it", async () => {
    const opened = await open(contributor, `${contributor.handle}:main`);
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ head_repo_id: fork.id, head: { ref: "main" } });
    const files = await json<{ files: { filename: string; status: string }[] }>(
      api("GET", `${base.path}/pulls/1/files`, owner.token),
    );
    expect(files.body.files).toEqual([
      expect.objectContaining({ filename: "b.txt", status: "added" }),
    ]);
    await runJobs(base.id);
    expect((await pull()).mergeable).toBe(true);

    const merged = await json<{ sha: string }>(
      api("PUT", `${base.path}/pulls/1/merge`, owner.token),
    );
    expect(merged.status).toBe(200);
    // The default message names the fork's branch, as its owner's.
    const commit = await json<{ commit: { message: string } }>(
      api("GET", `${base.path}/commits/${merged.body.sha}`, owner.token),
    );
    expect(commit.body.commit.message).toMatch(
      new RegExp(`^Merge pull request #1 from ${contributor.handle}/main\n`),
    );
    const read = await json<{ content: string }>(
      api("GET", `${base.path}/contents/b.txt?ref=main`, owner.token),
    );
    expect(atob(read.body.content.replace(/\n/g, ""))).toBe("from the fork\n");
    // Merged: the fork no longer follows the branch for it, once told.
    await runJobs(base.id);
    expect(await outgoing()).toEqual([]);
  });

  it("rebase onto a base that moved on, reading the fork's commits from its packs", async () => {
    expect((await open(contributor, `${contributor.handle}:main`)).status).toBe(201);
    await commitOn(owner, base.path, "main", [{ path: "c.txt", content: "base\n" }]);
    const merged = await json<{ sha: string }>(
      api("PUT", `${base.path}/pulls/1/merge`, owner.token, { merge_method: "rebase" }),
    );
    expect(merged.status).toBe(200);
    const made = await json<{ commit: { committer: { name: string } }; parents: unknown[] }>(
      api("GET", `${base.path}/commits/${merged.body.sha}`, owner.token),
    );
    expect(made.body.commit.committer.name).toBe("Fyrden");
    expect(made.body.parents).toHaveLength(1);
    for (const [name, content] of [
      ["b.txt", "from the fork\n"],
      ["c.txt", "base\n"],
    ] as const) {
      const read = await json<{ content: string }>(
        api("GET", `${base.path}/contents/${name}?ref=main`, owner.token),
      );
      expect(atob(read.body.content.replace(/\n/g, ""))).toBe(content);
    }
  });

  it("follow pushes to the fork's branch, by whoever pushed", async () => {
    await open(contributor, `${contributor.handle}:main`);
    const before = (await pull()).head.sha;
    const next = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    expect((await pull()).head.sha).toBe(before);
    await sync();
    expect((await pull()).head.sha).toBe(next);
    const lastPusher = await inRepo(
      env.REPO.getByName(base.id),
      (r: RepoDO) => r.pulls.get(1)?.lastPusher,
    );
    expect(lastPusher).toBe(contributor.principalId);
    const files = await json<{ files: { filename: string }[] }>(
      api("GET", `${base.path}/pulls/1/files`, owner.token),
    );
    expect(files.body.files.map((f) => f.filename)).toEqual(["b.txt", "c.txt"]);
  });

  it("follow the fork's branch after the fork is restored, its ref versions counting anew", async () => {
    await open(contributor, `${contributor.handle}:main`);
    await sync();
    await commitOn(contributor, fork.path, "main", [{ path: "c.txt", content: "c\n" }]);
    await sync();
    // As a restore leaves it: an older ref state, under a newer restore generation.
    await inRepo(env.REPO.getByName(fork.id), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      sql.exec("UPDATE ref_state SET version = 1 WHERE id = 1");
      sql.exec("UPDATE repo_meta SET epoch_gen = epoch_gen + 1 WHERE id = 1");
    });
    const next = await commitOn(contributor, fork.path, "main", [
      { path: "d.txt", content: "d\n" },
    ]);
    await sync();
    expect((await pull()).head.sha).toBe(next);
  });

  it("follow the fork's branch again after the fork is restored to before the pull request opened", async () => {
    await open(contributor, `${contributor.handle}:main`);
    await sync();
    expect(await outgoing()).toEqual([{ generation: 1 }]);
    // Only a restore asks the network's members: not a new repository's first epoch.
    const refollow = (id: string) =>
      inRepo(env.REPO.getByName(id), (r: RepoDO) => r.git.jobs.get(PULL_REFOLLOW_JOB));
    expect(await refollow(fork.id)).toBeUndefined();
    expect(await refollow(base.id)).toBeUndefined();
    // As a restore to a snapshot from before the opening leaves the fork: no registration, no
    // notice, an older ref state. The runbook takes the next restore generation, and the restored
    // object, started again, takes it with its first write.
    const stub = env.REPO.getByName(fork.id);
    await inRepo(stub, (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      sql.exec("DELETE FROM outgoing_pulls");
      sql.exec("DELETE FROM revision_notices");
      sql.exec("UPDATE ref_state SET version = 1 WHERE id = 1");
    });
    await allocateEpoch(env.DIRECTORY, fork.id);
    await runInDurableObject(stub, (_: RepoDO, state) => state.abort()).catch(() => {});
    const next = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    await runJobs(fork.id);
    await sync();
    expect(await outgoing()).toEqual([{ generation: 1 }]);
    expect((await pull()).head.sha).toBe(next);
  });

  it("ask the network's members again within an invocation's budget of internal calls", async () => {
    // More members than one budget asks: repositories of the network as the directory has them
    // (objects never set up, which answer at once).
    const prefix = uniqueId("member");
    await env.DIRECTORY.prepare(
      `INSERT INTO repos (id, owner_id, name, network_id, org_shard, visibility, state, created_at,
         updated_at)
       SELECT ?1 || j.value, r.owner_id, ?1 || j.value, r.network_id, r.org_shard, r.visibility,
         'active', r.created_at, r.updated_at
       FROM repos r, json_each(?2) j WHERE r.id = ?3`,
    )
      .bind(prefix, JSON.stringify(Array.from({ length: 60 }, (_, i) => i)), fork.id)
      .run();
    const budget = 30;
    const ran = await inRepo(env.REPO.getByName(fork.id), (r: RepoDO) => {
      r.pullSource.restored();
      const jobs = new JobQueue(r.git.context, () => {}, {
        ...DEFAULT_JOB_POLICY,
        maxInternalCalls: budget,
      });
      return measureInvocation(r.git.context.metrics, { where: "do", op: "test" }, async () => {
        await jobs.runDue(
          { pull_refollow: r.pullSource.refollowHandler() },
          r.git.memory,
          r.git.context.now() + 60_000,
        );
        return {
          calls: currentInvocation()?.tally.internal ?? 0,
          state: jobs.get(PULL_REFOLLOW_JOB)?.state,
        };
      });
    });
    // Stopped once the budget was spent, at most one slice (20 calls) past it, the rest left.
    expect(ran.state).toBe("queued");
    expect(ran.calls).toBeGreaterThanOrEqual(budget);
    expect(ran.calls).toBeLessThanOrEqual(budget + 20);
  });

  it("are not moved by a branch of the base with the same name", async () => {
    await open(contributor, `${contributor.handle}:main`, { base: "main" });
    const head = (await pull()).head.sha;
    await commitOn(owner, base.path, "main", [{ path: "z.txt", content: "z\n" }]);
    expect((await pull()).head.sha).toBe(head);
  });

  it("stop following the branch when closed, and follow it again when reopened", async () => {
    await open(contributor, `${contributor.handle}:main`);
    await runJobs(base.id);
    expect(await outgoing()).toEqual([{ generation: 1 }]);
    await api("PATCH", `${base.path}/pulls/1`, contributor.token, { state: "closed" });
    await runJobs(base.id);
    expect(await outgoing()).toEqual([]);
    // Pushed while closed: taken once reopened.
    const next = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    await api("PATCH", `${base.path}/pulls/1`, contributor.token, { state: "open" });
    await runJobs(base.id);
    expect(await outgoing()).toEqual([{ generation: 2 }]);
    await sync();
    expect((await pull()).head.sha).toBe(next);
  });

  it("show the fork's branch deleted, keeping the last revision, and follow it once back", async () => {
    // A branch other than the fork's default one (which cannot be deleted).
    const tip = await json<{ sha: string }>(
      api("GET", `${fork.path}/commits/main`, contributor.token),
    );
    await moveForkBranch("topic", ZERO, tip.body.sha);
    await open(contributor, `${contributor.handle}:topic`);
    const head = (await pull()).head.sha;
    await moveForkBranch("topic", head, ZERO);
    await sync();
    expect(await pull()).toMatchObject({ head_ref_deleted: true, head: { sha: head } });
    await moveForkBranch("topic", ZERO, head);
    await sync();
    expect(await pull()).toMatchObject({ head_ref_deleted: false, head: { sha: head } });
  });

  it("never let the base serve fork commits outside the pull request", async () => {
    // A branch of the fork no pull request names: its commit is in the packs the base borrows.
    const tip = await json<{ sha: string }>(
      api("GET", `${fork.path}/commits/main`, contributor.token),
    );
    await moveForkBranch("secret", ZERO, tip.body.sha);
    const secret = await commitOn(contributor, fork.path, "secret", [
      { path: "secret.txt", content: "not for the base\n" },
    ]);
    await open(contributor, `${contributor.handle}:main`);
    const stub = env.REPO.getByName(base.id);
    const borrowed = await inRepo(
      stub,
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM packs WHERE origin = 'borrowed' AND state = 'live'",
          )
          .one().n,
    );
    expect(borrowed).toBeGreaterThan(0);
    expect((await stub.objectAccess({ kind: "commit", commit: (await pull()).head.sha })).ok).toBe(
      true,
    );
    expect((await stub.objectAccess({ kind: "commit", commit: secret })).ok).toBe(false);
  });

  it("need a fork the caller can read, in the same network", async () => {
    const stranger = await user();
    await api("PUT", `${base.path}/collaborators/${stranger.handle}`, owner.token, {
      permission: "pull",
    });
    // The fork is the contributor's own (private): the stranger cannot read it.
    expect((await open(stranger, `${contributor.handle}:main`)).body.code).toBe("head_not_found");
    expect((await open(contributor, `${stranger.handle}:main`)).body.code).toBe("head_not_found");
    expect((await open(contributor, `${contributor.handle}:nope`)).body.code).toBe(
      "head_not_found",
    );
  });

  it("refuse a fork's branch with nothing the base lacks", async () => {
    const tip = await json<{ sha: string }>(api("GET", `${base.path}/commits/main`, owner.token));
    await moveForkBranch("same", ZERO, tip.body.sha);
    expect((await open(contributor, `${contributor.handle}:same`)).body.code).toBe("no_commits");
  });

  it("apply revisions in order: a late notice of an earlier one is stale", async () => {
    await open(contributor, `${contributor.handle}:main`);
    const first = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    const second = await commitOn(contributor, fork.path, "main", [
      { path: "d.txt", content: "d\n" },
    ]);
    await sync();
    expect((await pull()).head.sha).toBe(second);
    const pullRow = await inRepo(env.REPO.getByName(base.id), (r: RepoDO) => r.pulls.get(1));
    const answer = await env.REPO.getByName(base.id).receiveRevision({
      headRepoId: fork.id,
      number: 1,
      generation: 1,
      refVersion: (pullRow?.headRefVersion ?? 0) - 1,
      sha: first,
      pusher: contributor.principalId,
      pusherGrant: null,
      pushed: true,
    });
    expect(answer).toBe("stale");
    expect((await pull()).head.sha).toBe(second);
  });
});

describe("an owner with several repositories in the network", () => {
  let stranger: Who;
  let second: { id: string; name: string; path: string };
  const letRead = (repo: { path: string }) =>
    api("PUT", `${repo.path}/collaborators/${stranger.handle}`, contributor.token, {
      permission: "pull",
    });

  beforeEach(async () => {
    stranger = await user();
    await api("PUT", `${base.path}/collaborators/${stranger.handle}`, owner.token, {
      permission: "pull",
    });
    // Named to sort after the first fork: a lookup that took the first by name finds that one.
    const forked = await json<{ id: string; name: string }>(
      api("POST", `${base.path}/forks`, contributor.token, { name: uniqueId("second") }),
    );
    expect(forked.status).toBe(201);
    second = { ...forked.body, path: `/repos/${contributor.handle}/${forked.body.name}` };
    expect(second.name > fork.name).toBe(true);
    await commitOn(contributor, second.path, "main", [{ path: "s.txt", content: "second\n" }]);
  });

  it("tells a caller who reads none of them nothing of them", async () => {
    expect((await open(stranger, `${contributor.handle}:main`)).body.code).toBe("head_not_found");
  });

  it("takes the one the caller reads, whatever the others", async () => {
    expect((await letRead(second)).status).toBe(200);
    const opened = await open(stranger, `${contributor.handle}:main`);
    expect(opened.status).toBe(201);
    expect(opened.body.head_repo_id).toBe(second.id);
  });

  it("needs head_repo only among those the caller reads", async () => {
    expect((await letRead(fork)).status).toBe(200);
    expect((await letRead(second)).status).toBe(200);
    expect((await open(stranger, `${contributor.handle}:main`)).body.code).toBe(
      "head_repo_required",
    );
    const named = await open(stranger, `${contributor.handle}:main`, { head_repo: second.name });
    expect(named.body.head_repo_id).toBe(second.id);
  });
});

describe("revisions told out of order or more than once", () => {
  it("take a push back to the same commit as a push, by its pusher", async () => {
    await open(contributor, `${contributor.handle}:main`);
    const head = (await pull()).head.sha;
    const other = await user();
    await notify({ refVersion: ahead(1_000), sha: head, pusher: other.principalId });
    const row = await inRepo(env.REPO.getByName(base.id), (r: RepoDO) => r.pulls.get(1));
    expect(row).toMatchObject({ lastPusher: other.principalId, headSha: head });
  });

  it("never let a late deletion replace a later revision waiting to be imported", async () => {
    await open(contributor, `${contributor.handle}:main`);
    const next = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    expect(
      await notify({ refVersion: ahead(2_000), sha: next, pusher: contributor.principalId }),
    ).toBe("queued");
    expect(await notify({ refVersion: ahead(1_500), sha: null, pushed: false })).toBe("stale");
    await runJobs(base.id);
    expect(await pull()).toMatchObject({ head_ref_deleted: false, head: { sha: next } });
  });

  it("keep a reopened pull request followed when a close is told late", async () => {
    await open(contributor, `${contributor.handle}:main`);
    await api("PATCH", `${base.path}/pulls/1`, contributor.token, { state: "closed" });
    await api("PATCH", `${base.path}/pulls/1`, contributor.token, { state: "open" });
    await runJobs(base.id);
    expect(await outgoing()).toEqual([{ generation: 2 }]);
    // A generation-2 import's lease, and a generation-1 one.
    const leases = await inRepo(env.REPO.getByName(fork.id), (r: RepoDO) => {
      const packs = r.git.context.storage.sql
        .exec<{ pack_id: string }>("SELECT pack_id FROM packs WHERE state = 'live' LIMIT 1")
        .toArray()
        .map((p) => p.pack_id as never);
      const grant = (holder: string) => {
        const g = r.git.leases.grant("read", packs, holder, 60_000);
        if (!g.ok) throw new Error("no lease");
        return g.leaseId;
      };
      return { old: grant(`pull:${base.id}:pr:1:1:5`), current: grant(`pull:${base.id}:pr:1:2:9`) };
    });
    await env.REPO.getByName(fork.id).unregisterOutgoingPull(base.id, 1, 1);
    expect(await outgoing()).toEqual([{ generation: 2 }]);
    const left = await inRepo(env.REPO.getByName(fork.id), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ lease_id: string }>(
          "SELECT DISTINCT lease_id FROM leases WHERE holder LIKE 'pull:%'",
        )
        .toArray()
        .map((l) => l.lease_id),
    );
    expect(left).toContain(leases.current);
    expect(left).not.toContain(leases.old);
  });

  it("reopen once the fork's branch is back, though it was gone when closed", async () => {
    const tip = await json<{ sha: string }>(
      api("GET", `${fork.path}/commits/main`, contributor.token),
    );
    await moveForkBranch("topic", ZERO, tip.body.sha);
    await open(contributor, `${contributor.handle}:topic`);
    await moveForkBranch("topic", tip.body.sha, ZERO);
    await sync();
    expect((await pull()).head_ref_deleted).toBe(true);
    await api("PATCH", `${base.path}/pulls/1`, contributor.token, { state: "closed" });
    await moveForkBranch("topic", ZERO, tip.body.sha);
    const reopened = await json<Pull>(
      api("PATCH", `${base.path}/pulls/1`, contributor.token, { state: "open" }),
    );
    expect(reopened.status).toBe(200);
    await sync();
    expect(await pull()).toMatchObject({ state: "open", head_ref_deleted: false });
  });
});

describe("revisions pushed by those who only write to the fork", () => {
  it("are taken, and their pusher named, though the pusher cannot read the base", async () => {
    await open(contributor, `${contributor.handle}:main`);
    const helper = await user();
    expect(
      (
        await api("PUT", `${fork.path}/collaborators/${helper.handle}`, contributor.token, {
          permission: "push",
        })
      ).status,
    ).toBe(200);
    const next = await commitOn(helper, fork.path, "main", [{ path: "h.txt", content: "h\n" }]);
    await sync();
    expect((await pull()).head.sha).toBe(next);
    const row = await inRepo(env.REPO.getByName(base.id), (r: RepoDO) => r.pulls.get(1));
    expect(row?.lastPusher).toBe(helper.principalId);
  });
});

describe("a registration told late", () => {
  it("leaves a later generation's following and its notice alone", async () => {
    const stub = env.REPO.getByName(fork.id);
    const tip = await stub.pullHeadTip("main");
    await stub.registerOutgoingPull({
      baseRepoId: base.id,
      number: 7,
      headRef: "main",
      generation: 2,
      knownSha: null,
    });
    await stub.registerOutgoingPull({
      baseRepoId: base.id,
      number: 7,
      headRef: "main",
      generation: 1,
      knownSha: tip.sha,
    });
    const rows = await inRepo(stub, (r: RepoDO) => ({
      follows: r.git.context.storage.sql
        .exec<{ generation: number }>("SELECT generation FROM outgoing_pulls WHERE pr_number = 7")
        .toArray(),
      notices: r.git.context.storage.sql
        .exec<{ generation: number; pushed: number }>(
          "SELECT generation, pushed FROM revision_notices WHERE pr_number = 7",
        )
        .toArray(),
    }));
    expect(rows).toEqual({
      follows: [{ generation: 2 }],
      notices: [{ generation: 2, pushed: 1 }],
    });
  });
});

describe("an author who loses access to the fork", () => {
  it("gets no revision published after it, though its import had begun", async () => {
    // The pull request's author reads the fork as a collaborator, then no longer does.
    const author = await user();
    await api("PUT", `${base.path}/collaborators/${author.handle}`, owner.token, {
      permission: "pull",
    });
    await api("PUT", `${fork.path}/collaborators/${author.handle}`, contributor.token, {
      permission: "pull",
    });
    expect((await open(author, `${contributor.handle}:main`)).status).toBe(201);
    const head = (await pull()).head.sha;
    await runJobs(base.id);
    await commitOn(contributor, fork.path, "main", [{ path: "c.txt", content: "c\n" }]);
    await runJobs(fork.id);
    const stub = env.REPO.getByName(base.id);
    const slice = () =>
      inRepo(stub, (r: RepoDO) =>
        r.git.jobs.runJob("revision-import", r.pullImports.handler(), r.git.memory, 0),
      );
    await slice(); // snapshot: the author still reads the fork
    expect((await inRepo(stub, (r: RepoDO) => r.pullImports.get(1)))?.step).not.toBe("snapshot");
    expect(
      (await api("DELETE", `${fork.path}/collaborators/${author.handle}`, contributor.token))
        .status,
    ).toBeLessThan(300);
    for (let i = 0; i < 6; i++) await slice();
    expect((await pull()).head.sha).toBe(head);
    expect(await inRepo(stub, (r: RepoDO) => r.pullImports.get(1))).toBeUndefined();
  });
});

describe("an opener who loses access to the fork while it opens", () => {
  it("opens nothing", async () => {
    const opener = await user();
    await api("PUT", `${base.path}/collaborators/${opener.handle}`, owner.token, {
      permission: "pull",
    });
    await api("PUT", `${fork.path}/collaborators/${opener.handle}`, contributor.token, {
      permission: "pull",
    });
    // Removed once the Worker has checked access, as the import finishes.
    await inRepo(env.REPO.getByName(base.id), (r: RepoDO) => {
      r.forkPullHooks = {
        beforePublish: async () => {
          r.forkPullHooks = {};
          await api("DELETE", `${fork.path}/collaborators/${opener.handle}`, contributor.token);
        },
      };
    });
    const opened = await open(opener, `${contributor.handle}:main`);
    expect(opened.body.code).toBe("head_not_found");
    expect((await json(api("GET", `${base.path}/pulls/1`, owner.token))).status).toBe(404);
  });
});

describe("a base frozen for a transfer", () => {
  it("keeps a revision waiting, its attempts unspent, and takes it once thawed", async () => {
    await open(contributor, `${contributor.handle}:main`);
    await runJobs(base.id);
    const next = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    const stub = env.REPO.getByName(base.id);
    const transferId = uniqueId("trf");
    await runJobs(fork.id);
    expect(
      await stub.freezeForTransfer({ transferId, from: owner.principalId, to: uniqueId("org") }),
    ).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) await runJobs(base.id);
    const waiting = await inRepo(stub, (r: RepoDO) => r.pullImports.get(1));
    expect(waiting).toMatchObject({ sha: next, attempts: 0 });
    await stub.unfreezeTransfer(transferId);
    // Its retry delay is on the object's clock: brought forward for the test.
    await inRepo(stub, (r: RepoDO) => {
      const now = r.git.context.now();
      r.git.context.storage.sql.exec("UPDATE revision_imports SET requested_at = ?", now);
      r.git.context.storage.sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE job_id = 'revision-import'",
        now,
      );
    });
    await runJobs(base.id);
    expect((await pull()).head.sha).toBe(next);
  });
});

describe("the base's collection after imports", () => {
  it("is asked for once no run is under way, even when one was when the packs were borrowed", async () => {
    const stub = env.REPO.getByName(base.id);
    await open(contributor, `${contributor.handle}:main`);
    const requested = () =>
      inRepo(stub, (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ due_at: number }>("SELECT due_at FROM collect_requests")
          .toArray(),
      );
    expect(await requested()).toHaveLength(1);
    // Due now, and a run of the collection under way: kept for later.
    await inRepo(stub, (r: RepoDO) => {
      r.git.context.storage.sql.exec("UPDATE collect_requests SET due_at = ?", r.git.context.now());
      r.git.jobs.ensure("gc", "gc", { cursor: new TextEncoder().encode("{}") });
    });
    await inRepo(stub, (r: RepoDO) =>
      r.git.jobs.runJob("revision-import", r.pullImports.handler(), r.git.memory, 0),
    );
    expect(await requested()).toHaveLength(1);
    // None under way: it becomes a run.
    await inRepo(stub, (r: RepoDO) =>
      r.git.context.storage.sql.exec("UPDATE jobs SET cursor = NULL WHERE job_id = 'gc'"),
    );
    await inRepo(stub, (r: RepoDO) =>
      r.git.jobs.runJob("revision-import", r.pullImports.handler(), r.git.memory, 0),
    );
    expect(await requested()).toEqual([]);
  });
});

describe("the base's own packs", () => {
  it("are taken back when the base repacked them away and the fork still reads them", async () => {
    // A second pack in the base, both borrowed by the fork, then the base's repack replaces both.
    await commitOn(owner, base.path, "main", [{ path: "z.txt", content: "z\n" }]);
    const stub = env.REPO.getByName(base.id);
    const before = (await packStates(stub)).filter((p) => p.state === "live").map((p) => p.pack_id);
    await runJob(stub, "repack");
    await runJob(stub, "retire-packs");
    const after = await packStates(stub);
    expect(after.filter((p) => before.includes(p.pack_id)).map((p) => p.state)).not.toContain(
      "live",
    );
    const opened = await open(contributor, `${contributor.handle}:main`);
    expect(opened.status).toBe(201);
    const files = await json<{ files: { filename: string }[] }>(
      api("GET", `${base.path}/pulls/1/files`, owner.token),
    );
    expect(files.body.files.map((f) => f.filename)).toContain("b.txt");
  });
});

describe("the base's view", () => {
  it("compacts borrowed packs past its cap on its own job, the pull request still readable", async () => {
    const stub = env.REPO.getByName(base.id);
    // Room for two borrowed packs only.
    await inRepo(stub, (r: RepoDO) => {
      r.packCap = { ...r.packCap, cap: 30 };
    });
    await open(contributor, `${contributor.handle}:main`);
    for (const name of ["c", "d", "e"]) {
      await commitOn(contributor, fork.path, "main", [
        { path: `${name}.txt`, content: `${name}\n` },
      ]);
      await sync();
    }
    const borrowed = () =>
      inRepo(
        stub,
        (r: RepoDO) =>
          r.git.context.storage.sql
            .exec<{ n: number }>(
              "SELECT count(*) AS n FROM packs WHERE origin = 'borrowed' AND state = 'live'",
            )
            .one().n,
      );
    for (let i = 0; i < 5; i++) await runJobs(base.id);
    expect(await borrowed()).toBeLessThanOrEqual(2);
    const files = await json<{ files: { filename: string }[] }>(
      api("GET", `${base.path}/pulls/1/files`, owner.token),
    );
    expect(files.body.files.map((f) => f.filename)).toEqual(["b.txt", "c.txt", "d.txt", "e.txt"]);
  });

  const borrowedLive = (stub: DurableObjectStub<RepoDO>) =>
    inRepo(
      stub,
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM packs WHERE origin = 'borrowed' AND state = 'live'",
          )
          .one().n,
    );

  it("refuses a revision whose packs no compaction could make room for, keeping the last one", async () => {
    const stub = env.REPO.getByName(base.id);
    // Room for two borrowed packs, and no two of the fork's packs fit one compaction.
    await inRepo(stub, (r: RepoDO) => {
      r.packCap = { ...r.packCap, cap: 30 };
      r.maintenance = { ...r.maintenance, maxRewriteObjects: 1 };
    });
    await open(contributor, `${contributor.handle}:main`);
    const kept = await commitOn(contributor, fork.path, "main", [
      { path: "c.txt", content: "c\n" },
    ]);
    await sync();
    expect((await pull()).head.sha).toBe(kept);
    expect(await borrowedLive(stub)).toBe(2);
    // A third pack: the import is given up, the pull request keeps its revision.
    const refused = await commitOn(contributor, fork.path, "main", [
      { path: "d.txt", content: "d\n" },
    ]);
    await sync();
    expect((await pull()).head.sha).toBe(kept);
    expect(await borrowedLive(stub)).toBe(2);
    // Opening another pull request on it is refused, with nothing borrowed.
    await moveForkBranch("topic", ZERO, refused);
    const opened = await open(contributor, `${contributor.handle}:topic`);
    expect(opened).toMatchObject({ status: 422, body: { code: "view_full" } });
    expect(await borrowedLive(stub)).toBe(2);
  });

  it("refuses to take back packs at publication that the view could no longer hold", async () => {
    const stub = env.REPO.getByName(base.id);
    for (const name of ["c", "d"])
      await commitOn(contributor, fork.path, "main", [
        { path: `${name}.txt`, content: `${name}\n` },
      ]);
    await inRepo(stub, (r: RepoDO) => {
      r.packCap = { ...r.packCap, cap: 30 };
      // Between adoption and publication: a compaction replaced a pack the import borrowed (its
      // output standing in for it here by nothing), and no two packs fit one any more.
      r.forkPullHooks.beforePublish = async () => {
        const sql = r.git.context.storage.sql;
        sql.exec(
          `UPDATE packs SET state = 'superseded' WHERE pack_id = (SELECT pack_id FROM packs
             WHERE origin = 'borrowed' AND state = 'live' ORDER BY created_at LIMIT 1)`,
        );
        r.maintenance = { ...r.maintenance, maxRewriteObjects: 1 };
      };
    });
    const opened = await open(contributor, `${contributor.handle}:main`);
    expect(opened).toMatchObject({ status: 422, body: { code: "view_full" } });
    expect(await borrowedLive(stub)).toBe(2);
  });

  /** The base's live borrowed packs with their objects, oldest first. */
  const borrowedCounts = (stub: DurableObjectStub<RepoDO>) =>
    inRepo(stub, (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ pack_id: string; object_count: number }>(
          `SELECT pack_id, object_count FROM packs WHERE origin = 'borrowed' AND state = 'live'
           ORDER BY created_at, pack_id`,
        )
        .toArray(),
    );
  /** Runs the base's alarms until its view's compaction is done. */
  const compactView = async (stub: DurableObjectStub<RepoDO>) => {
    for (let i = 0; i < 20; i++) {
      await inRepo(stub, (r: RepoDO) => r.alarm());
      const state = await inRepo(stub, (r: RepoDO) => r.git.jobs.get(VIEW_COMPACT_JOB)?.state);
      if (state === "done") return;
    }
    throw new Error("the view's compaction did not finish");
  };
  /** A branch of the fork at a new commit of its own; answers the branch. */
  const forkBranch = async (name: string, file: string) => {
    const sha = await commitOn(contributor, fork.path, "main", [
      { path: file, content: `${file}\n` },
    ]);
    await moveForkBranch(name, ZERO, sha);
    return name;
  };
  /**
   * Another fork of the base, with a commit of its own: a pull request from
   * it borrows that one pack (the fork's other packs are the base's). Its
   * `owner:branch` head.
   */
  const otherFork = async () => {
    const other = await user();
    await api("PUT", `${base.path}/collaborators/${other.handle}`, owner.token, {
      permission: "pull",
    });
    const made = await json<{ name: string }>(
      api("POST", `${base.path}/forks`, other.token, { name: uniqueId("other") }),
    );
    expect(made.status).toBe(201);
    await commitOn(other, `/repos/${other.handle}/${made.body.name}`, "main", [
      { path: "d.txt", content: "d\n" },
    ]);
    return { other, head: `${other.handle}:main` };
  };

  for (const phase of ["swap", "compact"] as const)
    it(`decides on the written size of the compaction's run under way (${phase})`, async () => {
      const stub = env.REPO.getByName(base.id);
      // Room for one borrowed pack; a run merges at most 100 objects.
      await inRepo(stub, (r: RepoDO) => {
        r.packCap = { ...r.packCap, cap: 31 };
        r.maintenance = { ...r.maintenance, maxRewriteObjects: 100 };
      });
      await commitOn(contributor, fork.path, "main", [{ path: "c.txt", content: "c\n" }]);
      expect((await open(contributor, `${contributor.handle}:main`)).status).toBe(201);
      // Its two borrowed packs are over the cap: a run of the compaction merged them into 100
      // objects (the most a run takes), waiting to be swapped in; in the compact phase, the
      // cursor names it only as the run's output (evicted, or deleting its scratch, before the
      // cursor moved on).
      await inRepo(stub, (r: RepoDO) => {
        const sql = r.git.context.storage.sql;
        const sources = sql
          .exec<{ pack_id: string }>(
            "SELECT pack_id FROM packs WHERE origin = 'borrowed' AND state = 'live'",
          )
          .toArray()
          .map((p) => p.pack_id);
        expect(sources).toHaveLength(2);
        const now = r.git.context.now();
        sql.exec(
          `INSERT INTO packs (pack_id, network_id, r2_key, kind, state, object_count, bytes,
             created_at, last_touched_at)
           VALUES ('run-output', ?, 'run-output', 'compact', 'indexing', 100, 1, ?, ?)`,
          r.git.networkId(),
          now,
          now,
        );
        const cursor =
          phase === "swap"
            ? { phase, sources, runId: "run", outputId: "run-output" }
            : { phase, sources, runId: "run", rewrite: { packId: "run-output", seq: 1 } };
        // Held by a slice that has not finished: admission sees it, no alarm runs it.
        sql.exec(
          "UPDATE jobs SET state = 'running', lease_expires_at = ?, cursor = ? WHERE job_id = ?",
          now + 60 * 60_000,
          new TextEncoder().encode(JSON.stringify(cursor)),
          VIEW_COMPACT_JOB,
        );
      });
      // A third pack: chosen afresh, the three would merge; after the run, it pairs with nothing.
      const opened = await open(
        contributor,
        `${contributor.handle}:${await forkBranch("topic", "d.txt")}`,
      );
      expect(opened).toMatchObject({ status: 422, body: { code: "view_full" } });
    });

  it("takes packs that fit only were objects shared once the compaction tells they are", async () => {
    const stub = env.REPO.getByName(base.id);
    // Another fork, before the base borrows anything (a pull request from it borrows the one pack
    // of its own).
    const { other, head: otherHead } = await otherFork();
    await inRepo(stub, (r: RepoDO) => {
      r.packCap = { ...r.packCap, cap: 31 };
    });
    // Two packs borrowed (over the cap of one, compacted later), then the fork repacks them into
    // one holding both their objects, which is borrowed too.
    await commitOn(contributor, fork.path, "main", [{ path: "c.txt", content: "c\n" }]);
    expect((await open(contributor, `${contributor.handle}:main`)).status).toBe(201);
    await runJob(env.REPO.getByName(fork.id), "repack");
    const head = (await pull()).head.sha;
    await moveForkBranch("whole", ZERO, head);
    expect((await open(contributor, `${contributor.handle}:whole`)).status).toBe(201);
    const [b, c, whole] = await borrowedCounts(stub);
    expect(whole?.object_count).toBe((b?.object_count ?? 0) + (c?.object_count ?? 0));
    // A run takes the three (twice the objects there are) and no more.
    const budget = 2 * (whole?.object_count ?? 0);
    await inRepo(stub, (r: RepoDO) => {
      r.maintenance = { ...r.maintenance, maxRewriteObjects: budget };
    });
    // Were no object shared, the run's output and the new pack would not merge: it waits.
    const waiting = await open(other, otherHead);
    expect(waiting).toMatchObject({ status: 409, body: { code: "busy" } });
    await compactView(stub);
    // The output holds each object once: room for the new pack.
    expect((await borrowedCounts(stub)).map((p) => p.object_count)).toEqual([whole?.object_count]);
    expect(await open(other, otherHead)).toMatchObject({ status: 201 });
    expect(await borrowedLive(stub)).toBe(2);
  });

  it("refuses packs that fit only were objects shared once the compaction tells they are not", async () => {
    const stub = env.REPO.getByName(base.id);
    const { other, head: otherHead } = await otherFork();
    await inRepo(stub, (r: RepoDO) => {
      r.packCap = { ...r.packCap, cap: 31 };
    });
    // Three packs borrowed, sharing no object (over the cap of one, compacted later).
    for (const name of ["c", "e"])
      await commitOn(contributor, fork.path, "main", [{ path: `${name}.txt`, content: name }]);
    expect((await open(contributor, `${contributor.handle}:main`)).status).toBe(201);
    const counts = (await borrowedCounts(stub)).map((p) => p.object_count);
    expect(counts).toHaveLength(3);
    // A run takes the three and no more.
    const budget = counts.reduce((n, c) => n + c, 0);
    await inRepo(stub, (r: RepoDO) => {
      r.maintenance = { ...r.maintenance, maxRewriteObjects: budget };
    });
    const waiting = await open(other, otherHead);
    expect(waiting).toMatchObject({ status: 409, body: { code: "busy" } });
    await compactView(stub);
    expect((await borrowedCounts(stub)).map((p) => p.object_count)).toEqual([budget]);
    // Nothing shared: the new pack would never merge with the output.
    const refused = await open(other, otherHead);
    expect(refused).toMatchObject({ status: 422, body: { code: "view_full" } });
    expect(await borrowedLive(stub)).toBe(1);
  });

  it("leaves a compaction that cannot bring the view within its cap failing, not done", async () => {
    const stub = env.REPO.getByName(base.id);
    await open(contributor, `${contributor.handle}:main`);
    for (const name of ["c", "d"]) {
      await commitOn(contributor, fork.path, "main", [
        { path: `${name}.txt`, content: `${name}\n` },
      ]);
      await sync();
    }
    expect(await borrowedLive(stub)).toBe(3);
    // The cap lowered, and the rewrite budget with it, under a view already over it.
    const job = await inRepo(stub, async (r: RepoDO) => {
      r.packCap = { ...r.packCap, cap: 30 };
      const handler = viewCompactionHandler({
        git: r.git,
        policy: () => ({ ...r.maintenance, maxRewriteObjects: 1 }),
        blocks: () => createClockBlockCache(),
        ownCap: () => r.packCap.cap,
        record: async () => {},
      });
      scheduleViewCompaction(r.git);
      await r.git.jobs.runJob(VIEW_COMPACT_JOB, handler, r.git.memory, 0);
      return r.git.context.storage.sql
        .exec<{ state: string; last_error: string | null }>(
          "SELECT state, last_error FROM jobs WHERE job_id = ?",
          VIEW_COMPACT_JOB,
        )
        .one();
    });
    expect(job.state).not.toBe("done");
    expect(job.last_error).toMatch(/over its cap/);
    expect(await borrowedLive(stub)).toBe(3);
  });
});

describe("a head branch in a fork, written from the base", () => {
  const updateBranch = (who: Who = owner) =>
    json<{ sha: string; code?: string }>(
      api("PUT", `${base.path}/pulls/1/update-branch`, who.token),
    );
  const setConsent = (who: Who, allowed: boolean) =>
    json<Pull & { maintainer_can_modify: boolean }>(
      api("PATCH", `${base.path}/pulls/1`, who.token, { maintainer_can_modify: allowed }),
    );
  const forkTip = async () =>
    (
      await json<{ commit: { sha: string } }>(
        api("GET", `${fork.path}/branches/main`, contributor.token),
      )
    ).body.commit.sha;
  const forkFile = async (name: string) =>
    atob(
      (
        await json<{ content: string }>(
          api("GET", `${fork.path}/contents/${name}?ref=main`, contributor.token),
        )
      ).body.content.replace(/\n/g, ""),
    );
  /** Opened, the fork told which branch it is followed for, and the base moved on. */
  const opened = async (extra: Record<string, unknown> = {}) => {
    const made = await open(contributor, `${contributor.handle}:main`, extra);
    expect(made.status).toBe(201);
    await runJobs(base.id);
    await commitOn(owner, base.path, "main", [{ path: "c.txt", content: "base\n" }]);
    return made.body as Pull & { maintainer_can_modify: boolean };
  };

  it("is updated by the base's maintainers when its author lets them, in the fork", async () => {
    expect((await opened()).maintainer_can_modify).toBe(false);
    expect((await updateBranch()).body.code).toBe("maintainer_edits_off");
    const allowed = await setConsent(contributor, true);
    expect(allowed.status).toBe(200);
    expect(allowed.body.maintainer_can_modify).toBe(true);
    // The fork has the consent once told.
    await runJobs(base.id);
    const updated = await updateBranch();
    expect(updated.status).toBe(202);
    expect(await forkTip()).toBe(updated.body.sha);
    expect(await forkFile("c.txt")).toBe("base\n");
    expect(await forkFile("b.txt")).toBe("from the fork\n");
    // The fork tells the base of the new head, as of any push.
    await sync();
    expect((await pull()).head.sha).toBe(updated.body.sha);
  });

  it("lets only the author allow it, and only for a head in a fork", async () => {
    await opened();
    expect((await setConsent(owner, true)).status).toBe(403);
    expect((await pull()) as Pull & { maintainer_can_modify: boolean }).toMatchObject({
      maintainer_can_modify: false,
    });
    // A head branch in the base itself: the base's own to write, nothing to allow.
    const tip = (
      await json<{ commit: { sha: string } }>(api("GET", `${base.path}/branches/main`, owner.token))
    ).body.commit.sha;
    const target: PushTarget = {
      repo: { id: base.id, name: base.name, stub: env.REPO.getByName(base.id) },
      owner: {
        principalId: owner.principalId,
        token: await scopedToken(owner.principalId, [], "git"),
      },
      path: `/${owner.handle}/${base.name}.git`,
    };
    const pushed = await postPush(
      target,
      pushBody([{ old: ZERO, new: tip, ref: "refs/heads/side" }], { pack: fx.packEmpty }),
    );
    expect(pushed.report).toContain("ok refs/heads/side\n");
    await commitOn(owner, base.path, "side", [{ path: "s.txt", content: "s\n" }]);
    const own = await json<Pull & { maintainer_can_modify: boolean }>(
      api("POST", `${base.path}/pulls`, owner.token, {
        title: "Own",
        head: "side",
        base: "main",
        maintainer_can_modify: true,
      }),
    );
    expect(own.status).toBe(201);
    expect(own.body.maintainer_can_modify).toBe(false);
    const patched = await json<Pull & { maintainer_can_modify: boolean }>(
      api("PATCH", `${base.path}/pulls/${own.body.number}`, owner.token, {
        maintainer_can_modify: true,
      }),
    );
    expect(patched.status).toBe(200);
    expect(patched.body.maintainer_can_modify).toBe(false);
  });

  it("stops a later write as soon as the author withdraws consent, before the fork is told", async () => {
    await opened({ maintainer_can_modify: true });
    expect((await setConsent(contributor, false)).status).toBe(200);
    expect((await updateBranch()).body.code).toBe("maintainer_edits_off");
  });

  it("is refused once the author is disabled, though its role in the fork remains", async () => {
    await opened({ maintainer_can_modify: true });
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = ? WHERE id = ?")
      .bind(Date.now(), contributor.principalId)
      .run();
    const before = await forkTip();
    expect((await updateBranch()).body.code).toBe("maintainer_edits_off");
    expect(await forkTip()).toBe(before);
  });

  it("is refused by the fork when its own copy of the consent says no", async () => {
    await opened({ maintainer_can_modify: true });
    await inRepo(env.REPO.getByName(fork.id), (r: RepoDO) => {
      r.git.context.storage.sql.exec("UPDATE outgoing_pulls SET maintainer_can_modify = 0");
    });
    const before = await forkTip();
    expect((await updateBranch()).body.code).toBe("maintainer_edits_off");
    expect(await forkTip()).toBe(before);
  });

  it("needs no consent from a maintainer who writes the fork too", async () => {
    await opened();
    const set = await api("PUT", `${fork.path}/collaborators/${owner.handle}`, contributor.token, {
      permission: "push",
    });
    expect(set.status).toBe(200);
    const updated = await updateBranch();
    expect(updated.status).toBe(202);
    expect(await forkTip()).toBe(updated.body.sha);
  });

  it("takes a maintainer's token limited to the base, while the author allows it", async () => {
    await opened({ maintainer_can_modify: true });
    // Writing the fork too does not make a token limited to the base write it directly.
    const set = await api("PUT", `${fork.path}/collaborators/${owner.handle}`, contributor.token, {
      permission: "push",
    });
    expect(set.status).toBe(200);
    const limited = { ...owner, token: await scopedToken(owner.principalId, [], "pat", [base.id]) };
    const updated = await updateBranch(limited);
    expect(updated.status).toBe(202);
    expect(await forkTip()).toBe(updated.body.sha);
  });

  it("is refused in the fork's commit when the consent is withdrawn there meanwhile", async () => {
    await opened({ maintainer_can_modify: true });
    const before = await forkTip();
    await inRepo(env.REPO.getByName(fork.id), (r: RepoDO) => {
      r.headWriteHooks = {
        beforeFinish: async () => {
          r.headWriteHooks = {};
          r.git.context.storage.sql.exec("UPDATE outgoing_pulls SET maintainer_can_modify = 0");
        },
      };
    });
    const refused = await updateBranch();
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("maintainer_edits_off");
    expect(await forkTip()).toBe(before);
  });

  it("is refused when the fork's branch moved since the base last had it", async () => {
    await opened({ maintainer_can_modify: true });
    await commitOn(contributor, fork.path, "main", [{ path: "d.txt", content: "d\n" }]);
    expect((await updateBranch()).body.code).toBe("head_moved");
  });

  it("takes suggestions, committed in the fork, their threads resolved", async () => {
    const made = await opened({ maintainer_can_modify: true });
    const suggested = await json<{ id: number }>(
      api("POST", `${base.path}/pulls/1/comments`, owner.token, {
        body: "Better:\n```suggestion\nFROM THE FORK\n```",
        commit_id: made.head.sha,
        path: "b.txt",
        line: 1,
      }),
    );
    expect(suggested.status).toBe(201);
    const applied = await json<{ commit: { sha: string } }>(
      api("POST", `${base.path}/pulls/1/suggestions/apply`, owner.token, {
        comment_ids: [suggested.body.id],
      }),
    );
    expect(applied.status).toBe(201);
    expect(await forkTip()).toBe(applied.body.commit.sha);
    expect(await forkFile("b.txt")).toBe("FROM THE FORK\n");
    const threads = await json<{ threads: { resolved: boolean }[] }>(
      api("GET", `${base.path}/pulls/1/threads`, owner.token),
    );
    expect(threads.body.threads.every((t) => t.resolved)).toBe(true);
  });
});
