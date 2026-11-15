/*
 * GitHub's filter patterns for `branches`, `tags` and `paths` (verified
 * 2026-11-15, https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet):
 * `*` matches any run of characters but `/`, `**` any run at all, `?` zero
 * or one of the preceding character, `+` one or more of it, `[...]` one
 * listed character or range, a leading `!` negates, and `\` escapes. A
 * `**` followed by `/` may also match nothing: the cheat sheet's README
 * pattern under `**` matches `README.md` at the root.
 *
 * A pattern compiles to a list of steps run as a set of states over the
 * input (a Thompson walk), so matching costs at most pattern length times
 * input length, whatever the pattern.
 */

/** One step of a compiled pattern. */
type Step =
  | {
      readonly kind: "char";
      readonly test: (c: string) => boolean;
      /** `one` exactly once, `optional` zero or once (`?`), `many` zero or more (the tail of `+`). */
      readonly repeat: "one" | "optional" | "many";
    }
  /** `*`: any characters but `/`. */
  | { readonly kind: "star" }
  /** `**`: any characters. */
  | { readonly kind: "globstar" }
  /** Reads nothing; carries on at the next step or `skip` steps past it. */
  | { readonly kind: "fork"; readonly skip: number };

export interface CompiledPattern {
  /** The pattern began with `!`. */
  readonly negated: boolean;
  /** Whether the whole of `value` matches the pattern (its `!` aside). */
  matches(value: string): boolean;
}

interface CompileStats {
  examined: number;
}

/** Compiles in work linear in the pattern's length (see `compileWork`). */
export function compilePattern(pattern: string): CompiledPattern {
  const negated = pattern.startsWith("!");
  const steps = compileSteps(negated ? pattern.slice(1) : pattern, { examined: 0 });
  return { negated, matches: (value) => run(steps, value) };
}

/** Characters compiling `pattern` examines, for tests that bound the compiler's work. */
export function compileWork(pattern: string): number {
  const stats = { examined: 0 };
  compileSteps(pattern.startsWith("!") ? pattern.slice(1) : pattern, stats);
  return stats.examined;
}

function compileSteps(source: string, stats: CompileStats): Step[] {
  const steps: Step[] = [];
  const chars = [...source];
  // The next `]` after each position, found in one pass from the end, so an unclosed `[` costs
  // nothing to look for.
  const nextClose = new Array<number>(chars.length + 1).fill(-1);
  for (let i = chars.length - 1; i >= 0; i--) {
    stats.examined++;
    nextClose[i] = chars[i] === "]" ? i : (nextClose[i + 1] as number);
  }
  const literal = (c: string): Step => ({ kind: "char", test: (x) => x === c, repeat: "one" });
  for (let i = 0; i < chars.length; i++) {
    stats.examined++;
    const c = chars[i] as string;
    const last = steps[steps.length - 1];
    if (c === "\\" && i + 1 < chars.length) {
      steps.push(literal(chars[++i] as string));
    } else if (c === "*") {
      let end = i;
      while (chars[end + 1] === "*") end++;
      if (end === i) steps.push({ kind: "star" });
      else if (chars[end + 1] === "/") {
        // `**/` is nothing, or `**` then `/`.
        steps.push({ kind: "fork", skip: 2 }, { kind: "globstar" }, literal("/"));
        end++;
      } else steps.push({ kind: "globstar" });
      i = end;
    } else if ((c === "?" || c === "+") && last?.kind === "char" && last.repeat === "one") {
      // A quantifier applies to the character or class before it; anywhere else it is literal.
      if (c === "?") steps[steps.length - 1] = { ...last, repeat: "optional" };
      else steps.push({ ...last, repeat: "many" });
    } else if (c === "[") {
      const close = nextClose[i + 1] as number;
      const test = close > i + 1 ? charClass(chars, i + 1, close, stats) : undefined;
      if (test) {
        steps.push({ kind: "char", test, repeat: "one" });
        i = close;
      } else steps.push(literal(c));
    } else steps.push(literal(c));
  }
  return steps;
}

/** `[...]`'s test, or undefined when its contents are not characters and ranges. */
function charClass(
  chars: readonly string[],
  start: number,
  end: number,
  stats: CompileStats,
): ((c: string) => boolean) | undefined {
  const singles = new Set<string>();
  const ranges: [number, number][] = [];
  // Stops at the first `[` or `/`: a refused class is read only up to the next `[`, so the
  // characters each unclosed `[` reads are disjoint and the whole pattern is read about twice.
  for (let i = start; i < end; i++) {
    stats.examined++;
    const c = chars[i] as string;
    if (c === "/" || c === "[") return undefined;
    if (chars[i + 1] === "-" && i + 2 < end) {
      // The endpoint is read here too, so it stops the class like any other character would.
      const endpoint = chars[i + 2] as string;
      if (endpoint === "/" || endpoint === "[") return undefined;
      const from = c.codePointAt(0) ?? 0;
      const to = (chars[i + 2] as string).codePointAt(0) ?? 0;
      if (from > to) return undefined;
      ranges.push([from, to]);
      i += 2;
    } else singles.add(c);
  }
  return (x) => {
    if (singles.has(x)) return true;
    const code = x.codePointAt(0) ?? -1;
    return ranges.some(([from, to]) => code >= from && code <= to);
  };
}

/** Adds state `i` and every state reachable from it without reading a character. */
function close(steps: readonly Step[], states: Uint8Array, i: number): void {
  const pending = [i];
  for (let s = pending.pop(); s !== undefined; s = pending.pop()) {
    if (states[s]) continue;
    states[s] = 1;
    const step = steps[s];
    if (!step) continue;
    if (step.kind === "fork") pending.push(s + 1, s + 1 + step.skip);
    // A step that may match nothing lets the walk carry on to the next one.
    else if (!(step.kind === "char" && step.repeat === "one")) pending.push(s + 1);
  }
}

function run(steps: readonly Step[], value: string): boolean {
  let current = new Uint8Array(steps.length + 1);
  close(steps, current, 0);
  for (const c of value) {
    const next = new Uint8Array(steps.length + 1);
    let any = false;
    for (let s = 0; s < steps.length; s++) {
      if (!current[s]) continue;
      const step = steps[s] as Step;
      if (step.kind === "fork") continue;
      if (step.kind === "char") {
        if (!step.test(c)) continue;
        if (step.repeat === "many") close(steps, next, s);
        else close(steps, next, s + 1);
      } else if (step.kind === "star") {
        if (c === "/") continue;
        close(steps, next, s);
      } else close(steps, next, s);
      any = true;
    }
    if (!any) return false;
    current = next;
  }
  return current[steps.length] === 1;
}

/**
 * Whether `value` is selected by `patterns` read in order: a pattern that
 * matches includes it, a `!` pattern that matches excludes it, the last
 * match wins, and no match (or no patterns) selects nothing.
 */
export function matchesPatterns(patterns: readonly string[], value: string): boolean {
  return selects(patterns.map(compilePattern), value);
}

function selects(patterns: readonly CompiledPattern[], value: string): boolean {
  let selected = false;
  for (const p of patterns) if (p.matches(value)) selected = !p.negated;
  return selected;
}

/** A `branches`/`tags` filter, or its `-ignore` form. */
export interface PatternFilter {
  readonly mode: "include" | "ignore";
  readonly patterns: readonly string[];
}

/** Whether a filter lets one branch or tag name through. */
export function filterAllows(filter: PatternFilter, name: string): boolean {
  return matchesPatterns(filter.patterns, name) === (filter.mode === "include");
}

/**
 * Whether a `paths` filter lets a change through: some changed path is
 * included (or, for `paths-ignore`, not ignored). No changed paths never
 * pass ("If there are no files changed, the workflow will not run",
 * verified 2026-11-15, same page, `on.<push|pull_request>.paths`).
 */
export function pathsAllow(filter: PatternFilter, paths: readonly string[]): boolean {
  const compiled = filter.patterns.map(compilePattern);
  const include = filter.mode === "include";
  return paths.some((path) => selects(compiled, path) === include);
}
