// `blame.refused`: lines a run settles as unresolved, by reason, counted once
// at the publish whose compare-and-set moved the run's row. Delivering them
// again, retrying, or a slice that loses its row counts nothing.
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { METRIC_AGGREGATION, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type BlameState,
  oidFromHex,
  UNRESOLVED_REASONS,
  type UnresolvedReason,
} from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import {
  type BlameAnswer,
  type BlameResult,
  RepoBlame,
  type RepoBlameDeps,
  unresolvedSince,
} from "../src/do/repo/blame.js";
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

/** Every metric point counted, in order. */
function recording(): { metrics: Metrics; refused: () => Record<string, number> } {
  const points: { name: string; dimensions: Record<string, string>; value: number }[] = [];
  return {
    metrics: {
      count(name, dimensions, value = 1) {
        points.push({ name, dimensions, value });
      },
    },
    refused: () => {
      const out: Record<string, number> = {};
      for (const p of points) {
        if (p.name !== "blame.refused") continue;
        const reason = p.dimensions.reason as string;
        out[reason] = (out[reason] ?? 0) + p.value;
      }
      return out;
    },
  };
}

/** `git` with its metrics replaced, and `bucket` too when given. */
function withMetrics(git: RepoGitStorage, metrics: Metrics, bucket?: R2Bucket): RepoGitStorage {
  const context = { ...git.context, metrics };
  return new Proxy(git, {
    get: (inner, property) =>
      property === "context"
        ? context
        : property === "bucket" && bucket
          ? bucket
          : Reflect.get(inner, property),
  });
}

/** The bucket with checkpoint writes held until `release` opens; `entered` opens at the first. */
function holdingPuts(bucket: R2Bucket, release: Promise<void>, entered: () => void): R2Bucket {
  return new Proxy(bucket, {
    get(inner, property) {
      const value = Reflect.get(inner, property);
      if (typeof value !== "function") return value;
      if (property !== "put") return value.bind(inner);
      return async (...args: unknown[]) => {
        entered();
        await release;
        return value.apply(inner, args);
      };
    },
  });
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

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

const ok = (result: BlameResult): BlameAnswer => {
  if (!result.ok) throw new Error(`${result.failure.status} ${result.failure.code}`);
  return result.value;
};

/** Lines an answer shows unresolved, by reason. */
function shown(answer: BlameAnswer): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of answer.ranges)
    if ("unresolved" in r) out[r.unresolved] = (out[r.unresolved] ?? 0) + r.line_count;
  return out;
}

const WALK = { path: "f.txt", lineStart: 1, lineEnd: 6 };

/** A run of f.txt one step in, then two slices that died at its head: the next refuses it. */
async function twiceDead(repo: Repo, repoId: string, metrics: Metrics) {
  const git = withMetrics(repo.git, metrics);
  ok(await blamer(repo, repoId, { git, slice: { maxSteps: 1 } }).answer({ path: "f.txt" }));
  const run = repo.git.context.storage.sql
    .exec<{ run_id: string; generation: number }>(
      "SELECT run_id, generation FROM blame_runs WHERE path = 'f.txt'",
    )
    .one();
  const runs = new BlameRuns(repo.git.context.storage);
  runs.beginAttempt(run.run_id, run.generation);
  runs.beginAttempt(run.run_id, run.generation);
  return git;
}

describe("blame.refused", () => {
  it("is a counter: its points add up within an invocation", () => {
    expect(METRIC_AGGREGATION["blame.refused"]).toBeUndefined();
  });

  it("counts lines refused as step_lost once, however often they are delivered again", async () => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const record = recording();
      const git = await twiceDead(repo, repoId, record.metrics);
      const before = record.refused();
      const refused = ok(await blamer(repo, repoId, { git }).answer(WALK));
      const atRefusal = record.refused();
      // Walk the run to its end, then read it again in every way a client can.
      let last = refused;
      for (let guard = 0; last.state !== "complete" && guard < 50; guard++)
        last = ok(await blamer(repo, repoId, { git }).answer(WALK));
      const done = record.refused();
      const pages: BlameAnswer[] = [];
      let continuation: string | undefined;
      do {
        const page = ok(
          await blamer(repo, repoId, { git }).answer({
            path: "f.txt",
            ...(continuation && { continuation }),
          }),
        );
        pages.push(page);
        continuation = page.next_continuation ?? undefined;
      } while (continuation);
      ok(await blamer(repo, repoId, { git }).answer(WALK));
      ok(await blamer(repo, repoId, { git }).answer({ path: "f.txt" }));
      return { before, refused, atRefusal, last, done, after: record.refused() };
    });
    expect(seen.before).toEqual({});
    const lost = shown(seen.refused).step_lost ?? 0;
    expect(lost).toBeGreaterThan(0);
    expect(seen.atRefusal).toEqual({ step_lost: lost });
    // Over the run's life the count is what the finished blame shows unresolved, no more.
    expect(seen.done).toEqual(shown(seen.last));
    expect(seen.done.step_lost).toBe(lost);
    expect(seen.last.unresolved_lines).toBe(Object.values(seen.done).reduce((a, b) => a + b, 0));
    expect(seen.after).toEqual(seen.done);
  });

  it.each([
    ["deleted", "DELETE FROM blame_runs"],
    ["moved", "UPDATE blame_runs SET generation = generation + 1"],
  ])("counts nothing when the run's row is %s under the slice that refused", async (_, sql) => {
    const { stub, repoId } = await pushed();
    const seen = await inRepo(stub, async (repo) => {
      const record = recording();
      await twiceDead(repo, repoId, record.metrics);
      const release = gate();
      const entered = gate();
      const held = withMetrics(
        repo.git,
        record.metrics,
        holdingPuts(repo.git.bucket, release.promise, entered.open),
      );
      const answering = blamer(repo, repoId, { git: held }).answer(WALK);
      await entered.promise;
      repo.git.context.storage.sql.exec(sql);
      release.open();
      const answer = ok(await answering);
      return { shown: shown(answer), refused: record.refused() };
    });
    // The answer carries what the slice computed; nothing was published, so nothing counts.
    expect(seen.shown.step_lost ?? 0).toBeGreaterThan(0);
    expect(seen.refused).toEqual({});
  });
});

describe("unresolvedSince", () => {
  const code = (reason: UnresolvedReason) => -1 - UNRESOLVED_REASONS.indexOf(reason);
  /** A state of `lines` lines with `ranges` settled, four numbers each. */
  const state = (lines: number, ranges: number[], stateLimit: boolean): BlameState =>
    ({
      commit: oidFromHex("a".repeat(40)),
      path: [],
      lines,
      steps: 0,
      queue: [],
      ranges: Int32Array.from(ranges),
      rangeCount: ranges.length / 4,
      facts: {},
      factOrder: [],
      stateLimit,
    }) as BlameState;

  const settled = [
    ...[0, 2, 0, 1],
    ...[2, 1, code("object_limit"), 0],
    ...[3, 1, 0, 3],
    ...[5, 2, code("step_lost"), 0],
    ...[9, 1, code("object_limit"), 0],
  ];

  it("takes the unresolved ranges settled from a range on, by reason", () => {
    expect(unresolvedSince(state(12, settled, false), 0)).toEqual(
      new Map([
        ["object_limit", 2],
        ["step_lost", 2],
      ]),
    );
    expect(unresolvedSince(state(12, settled, false), 2)).toEqual(
      new Map([
        ["step_lost", 2],
        ["object_limit", 1],
      ]),
    );
    expect(unresolvedSince(state(12, settled, false), 5)).toEqual(new Map());
  });

  it("adds a flagged state's lines no range settled, earlier refusals not counted twice", () => {
    // 12 lines; ranges settle 2 + 1 + 1 + 2 + 1 = 7 of them, so 5 are state_limit.
    expect(unresolvedSince(state(12, settled, true), 5)).toEqual(new Map([["state_limit", 5]]));
    expect(unresolvedSince(state(12, settled, true), 3)).toEqual(
      new Map([
        ["step_lost", 2],
        ["object_limit", 1],
        ["state_limit", 5],
      ]),
    );
  });

  it("is empty for an empty file", () => {
    expect(unresolvedSince(state(0, [], false), 0)).toEqual(new Map());
  });
});
