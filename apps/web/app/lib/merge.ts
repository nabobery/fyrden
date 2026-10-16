/** The merge methods, in the order the merge box offers them. */
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** What the active rulesets on a base branch ask of a merge into it. */
export interface MergeRules {
  /** The merge methods every applicable `pull_request` rule allows, in the usual order. */
  methods: MergeMethod[];
  /** Approvals needed (the most any rule asks). */
  approvals: number;
  threadsResolved: boolean;
  lastPushApproval: boolean;
  upToDate: boolean;
  signatures: boolean;
  /** The rulesets these come from, by name. */
  rulesets: string[];
}

export const METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Create a merge commit",
  squash: "Squash and merge",
  rebase: "Rebase and merge",
};
