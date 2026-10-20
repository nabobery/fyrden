import { atLeast, type RepoRole } from "../authz/roles.js";
import type { IssueState, IssueStateReason } from "./issue.js";

/** What can be done to an issue after it is opened. */
export const ISSUE_ACTIONS = [
  "edit",
  "close",
  "reopen",
  "mark_duplicate",
  "lock",
  "unlock",
  "delete",
] as const;
export type IssueAction = (typeof ISSUE_ACTIONS)[number];

/** One row of the issue mutation matrix. */
export interface IssueActionRule {
  /** The author (anyone with the author's root identity) may do it to its own issue. */
  readonly author: boolean;
  /** The role anyone else needs. */
  readonly minRole: RepoRole;
  /** The states it applies in. */
  readonly from: readonly IssueState[];
  /** The audit action it records. */
  readonly audit: string;
}

/**
 * The mutation matrix (GitHub's roles): the author edits, closes and
 * reopens its own issue with any role that reads the repository; on anyone
 * else's, triage closes, reopens and marks duplicates (the author too needs
 * triage to mark one), write edits and locks, admin deletes. Opening one
 * takes only read (and the `issues:write` permission).
 */
export const ISSUE_ACTION_RULES: Readonly<Record<IssueAction, IssueActionRule>> = {
  edit: { author: true, minRole: "write", from: ["open", "closed"], audit: "issue.edit" },
  close: { author: true, minRole: "triage", from: ["open"], audit: "issue.close" },
  reopen: { author: true, minRole: "triage", from: ["closed"], audit: "issue.reopen" },
  mark_duplicate: {
    author: false,
    minRole: "triage",
    from: ["open", "closed"],
    audit: "issue.mark_duplicate",
  },
  lock: { author: false, minRole: "write", from: ["open", "closed"], audit: "issue.lock" },
  unlock: { author: false, minRole: "write", from: ["open", "closed"], audit: "issue.unlock" },
  delete: { author: false, minRole: "admin", from: ["open", "closed"], audit: "issue.delete" },
};

export type IssueRefusal = "forbidden" | "wrong_state";

/**
 * Whether a caller may take `action` now. `role` is the caller's role on
 * the repository, capped by any agents' owners; `isAuthor` compares root
 * identities, as for pull requests.
 */
export function decideIssueAction(
  action: IssueAction,
  input: { readonly state: IssueState; readonly isAuthor: boolean; readonly role: RepoRole | null },
): { ok: true } | { ok: false; refusal: IssueRefusal } {
  const rule = ISSUE_ACTION_RULES[action];
  if (!atLeast(input.role, "read")) return { ok: false, refusal: "forbidden" };
  if (!(rule.author && input.isAuthor) && !atLeast(input.role, rule.minRole))
    return { ok: false, refusal: "forbidden" };
  if (!rule.from.includes(input.state)) return { ok: false, refusal: "wrong_state" };
  return { ok: true };
}

/** An issue's state and what its closing recorded. */
export interface IssueStateFields {
  readonly state: IssueState;
  readonly stateReason: IssueStateReason | null;
  readonly duplicateOf: number | null;
  readonly closedAt: number | null;
  readonly closedBy: string | null;
}

/** A change of state asked of an issue; a field left out stays as it is. */
export interface IssueStatePatch {
  readonly state?: IssueState;
  readonly stateReason?: IssueStateReason;
  readonly duplicateOf?: number;
}

export type IssueStateRefusal =
  /** A reason that does not go with the state asked for (`reopened` to close, a close reason to open). */
  | "reason_not_for_state"
  /** Closing as a duplicate names no issue or pull request. */
  | "duplicate_target_required"
  | "duplicate_of_itself"
  /** A duplicate target given with another reason. */
  | "duplicate_target_without_reason";

export type IssueStatePlan =
  | {
      readonly ok: true;
      /** The action to authorize; null when nothing changes. */
      readonly action: "close" | "reopen" | "mark_duplicate" | null;
      /** The event the change emits, as `issue.<event>`; null when nothing changes. */
      readonly event: "closed" | "reopened" | "edited" | null;
      readonly next: IssueStateFields;
    }
  | { readonly ok: false; readonly refusal: IssueStateRefusal };

const CLOSE_REASONS: ReadonlySet<IssueStateReason> = new Set([
  "completed",
  "not_planned",
  "duplicate",
]);

/**
 * What a change of state asks of issue `at.number`, normalized so the
 * result holds the invariants: a duplicate target exactly when closed as a
 * duplicate (never the issue itself); `reopened` or no reason while open,
 * with no close recorded; a close reason, its time and who closed while
 * closed. Closing sets `closedAt` and `closedBy`; reopening clears them. As
 * GitHub, a reason alone changes nothing, except moving a closed issue to
 * or from `duplicate` (which takes triage, as marking one does).
 */
export function planIssueState(
  current: IssueStateFields,
  patch: IssueStatePatch,
  at: { readonly number: number; readonly actor: string; readonly now: number },
): IssueStatePlan {
  const target = patch.state ?? current.state;
  const reason = patch.stateReason;
  if (patch.state !== undefined && reason !== undefined) {
    const fits = target === "closed" ? CLOSE_REASONS.has(reason) : reason === "reopened";
    if (!fits) return { ok: false, refusal: "reason_not_for_state" };
  }
  const unchanged: IssueStatePlan = { ok: true, action: null, event: null, next: current };
  const duplicateTarget = (fallback: number | null) => {
    const dup = patch.duplicateOf ?? fallback;
    if (dup === null) return { ok: false as const, refusal: "duplicate_target_required" as const };
    if (dup === at.number) return { ok: false as const, refusal: "duplicate_of_itself" as const };
    return { ok: true as const, dup };
  };

  if (current.state === "open" && target === "closed") {
    const closeReason = reason ?? "completed";
    if (closeReason !== "duplicate" && patch.duplicateOf !== undefined)
      return { ok: false, refusal: "duplicate_target_without_reason" };
    const closing = { state: "closed", closedAt: at.now, closedBy: at.actor } as const;
    if (closeReason !== "duplicate")
      return {
        ok: true,
        action: "close",
        event: "closed",
        next: { ...closing, stateReason: closeReason, duplicateOf: null },
      };
    const dup = duplicateTarget(null);
    if (!dup.ok) return dup;
    return {
      ok: true,
      action: "mark_duplicate",
      event: "closed",
      next: { ...closing, stateReason: "duplicate", duplicateOf: dup.dup },
    };
  }

  if (current.state === "closed" && target === "open") {
    if (patch.duplicateOf !== undefined)
      return { ok: false, refusal: "duplicate_target_without_reason" };
    return {
      ok: true,
      action: "reopen",
      event: "reopened",
      next: {
        state: "open",
        stateReason: "reopened",
        duplicateOf: null,
        closedAt: null,
        closedBy: null,
      },
    };
  }

  if (current.state === "open") {
    if (patch.duplicateOf !== undefined)
      return { ok: false, refusal: "duplicate_target_without_reason" };
    return unchanged;
  }

  // Closed and staying closed: only moving to, between or from duplicates changes anything.
  const wasDuplicate = current.stateReason === "duplicate";
  const nextReason =
    reason !== undefined && CLOSE_REASONS.has(reason) ? reason : current.stateReason;
  if (nextReason === "duplicate") {
    const dup = duplicateTarget(current.duplicateOf);
    if (!dup.ok) return dup;
    if (wasDuplicate && dup.dup === current.duplicateOf) return unchanged;
    return {
      ok: true,
      action: "mark_duplicate",
      event: "edited",
      next: { ...current, stateReason: "duplicate", duplicateOf: dup.dup },
    };
  }
  if (patch.duplicateOf !== undefined)
    return { ok: false, refusal: "duplicate_target_without_reason" };
  if (!wasDuplicate) return unchanged;
  return {
    ok: true,
    action: "mark_duplicate",
    event: "edited",
    next: { ...current, stateReason: nextReason, duplicateOf: null },
  };
}
