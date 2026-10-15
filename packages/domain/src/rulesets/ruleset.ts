import type { RepoRole } from "../authz/roles.js";
import type { PrincipalType } from "../principals/principal.js";

/**
 * Rulesets, shaped as GitHub's repository rulesets: rules on the branches
 * or tags whose names match, for everyone but the actors who may bypass
 * them. Fyrden adds `actor_types`, the principal types a ruleset applies
 * to (all when absent): "agents must use pull requests" is a
 * `pull_request` rule for `agent`.
 */

/** The rules Fyrden enforces, by GitHub's names. */
export const RULE_TYPES = [
  "creation",
  "update",
  "deletion",
  "non_fast_forward",
  "required_signatures",
  "pull_request",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

export interface Rule {
  readonly type: RuleType;
}

/** A ruleset's own state: `active` blocks, `evaluate` only reports, `disabled` does nothing. */
export type Enforcement = "active" | "evaluate" | "disabled";

export interface BypassActor {
  /** The repository roles that bypass it (that role or stronger). */
  readonly actor_type: "RepositoryRole";
  readonly actor_id: RepoRole;
  readonly bypass_mode: "always";
}

export interface Ruleset {
  readonly id: number;
  readonly name: string;
  readonly target: "branch" | "tag";
  readonly enforcement: Enforcement;
  readonly conditions: {
    readonly ref_name: { readonly include: readonly string[]; readonly exclude: readonly string[] };
  };
  readonly rules: readonly Rule[];
  readonly bypass_actors: readonly BypassActor[];
  /** The principal types it applies to; every type when absent. */
  readonly actor_types?: readonly PrincipalType[];
}

/** Rules that need only the ref name and the kind of update: checked before an upload. */
export const PRECHECK_RULES: ReadonlySet<RuleType> = new Set([
  "creation",
  "update",
  "deletion",
  "pull_request",
]);

const PREFIX = { branch: "refs/heads/", tag: "refs/tags/" } as const;

/**
 * Whether `pattern` matches the full ref name `ref`, as GitHub's ruleset
 * conditions do: `~ALL`, `~DEFAULT_BRANCH`, or an fnmatch pattern over the
 * full name where `*` stays within a path segment and `**` crosses them.
 */
export function refPatternMatches(
  pattern: string,
  ref: string,
  target: Ruleset["target"],
  defaultBranch: string | null,
): boolean {
  if (!ref.startsWith(PREFIX[target])) return false;
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH")
    return target === "branch" && defaultBranch !== null && ref === `refs/heads/${defaultBranch}`;
  return globMatches(pattern, ref);
}

/**
 * fnmatch over full ref names, without backtracking: the set of ref
 * positions the pattern can have reached is carried token by token (`*`
 * any run without `/`, `**` any run, `?` one character but `/`, anything
 * else itself), so the work is at most the pattern's length times the
 * ref's, whatever the pattern.
 */
export function globMatches(pattern: string, ref: string): boolean {
  return globWalk(pattern, ref).matched;
}

/**
 * {@link globMatches} with the work it did: `steps` counts the ref
 * positions visited, so a test can check the bound without a clock.
 */
export function globWalk(pattern: string, ref: string): { matched: boolean; steps: number } {
  // Without a wildcard it is one comparison.
  if (!pattern.includes("*") && !pattern.includes("?"))
    return { matched: pattern === ref, steps: 1 };
  let steps = 0;
  const n = ref.length;
  let reach = new Uint8Array(n + 1);
  reach[0] = 1;
  // The reached positions lie within [lo, hi]; none left means no match,
  // so a pattern that cannot match stops at its first difference.
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    const next = new Uint8Array(n + 1);
    let nextLo = n + 1;
    let nextHi = -1;
    if (c === "*") {
      const crosses = pattern[i + 1] === "*";
      if (crosses) i++;
      // From each reached position, any run (of non-`/`, for a single `*`).
      let open = false;
      for (let at = lo; at <= n; at++) {
        steps++;
        if (reach[at]) open = true;
        if (open) {
          next[at] = 1;
          if (at < nextLo) nextLo = at;
          nextHi = at;
        }
        if (!crosses && ref[at] === "/") open = false;
        if (!open && at > hi) break;
      }
    } else {
      for (let at = lo; at <= hi && at < n; at++) {
        steps++;
        if (reach[at] && (c === "?" ? ref[at] !== "/" : ref[at] === c)) {
          next[at + 1] = 1;
          if (at + 1 < nextLo) nextLo = at + 1;
          nextHi = at + 1;
        }
      }
    }
    if (nextHi < 0) return { matched: false, steps };
    reach = next;
    lo = nextLo;
    hi = nextHi;
  }
  return { matched: reach[n] === 1, steps };
}
