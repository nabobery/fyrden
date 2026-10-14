import { atLeast, type RepoRole } from "../authz/roles.js";
import type { PrincipalType } from "../principals/principal.js";
import { PRECHECK_RULES, type Rule, type Ruleset, refPatternMatches } from "./ruleset.js";

/** Who is pushing: their principal type and their role on the repository. */
export interface RuleActor {
  readonly principalType: PrincipalType;
  readonly role: RepoRole | null;
}

/** One ref update, as far as it is known at the point of the check. */
export interface RefChange {
  readonly ref: string;
  readonly kind: "create" | "update" | "delete";
  /** Known at the commit point: whether an update keeps the old commit in its history. */
  readonly fastForward?: boolean;
  /** Known at the commit point: a new commit whose signature is not verified, if any. */
  readonly unverifiedCommit?: { readonly sha: string; readonly reason: string };
}

export interface RuleViolation {
  readonly ruleset: string;
  readonly rule: Rule["type"];
  /** For the client, naming the ruleset. */
  readonly message: string;
  /** False for an `evaluate` ruleset: reported, not enforced. */
  readonly blocking: boolean;
}

/** The rules of active or evaluated rulesets that apply to `ref` for `actor`. */
export function applicableRules(
  rulesets: readonly Ruleset[],
  ref: string,
  actor: RuleActor,
  defaultBranch: string | null,
): { readonly ruleset: Ruleset; readonly rule: Rule }[] {
  const out: { ruleset: Ruleset; rule: Rule }[] = [];
  for (const ruleset of rulesets) {
    if (ruleset.enforcement === "disabled") continue;
    if (ruleset.actor_types && !ruleset.actor_types.includes(actor.principalType)) continue;
    const { include, exclude } = ruleset.conditions.ref_name;
    const matches = (p: string) => refPatternMatches(p, ref, ruleset.target, defaultBranch);
    if (!include.some(matches) || exclude.some(matches)) continue;
    if (bypasses(ruleset, actor)) continue;
    for (const rule of ruleset.rules) {
      // Signatures are of commits: a tag ruleset carries no such rule.
      if (rule.type === "required_signatures" && ruleset.target !== "branch") continue;
      out.push({ ruleset, rule });
    }
  }
  return out;
}

function bypasses(ruleset: Ruleset, actor: RuleActor): boolean {
  return ruleset.bypass_actors.some(
    (b) => b.actor_type === "RepositoryRole" && atLeast(actor.role, b.actor_id),
  );
}

/**
 * The rules `change` breaks. `stage` "precheck" checks only the rules that
 * need no objects (before an upload); "commit" checks every rule, with the
 * fast-forward and signature facts the commit point knows.
 */
export function ruleViolations(
  rulesets: readonly Ruleset[],
  change: RefChange,
  actor: RuleActor,
  defaultBranch: string | null,
  stage: "precheck" | "commit",
): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const { ruleset, rule } of applicableRules(rulesets, change.ref, actor, defaultBranch)) {
    if (stage === "precheck" && !PRECHECK_RULES.has(rule.type)) continue;
    const broken = breaks(rule, change);
    if (broken)
      out.push({
        ruleset: ruleset.name,
        rule: rule.type,
        message: `${broken} (ruleset "${ruleset.name}")`,
        blocking: ruleset.enforcement === "active",
      });
  }
  return out;
}

function breaks(rule: Rule, change: RefChange): string | undefined {
  switch (rule.type) {
    case "creation":
      return change.kind === "create" ? "cannot create this ref" : undefined;
    case "update":
      return change.kind === "update" ? "cannot update this ref" : undefined;
    case "deletion":
      return change.kind === "delete" ? "cannot delete this ref" : undefined;
    case "pull_request":
      return "changes must be made through a pull request";
    case "non_fast_forward":
      return change.kind === "update" && change.fastForward === false
        ? "cannot force-push to this ref"
        : undefined;
    case "required_signatures":
      return change.unverifiedCommit
        ? `commits must have verified signatures (${change.unverifiedCommit.sha.slice(0, 12)} is ${change.unverifiedCommit.reason})`
        : undefined;
  }
}
