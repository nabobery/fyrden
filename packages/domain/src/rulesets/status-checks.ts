import { type CheckSummary, checkNameKey, countedByDefault } from "../checks/checks.js";

/**
 * Required status checks, as GitHub's `required_status_checks` rule judges
 * them: named checks a commit must pass before a ref may point at it, each
 * from an expected source or from any. Pure: the caller reads the commit's
 * check summaries and passes them in.
 */

/** The check summaries of one commit, of the names asked (or more). */
export interface StatusCheckFacts {
  readonly sha: string;
  readonly checks: readonly CheckSummary[];
}

/** One check a rule requires, by GitHub's names. */
export interface RequiredStatusCheck {
  /** The status context or check name. */
  readonly context: string;
  /** The source it must come from (a principal id, or `ci`); any source when absent. */
  readonly integration_id?: string;
}

/** The `required_status_checks` rule's parameters, by GitHub's names. */
export interface RequiredStatusChecksParameters {
  readonly required_status_checks: readonly RequiredStatusCheck[];
  /**
   * Strict: a pull request merged into the branch must contain its latest
   * commit (as `require_up_to_date`). GitHub's default for the rule.
   */
  readonly strict_required_status_checks_policy: boolean;
  /** A ref being created skips this rule. */
  readonly do_not_enforce_on_create: boolean;
}

/** Required checks one rule may name. Proposed. */
export const MAX_REQUIRED_CHECKS = 50;

/** Blocking checks one refusal names; the rest are counted. Proposed. */
export const MAX_CHECKS_NAMED = 5;

/** The rule's parameters with the defaults filled in: strict, and enforced on creation. */
export function requiredStatusChecksParameters(
  parameters: Partial<RequiredStatusChecksParameters> & {
    readonly required_status_checks: readonly RequiredStatusCheck[];
  },
): RequiredStatusChecksParameters {
  return {
    strict_required_status_checks_policy: true,
    do_not_enforce_on_create: false,
    ...parameters,
  };
}

/** Where a required check stands on a commit. */
export type RequiredCheckState = "passed" | "pending" | "failing" | "expected";

export interface RequiredCheckOutcome {
  readonly check: RequiredStatusCheck;
  readonly state: RequiredCheckState;
  /** The facts that decided it: the latest status and every check of its candidates. */
  readonly deciding: readonly CheckSummary[];
}

/** Conclusions a required check passes on (GitHub's: success, skipped, neutral). */
const PASSING: ReadonlySet<string> = new Set(["success", "skipped", "neutral"]);

/**
 * The facts `check` could count: those of its name from its source, or
 * from every source when it names none.
 */
export function candidateFacts(
  check: RequiredStatusCheck,
  facts: StatusCheckFacts,
): readonly CheckSummary[] {
  const key = checkNameKey(check.context);
  return facts.checks.filter(
    (f) =>
      checkNameKey(f.name) === key &&
      (check.integration_id === undefined || f.source === check.integration_id),
  );
}

/**
 * The facts that decide `check`: of its candidates, those the summaries
 * count by default (the latest status, as GitHub's combined status takes
 * each context's latest whoever posted it, and every check: a check and a
 * status of one name must both pass), the status first, then the checks by
 * source, whatever order they came in.
 */
function decidingFacts(candidates: readonly CheckSummary[]): CheckSummary[] {
  const counted = countedByDefault(candidates);
  const statuses = counted.filter((f) => f.kind === "status");
  const checks = counted
    .filter((f) => f.kind === "check")
    .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  return [...statuses, ...checks];
}

/**
 * Of a commit's summaries, those `required` checks decide by (each
 * requirement's deciding facts): what a pull request's failing checks are
 * read from once a rule names required checks. In the order given.
 */
export function countedByRequired(
  required: readonly RequiredStatusCheck[],
  rows: readonly CheckSummary[],
): CheckSummary[] {
  const facts = { sha: "", checks: rows };
  const counted = new Set(required.flatMap((check) => decidingFacts(candidateFacts(check, facts))));
  return rows.filter((row) => counted.has(row));
}

/** Where one status or check stands: passed (success, skipped, neutral), pending or failing. */
export function checkFactState(fact: CheckSummary): "passed" | "pending" | "failing" {
  if (fact.status !== "completed") return "pending";
  return fact.conclusion !== null && PASSING.has(fact.conclusion) ? "passed" : "failing";
}

/**
 * Each required check's outcome on a commit. Facts left out (they could
 * not be read) leave every check `expected`.
 */
export function requiredCheckOutcomes(
  required: readonly RequiredStatusCheck[],
  facts: StatusCheckFacts | undefined,
): RequiredCheckOutcome[] {
  return required.map((check) => {
    const deciding = facts ? decidingFacts(candidateFacts(check, facts)) : [];
    if (deciding.length === 0) return { check, state: "expected", deciding };
    const states = deciding.map(checkFactState);
    const state = states.includes("failing")
      ? "failing"
      : states.includes("pending")
        ? "pending"
        : "passed";
    return { check, state, deciding };
  });
}

/**
 * Why the outcomes block a ref update, in GitHub's words (`required status
 * check "build" is failing`), naming at most `MAX_CHECKS_NAMED` checks;
 * undefined when every required check passed.
 */
export function requiredChecksRefusal(
  outcomes: readonly RequiredCheckOutcome[],
): string | undefined {
  const blocking = outcomes.filter((o) => o.state !== "passed");
  if (blocking.length === 0) return undefined;
  const named = blocking
    .slice(0, MAX_CHECKS_NAMED)
    .map((o) => `required status check "${o.check.context}" is ${o.state}`);
  const rest = blocking.length - named.length;
  if (rest > 0)
    named.push(`and ${rest} more required status check${rest === 1 ? " is" : "s are"} not passing`);
  return named.join("; ");
}
