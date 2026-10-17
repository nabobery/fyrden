import { atLeast, type RepoRole } from "../authz/roles.js";
import type { PullState } from "./pull.js";

/** What can be done to a pull request after it is opened. */
export const PULL_ACTIONS = [
  "edit",
  "retarget",
  "convert_to_draft",
  "ready_for_review",
  "close",
  "reopen",
  "merge",
  "set_maintainer_edits",
] as const;
export type PullAction = (typeof PULL_ACTIONS)[number];

/** One row of the pull request mutation matrix. */
export interface PullActionRule {
  /** The author (anyone with the author's root identity) may do it to its own pull request. */
  readonly author: boolean;
  /** The role anyone else needs; null when only the author may. */
  readonly minRole: RepoRole | null;
  /** The states it applies in. */
  readonly from: readonly PullState[];
  /** The state it leaves the pull request in, when it changes it. */
  readonly to?: PullState;
  /** The event it emits, as `pull_request.<event>`. */
  readonly event: string;
  /** The audit action it records. */
  readonly audit: string;
}

/**
 * The mutation matrix (GitHub's roles): the author edits, retargets,
 * drafts, closes and reopens its own pull request with any role that reads
 * the repository; on anyone else's, triage closes and reopens, write does
 * the rest. Merging takes write, the author's own included; a merge emits
 * `closed` (with `merged` set), as GitHub's does.
 */
export const PULL_ACTION_RULES: Readonly<Record<PullAction, PullActionRule>> = {
  edit: {
    author: true,
    minRole: "write",
    from: ["open", "closed", "merged"],
    event: "edited",
    audit: "pull_request.edit",
  },
  retarget: {
    author: true,
    minRole: "write",
    from: ["open"],
    event: "edited",
    audit: "pull_request.retarget",
  },
  convert_to_draft: {
    author: true,
    minRole: "write",
    from: ["open"],
    event: "converted_to_draft",
    audit: "pull_request.convert_to_draft",
  },
  ready_for_review: {
    author: true,
    minRole: "write",
    from: ["open"],
    event: "ready_for_review",
    audit: "pull_request.ready_for_review",
  },
  close: {
    author: true,
    minRole: "triage",
    from: ["open"],
    to: "closed",
    event: "closed",
    audit: "pull_request.close",
  },
  reopen: {
    author: true,
    minRole: "triage",
    from: ["closed"],
    to: "open",
    event: "reopened",
    audit: "pull_request.reopen",
  },
  merge: {
    author: false,
    minRole: "write",
    from: ["open"],
    to: "merged",
    event: "closed",
    audit: "pull_request.merge",
  },
  // Whether the base's maintainers may write the head branch (in another repository): the
  // author's to give or take back, as GitHub's.
  set_maintainer_edits: {
    author: true,
    minRole: null,
    from: ["open", "closed"],
    event: "edited",
    audit: "pull_request.maintainer_edits",
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
  if (
    !(rule.author && input.isAuthor) &&
    (rule.minRole === null || !atLeast(input.role, rule.minRole))
  )
    return { ok: false, refusal: "forbidden" };
  if (!rule.from.includes(input.state)) return { ok: false, refusal: "wrong_state" };
  if (action === "reopen" && input.headRefDeleted)
    return { ok: false, refusal: "head_ref_deleted" };
  return { ok: true };
}
