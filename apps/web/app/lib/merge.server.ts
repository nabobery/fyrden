import { MERGE_METHODS, pullRequestParameters, type Rule, refPatternMatches } from "@fyrden/domain";
import type { MergeRules } from "./merge.js";

/** A ruleset as the API lists it (the fields the merge box reads). */
export interface ListedRuleset {
  name: string;
  target: "branch" | "tag";
  enforcement: "active" | "evaluate" | "disabled";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Rule[];
}

/**
 * What the active branch rulesets covering `base` ask of a merge into it.
 * Who merges is not known here: a role that bypasses a ruleset, or an
 * actor type it leaves out, may meet less; the server decides when merging.
 */
export function mergeRules(
  rulesets: readonly ListedRuleset[],
  base: string,
  defaultBranch: string,
): MergeRules {
  const ref = `refs/heads/${base}`;
  const out: MergeRules = {
    methods: [...MERGE_METHODS],
    approvals: 0,
    threadsResolved: false,
    lastPushApproval: false,
    upToDate: false,
    signatures: false,
    rulesets: [],
  };
  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== "active" || ruleset.target !== "branch") continue;
    const matches = (pattern: string) => refPatternMatches(pattern, ref, "branch", defaultBranch);
    const { include, exclude } = ruleset.conditions.ref_name;
    if (!include.some(matches) || exclude.some(matches)) continue;
    let applies = false;
    for (const rule of ruleset.rules) {
      if (rule.type === "pull_request") {
        const p = pullRequestParameters(rule);
        out.methods = out.methods.filter((m) => p.allowed_merge_methods.includes(m));
        out.approvals = Math.max(out.approvals, p.required_approving_review_count);
        out.threadsResolved ||= p.required_review_thread_resolution;
        out.lastPushApproval ||= p.require_last_push_approval;
        applies = true;
      } else if (rule.type === "require_up_to_date") {
        out.upToDate = true;
        applies = true;
      } else if (rule.type === "required_signatures") {
        out.signatures = true;
        applies = true;
      }
    }
    if (applies) out.rulesets.push(ruleset.name);
  }
  return out;
}
