// Mergeability worked out in the background: queued with each change of a
// pull request or move of its base branch, served longest waiting first, a
// result kept only for the pair of base tip and head it was worked out for.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { MERGEABILITY_POLICY } from "../src/do/repo/mergeability.js";
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
    expect(await pull()).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
    expect(await queue()).toEqual([1]);
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: true, mergeable_state: "clean" });
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

  it("is unknown past its budget, without being retried", async () => {
    await open("feature");
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeabilityPolicy = { ...MERGEABILITY_POLICY, maxTrees: 1 };
    });
    await runJobs();
    expect(await pull()).toMatchObject({ mergeable: null, mergeable_state: "unknown" });
    expect((await mergeabilityEvents()).at(-1)).toMatchObject({ state: "unknown" });
    // Known to be past the budget for this pair: asking again queues nothing.
    expect(await queue()).toEqual([]);
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
