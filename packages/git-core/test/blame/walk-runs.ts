import { createHash } from "node:crypto";
import { type BlameState, decodeBlameState, encodeBlameState } from "../../src/blame/state.js";
import {
  advanceBlame,
  type BlameRange,
  type BlameSliceLimits,
  blameRanges,
  DEFAULT_BLAME_SLICE,
  startBlame,
} from "../../src/blame/walk.js";
import { oidToHex } from "../../src/object/oid.js";
import { type FakeCommit, FakeSource, oidOfName, PATH } from "./fake-source.js";

/** One run over a history: limits that differ from the defaults, and whether to decode after each slice. */
export interface WalkRun {
  readonly limits: Partial<Omit<BlameSliceLimits, "stepIsFresh" | "align">>;
  readonly roundTrip?: boolean;
}

/** What a run gives: ranges whole and paged, the final state's hash, and each slice's stop. */
export interface WalkResult {
  readonly ranges: string;
  readonly page: string;
  readonly state: string;
  readonly steps: number;
  readonly stateLimit: boolean;
  readonly stops: string;
}

function describe(source: FakeSource, state: BlameState, offset: number, limit: number): string {
  return blameRanges(state, offset, limit)
    .map((range: BlameRange) =>
      "unresolved" in range
        ? `${range.startLine}+${range.lineCount}:${range.unresolved}`
        : `${range.startLine}+${range.lineCount}:${source.names.get(oidToHex(range.commit))}@${range.sourceStartLine}`,
    )
    .join(" ");
}

export async function runHistory(
  history: Readonly<Record<string, FakeCommit>>,
  tip: string,
  run: WalkRun,
): Promise<WalkResult | { readonly failure: string }> {
  const source = new FakeSource(history);
  const slice: BlameSliceLimits = {
    ...DEFAULT_BLAME_SLICE,
    ...run.limits,
    stepIsFresh: () => true,
  };
  const started = await startBlame(source, oidOfName(tip), PATH, slice);
  if ("failure" in started) return { failure: started.failure };
  let state = started;
  const stops: string[] = [];
  for (let guard = 0; guard < 2000; guard++) {
    const result = await advanceBlame(state, source, slice);
    stops.push(`${result.steps}/${result.stop}`);
    if (run.roundTrip) state = decodeBlameState(encodeBlameState(state));
    if (result.stop === "done") break;
  }
  return {
    ranges: describe(source, state, 0, Number.MAX_SAFE_INTEGER),
    page: `${describe(source, state, 1, 2)} | ${describe(source, state, 3, 1)}`,
    state: createHash("sha256").update(encodeBlameState(state)).digest("hex"),
    steps: state.steps,
    stateLimit: state.stateLimit,
    stops: stops.join(","),
  };
}
