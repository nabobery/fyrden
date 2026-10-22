/*
 * CODEOWNERS patterns as GitHub matches them: gitignore-like, but not
 * gitignore. A leading `/` anchors a pattern at the repository's root; one
 * with no other `/` matches at any depth. `dir/` owns everything under a
 * directory `dir` (not `dir` itself). `**` matches any number of
 * directories (as the last segment, everything beneath). `*` matches within
 * one path segment (as a whole segment, one segment), `?` one character, and
 * `\` makes the next character literal. A pattern whose last segment is a
 * name also owns everything under a directory of that name, except a last
 * segment that is `*` alone: `docs/*` owns docs' files, not deeper ones.
 * Paths are case-sensitive. Negation (`!`) is not GitHub's: `compilePattern`
 * refuses it; brackets are literal characters (GitHub has no ranges).
 * Patterns of nothing but globstars and slashes (other than `**` and
 * `/**`, everything) are refused: their meaning differs between
 * implementations, so none is guessed. `**` twice in a row is one.
 *
 * Matching walks segments and characters with no regular expressions; every
 * step is counted against a budget, so no pattern can take more work than
 * its caller allows.
 */

/** A part of a segment's glob: a run of literal text, `?` or `*`. */
type GlobPart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "one" }
  | { readonly kind: "any" };

/** One segment of a compiled pattern. */
type Element =
  /** `**`: any number of segments (at least one when it ends the pattern). */
  | { readonly kind: "dirs"; readonly atLeastOne: boolean }
  /** A segment's glob; `star` when it is `*` alone. */
  | { readonly kind: "segment"; readonly parts: readonly GlobPart[]; readonly star: boolean };

export interface CompiledPattern {
  readonly source: string;
  readonly elements: readonly Element[];
  /** A matching prefix also owns everything beneath it (the last segment is a name). */
  readonly descendants: boolean;
}

/** Why a pattern cannot be used, as a CODEOWNERS error says it. */
export type PatternRefusal =
  | "empty"
  | "negation"
  | "globstar_only"
  | "escaped_comment"
  | "escaped_slash"
  | "triple_star"
  | "too_many_wildcards"
  | "too_many_segments"
  | "root_only"
  | "trailing_escape";

/** A pattern too costly to match within the budget given: what was spent. */
export class MatchBudgetExceeded extends Error {
  constructor(readonly steps: number) {
    super(`matching took more than ${steps} steps`);
    this.name = "MatchBudgetExceeded";
  }
}

/**
 * Wildcards (`*` and `?` characters) a pattern holds at most: each is a
 * part of its compiled form, so with the file's rule cap this bounds what
 * a file compiles to. Proposed.
 */
export const MAX_PATTERN_WILDCARDS = 64;

/**
 * Path segments a pattern holds at most: each compiles to its own parts.
 * With the wildcard cap and the file's rule cap, a file compiles to some
 * 200 parts a rule at most. Proposed.
 */
export const MAX_PATTERN_SEGMENTS = 64;

/**
 * Why `pattern` cannot be used, if it cannot: read once, escapes
 * respected (an escaped character is literal, and a slash cannot be
 * escaped: it always separates).
 */
function refusalOf(pattern: string): PatternRefusal | undefined {
  if (pattern.length === 0) return "empty";
  if (pattern.startsWith("!")) return "negation";
  if (pattern.startsWith("\\#")) return "escaped_comment";
  let stars = 0;
  let wildcards = 0;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) return "trailing_escape";
      if (next === "/") return "escaped_slash";
      stars = 0;
      i++;
      continue;
    }
    stars = char === "*" ? stars + 1 : 0;
    if (stars === 3) return "triple_star";
    if ((char === "*" || char === "?") && ++wildcards > MAX_PATTERN_WILDCARDS)
      return "too_many_wildcards";
  }
  const segments = pattern.split("/");
  if (segments.length > MAX_PATTERN_SEGMENTS) return "too_many_segments";
  if (segments.every((s) => s === "")) return "root_only";
  const named = segments.filter((s) => s !== "");
  if (named.every((s) => s === "**") && (named.length > 1 || segments.at(-1) === ""))
    return "globstar_only";
  return undefined;
}

/**
 * A segment's glob parts, literal text in runs (its escapes checked
 * already). A run is made from slices of the segment, joined once, so it
 * is one flat string.
 */
function partsOf(segment: string): GlobPart[] {
  const parts: GlobPart[] = [];
  let pieces: string[] = [];
  // Where the literal text not yet taken starts.
  let from = 0;
  const flush = (to: number) => {
    if (to > from) pieces.push(segment.slice(from, to));
    if (pieces.length > 0) parts.push({ kind: "literal", text: pieces.join("") });
    pieces = [];
  };
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i] as string;
    if (char === "\\") {
      // The text before it, then the escaped character, whole (a surrogate pair is two units).
      if (i > from) pieces.push(segment.slice(from, i));
      const escaped = String.fromCodePoint(segment.codePointAt(i + 1) as number);
      pieces.push(escaped);
      i += escaped.length;
      from = i + 1;
    } else if (char === "*" || char === "?") {
      flush(i);
      from = i + 1;
      // Consecutive stars within a segment are one.
      if (char === "?") parts.push({ kind: "one" });
      else if (parts.at(-1)?.kind !== "any") parts.push({ kind: "any" });
    }
  }
  flush(segment.length);
  return parts;
}

/** Compiles a CODEOWNERS pattern (as written, escapes included), or says why it cannot be. */
export function compilePattern(
  pattern: string,
):
  | { readonly ok: true; readonly pattern: CompiledPattern }
  | { readonly ok: false; readonly refusal: PatternRefusal } {
  const refusal = refusalOf(pattern);
  if (refusal) return { ok: false, refusal };
  let segments = pattern.split("/");
  if (segments[0] === "") segments = segments.slice(1);
  else if (segments.length === 1 || (segments.length === 2 && segments[1] === "")) {
    // No slash but a trailing one: at any depth.
    if (segments[0] !== "**") segments = ["**", ...segments];
  }
  // `dir/`: everything beneath (not the directory itself).
  if (segments.length > 1 && segments.at(-1) === "") segments[segments.length - 1] = "**";
  const elements: Element[] = [];
  for (const [i, segment] of segments.entries()) {
    const last = i === segments.length - 1;
    if (segment === "**") {
      // `dir/**/` (the trailing slash's `**` after a written one) is one.
      if (elements.at(-1)?.kind === "dirs") {
        if (last) elements[elements.length - 1] = { kind: "dirs", atLeastOne: true };
        continue;
      }
      elements.push({ kind: "dirs", atLeastOne: last });
      continue;
    }
    elements.push({ kind: "segment", parts: partsOf(segment), star: segment === "*" });
  }
  const tail = elements.at(-1);
  return {
    ok: true,
    pattern: {
      source: pattern,
      elements,
      descendants: tail?.kind === "segment" && !tail.star,
    },
  };
}

/** A counter of matching steps, shared by every match a caller makes under one budget. */
export class MatchBudget {
  #spent = 0;
  constructor(readonly limit: number) {}
  get spent(): number {
    return this.#spent;
  }
  /** Spends `steps`; throws once past the limit. */
  spend(steps = 1): void {
    this.#spent += steps;
    if (this.#spent > this.limit) throw new MatchBudgetExceeded(this.limit);
  }
}

/** The code units of the code point at `at` in `text` (2 for a surrogate pair). */
const width = (text: string, at: number) => ((text.codePointAt(at) as number) > 0xffff ? 2 : 1);

/**
 * Whether `segment` matches a segment glob: greedy `*` with backtracking to
 * the last star (the classic two-pointer match, literal runs compared
 * whole), `?` one code point. Each comparison spends its length.
 */
function segmentMatches(parts: readonly GlobPart[], segment: string, budget: MatchBudget): boolean {
  let p = 0;
  let s = 0;
  let starP = -1;
  let starS = 0;
  while (s < segment.length) {
    const part = parts[p];
    budget.spend(part?.kind === "literal" ? part.text.length : 1);
    if (part?.kind === "literal" && segment.startsWith(part.text, s)) {
      p++;
      s += part.text.length;
    } else if (part?.kind === "one") {
      p++;
      s += width(segment, s);
    } else if (part?.kind === "any") {
      starP = p++;
      starS = s;
    } else if (starP >= 0) {
      p = starP + 1;
      starS += width(segment, starS);
      s = starS;
    } else return false;
  }
  while (parts[p]?.kind === "any") p++;
  return p === parts.length;
}

/** A path ready to match: its segments. */
export interface PreparedPath {
  readonly segments: readonly string[];
}

/**
 * `path` (a file's path from the repository root, no leading `/`) ready to
 * match against any number of patterns, its preparation spent from
 * `budget` before it is made.
 */
export function preparePath(path: string, budget: MatchBudget): PreparedPath {
  budget.spend(path.length + 1);
  return { segments: path.split("/") };
}

/** Whether `pattern` owns `path`, spending steps from `budget`. */
export function matchesPath(
  pattern: CompiledPattern,
  path: PreparedPath,
  budget: MatchBudget,
): boolean {
  const { segments } = path;
  const { elements } = pattern;
  // Reachable positions: after `e` elements, `s` segments consumed.
  let reachable = new Set<number>([0]);
  for (const element of elements) {
    const next = new Set<number>();
    for (const s of reachable) {
      budget.spend();
      if (element.kind === "dirs") {
        // Any number of segments (each one non-empty), at least one if required.
        for (let t = s + (element.atLeastOne ? 1 : 0); t <= segments.length; t++) {
          budget.spend();
          next.add(t);
        }
      } else if (s < segments.length) {
        const segment = segments[s] as string;
        if (segment.length > 0 && segmentMatches(element.parts, segment, budget)) next.add(s + 1);
      }
    }
    reachable = next;
    if (reachable.size === 0) return false;
  }
  if (reachable.has(segments.length)) return true;
  // Only proper prefixes matched (every element consumed a segment): a name owns what is beneath it.
  return pattern.descendants;
}
