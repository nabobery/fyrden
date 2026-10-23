import {
  type CodeOwnersFile,
  MatchBudget,
  MatchBudgetExceeded,
  ownershipOf,
  pathText,
} from "@fyrden/domain";
import {
  type CursorName,
  DIFF_START,
  type DiffCursor,
  diffTreesFrom,
  type Oid,
  type ResumedChange,
  TreeDiffLimitError,
  type TreeEntry,
} from "@fyrden/git-core";
import { ReadsTooLargeError } from "./held-reads.js";

/*
 * One slice of working out who owns what a pull request changes: the tree
 * diff from its merge base to its head resumed where the last slice
 * stopped, each changed path matched against the CODEOWNERS rules by its
 * bytes (a path that is not UTF-8 is never matched: two such paths could
 * decode to the same text), and, for each rule that decides a path, how
 * many it decides and the first. Every budget either stops the slice at a
 * position the next resumes from, or, past an evaluation's totals, ends it
 * `too_large` with why. Nothing here reads storage: the caller's reader
 * stops it (`ReadDeferred`) or fails it.
 */

/** Why an evaluation ended `too_large`. */
export type TooLargeReason =
  | "file"
  | "tree"
  | "depth"
  | "scan"
  | "work"
  | "merge_base"
  | "stuck"
  | "path";

export interface CodeOwnerLimits {
  /** Changes one slice lists at most. */
  readonly sliceChanges: number;
  /** Tree entries one slice reads at most. */
  readonly sliceScanned: number;
  /** Matcher steps one slice spends at most. */
  readonly sliceSteps: number;
  /** Directories a path may be deep. */
  readonly maxDepth: number;
  /** An evaluation's totals. */
  readonly totalTrees: number;
  readonly totalScanned: number;
  readonly totalChanges: number;
  readonly totalSteps: number;
  readonly maxSlices: number;
  /** Slices in a row without progress before it ends `stuck`. */
  readonly stalledSlices: number;
}

/** Proposed values (to be measured). */
export const CODE_OWNER_LIMITS: CodeOwnerLimits = {
  sliceChanges: 8_192,
  sliceScanned: 200_000,
  sliceSteps: 1_000_000,
  maxDepth: 64,
  totalTrees: 20_000,
  totalScanned: 2_000_000,
  totalChanges: 200_000,
  totalSteps: 50_000_000,
  maxSlices: 400,
  stalledSlices: 3,
};

/** Bytes of an example path kept at most. */
export const EXAMPLE_BYTES = 512;

/** What a rule decided: how many changed paths, and the first (cut to `EXAMPLE_BYTES`). */
export interface RuleCount {
  readonly paths: number;
  readonly example: string;
}

export interface EvaluationTotals {
  readonly trees: number;
  readonly scanned: number;
  readonly changes: number;
  readonly steps: number;
  readonly slices: number;
  /** Slices in a row that made no progress. */
  readonly stalled: number;
}

/** An evaluation as it stands between slices. */
export interface Evaluation {
  readonly state: "pending" | "complete" | "too_large";
  readonly reason: TooLargeReason | null;
  /** Where the diff resumes; null before the first slice. */
  readonly cursor: DiffCursor | null;
  /** By the rule's line. */
  readonly rules: Map<number, RuleCount>;
  readonly unmatched: number;
  readonly unmatchable: number;
  /** The first path that is not UTF-8, its bytes cut to `EXAMPLE_BYTES`, as base64. */
  readonly unmatchableExample: string | null;
  /** The file's invalid lines. */
  readonly errors: number;
  readonly totals: EvaluationTotals;
}

export function freshEvaluation(): Evaluation {
  return {
    state: "pending",
    reason: null,
    cursor: null,
    rules: new Map(),
    unmatched: 0,
    unmatchable: 0,
    unmatchableExample: null,
    errors: 0,
    totals: { trees: 0, scanned: 0, changes: 0, steps: 0, slices: 0, stalled: 0 },
  };
}

/**
 * The next slice of `evaluation`: the changes from `base` (null: none in
 * common, so every path of `head` is one) to `head` matched against
 * `file`, within `limits`.
 */
export async function evaluateSlice(
  readTree: (oid: Oid) => Promise<readonly TreeEntry[]>,
  base: Oid | null,
  head: Oid,
  file: CodeOwnersFile,
  evaluation: Evaluation,
  limits: CodeOwnerLimits = CODE_OWNER_LIMITS,
): Promise<Evaluation> {
  if (evaluation.state !== "pending") return evaluation;
  const slices = evaluation.totals.slices + 1;
  const tooLarge = (reason: TooLargeReason): Evaluation => ({
    ...evaluation,
    state: "too_large",
    reason,
    totals: { ...evaluation.totals, slices },
  });
  if (slices > limits.maxSlices) return tooLarge("work");
  let listed: Awaited<ReturnType<typeof diffTreesFrom>>;
  try {
    listed = await diffTreesFrom(readTree, base, head, evaluation.cursor, {
      maxChanges: limits.sliceChanges,
      maxScanned: limits.sliceScanned,
      maxDepth: limits.maxDepth,
    });
  } catch (error) {
    if (error instanceof TreeDiffLimitError)
      return tooLarge(error.limit === "depth" ? "depth" : "path");
    if (error instanceof ReadsTooLargeError) return tooLarge("tree");
    throw error;
  }
  const rules = new Map(evaluation.rules);
  let { unmatched, unmatchable, unmatchableExample } = evaluation;
  const budget = new MatchBudget(limits.sliceSteps);
  let cursor: DiffCursor | null = listed.next;
  let matched = 0;
  for (const change of listed.changes) {
    const text = pathText(change.pathBytes);
    if (text === undefined) {
      unmatchable++;
      unmatchableExample ??= base64(change.pathBytes.subarray(0, EXAMPLE_BYTES));
      matched++;
      continue;
    }
    let decided: ReturnType<typeof ownershipOf>;
    try {
      decided = ownershipOf(file, text, budget);
    } catch (error) {
      if (!(error instanceof MatchBudgetExceeded)) throw error;
      // A path a whole slice's steps cannot decide is never decided.
      if (matched === 0) return tooLarge("path");
      cursor = (listed.changes[matched - 1] as ResumedChange).cursor;
      break;
    }
    matched++;
    if (decided.kind === "unmatched") unmatched++;
    else {
      const counted = rules.get(decided.line);
      rules.set(decided.line, {
        paths: (counted?.paths ?? 0) + 1,
        example: counted?.example ?? cutText(text),
      });
    }
  }
  const totals: EvaluationTotals = {
    trees: evaluation.totals.trees + listed.trees,
    scanned: evaluation.totals.scanned + listed.scanned,
    changes: evaluation.totals.changes + matched,
    steps: evaluation.totals.steps + budget.spent,
    slices,
    stalled:
      matched > 0 || !sameCursor(cursor, evaluation.cursor ?? DIFF_START)
        ? 0
        : evaluation.totals.stalled + 1,
  };
  const next: Evaluation = {
    ...evaluation,
    cursor,
    rules,
    unmatched,
    unmatchable,
    unmatchableExample,
    errors: file.errors.length,
    totals,
  };
  if (totals.trees > limits.totalTrees || totals.scanned > limits.totalScanned)
    return { ...next, state: "too_large", reason: "scan" };
  if (totals.changes > limits.totalChanges || totals.steps > limits.totalSteps)
    return { ...next, state: "too_large", reason: "work" };
  if (cursor === null) return { ...next, state: "complete" };
  if (totals.stalled >= limits.stalledSlices)
    return { ...next, state: "too_large", reason: "stuck" };
  return next;
}

/** An evaluation's checkpoint as stored: the cursor and the rules' counts as JSON, paths in base64. */
export interface StoredEvaluation {
  readonly cursor: string | null;
  readonly partial: string;
  readonly totals: string;
}

export function serializeEvaluation(evaluation: Evaluation): StoredEvaluation {
  return {
    cursor:
      evaluation.cursor === null
        ? null
        : JSON.stringify({
            path: evaluation.cursor.path.map((n) => [base64(n.name), n.tree ? 1 : 0]),
            enter: evaluation.cursor.enter ? 1 : 0,
          }),
    partial: JSON.stringify({
      rules: [...evaluation.rules].map(([line, r]) => [
        line,
        r.paths,
        base64(new TextEncoder().encode(r.example)),
      ]),
      unmatched: evaluation.unmatched,
      unmatchable: evaluation.unmatchable,
      unmatchableExample: evaluation.unmatchableExample,
    }),
    totals: JSON.stringify(evaluation.totals),
  };
}

export function deserializeEvaluation(
  stored: StoredEvaluation & { readonly errors: number },
): Evaluation {
  const partial = JSON.parse(stored.partial) as {
    rules: [number, number, string][];
    unmatched: number;
    unmatchable: number;
    unmatchableExample: string | null;
  };
  const cursor =
    stored.cursor === null
      ? null
      : (JSON.parse(stored.cursor) as { path: [string, 0 | 1][]; enter: 0 | 1 });
  return {
    state: "pending",
    reason: null,
    cursor: cursor && {
      path: cursor.path.map(
        ([name, tree]): CursorName => ({ name: unbase64(name), tree: tree === 1 }),
      ),
      enter: cursor.enter === 1,
    },
    rules: new Map(
      partial.rules.map(([line, paths, example]) => [
        line,
        { paths, example: exampleText.decode(unbase64(example)) },
      ]),
    ),
    unmatched: partial.unmatched,
    unmatchable: partial.unmatchable,
    unmatchableExample: partial.unmatchableExample,
    errors: stored.errors,
    totals: JSON.parse(stored.totals) as EvaluationTotals,
  };
}

/** An example's bytes as the text they were: every byte, a leading byte order mark too. */
const exampleText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

function sameCursor(a: DiffCursor | null, b: DiffCursor | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.enter !== b.enter || a.path.length !== b.path.length) return false;
  return a.path.every((n, i) => {
    const m = b.path[i] as CursorName;
    return (
      n.tree === m.tree &&
      n.name.length === m.name.length &&
      n.name.every((x, k) => x === m.name[k])
    );
  });
}

/** `text` cut to at most `EXAMPLE_BYTES` of UTF-8, at a character's end. */
function cutText(text: string): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > EXAMPLE_BYTES) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
