import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FakeCommit } from "./fake-source.js";
import { runHistory, type WalkResult, type WalkRun } from "./walk-runs.js";

/*
 * Generated histories, each run under the default limits and under each limit
 * pulled tight: one slice a step with the state decoded between slices, the
 * encoded and live room, the step limit, the line limit, engine work and the
 * file size. Chosen so that between them they catch every change to the walk
 * that a mutation run found the other tests let through. Under the default
 * limits every line each one settles agrees with git blame 2.53.0; the rest is
 * what the walk's own rules answer, frozen.
 */

interface Vector {
  readonly id: string;
  readonly tip: string;
  readonly history: Readonly<Record<string, FakeCommit>>;
  readonly runs: readonly (WalkRun & { readonly expected: WalkResult | { failure: string } })[];
}

const VECTORS: Vector[] = JSON.parse(
  readFileSync(join(import.meta.dirname, "vectors", "walks.json"), "utf8"),
);

describe("whole walks over generated histories", () => {
  it.each(VECTORS.map((v) => [v.id, v] as const))("%s", async (_, v) => {
    for (const run of v.runs) {
      expect({ limits: run.limits, got: await runHistory(v.history, v.tip, run) }).toEqual({
        limits: run.limits,
        got: run.expected,
      });
    }
  });
});
