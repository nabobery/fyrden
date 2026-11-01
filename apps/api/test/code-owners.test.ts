// Who owns what a pull request changes, worked out in the background from
// its base branch's CODEOWNERS and the three-dot diff (merge base to head),
// shown only for the pull request's current base branch, base tip and head:
// queued with the changes that move them, drafts when asked, superseded
// runs publishing nothing, evaluations reused across base moves that change
// neither the merge base nor the file, and pruned once nothing points at them.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { CODEOWNERS_EVALUATION_VERSION } from "../src/do/repo/code-owners.js";
import { api, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;

type Owners = {
  state: string;
  reason?: string;
  file: { path: string; sha: string } | null;
  errors: number;
  rules: { line: number; owners: string[]; paths: number; example_path: string }[];
  ownerless_paths: number;
  unmatched_paths: number;
  unmatchable_paths: number;
  next_cursor: string | null;
};

const stub = () => env.REPO.getByName(repo.id);

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (await answer.json()) as T;
}

/** Writes `files` (null deletes) on `branch` as one commit; its sha. */
async function commit(branch: string, files: Record<string, string | null>): Promise<string> {
  return (
    await ok<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch,
        message: "change",
        changes: Object.entries(files).map(([p, content]) =>
          content === null ? { path: p, delete: true } : { path: p, content },
        ),
      }),
    )
  ).commit.sha;
}

async function branchAt(name: string, sha: string): Promise<void> {
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

const open = (extra: Record<string, unknown> = {}) =>
  ok<{ number: number }>(
    api("POST", `${path}/pulls`, owner.token, {
      title: "Change",
      head: "feature",
      base: "main",
      ...extra,
    }),
  );

const owners = (number = 1, query = "", token = owner.token) =>
  api("GET", `${path}/pulls/${number}/code-owners${query}`, token);
const ownersOf = (number = 1, query = "") => ok<Owners>(owners(number, query));

/** Runs the repository's due jobs, a few rounds. */
const runJobs = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await inRepo(stub(), (r: RepoDO) => r.alarm());
};

/** Makes every queued job and every unreadable result's retry due now. */
const retryNow = () =>
  inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    const now = r.git.context.now();
    sql.exec("UPDATE jobs SET next_run_at = ? WHERE state = 'queued'", now);
    sql.exec("UPDATE code_owner_jobs SET requested_at = ?", now);
    sql.exec("UPDATE code_owner_pointers SET retry_at = ? WHERE retry_at IS NOT NULL", now);
  });

const rows = (table: string) =>
  inRepo(
    stub(),
    (r: RepoDO) =>
      r.git.context.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n,
  );

/**
 * Pull request 1's code owners worked out again from nothing (its result
 * and evaluations forgotten, it queued alone), the jobs run `rounds` times.
 */
async function workedOutAgain(rounds = 5): Promise<void> {
  await inRepo(stub(), (r: RepoDO) => {
    const sql = r.git.context.storage.sql;
    for (const table of ["code_owner_rules", "code_owner_evaluations", "code_owner_pointers"])
      sql.exec(`DELETE FROM ${table}`);
    r.codeOwners.stale(1, true);
  });
  await runJobs(rounds);
}

/** Rows the repository object writes for code owners and its job queue while `work` runs. */
async function rowsWrittenBy(work: () => Promise<unknown>): Promise<number> {
  let written = 0;
  const restore = await inRepo(stub(), (r: RepoDO) => {
    const metrics = r.git.context.metrics;
    const count = metrics.count.bind(metrics);
    metrics.count = (name, dimensions, value = 1) => {
      const op = String((dimensions as Record<string, unknown>)?.op ?? "");
      if (name === "do.rows_written" && (op.startsWith("code_owners") || op.startsWith("jobs.")))
        written += value;
      count(name, dimensions, value);
    };
    return () => {
      metrics.count = count;
    };
  });
  try {
    await work();
  } finally {
    await inRepo(stub(), () => restore());
  }
  return written;
}

beforeEach(async () => {
  owner = await user();
  repo = await ok<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${owner.handle}/${repo.name}`;
});

describe("code owners of a pull request", () => {
  it("are worked out from the base branch's file for what the pull request changes", async () => {
    await commit("main", {
      ".github/CODEOWNERS": "* @everyone\n*.ts @ts-team\n/docs/ @org/docs\n/src/gen/\n!bad @x\n",
      "docs/a.md": "a\n",
      "src/x.ts": "x\n",
    });
    await branchAt("feature", await commit("main", { "keep.txt": "k\n" }));
    await commit("feature", {
      "docs/a.md": "a2\n",
      "src/x.ts": "x2\n",
      "src/gen/out.ts": "o\n",
      "README.md": "r\n",
    });
    await open();
    expect((await ownersOf()).state).toBe("pending");
    await runJobs();
    const result = await ownersOf();
    expect(result).toMatchObject({
      state: "complete",
      file: { path: ".github/CODEOWNERS", sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
      errors: 1,
      ownerless_paths: 1,
      unmatched_paths: 0,
      unmatchable_paths: 0,
      next_cursor: null,
    });
    expect(result.rules).toEqual([
      { line: 1, owners: ["@everyone"], paths: 1, example_path: "README.md" },
      { line: 2, owners: ["@ts-team"], paths: 1, example_path: "src/x.ts" },
      { line: 3, owners: ["@org/docs"], paths: 1, example_path: "docs/a.md" },
      { line: 4, owners: [], paths: 1, example_path: "src/gen/out.ts" },
    ]);
  });

  it("ignore a file the head adds, and say when the base has none", async () => {
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { CODEOWNERS: "* @me\n", "a.txt": "b\n" });
    await open();
    await runJobs();
    expect(await ownersOf()).toMatchObject({ state: "none", file: null, rules: [] });
  });

  it("take the first location that holds the file, and follow the base when it moves", async () => {
    await commit("main", { CODEOWNERS: "* @root\n", "docs/CODEOWNERS": "* @docs\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    expect(await ownersOf()).toMatchObject({
      file: { path: "CODEOWNERS" },
      rules: [{ owners: ["@root"] }],
    });
    // The base moves: the same bytes now also at the first location (it wins), the merge base
    // unchanged: the evaluation is reused, the pointer names the new location.
    const evaluations = await rows("code_owner_evaluations");
    await commit("main", { ".github/CODEOWNERS": "* @root\n" });
    expect((await ownersOf()).state).toBe("pending");
    await runJobs();
    expect(await ownersOf()).toMatchObject({
      state: "complete",
      file: { path: ".github/CODEOWNERS" },
      rules: [{ owners: ["@root"] }],
    });
    expect(await rows("code_owner_evaluations")).toBe(evaluations);
    // Changed rules on the base: worked out again.
    await commit("main", { ".github/CODEOWNERS": "* @changed\n" });
    await runJobs();
    expect((await ownersOf()).rules).toMatchObject([{ owners: ["@changed"] }]);
  });

  it("wait for a draft to be asked about, then work it out", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open({ draft: true });
    await runJobs();
    expect(await rows("code_owner_pointers")).toBe(0);
    expect((await ownersOf()).state).toBe("pending");
    await runJobs();
    expect((await ownersOf()).state).toBe("complete");
  });

  it("publish nothing from a run its pull request moved past while it worked", async () => {
    await commit("main", { CODEOWNERS: "* @me\n*.md @docs\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    const before = (await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token)))
      .head.sha;
    // Every pointer written, as it is written.
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      sql.exec("CREATE TABLE pointer_log (head TEXT NOT NULL)");
      sql.exec(`CREATE TRIGGER pointer_insert AFTER INSERT ON code_owner_pointers
        BEGIN INSERT INTO pointer_log VALUES (new.head); END`);
      sql.exec(`CREATE TRIGGER pointer_update AFTER UPDATE ON code_owner_pointers
        BEGIN INSERT INTO pointer_log VALUES (new.head); END`);
      r.codeOwners.hooks.beforePublish = async () => {
        delete r.codeOwners.hooks.beforePublish;
        // The head moves after the run read it, before it publishes.
        await commit("feature", { "b.md": "b\n" });
      };
    });
    await runJobs();
    const after = (await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token)))
      .head.sha;
    expect(after).not.toBe(before);
    const written = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ head: string }>("SELECT head FROM pointer_log")
        .toArray()
        .map((row) => row.head),
    );
    // The run for the old head published nothing; the new head's did.
    expect(written).not.toContain(before);
    expect(written).toContain(after);
    expect((await ownersOf()).rules.map((r) => r.owners)).toEqual([["@me"], ["@docs"]]);
  });

  it("end too large for a file past GitHub's limit, without trying the next location", async () => {
    await commit("main", {
      ".github/CODEOWNERS": `# ${"x".repeat(3_000_000)}\n`,
      CODEOWNERS: "* @fallback\n",
    });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    expect(await ownersOf()).toMatchObject({ state: "too_large", reason: "file" });
  });

  it("forget a closed pull request's, and work them out again for its current pair on reopening", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" }));
    expect(await rows("code_owner_pointers")).toBe(0);
    expect(await rows("code_owner_jobs")).toBe(0);
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" }));
    await runJobs();
    expect((await ownersOf()).state).toBe("complete");
  });

  it("are queued again after a restore for open ready pull requests whose result is missing", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec("DELETE FROM code_owner_evaluations");
      r.codeOwners.restored();
    });
    // Read only after the jobs ran: the restore's scan queued it, not the read.
    expect(await rows("code_owner_jobs")).toBe(0);
    await runJobs();
    expect((await ownersOf()).state).toBe("complete");
  });

  it("prune evaluations nothing points at", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    await commit("feature", { "a.txt": "c\n" });
    await runJobs();
    expect(await rows("code_owner_evaluations")).toBe(1);
    expect(await rows("code_owner_rules")).toBe(1);
  });

  it("need contents:read too, and page their rules with a cursor bound to the evaluation", async () => {
    await commit("main", { CODEOWNERS: "* @a\n*.md @b\n*.ts @c\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n", "b.md": "b\n", "c.ts": "c\n" });
    await open();
    await runJobs();
    const pullsOnly = await scopedToken(owner.principalId, ["pull_requests:read"]);
    expect((await owners(1, "", pullsOnly)).status).toBe(403);
    const first = await ownersOf(1, "?per_page=2");
    expect(first.rules.map((r) => r.line)).toEqual([1, 2]);
    expect(first.next_cursor).not.toBeNull();
    const second = await ownersOf(1, `?per_page=2&cursor=${first.next_cursor}`);
    expect(second.rules.map((r) => r.line)).toEqual([3]);
    expect(second.next_cursor).toBeNull();
    // Worked out again for a new head: the old cursor names an evaluation that is no longer it.
    await commit("feature", { "d.md": "d\n" });
    await runJobs();
    const stale = await owners(1, `?per_page=2&cursor=${first.next_cursor}`);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({ code: "invalid_cursor" });
  });

  it("cost about 28 rows for a typical pull request, and about 6 more a slice (measured)", async () => {
    await commit("main", { CODEOWNERS: "* @me\n*.md @docs\n/src/ @src\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n", "b.md": "b\n", "src/c.ts": "c\n" });
    await open();
    await runJobs();
    const typical = await rowsWrittenBy(() => workedOutAgain());
    expect((await ownersOf()).state).toBe("complete");

    // Twenty changed paths, one a slice: what each slice before the last costs.
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i++) files[`many/f${String(i).padStart(2, "0")}.txt`] = `${i}\n`;
    await commit("feature", files);
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwners.limits = { ...r.codeOwners.limits, sliceChanges: 1 };
    });
    const sliced = await rowsWrittenBy(() => workedOutAgain(40));
    const result = await ownersOf();
    expect(result.state).toBe("complete");
    const slices = result.rules.reduce((n, r) => n + r.paths, 0) + result.unmatched_paths;
    const perSlice = sliced / slices;
    // Measured 2026-10-23: 21 rows typical (11 of its own tables with their indexes, 10 of the
    // job queue's); 136 for 23 one-change slices, about 6 a slice. Since its owners are asked
    // (2026-10-24), 7 more for the request job a new result queues (its queue row, the job's).
    expect(typical).toBeLessThanOrEqual(31);
    expect(perSlice).toBeLessThanOrEqual(7);
  });

  it("work out a draft that was queued before it became one, once read", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { draft: true }));
    expect((await ownersOf()).state).toBe("pending");
    await runJobs();
    expect((await ownersOf()).state).toBe("complete");
  });

  it("end too large when a tree on the way to the file is, and stuck when its reads never fit", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwners.policy = { ...r.codeOwners.policy, maxTreeBytes: 10 };
    });
    await runJobs();
    expect(await ownersOf()).toMatchObject({ state: "too_large", reason: "tree" });

    await commit("feature", { "a.txt": "c\n" });
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwners.policy = { ...r.codeOwners.policy, maxTreeBytes: 1024 * 1024, maxReads: 0 };
    });
    for (let i = 0; i < 3; i++) {
      await runJobs(1);
      expect((await ownersOf()).state).toBe(i < 2 ? "unreadable" : "too_large");
      await retryNow();
    }
    expect(await ownersOf()).toMatchObject({ state: "too_large", reason: "stuck" });
  });

  it("wait, without ending stuck, while other work holds the memory a slice needs", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    // Worked out again while no memory is free (other work holds it all).
    const restore = await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (const table of ["code_owner_rules", "code_owner_evaluations", "code_owner_pointers"])
        sql.exec(`DELETE FROM ${table}`);
      r.codeOwners.stale(1, true);
      const memory = r.git.memory;
      const tryReserve = memory.tryReserve.bind(memory);
      memory.tryReserve = () => undefined;
      return () => {
        memory.tryReserve = tryReserve;
      };
    });
    try {
      for (let i = 0; i < 5; i++) {
        await runJobs(1);
        await retryNow();
      }
      expect((await ownersOf()).state).toBe("pending");
    } finally {
      await inRepo(stub(), () => restore());
    }
    await retryNow();
    await runJobs();
    expect((await ownersOf()).state).toBe("complete");
  });

  it("count only slices in a row that could not read what the diff needs first", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = `${i}\n`;
    await commit("feature", files);
    await open();
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwners.policy = { ...r.codeOwners.policy, maxReads: 0 };
    });
    for (let i = 0; i < 2; i++) {
      await runJobs(1);
      await retryNow();
    }
    expect((await ownersOf()).state).toBe("unreadable");
    // A slice gets further: the streak of slices that could not read is over.
    const streak: number[] = [];
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwners.policy = { ...r.codeOwners.policy, maxReads: 150 };
      r.codeOwners.limits = { ...r.codeOwners.limits, sliceChanges: 1 };
      r.codeOwners.hooks.afterCheckpoint = () => {
        delete r.codeOwners.hooks.afterCheckpoint;
        streak.push(
          r.git.context.storage.sql
            .exec<{ n: number }>(
              "SELECT count(*) AS n FROM code_owner_pointers WHERE reason = 'budget'",
            )
            .one().n,
        );
      };
    });
    await runJobs(1);
    expect(streak).toEqual([0]);
  });

  it("work one heavy slice an alarm (a large file parsed)", async () => {
    // A file of 64 KiB or more makes every slice heavy: each ends its invocation.
    await commit("main", { CODEOWNERS: `# ${"x".repeat(70_000)}\n* @me\n` });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = `${i}\n`;
    await commit("feature", files);
    await open();
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (const table of ["code_owner_rules", "code_owner_evaluations", "code_owner_pointers"])
        sql.exec(`DELETE FROM ${table}`);
      r.codeOwners.limits = { ...r.codeOwners.limits, sliceChanges: 1 };
      r.codeOwners.stale(1, true);
    });
    const slicesAfter = async () =>
      inRepo(stub(), (r: RepoDO) => {
        const row = r.git.context.storage.sql
          .exec<{ totals: string | null }>("SELECT totals FROM code_owner_evaluations")
          .toArray()[0];
        return row?.totals ? (JSON.parse(row.totals) as { slices: number }).slices : 0;
      });
    await inRepo(stub(), (r: RepoDO) => r.alarm());
    expect(await slicesAfter()).toBe(1);
    await inRepo(stub(), (r: RepoDO) => r.alarm());
    expect(await slicesAfter()).toBe(2);
  });

  it("end the invocation after a slice that made no progress (a budget spent), not repeat it", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "d/a.txt": "b\n" });
    await open();
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (const table of ["code_owner_rules", "code_owner_evaluations", "code_owner_pointers"])
        sql.exec(`DELETE FROM ${table}`);
      // Too few entries a slice to read past the root: every slice stops with no progress.
      r.codeOwners.limits = { ...r.codeOwners.limits, sliceScanned: 1 };
      r.codeOwners.stale(1, true);
    });
    await inRepo(stub(), (r: RepoDO) => r.alarm());
    const stalled = await inRepo(stub(), (r: RepoDO) => {
      const row = r.git.context.storage.sql
        .exec<{ totals: string | null; state: string }>(
          "SELECT totals, state FROM code_owner_evaluations",
        )
        .one();
      return {
        state: row.state,
        stalled: (JSON.parse(row.totals ?? "{}") as { stalled?: number }).stalled,
      };
    });
    // One such slice an alarm: three would have ended it stuck in this one.
    expect(stalled).toEqual({ state: "pending", stalled: 1 });
  });

  it("end the invocation after a slice whose matcher spent all its steps, even on its first path", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    const base = await commit("main", { "a.txt": "a\n" });
    await branchAt("feature", base);
    await branchAt("other", base);
    await commit("feature", { "a.txt": "b\n" });
    await commit("other", { "a.txt": "c\n" });
    await open();
    await open({ head: "other" });
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (const table of ["code_owner_rules", "code_owner_evaluations", "code_owner_pointers"])
        sql.exec(`DELETE FROM ${table}`);
      // Too few steps a slice to decide even one path.
      r.codeOwners.limits = { ...r.codeOwners.limits, sliceSteps: 2 };
      r.codeOwners.stale(1, true);
      r.codeOwners.stale(2, true);
    });
    await inRepo(stub(), (r: RepoDO) => r.alarm());
    // The first ends `too_large` (path); its slice spent its steps, so the second waits.
    expect((await ownersOf(1)).state).toBe("too_large");
    expect(await rows("code_owner_pointers")).toBe(1);
  });

  it("run light slices together in one alarm (a small file, a few changes)", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) files[`f${i}.txt`] = `${i}\n`;
    await commit("feature", files);
    await open();
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      for (const table of ["code_owner_rules", "code_owner_evaluations", "code_owner_pointers"])
        sql.exec(`DELETE FROM ${table}`);
      r.codeOwners.limits = { ...r.codeOwners.limits, sliceChanges: 1 };
      r.codeOwners.stale(1, true);
    });
    await inRepo(stub(), (r: RepoDO) => r.alarm());
    expect((await ownersOf()).state).toBe("complete");
  });

  it("never take a cursor for a result made after its own was pruned", async () => {
    await commit("main", { CODEOWNERS: "* @a\n*.md @b\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n", "b.md": "b\n" });
    await open();
    await runJobs();
    const first = await ownersOf(1, "?per_page=1");
    expect(first.next_cursor).not.toBeNull();
    // Closed: its result is no one's, and pruned; reopened: worked out again, under a new id.
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" }));
    await runJobs();
    expect(await rows("code_owner_evaluations")).toBe(0);
    await ok(api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" }));
    await runJobs();
    const stale = await owners(1, `?per_page=1&cursor=${first.next_cursor}`);
    expect(stale.status).toBe(422);
    expect(await stale.json()).toMatchObject({ code: "invalid_cursor" });
  });

  it("answer pending, and queue them, for a result kept under another evaluator version", async () => {
    await commit("main", { CODEOWNERS: "* @me\n" });
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    await inRepo(stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec("UPDATE code_owner_pointers SET version = version - 1");
    });
    expect((await ownersOf()).state).toBe("pending");
    await runJobs();
    expect((await ownersOf()).state).toBe("complete");
  });

  it("work out again a result an earlier evaluator left stuck, now that locating reads a tree at a time", async () => {
    await branchAt("feature", await commit("main", { "a.txt": "a\n" }));
    await commit("feature", { "a.txt": "b\n" });
    await open();
    await runJobs();
    // As the previous version left it: final, for the same pair.
    await inRepo(stub(), (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        `UPDATE code_owner_pointers SET version = ?, eval_id = NULL, outcome = 'too_large',
           reason = 'stuck'`,
        CODEOWNERS_EVALUATION_VERSION - 1,
      );
    });
    expect((await ownersOf()).state).toBe("pending");
    await runJobs();
    expect((await ownersOf()).state).toBe("none");
  });
});
