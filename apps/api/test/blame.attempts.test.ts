// What a blame run does after slices die: a death is simulated by an attempt
// begun on the run's row and never cleared, as a reset leaves it. A start
// that keeps dying is given up; a recovery runs only on a whole allowance,
// then one step, then refuses the step as step_lost; and a run that dies
// even then is kept lost, so it isn't started again only to die the same way.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { describe, expect, inject, it, vi } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  type BlameAnswer,
  type BlameResult,
  RepoBlame,
  type RepoBlameDeps,
} from "../src/do/repo/blame.js";
import { afterSlice } from "../src/do/repo/blame-attempts.js";
import { BlameRuns } from "../src/do/repo/blame-runs.js";
import { postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("blameFixtures");

async function pushed(): Promise<{ stub: DurableObjectStub<RepoDO>; repoId: string }> {
  const target = await pushTarget();
  const reply = await postPush(
    target,
    pushBody([{ old: ZERO, new: fx.tip, ref: "refs/heads/main" }], { pack: fx.pack }),
  );
  expect(reply.report).toContain("ok refs/heads/main\n");
  return { stub: target.repo.stub, repoId: target.repo.id };
}

type Repo = Parameters<Parameters<typeof inRepo>[1]>[0];

function blamer(repo: Repo, repoId: string, extra: Partial<RepoBlameDeps> = {}): RepoBlame {
  return new RepoBlame({
    git: repo.git,
    memoryBlocks: createClockBlockCache(),
    storage: repo.git.context.storage as unknown as DurableObjectStorage,
    repoId: () => repoId,
    epochGen: () => repo.events.epochGen(),
    ...extra,
  });
}

const row = (repo: Repo, path: string) =>
  repo.git.context.storage.sql
    .exec<{
      run_id: string;
      state: string;
      generation: number;
      attempts: number;
      checkpoint_key: string | null;
    }>(
      "SELECT run_id, state, generation, attempts, checkpoint_key FROM blame_runs WHERE path = ?",
      path,
    )
    .toArray()[0];

const refusal = (r: BlameResult) =>
  r.ok
    ? "answered"
    : { status: r.failure.status, code: r.failure.code, retryAfter: r.failure.retryAfter };

/** A window over the whole file: a window walks whenever the run isn't done. */
const WALK = { path: "f.txt", lineStart: 1, lineEnd: 6 };

const reasons = (answer: BlameAnswer) =>
  answer.ranges.flatMap((r) => ("unresolved" in r ? [r.unresolved] : []));

/** A run of f.txt one step in: started, walked one step, its checkpoint published. */
async function partway(repo: Repo, repoId: string) {
  const first = await blamer(repo, repoId, { slice: { maxSteps: 1 } }).answer({ path: "f.txt" });
  if (!first.ok || first.value.state !== "partial") throw new Error("the run should be partway");
  return row(repo, "f.txt") as NonNullable<ReturnType<typeof row>>;
}

describe("blame after slices die", () => {
  it("retries a start that died, and gives up on one that died three times", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const runs = new BlameRuns(repo.git.context.storage);
      const key = (path: string) => ({
        commit: Uint8Array.from(Buffer.from(fx.tip, "hex")) as never,
        path,
        engineVersion: 1,
        epochGen: repo.events.epochGen(),
      });
      const once = runs.create(key("f.txt"), Date.now(), new Set()).row.runId;
      runs.beginAttempt(once, 0);
      const retried = await blamer(repo, repoId).answer({ path: "f.txt" });
      const thrice = runs.create(key("link"), Date.now(), new Set()).row.runId;
      for (let k = 0; k < 3; k++) runs.beginAttempt(thrice, 0);
      const given = await blamer(repo, repoId).answer({ path: "link" });
      return {
        retried: retried.ok ? retried.value.state : refusal(retried),
        retriedRow: row(repo, "f.txt"),
        given: refusal(given),
        givenRow: row(repo, "link") ?? null,
      };
    });
    expect(seen.retried).toBe("complete");
    expect(seen.retriedRow).toMatchObject({ state: "done", attempts: 0 });
    expect(seen.given).toEqual({ status: 422, code: "work_limit", retryAfter: undefined });
    expect(seen.givenRow).toBeNull();
  });

  it("runs a recovery only on a whole allowance; short of one it's busy and counts nothing", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const before = await partway(repo, repoId);
      new BlameRuns(repo.git.context.storage).beginAttempt(before.run_id, before.generation);
      const short = blamer(repo, repoId, { spentCalls: () => 300 });
      const answers = [];
      for (let k = 0; k < 10; k++) answers.push(refusal(await short.answer(WALK)));
      const during = row(repo, "f.txt");
      const recovered = await blamer(repo, repoId).answer(WALK);
      return { answers, during, before, recovered, after: row(repo, "f.txt") };
    });
    expect(new Set(seen.answers.map((a) => JSON.stringify(a)))).toEqual(
      new Set([JSON.stringify({ status: 503, code: "blame_busy", retryAfter: 1 })]),
    );
    expect(seen.during).toMatchObject({ generation: seen.before.generation, attempts: 1 });
    // The recovery runs one step, however many the slice may take: one generation on, not done.
    expect(seen.recovered.ok && seen.recovered.value.state).toBe("partial");
    expect(seen.after).toMatchObject({ generation: seen.before.generation + 1, attempts: 0 });
  });

  it("refuses the head step as step_lost after two deaths, and the walk goes on", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const before = await partway(repo, repoId);
      const runs = new BlameRuns(repo.git.context.storage);
      runs.beginAttempt(before.run_id, before.generation);
      runs.beginAttempt(before.run_id, before.generation);
      const refused = await blamer(repo, repoId).answer({
        path: "f.txt",
        lineStart: 1,
        lineEnd: 6,
      });
      return { refused, before, after: row(repo, "f.txt") };
    });
    if (!seen.refused.ok) throw new Error(seen.refused.failure.code);
    expect(reasons(seen.refused.value)).toContain("step_lost");
    expect(seen.after).toMatchObject({ generation: seen.before.generation + 1, attempts: 0 });
  });

  it("keeps a run lost after three, without reading its checkpoint, and starts no new run for it", async () => {
    const { stub, repoId } = await pushed();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen = await inRepo(stub, async (repo) => {
      const before = await partway(repo, repoId);
      const runs = new BlameRuns(repo.git.context.storage);
      for (let k = 0; k < 3; k++) runs.beginAttempt(before.run_id, before.generation);
      const gets: string[] = [];
      const bucket = new Proxy(repo.git.bucket, {
        get(inner, property) {
          const value = Reflect.get(inner, property);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (property === "get") gets.push(String(args[0]));
            return value.apply(inner, args);
          };
        },
      });
      const git = new Proxy(repo.git, {
        get: (inner, property) => (property === "bucket" ? bucket : Reflect.get(inner, property)),
      });
      const counting = blamer(repo, repoId, { git });
      const fourth = await counting.answer(WALK);
      const fifth = await counting.answer(WALK);
      const all = repo.git.context.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM blame_runs WHERE path = 'f.txt'")
        .one().n;
      return {
        fourth: refusal(fourth),
        fifth: refusal(fifth),
        gets,
        after: row(repo, "f.txt"),
        all,
        before,
      };
    });
    const logged = errors.mock.calls.map((c) => String(c[0]));
    errors.mockRestore();
    expect(seen.fourth).toEqual({ status: 422, code: "work_limit", retryAfter: undefined });
    expect(seen.fifth).toEqual(seen.fourth);
    expect(seen.gets).toEqual([]);
    expect(seen.after).toMatchObject({
      run_id: seen.before.run_id,
      state: "lost",
      checkpoint_key: null,
    });
    expect(seen.all).toBe(1);
    expect(logged.some((line) => line.includes("blame run lost"))).toBe(true);
  });
});

describe("afterSlice", () => {
  it("keeps the mark when a recovery made no step with lines still pending, else clears it", () => {
    expect(afterSlice({ attempt: 2, steps: 0, pending: true })).toBe("keep");
    expect(afterSlice({ attempt: 3, steps: 0, pending: true })).toBe("keep");
    expect(afterSlice({ attempt: 2, steps: 1, pending: true })).toBe("clear");
    expect(afterSlice({ attempt: 2, steps: 0, pending: false })).toBe("clear");
    expect(afterSlice({ attempt: 1, steps: 0, pending: true })).toBe("clear");
  });
});
