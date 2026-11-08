// The blame run rows: found by what they blame, moved only by the slice that
// read the generation they're at, marked by each attempt, capped per
// repository, and kept until they expire.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type Oid, oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { BLAME_RUN_CAP, BlameRuns, type RunKey, runExpiry } from "../src/do/repo/blame-runs.js";

const HOUR = 60 * 60 * 1000;
const commit = (n: number): Oid => oidFromHex(n.toString(16).padStart(40, "0"));
const key = (n: number, overrides: Partial<RunKey> = {}): RunKey => ({
  commit: commit(n),
  path: `f${n}.txt`,
  engineVersion: 1,
  epochGen: 3,
  ...overrides,
});

/** Runs `use` with the rows of a fresh repository object. */
function withRuns<R>(use: (runs: BlameRuns) => R): Promise<R> {
  return runInDurableObject(env.REPO.getByName(uniqueId("repo")), (_, state) =>
    use(new BlameRuns(state.storage)),
  );
}

const published = {
  blobOid: commit(77),
  checkpointKey: "k1",
  checkpointBytes: 100,
  state: "running" as const,
  lines: 10,
  settledRanges: 2,
  unresolvedLines: 1,
};

describe("BlameRuns", () => {
  it("creates a run as initializing at generation 0, found again by what it blames", () =>
    withRuns((runs) => {
      const made = runs.create(key(1), 1_000, new Set());
      expect(made.row).toMatchObject({
        state: "initializing",
        generation: 0,
        attempts: 0,
        attemptGeneration: null,
        touchedAt: 1_000,
        expiresAt: 1_000 + 24 * HOUR,
      });
      expect(runs.find(key(1))?.runId).toBe(made.row.runId);
      expect(runs.get(made.row.runId)?.runId).toBe(made.row.runId);
      expect(runs.find(key(1, { epochGen: 4 }))).toBeUndefined();
      expect(runs.find(key(1, { engineVersion: 2 }))).toBeUndefined();
    }));

  it("moves a run only from the generation and restore generation the slice read", () =>
    withRuns((runs) => {
      const { runId } = runs.create(key(1), 1_000, new Set()).row;
      runs.beginAttempt(runId, 0);
      const next = { ...published, generation: 1, touchedAt: 2_000, expiresAt: 9_000 };
      expect(runs.publish(runId, { generation: 0, epochGen: 4 }, next)).toBe(false);
      expect(runs.publish(runId, { generation: 0, epochGen: 3 }, next)).toBe(true);
      expect(runs.get(runId)).toMatchObject({
        ...next,
        attempts: 0,
        attemptGeneration: null,
      });
      expect(runs.publish(runId, { generation: 0, epochGen: 3 }, { ...next, generation: 2 })).toBe(
        false,
      );
      expect(runs.get(runId)?.generation).toBe(1);
    }));

  it("counts attempts at one generation, starts again at another, and peeks without counting", () =>
    withRuns((runs) => {
      const { runId } = runs.create(key(1), 1_000, new Set()).row;
      expect(runs.peekAttempt(runId, 0)).toBe(0);
      expect(runs.beginAttempt(runId, 0)).toBe(1);
      expect(runs.beginAttempt(runId, 0)).toBe(2);
      expect(runs.peekAttempt(runId, 0)).toBe(2);
      expect(runs.peekAttempt(runId, 1)).toBe(0);
      expect(runs.beginAttempt(runId, 1)).toBe(1);
      runs.clearAttempts(runId);
      expect(runs.peekAttempt(runId, 1)).toBe(0);
      expect(runs.beginAttempt("01J9ZZZZZZZZZZZZZZZZZZZZZZ", 0)).toBe(0);
    }));

  it("keeps at most the cap, removing the least recently touched, never one being written", () =>
    withRuns((runs) => {
      const ids: string[] = [];
      for (let n = 0; n < BLAME_RUN_CAP; n++)
        ids.push(runs.create(key(n), 1_000 + n, new Set()).row.runId);
      const oldest = ids[0] as string;
      const next = ids[1] as string;
      const made = runs.create(key(1000), 5_000, new Set([oldest]));
      expect(made.removed).toEqual([next]);
      expect(runs.get(oldest)).toBeDefined();
      expect(runs.get(next)).toBeUndefined();
      expect(runs.count()).toBe(BLAME_RUN_CAP);
    }));

  it("keeps a lost run as a tombstone, found by what it blames, until it expires", () =>
    withRuns((runs) => {
      const { runId } = runs.create(key(1), 1_000, new Set()).row;
      runs.markLost(runId, 2_000);
      expect(runs.find(key(1))).toMatchObject({
        runId,
        state: "lost",
        expiresAt: 2_000 + 24 * HOUR,
      });
      expect(runs.expired(2_000 + 24 * HOUR - 1, 10)).toEqual([]);
      expect(runs.expired(2_000 + 24 * HOUR, 10).map((r) => r.runId)).toEqual([runId]);
    }));

  it("moves a read run's touch at most once an hour", () =>
    withRuns((runs) => {
      const { runId } = runs.create(key(1), 1_000, new Set()).row;
      expect(runs.touch(runId, 1_000 + HOUR - 1, 1_000 + HOUR - 1 + 7 * 24 * HOUR)).toBe(false);
      expect(runs.get(runId)?.touchedAt).toBe(1_000);
      expect(runs.touch(runId, 1_000 + HOUR, 9)).toBe(true);
      expect(runs.get(runId)).toMatchObject({ touchedAt: 1_000 + HOUR, expiresAt: 9 });
    }));

  it("lists expired runs, oldest expiry first, up to a limit, and removes one", () =>
    withRuns((runs) => {
      const a = runs.create(key(1), 1_000, new Set()).row.runId;
      const b = runs.create(key(2), 500, new Set()).row.runId;
      runs.create(key(3), 10 * 24 * HOUR, new Set());
      expect(runs.expired(5 * 24 * HOUR, 10).map((r) => r.runId)).toEqual([b, a]);
      expect(runs.expired(5 * 24 * HOUR, 1).map((r) => r.runId)).toEqual([b]);
      runs.remove(b);
      expect(runs.get(b)).toBeUndefined();
    }));
});

describe("runExpiry", () => {
  it("keeps an unfinished or lost run a day, a finished one a week, or an hour when caching could change it", () => {
    expect(runExpiry({ state: "initializing", now: 0, transient: false })).toBe(24 * HOUR);
    expect(runExpiry({ state: "running", now: 0, transient: true })).toBe(24 * HOUR);
    expect(runExpiry({ state: "lost", now: 0, transient: false })).toBe(24 * HOUR);
    expect(runExpiry({ state: "done", now: 0, transient: false })).toBe(7 * 24 * HOUR);
    expect(runExpiry({ state: "done", now: 0, transient: true })).toBe(HOUR);
  });
});
