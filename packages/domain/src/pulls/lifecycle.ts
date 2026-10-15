import { atLeast, type RepoRole } from "../authz/roles.js";
import type { PullState } from "./pull.js";

/** What can be done to a pull request after it is opened (merging comes with reviews). */
export const PULL_ACTIONS = [
  "edit",
  "retarget",
  "convert_to_draft",
  "ready_for_review",
  "close",
  "reopen",
] as const;
export type PullAction = (typeof PULL_ACTIONS)[number];

/** One row of the pull request mutation matrix. */
export interface PullActionRule {
  /** The author (anyone with the author's root identity) may do it to its own pull request. */
  readonly author: boolean;
  /** The role anyone else needs. */
  readonly minRole: RepoRole;
  /** The states it applies in. */
  readonly from: readonly PullState[];
  /** The state it leaves the pull request in, when it changes it. */
  readonly to?: PullState;
  /** The event it emits, as `pull_request.<event>`. */
  readonly event: string;
  /** The audit action it records. */
  readonly audit: string;
  /** Approvals given before it stop counting. */
  readonly staleApprovals: boolean;
  /** Whether the pull request can be merged must be worked out again. */
  readonly invalidatesMergeability: boolean;
  /** Starts a new generation: work begun for the earlier one does not apply. */
  readonly newGeneration: boolean;
}

/**
 * The mutation matrix (GitHub's roles): the author edits, retargets,
 * drafts, closes and reopens its own pull request with any role that reads
 * the repository; on anyone else's, triage closes and reopens, write does
 * the rest.
 */
export const PULL_ACTION_RULES: Readonly<Record<PullAction, PullActionRule>> = {
  edit: {
    author: true,
    minRole: "write",
    from: ["open", "closed", "merged"],
    event: "edited",
    audit: "pull_request.edit",
    staleApprovals: false,
    invalidatesMergeability: false,
    newGeneration: false,
  },
  retarget: {
    author: true,
    minRole: "write",
    from: ["open"],
    event: "edited",
    audit: "pull_request.retarget",
    staleApprovals: true,
    invalidatesMergeability: true,
    newGeneration: false,
  },
  convert_to_draft: {
    author: true,
    minRole: "write",
    from: ["open"],
    event: "converted_to_draft",
    audit: "pull_request.convert_to_draft",
    staleApprovals: false,
    invalidatesMergeability: false,
    newGeneration: false,
  },
  ready_for_review: {
    author: true,
    minRole: "write",
    from: ["open"],
    event: "ready_for_review",
    audit: "pull_request.ready_for_review",
    staleApprovals: false,
    invalidatesMergeability: false,
    newGeneration: false,
  },
  close: {
    author: true,
    minRole: "triage",
    from: ["open"],
    to: "closed",
    event: "closed",
    audit: "pull_request.close",
    staleApprovals: false,
    invalidatesMergeability: false,
    newGeneration: false,
  },
  reopen: {
    author: true,
    minRole: "triage",
    from: ["closed"],
    to: "open",
    event: "reopened",
    audit: "pull_request.reopen",
    staleApprovals: false,
    invalidatesMergeability: true,
    newGeneration: true,
  },
};

export type PullRefusal = "forbidden" | "wrong_state" | "head_ref_deleted";

/**
 * Whether a caller may take `action` now. `role` is the caller's role on
 * the repository, capped by any agents' owners; `isAuthor` compares root
 * identities, so a person's own agents act on its pull requests as it does,
 * but never with more than their own role.
 */
export function decidePullAction(
  action: PullAction,
  input: {
    readonly state: PullState;
    readonly headRefDeleted: boolean;
    readonly isAuthor: boolean;
    readonly role: RepoRole | null;
  },
): { ok: true } | { ok: false; refusal: PullRefusal } {
  const rule = PULL_ACTION_RULES[action];
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (!(rule.author && input.isAuthor) && !atLeast(input.role, rule.minRole))
    return { ok: false, refusal: "forbidden" };
  if (!rule.from.includes(input.state)) return { ok: false, refusal: "wrong_state" };
  if (action === "reopen" && input.headRefDeleted)
    return { ok: false, refusal: "head_ref_deleted" };
  return { ok: true };
}
