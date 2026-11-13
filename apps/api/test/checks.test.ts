// Commit statuses and check summaries in the repository object: one summary
// per commit, name and publisher; check attempts started once per caller key
// and moved forward only, a late update from an older attempt refused; a
// batch written once per check; the limits per commit.
import { env } from "cloudflare:workers";
import { FYRDEN_CI_SOURCE } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { CheckStart, CheckUpdate } from "../src/do/repo/checks.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";

let owner: Who;
let repo: { id: string; name: string };
let path: string;
let sha: string;

const stub = () => env.REPO.getByName(repo.id);
const actor = (who: Who) => ({ principal: who.principalId, actChain: [], via: "api" as const });
const commitOn = async (branch: string, content: string) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, {
      branch,
      message: "change",
      changes: [{ path: "a.txt", content }],
    }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
const post = (state: string, context = "ci/build", who = owner, at = sha) =>
  stub().createStatus(
    at,
    { state: state as "success", context, description: null, targetUrl: null },
    actor(who),
  );
const summaries = (at = sha) => inRepo(stub(), (r: RepoDO) => r.checks.summariesOn(at));
const sql = <T>(query: string, ...bindings: unknown[]) =>
  inRepo(stub(), (r: RepoDO) =>
    r.git.context.storage.sql.exec(query, ...bindings).toArray(),
  ) as Promise<T[]>;
const start = (items: readonly CheckStart[], at = sha) => stub().startCheckAttempts(at, items);
const update = (items: readonly CheckUpdate[]) => stub().recordCheckUpdates(items);
const step = (
  name: string,
  attempt: number,
  status: CheckUpdate["status"],
  conclusion: CheckUpdate["conclusion"] = null,
): CheckUpdate => ({ sha, name, attempt, status, conclusion, detailsUrl: null });

/** Rows the repository object writes for checks while `work` runs. */
async function rowsWrittenBy(work: () => Promise<unknown>): Promise<number> {
  let written = 0;
  const restore = await inRepo(stub(), (r: RepoDO) => {
    const metrics = r.git.context.metrics;
    const count = metrics.count.bind(metrics);
    metrics.count = (name, dimensions, value = 1) => {
      const op = String((dimensions as Record<string, unknown>)?.op ?? "");
      if (name === "do.rows_written" && op.startsWith("checks.")) written += value;
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
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  sha = await commitOn("main", "one\n");
});

describe("a status", () => {
  it("is stored, and its publisher's summary of the context follows it", async () => {
    const made = await stub().createStatus(
      sha,
      {
        state: "failure",
        context: "CI/Build",
        description: "2 tests failed",
        targetUrl: "https://ci.example/1",
      },
      actor(owner),
    );
    expect(made).toMatchObject({
      ok: true,
      status: {
        sha,
        state: "failure",
        context: "CI/Build",
        description: "2 tests failed",
        targetUrl: "https://ci.example/1",
        creator: owner.principalId,
      },
    });
    expect(await summaries()).toEqual([
      expect.objectContaining({
        name: "CI/Build",
        source: owner.principalId,
        kind: "status",
        attempt: null,
        statusId: made.ok ? made.status.id : -1,
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://ci.example/1",
      }),
    ]);
  });

  it("reads pending as in progress, and keeps the failure it follows settled", async () => {
    await post("failure");
    await post("pending", "ci/BUILD");
    const [one] = await summaries();
    expect(one).toMatchObject({ name: "ci/BUILD", status: "in_progress", conclusion: null });
    const [row] = await sql<{ settled: string }>("SELECT settled FROM check_summaries");
    expect(row?.settled).toBe("failure");
    await post("success");
    const [after] = await sql<{ settled: string }>("SELECT settled FROM check_summaries");
    expect(after?.settled).toBe("success");
  });

  it("keeps each publisher's summary of one context apart", async () => {
    const other = await user();
    await api("PUT", `${path}/collaborators/${other.handle}`, owner.token, { permission: "push" });
    await post("failure", "build");
    await post("success", "BUILD", other);
    const rows = await summaries();
    expect(rows.map((r) => [r.source, r.conclusion]).sort()).toEqual(
      [
        [owner.principalId, "failure"],
        [other.principalId, "success"],
      ].sort(),
    );
    expect(
      (await inRepo(stub(), (r: RepoDO) => r.checks.summariesFor(sha, ["Build"]))).length,
    ).toBe(2);
  });

  it("needs a commit this repository has", async () => {
    expect(await post("success", "c", owner, "f".repeat(40))).toEqual({
      ok: false,
      code: "commit_not_found",
    });
    expect(await post("success", "c", owner, "main")).toEqual({
      ok: false,
      code: "commit_not_found",
    });
    expect(await summaries()).toEqual([]);
  });

  it("takes an empty description, and one of 140 characters", async () => {
    for (const description of ["", "d".repeat(140)])
      expect(
        (
          await stub().createStatus(
            sha,
            { state: "success", context: "c", description, targetUrl: null },
            actor(owner),
          )
        ).ok,
      ).toBe(true);
  });

  it("refuses fields past their limits", async () => {
    for (const bad of [
      { context: "", description: null, targetUrl: null },
      { context: "x".repeat(256), description: null, targetUrl: null },
      { context: "a\nb", description: null, targetUrl: null },
      { context: "c", description: "d".repeat(141), targetUrl: null },
      { context: "c", description: null, targetUrl: "javascript:alert(1)" },
    ])
      expect(await stub().createStatus(sha, { state: "success", ...bad }, actor(owner))).toEqual({
        ok: false,
        code: "invalid_status",
      });
    expect(await sql("SELECT id FROM commit_statuses")).toEqual([]);
  });

  it("is refused to a writer lowered to read while the change was prepared, writing nothing", async () => {
    const writer = await user();
    await api("PUT", `${path}/collaborators/${writer.handle}`, owner.token, { permission: "push" });
    expect((await post("pending", "warm", writer)).ok).toBe(true);
    await inRepo(stub(), (r: RepoDO) => {
      r.changeHooks.beforeChange = async (method) => {
        if (method !== "createStatus") return;
        r.changeHooks = {};
        r.git.context.storage.sql.exec(
          // A new version, as a pulled change would have: the parsed roles are kept per version.
          `UPDATE acl_snapshot SET roles = json_set(roles, '$."' || ? || '"', 'read'),
             version = version + 1`,
          writer.principalId,
        );
      };
    });
    expect(await post("success", "c", writer)).toEqual({ ok: false, code: "forbidden" });
    expect(await sql("SELECT context FROM commit_statuses")).toEqual([{ context: "warm" }]);
  });

  it("is refused to a caller whose role is no longer write, writing nothing", async () => {
    const answer = await inRepo(stub(), (r: RepoDO) =>
      r.checks.createStatus(
        sha,
        { state: "success", context: "c", description: null, targetUrl: null },
        { actor: actor(owner), root: owner.principalId, role: "read" },
      ),
    );
    expect(answer).toEqual({ ok: false, code: "forbidden" });
    expect(await sql("SELECT id FROM commit_statuses")).toEqual([]);
  });
});

describe("status limits", () => {
  /** `n` statuses of `context` on `at`, written directly. */
  const seed = (n: number, context: (i: number) => string, at = sha) =>
    inRepo(stub(), (r: RepoDO) => {
      const s = r.git.context.storage.sql;
      for (let i = 0; i < n; i++) {
        const c = context(i);
        s.exec(
          `INSERT INTO commit_statuses (sha, context, context_key, state, creator_id, creator_root, created_at)
           VALUES (?, ?, ?, 'success', 'usr_seed', 'usr_seed', 0)`,
          at,
          c,
          c.toLowerCase(),
        );
      }
    });

  it("allows 1,000 statuses of one context on a commit, ignoring case, and refuses the next", async () => {
    await seed(999, () => "Build");
    expect((await post("success", "build")).ok).toBe(true);
    expect(await post("success", "BUILD")).toEqual({ ok: false, code: "status_limit" });
    expect((await post("success", "lint")).ok).toBe(true);
  });

  it("allows 10,000 statuses on a commit in all", async () => {
    await seed(9_999, (i) => `c${i % 50}`);
    expect((await post("success", "new")).ok).toBe(true);
    expect(await post("success", "newer")).toEqual({ ok: false, code: "status_limit" });
  });

  it("allows 1,000 status summaries on a commit, and leaves room for Fyrden's runs", async () => {
    await inRepo(stub(), (r: RepoDO) => {
      const s = r.git.context.storage.sql;
      for (let i = 0; i < 999; i++)
        s.exec(
          `INSERT INTO check_summaries (sha, name_key, source, name, kind, status, conclusion, settled,
             status_id, updated_at)
           VALUES (?, ?, 'usr_seed', ?, 'status', 'completed', 'success', 'success', ?, 0)`,
          sha,
          `s${i}`,
          `s${i}`,
          i + 1,
        );
    });
    expect((await post("success", "one-more")).ok).toBe(true);
    expect(await post("success", "past-it")).toEqual({ ok: false, code: "check_limit" });
    // A context it already summarizes takes another status.
    expect((await post("failure", "one-more")).ok).toBe(true);
    expect(await start([{ name: "build", startKey: "k1" }])).toEqual([
      { ok: true, attempt: 1, current: true },
    ]);
  });
});

describe("check attempts", () => {
  it("start at 1 and go up with each new key; a re-run makes the earlier attempt stale", async () => {
    expect(await start([{ name: "build", startKey: "run1" }])).toEqual([
      { ok: true, attempt: 1, current: true },
    ]);
    expect(await update([step("build", 1, "in_progress")])).toEqual(["applied"]);
    expect(await start([{ name: "Build", startKey: "run2" }])).toEqual([
      { ok: true, attempt: 2, current: true },
    ]);
    // The cancelled attempt's success arrives after the re-run started.
    expect(await update([step("build", 1, "completed", "success")])).toEqual(["stale_attempt"]);
    expect(await summaries()).toEqual([
      expect.objectContaining({
        name: "Build",
        source: FYRDEN_CI_SOURCE,
        kind: "check",
        attempt: 2,
        status: "queued",
        conclusion: null,
      }),
    ]);
    expect(await update([step("build", 3, "in_progress")])).toEqual(["unknown_attempt"]);
    expect(await update([step("lint", 1, "in_progress")])).toEqual(["unknown_attempt"]);
  });

  it("keep the outcome of the last completed attempt, and whose it was, until the next completes", async () => {
    await start([{ name: "build", startKey: "a", actor: "usr_u" }]);
    await update([step("build", 1, "completed", "failure")]);
    await start([{ name: "build", startKey: "b", actor: "usr_v" }]);
    const settled = () =>
      sql<{ settled: string; settled_attempt: number; settled_actor_id: string; actor_id: string }>(
        "SELECT settled, settled_attempt, settled_actor_id, actor_id FROM check_summaries",
      );
    expect(await settled()).toEqual([
      { settled: "failure", settled_attempt: 1, settled_actor_id: "usr_u", actor_id: "usr_v" },
    ]);
    await update([step("build", 2, "completed", "success")]);
    expect(await settled()).toEqual([
      { settled: "success", settled_attempt: 2, settled_actor_id: "usr_v", actor_id: "usr_v" },
    ]);
  });

  it("answer a retried start with its attempt, and never make it current again once superseded", async () => {
    await start([{ name: "build", startKey: "A" }]);
    // A's answer was lost; it retries.
    expect(await start([{ name: "build", startKey: "A" }])).toEqual([
      { ok: true, attempt: 1, current: true },
    ]);
    await start([{ name: "build", startKey: "B" }]);
    expect(await start([{ name: "build", startKey: "A" }])).toEqual([
      { ok: true, attempt: 1, current: false },
    ]);
    expect((await summaries())[0]?.attempt).toBe(2);
  });

  it("take a name repeated in one call once per key, refusing a second key for it", async () => {
    expect(
      await start([
        { name: "build", startKey: "x" },
        { name: "BUILD", startKey: "x" },
        { name: "Build", startKey: "y" },
        { name: "lint", startKey: "z" },
      ]),
    ).toEqual([
      { ok: true, attempt: 1, current: true },
      { ok: true, attempt: 1, current: true },
      { ok: false, code: "duplicate_check" },
      { ok: true, attempt: 1, current: true },
    ]);
    // Every key answered is recorded: retrying it allocates nothing.
    expect(await start([{ name: "build", startKey: "x" }])).toEqual([
      { ok: true, attempt: 1, current: true },
    ]);
    expect(await sql("SELECT attempt FROM check_attempts WHERE name_key = 'build'")).toEqual([
      { attempt: 1 },
    ]);
  });

  it("stop at 100 attempts of a check, still answering a known key", async () => {
    await inRepo(stub(), (r: RepoDO) => {
      for (let i = 1; i <= 100; i++) {
        const [answer] = r.checks.startCheckAttempts(sha, [{ name: "build", startKey: `k${i}` }]);
        expect(answer).toEqual({ ok: true, attempt: i, current: true });
      }
    });
    expect(await start([{ name: "build", startKey: "k101" }])).toEqual([
      { ok: false, code: "attempt_limit" },
    ]);
    expect(await start([{ name: "build", startKey: "k100" }])).toEqual([
      { ok: true, attempt: 100, current: true },
    ]);
  });

  it("need a commit this repository has", async () => {
    expect(await start([{ name: "build", startKey: "k" }], "e".repeat(40))).toEqual([
      { ok: false, code: "commit_not_found" },
    ]);
  });
});

describe("check transitions", () => {
  beforeEach(async () => {
    await start([
      { name: "build", startKey: "b" },
      { name: "lint", startKey: "l" },
    ]);
  });

  it("read an absent conclusion and details URL as none", async () => {
    expect(await update([{ sha, name: "build", attempt: 1, status: "in_progress" }])).toEqual([
      "applied",
    ]);
    expect(
      await update([
        { sha, name: "build", attempt: 1, status: "completed", conclusion: "success" },
      ]),
    ).toEqual(["applied"]);
  });

  it("move forward only, and a completed attempt keeps its conclusion", async () => {
    expect(await update([step("build", 1, "completed", "success")])).toEqual(["applied"]);
    expect(await update([step("build", 1, "in_progress")])).toEqual(["invalid_transition"]);
    expect(await update([step("build", 1, "completed", "failure")])).toEqual([
      "invalid_transition",
    ]);
    expect(await update([step("build", 1, "completed", "success")])).toEqual(["unchanged"]);
    expect((await summaries()).find((s) => s.name === "build")).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  it("refuse a malformed item alone, applying the rest of the batch", async () => {
    expect(
      await update([
        step("build", 1, "in_progress", "success"),
        { ...step("lint", 1, "in_progress"), status: "running" as never },
        { ...step("lint", 1, "completed", "failure"), detailsUrl: "ftp://x" },
        { ...step("lint", 1, "completed", "failure"), detailsUrl: 42 as never },
        null as never,
        step("lint", 1, "in_progress"),
      ]),
    ).toEqual([
      "invalid_update",
      "invalid_update",
      "invalid_update",
      "invalid_update",
      "invalid_update",
      "applied",
    ]);
    expect((await summaries()).map((s) => [s.name, s.status]).sort()).toEqual([
      ["build", "queued"],
      ["lint", "in_progress"],
    ]);
  });

  it("fold one check's updates in a batch into one write", async () => {
    const one = await rowsWrittenBy(() => update([step("lint", 1, "in_progress")]));
    const three = await rowsWrittenBy(() =>
      update([
        step("build", 1, "in_progress"),
        step("build", 1, "completed", "failure"),
        step("build", 1, "completed", "failure"),
      ]),
    );
    // One write of the row, plus the settled index entry the completion moves.
    expect(one).toBe(1);
    expect(three).toBe(2);
    expect((await summaries()).find((s) => s.name === "build")).toMatchObject({
      status: "completed",
      conclusion: "failure",
    });
  });

  it("take 256 items in a call and refuse more, by throwing", async () => {
    const items = (n: number) => Array.from({ length: n }, () => step("build", 1, "in_progress"));
    expect((await update(items(256))).filter((r) => r === "applied")).toHaveLength(1);
    // Thrown inside the object, caught there: a rejected call would also surface as uncaught.
    await expect(
      inRepo(stub(), (r: RepoDO) => r.checks.recordCheckUpdates(items(257))),
    ).rejects.toThrow(/at most 256/);
    await expect(
      inRepo(stub(), (r: RepoDO) =>
        r.checks.startCheckAttempts(
          sha,
          Array.from({ length: 257 }, (_, i) => ({ name: `n${i}`, startKey: `k${i}` })),
        ),
      ),
    ).rejects.toThrow(/at most 256/);
    expect(await update([])).toEqual([]);
    expect(await start([])).toEqual([]);
  });
});

describe("a 200-check storm", () => {
  it("writes each check's row once per batch and appends no event", async () => {
    const names = Array.from({ length: 200 }, (_, i) => `job (${i})`);
    const outbox = () => sql<{ n: number }>("SELECT count(*) AS n FROM outbox");
    const [{ n: eventsBefore } = { n: 0 }] = await outbox();
    const started = await rowsWrittenBy(() =>
      start(names.map((name, i) => ({ name, startKey: `run:${i}:1` }))),
    );
    const batches = (status: CheckUpdate["status"], conclusion: CheckUpdate["conclusion"]) =>
      [0, 50, 100, 150].map((from) =>
        names.slice(from, from + 50).map((name) => step(name, 1, status, conclusion)),
      );
    const written: number[] = [];
    for (const batch of [...batches("in_progress", null), ...batches("completed", "success")])
      written.push(
        await rowsWrittenBy(async () => {
          const results = await update(batch);
          expect(results.every((r) => r === "applied")).toBe(true);
        }),
      );
    // Measured budgets, index entries included: a start writes its attempt (and its key's index
    // entry) and its summary (and its settled index entry); an intermediate state rewrites the
    // summary alone; a completion the summary and its settled index entry.
    expect(started).toBe(200 * 4);
    expect(written).toEqual([50, 50, 50, 50, 100, 100, 100, 100]);
    const [{ n: eventsAfter } = { n: 0 }] = await outbox();
    expect(eventsAfter).toBe(eventsBefore);
    expect((await summaries()).every((s) => s.conclusion === "success")).toBe(true);
  });
});
