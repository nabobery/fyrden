// Mergeability worked out in the background: queued with each change of a
// pull request or move of its base branch, served longest waiting first, a
// result kept only for the pair of base tip and head it was worked out for.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  MERGEABILITY_POLICY,
  MERGEABILITY_RETRY,
  mergeabilityRetryDelay,
} from "../src/do/repo/mergeability.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Pull = {
  number: number;
  mergeable: boolean | null;
  mergeable_state: string;
  mergeable_reason: string | null;
  head: { sha: string };
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);

const commitOn = async (branch: string, changes: Record<string, unknown>[]) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};

async function branchAt(name: string, sha: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

async function deleteBranch(name: string, at: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: at, new: ZERO, ref: `refs/heads/${name}` }]),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

const open = async (head: string, body: Record<string, unknown> = {}) => {
  const opened = await json<Pull>(
    api("POST", `${path}/pulls`, owner.token, { title: head, head, base: "main", ...body }),
  );
  expect(opened.status).toBe(201);
  return opened.body.number;
};
const pull = async (number = 1) =>
  (await json<Pull>(api("GET", `${path}/pulls/${number}`, owner.token))).body;
const runJobs = () => inRepo(stub(), (r: RepoDO) => r.alarm());
const queue = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ pr_number: number }>(
        "SELECT pr_number FROM mergeability_jobs ORDER BY requested_at, pr_number",
      )
      .toArray()
      .map((row) => row.pr_number),
  );
const mergeabilityEvents = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
      .toArray()
      .map((row) => JSON.parse(row.event) as { type: string; data: Record<string, unknown> })
      .filter((e) => e.type === "pull_request.mergeability")
      .map((e) => e.data),
  );
/** Makes every merge the job works out go past its budget, or no longer. */
const pastBudget = (past: boolean) =>
  inRepo(stub(), (r: RepoDO) => {
    r.mergeabilityPolicy = past ? { ...MERGEABILITY_POLICY, maxTrees: 1 } : MERGEABILITY_POLICY;
  });
/** The result kept for pull request 1, with when it is due to be worked out again. */
const kept = () =>
  inRepo(stub(), (r: RepoDO) => {
    const row = r.git.context.storage.sql
      .exec<{
        base_sha: string;
        head_sha: string;
        state: string;
        attempts: number;
        computed_at: number;
      }>("SELECT base_sha, head_sha, state, attempts, computed_at FROM mergeability")
      .one();
    return { ...row, retry_at: row.computed_at + mergeabilityRetryDelay(row.attempts) };
  });
const waiting = () =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql
      .exec<{ pr_number: number; requested_at: number }>(
        "SELECT pr_number, requested_at FROM mergeability_jobs",
      )
      .toArray(),
  );
/** When the queue's job runs next. */
const jobAt = () =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ next_run_at: number }>("SELECT next_run_at FROM jobs WHERE job_id = 'mergeability'")
        .one().next_run_at,
  );

let base: string;

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  base = await commitOn("main", [{ path: "a.txt", content: "one\ntwo\nthree\n" }]);
  await branchAt("feature", base);
  await commitOn("feature", [{ path: "a.txt", content: "one\ntwo\nTHREE\n" }]);
});

describe("mergeability", () => {
  it("is unknown until worked out, then clean, with an event", async () => {
    await open("feature");
    expect(await pull()).toMatchObject({
      mergeable: null,
      mergeable_state: "unknown",
      mergeable_reason: "pending",
    });
    expect(await queue()).toEqual([1]);
    await runJobs();
    expect(await pull()).toMatchObject({
      mergeable: true,
      mergeable_state: "clean",
      mergeable_reason: null,
    });
    expect(await queue()).toEqual([]);
    expect(await mergeabilityEvents()).toEqual([
      expect.objectContaining({ number: 1, state: "clean", mergeable: true }),
    ]);
    // Listed with it too.
    const listed = await json<{ pull_requests: Pull[] }>(api("GET", `${path}/pulls`, owner.token));
    expect(listed.body.pull_requests[0]).toMatchObject({ mergeable: true });
  });

  it("follows the base branch: a conflicting push makes it dirty, naming the paths", async () => {
    await open("feature");
    await runJobs();
    await commitOn("main", [{ path: "a.txt", content: "one\ntwo\n3\n" }]);
    // The kept result is for the old base tip: not shown.
    expect(await pull()).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: false, mergeable_state: "dirty" });
    expect((await mergeabilityEvents()).at(-1)).toMatchObject({
      state: "conflicts",
      conflicts: [{ path: "a.txt", kind: "content" }],
      conflicts_total: 1,
    });
  });

  it("works out only the latest pair when the head moves twice before it runs", async () => {
    await open("feature");
    await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
    const head = await commitOn("feature", [{ path: "c.txt", content: "c\n" }]);
    expect(await queue()).toEqual([1]);
    await runJobs();
    const now = await pull();
    expect(now.head.sha).toBe(head);
    expect(now).toMatchObject({ mergeable: true });
    expect(await mergeabilityEvents()).toHaveLength(1);
  });

  it("serves every pull request on a moved base, longest waiting first", async () => {
    const numbers: number[] = [];
    for (const name of ["f1", "f2", "f3", "f4", "f5"]) {
      await branchAt(name, base);
      await commitOn(name, [{ path: `${name}.txt`, content: `${name}\n` }]);
      numbers.push(await open(name));
    }
    await runJobs();
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    expect(await queue()).toEqual(numbers);
    await runJobs();
    for (const number of numbers) expect((await pull(number)).mergeable).toBe(true);
  });

  it("queues a moved base's open pull requests at once, waking its job once", async () => {
    await branchAt("release", base);
    for (const name of ["f1", "f2", "f3", "f4", "f5", "f6"]) {
      await branchAt(name, base);
      await commitOn(name, [{ path: `${name}.txt`, content: `${name}\n` }]);
      await open(name, name === "f6" ? { base: "release" } : {});
    }
    await runJobs();
    // A closed one and one on another base are left out; one already waiting asks again.
    expect((await api("PATCH", `${path}/pulls/4`, owner.token, { state: "closed" })).status).toBe(
      200,
    );
    await commitOn("f2", [{ path: "f2.txt", content: "F2\n" }]);
    const ensured: string[] = [];
    await inRepo(stub(), (r: RepoDO) => {
      // Its place, set apart from any time the move's request can have.
      r.git.context.storage.sql.exec(
        "UPDATE mergeability_jobs SET requested_at = 1 WHERE pr_number = 2",
      );
      const ensure = r.git.jobs.ensure.bind(r.git.jobs);
      r.git.jobs.ensure = (kind, ...rest) => {
        ensured.push(kind);
        return ensure(kind, ...rest);
      };
    });
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    expect(ensured.filter((kind) => kind === "mergeability")).toHaveLength(1);
    const queued = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ pr_number: number; seq: number; requested_at: number }>(
          "SELECT pr_number, seq, requested_at FROM mergeability_jobs ORDER BY requested_at, pr_number",
        )
        .toArray(),
    );
    // #2 keeps its place, its request newer; the others are queued together behind it.
    expect(queued.map((row) => [row.pr_number, row.seq])).toEqual([
      [2, 2],
      [1, 1],
      [3, 1],
      [5, 1],
    ]);
    expect(queued[0]?.requested_at).toBe(1);
    expect(new Set(queued.slice(1).map((row) => row.requested_at)).size).toBe(1);
    await runJobs();
    for (const number of [1, 2, 3, 5]) expect((await pull(number)).mergeable).toBe(true);
  });

  it("lets others go first when a pull request moved while it was worked out", async () => {
    await branchAt("other", base);
    await commitOn("other", [{ path: "o.txt", content: "o\n" }]);
    await open("feature");
    await open("other");
    const order: number[] = [];
    await inRepo(stub(), (r: RepoDO) => {
      let moved = false;
      r.mergeabilityHooks = {
        beforeWrite: async () => {
          order.push(
            ...r.git.context.storage.sql
              .exec<{ pr_number: number }>(
                "SELECT pr_number FROM mergeability_jobs ORDER BY requested_at, pr_number LIMIT 1",
              )
              .toArray()
              .map((row) => row.pr_number),
          );
          if (moved) return;
          moved = true;
          await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
        },
      };
    });
    await runJobs();
    // #1 was worked out first, moved meanwhile and went behind #2.
    expect(order).toEqual([1, 2, 1]);
    expect((await pull(1)).mergeable).toBe(true);
    expect((await pull(2)).mergeable).toBe(true);
  });

  it("never keeps a result for a pair that moved while it was worked out", async () => {
    await open("feature");
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeabilityHooks = {
        beforeWrite: async () => {
          r.mergeabilityHooks = {};
          await commitOn("main", [{ path: "a.txt", content: "one\ntwo\n3\n" }]);
        },
      };
    });
    await runJobs();
    // Worked out clean for the old base tip: never kept nor announced; the new pair, queued
    // again by the push, is worked out in its place.
    const tip = (await json<{ sha: string }>(api("GET", `${path}/commits/main`, owner.token))).body
      .sha;
    const kept = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ base_sha: string; state: string }>("SELECT base_sha, state FROM mergeability")
        .toArray(),
    );
    expect(kept).toEqual([{ base_sha: tip, state: "conflicts" }]);
    expect((await mergeabilityEvents()).map((e) => e.state)).toEqual(["conflicts"]);
    expect(await pull()).toMatchObject({ mergeable: false, mergeable_state: "dirty" });
  });

  it("keeps nothing while the repository is frozen, and waits for it", async () => {
    await open("feature");
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeabilityHooks = {
        beforeWrite: async () => {
          r.mergeabilityHooks = {};
          expect(
            await r.freezeForTransfer({
              transferId: uniqueId("trf"),
              from: owner.principalId,
              to: uniqueId("org"),
            }),
          ).toEqual({ ok: true });
        },
      };
    });
    await runJobs();
    expect(await queue()).toEqual([1]);
    const kept = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("SELECT * FROM mergeability").toArray(),
    );
    expect(kept).toEqual([]);
  });

  it("is worked out again for the new base when the pull request is retargeted", async () => {
    await branchAt("release", base);
    await commitOn("release", [{ path: "a.txt", content: "one\ntwo\n3\n" }]);
    await open("feature");
    await runJobs();
    expect((await pull()).mergeable).toBe(true);
    const retargeted = await api("PATCH", `${path}/pulls/1`, owner.token, { base: "release" });
    expect(retargeted.status).toBe(200);
    // The result kept is for the old base: not shown.
    expect(await pull()).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
    expect(await queue()).toEqual([1]);
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: false, mergeable_state: "dirty" });
  });

  it("is not queued by reads while its base branch is gone, and is once it is back", async () => {
    await branchAt("release", base);
    await open("feature", { base: "release" });
    await runJobs();
    await deleteBranch("release", base);
    await runJobs();
    for (let i = 0; i < 3; i++) {
      expect(await pull()).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
      expect(await queue()).toEqual([]);
    }
    await branchAt("release", base);
    expect(await queue()).toEqual([1]);
    await runJobs();
    expect((await pull()).mergeable).toBe(true);
  });

  it("does not hurry a waiting job when it is read", async () => {
    await open("feature");
    const at = () =>
      inRepo(
        stub(),
        (r: RepoDO) =>
          r.git.context.storage.sql
            .exec<{ next_run_at: number }>(
              "SELECT next_run_at FROM jobs WHERE job_id = 'mergeability'",
            )
            .one().next_run_at,
      );
    const later = Date.now() + 60_000;
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "UPDATE jobs SET next_run_at = ? WHERE job_id = 'mergeability'",
        later,
      ),
    );
    await pull();
    expect(await at()).toBe(later);
  });

  it("shows a draft as draft, and stops for a closed pull request", async () => {
    await open("feature", { draft: true });
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: true, mergeable_state: "draft" });
    await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
    expect(await queue()).toEqual([1]);
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    expect(await queue()).toEqual([]);
    expect(await pull()).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
  });

  it("is too expensive past its budget, and worked out again after a delay that doubles", async () => {
    await open("feature");
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    await pastBudget(true);
    await runJobs();
    expect(await pull()).toMatchObject({
      mergeable: null,
      mergeable_state: "unknown",
      mergeable_reason: "too_expensive",
    });
    expect((await mergeabilityEvents()).at(-1)).toMatchObject({ state: "unknown" });
    const first = await kept();
    expect(first).toMatchObject({ state: "unknown", attempts: 1 });
    expect(first.retry_at - first.computed_at).toBe(MERGEABILITY_RETRY.firstMs);
    // Waiting out its delay, and the job with it: asking for it or running the job does nothing.
    expect(await waiting()).toEqual([{ pr_number: 1, requested_at: first.retry_at }]);
    expect(await jobAt()).toBe(first.retry_at);
    await pull();
    await runJobs();
    expect(await kept()).toEqual(first);
    expect(await jobAt()).toBe(first.retry_at);
    // Its delay over, it is worked out again: still past, so it waits twice as long, with no
    // event (its state is the same).
    const announced: string[] = [];
    await inRepo(stub(), (r: RepoDO) => {
      const emit = r.events.emitActivity.bind(r.events);
      r.events.emitActivity = (type, ...rest) => {
        announced.push(type);
        return emit(type, ...rest);
      };
    });
    vi.setSystemTime(first.retry_at);
    await runJobs();
    const second = await kept();
    expect(second).toMatchObject({ state: "unknown", attempts: 2 });
    expect(second.retry_at - second.computed_at).toBe(2 * MERGEABILITY_RETRY.firstMs);
    expect(await jobAt()).toBe(second.retry_at);
    expect(announced).not.toContain("pull_request.mergeability");
    await pastBudget(false);
    vi.setSystemTime(second.retry_at);
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: true, mergeable_reason: null });
    expect(await queue()).toEqual([]);
  });

  it("waits at most the longest delay between tries", () => {
    expect(mergeabilityRetryDelay(1)).toBe(MERGEABILITY_RETRY.firstMs);
    expect(mergeabilityRetryDelay(3)).toBe(4 * MERGEABILITY_RETRY.firstMs);
    expect(mergeabilityRetryDelay(6)).toBe(32 * MERGEABILITY_RETRY.firstMs);
    expect(mergeabilityRetryDelay(7)).toBe(MERGEABILITY_RETRY.maxMs);
    expect(mergeabilityRetryDelay(5_000)).toBe(MERGEABILITY_RETRY.maxMs);
  });

  it("starts its delays over when the head or the base moves", async () => {
    await open("feature");
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    await pastBudget(true);
    await runJobs();
    vi.setSystemTime((await kept()).retry_at);
    await runJobs();
    expect(await kept()).toMatchObject({ attempts: 2 });
    // The head moves: worked out at once for the new pair, its delay the first one again.
    const head = await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
    await runJobs();
    const moved = await kept();
    expect(moved).toMatchObject({ head_sha: head, state: "unknown", attempts: 1 });
    expect(moved.retry_at - moved.computed_at).toBe(MERGEABILITY_RETRY.firstMs);
    // So does the base.
    const tip = await commitOn("main", [{ path: "y.txt", content: "y\n" }]);
    await runJobs();
    expect(await kept()).toMatchObject({ base_sha: tip, state: "unknown", attempts: 1 });
  });

  it("is worked out again at once when its budgets changed since", async () => {
    await open("feature");
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    await pastBudget(true);
    await runJobs();
    const before = await kept();
    await pastBudget(false);
    // Kept under other budgets (an older build's): asking for it brings its turn forward.
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("UPDATE mergeability SET policy_version = 0"),
    );
    expect(await pull()).toMatchObject({ mergeable_reason: "too_expensive" });
    expect((await waiting())[0]?.requested_at).toBeLessThan(before.retry_at);
    expect(await jobAt()).toBeLessThan(before.retry_at);
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: true, mergeable_reason: null });
  });

  it("is queued when asked for, past the budget by older budgets and not waiting", async () => {
    await open("feature");
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    await pastBudget(true);
    await runJobs();
    await pastBudget(false);
    await inRepo(stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec("UPDATE mergeability SET policy_version = 0");
      r.git.context.storage.sql.exec("DELETE FROM mergeability_jobs");
    });
    await pull();
    expect(await queue()).toEqual([1]);
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: true, mergeable_reason: null });
  });

  it("is unreadable when an object cannot be read, and worked out again after a delay", async () => {
    await open("feature");
    await inRepo(stub(), (r: RepoDO) => {
      vi.spyOn(r.git.commitGraph, "read").mockRejectedValue(new Error("lost"));
    });
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      vi.mocked(r.git.commitGraph.read).mockRestore();
    });
    expect(await pull()).toMatchObject({
      mergeable: null,
      mergeable_state: "unknown",
      mergeable_reason: "unreadable",
    });
    const first = await kept();
    expect(first).toMatchObject({ state: "error", attempts: 1 });
    expect(await waiting()).toEqual([{ pr_number: 1, requested_at: first.retry_at }]);
    vi.setSystemTime(first.retry_at);
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: true, mergeable_reason: null });
  });

  it("is queued when asked for and neither known nor queued", async () => {
    await open("feature");
    await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec("DELETE FROM mergeability_jobs"),
    );
    expect(await queue()).toEqual([]);
    await pull();
    expect(await queue()).toEqual([1]);
    await runJobs();
    expect((await pull()).mergeable).toBe(true);
  });
});
