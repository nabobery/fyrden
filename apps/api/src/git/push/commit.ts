import type { LockHandle, RepoGitStorage, UploadRecord } from "@fyrden/adapters-cloudflare/git";
import type { PackId, PushCommitRequest, PushCommitResult, RefUpdate } from "@fyrden/git-core";
import { anyLeased, type TailMerge, type TailMergeOutcome } from "../maintenance/tail-merge.js";

/** The Worker's re-authorization of the pusher, made just before it asks for the commit. */
export interface PushDecision {
  /** Why the pusher may no longer push; absent when they may. */
  readonly refusal?: string;
  /** The token the decision is about; must be the upload's. */
  readonly tokenId: string;
  /** When the Worker made the decision (ms since the epoch). */
  readonly decidedAt: number;
  /** The agents acting for the pusher, from the token checked (a delegated token's act chain). */
  readonly actChain?: readonly string[];
  /** The request committing the push, for its audit row. */
  readonly requestId?: string | null;
}

/**
 * How old a decision may be at the commit transaction. Proposed 60 s: the
 * commit follows the decision within one Durable Object call (plus lock
 * wait), so an older one means the call was stuck and the pusher must be
 * checked again.
 */
export const DECISION_MAX_AGE_MS = 60_000;

/** One committed ref transaction, collected by the commit hook for the push event. */
export interface CommittedTransaction {
  readonly version: number;
  readonly updates: readonly RefUpdate[];
}

/** Why a push is refused when the repository is at its pack-count cap and cannot make room now. */
export const PACK_CAP_REFUSAL =
  "the repository has too many packs to take this push now; they are being compacted, try the push again later";

/** Why a push is refused when the merge the cap needs failed. */
export const PACK_CAP_FAILED =
  "the server could not compact the repository's packs; try the push again later";

/** Why a commit that would supersede a pack a reader just leased is refused. */
export const PACKS_IN_USE =
  "the repository's packs are in use and cannot be compacted now; try the push again later";

/**
 * The pack-count cap, as the committer sees it: `prepare` returns the merge
 * the upload's commit needs. It runs once per push, on the first commit
 * that would make the upload live.
 */
export interface PushCapGate {
  prepare(): Promise<TailMergeOutcome>;
  /** The cap cannot be met now: schedule background compaction. */
  onOverBudget(reason: "budget" | "leased"): void;
  /** The merge failed (the push is refused, retryable). */
  onError(error: unknown): void;
}

type GateOutcome = TailMergeOutcome | { readonly kind: "failed" };

/** Tries before giving up when unrelated commits keep moving the ref-state version. */
const MAX_VERSION_RETRIES = 8;

/** How long the commit lock is extended after a tail merge. Proposed, as the lock's own TTL. */
const LOCK_RENEW_MS = 30_000;

/**
 * The commit point of one push transaction: `commitSync` with the upload
 * (when this transaction makes it live), the pusher as the reflog actor,
 * the fast-forward proof, and the in-transaction hooks. `authorize` checks,
 * inside the transaction, that the Worker's decision is for this upload's
 * token and fresh, and that this push still holds the commit lock.
 * `onCommitted` records the transaction for the push's log line; the
 * repository's own commit hook writes its events and audit row.
 *
 * With a `cap` gate, the transaction that makes the upload live first gets
 * the merge the pack-count cap needs. That transaction then also swaps in
 * the compacted pack: it goes live and the packs it replaces are
 * superseded (with the upload's own unit when that was merged too). A
 * replaced pack that gained a lease since the merge was chosen refuses the
 * commit, since a pack in use is never superseded. When the cap cannot be
 * met, the transaction is not attempted and the push fails with a
 * retryable message, refs unchanged.
 */
export function pushCommitter(
  git: RepoGitStorage,
  upload: UploadRecord,
  decision: PushDecision,
  lock: LockHandle,
  committed: CommittedTransaction[],
  cap?: PushCapGate,
  /** A last refusal checked in the transaction (the rulesets are still the ones checked). */
  fence?: () => string | undefined,
  /** Runs in the transaction that commits the upload, after its refs. */
  inCommit?: () => void,
): (request: PushCommitRequest) => Promise<PushCommitResult> {
  const authorize = ({ now }: { now: number }, removing: readonly PackId[]): string | undefined => {
    if (!git.locks.isHeld(lock)) return "the push lost its turn to commit; try the push again";
    const fenced = fence?.();
    if (fenced) return fenced;
    if (anyLeased(git, removing)) return PACKS_IN_USE;
    if (upload.tokenId !== decision.tokenId) return "the push was authorized for another token";
    if (now - decision.decidedAt > DECISION_MAX_AGE_MS)
      return "the push's authorization is too old; try the push again";
    return undefined;
  };
  let gate: Promise<GateOutcome> | undefined;
  const prepare = async (gated: PushCapGate): Promise<GateOutcome> => {
    let outcome: GateOutcome;
    try {
      outcome = await gated.prepare();
    } catch (error) {
      gated.onError(error);
      return { kind: "failed" };
    }
    // The merge's I/O ran under the commit lock: give the commit its full time.
    if (outcome.kind === "merged") git.locks.renew(lock, LOCK_RENEW_MS);
    if (outcome.kind === "over-budget") gated.onOverBudget(outcome.reason);
    return outcome;
  };
  return async (request) => {
    let swap: TailMerge | undefined;
    if (request.withUpload && cap && request.packs.length > 0) {
      gate ??= prepare(cap);
      const outcome = await gate;
      if (outcome.kind === "over-budget")
        return { ok: false, reason: "failed", message: PACK_CAP_REFUSAL };
      if (outcome.kind === "failed")
        return { ok: false, reason: "failed", message: PACK_CAP_FAILED };
      if (outcome.kind === "merged") swap = outcome.merge;
    }
    const removePacks = swap ? [...swap.removePacks] : [];
    for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
      const result = git.refStore.commitSync({
        addPacks: swap ? [swap.packId] : [],
        removePacks,
        ...(swap?.withIncoming ? { uploadUnitMergedInto: swap.packId } : {}),
        refUpdates: request.updates,
        expectedVersion: git.refStore.state().version,
        ...(request.withUpload ? { uploadId: request.uploadId } : {}),
        actor: {
          principal: upload.principal,
          grantId: upload.grantId,
          tokenId: upload.tokenId,
          actChain: decision.actChain ?? [],
          requestId: decision.requestId ?? null,
          via: "push",
        },
        fastForward: request.fastForward,
        authorize: (context) => authorize(context, removePacks),
        onCommitted: (context) => {
          committed.push({ version: context.version, updates: request.updates });
          if (request.withUpload) inCommit?.();
        },
      });
      if (result.ok) return { ok: true };
      switch (result.reason) {
        case "version-conflict":
          continue;
        case "ref-conflict":
          return { ok: false, reason: "ref-conflict", ref: result.ref };
        case "refname-conflict":
          return {
            ok: false,
            reason: "refname-conflict",
            ref: result.ref,
            conflictsWith: result.conflictsWith,
          };
        case "refused":
          return { ok: false, reason: "refused", message: result.message };
        case "dependency-gone":
          return {
            ok: false,
            reason: "failed",
            message: "objects this push builds on were removed meanwhile; try the push again",
          };
        case "unknown-pack":
          if (swap)
            return {
              ok: false,
              reason: "failed",
              message:
                "the repository's packs changed while this push committed; try the push again",
            };
          return { ok: false, reason: "failed", message: "the push could not be committed" };
        default:
          return { ok: false, reason: "failed", message: "the push could not be committed" };
      }
    }
    return { ok: false, reason: "failed", message: "the repository is busy; try the push again" };
  };
}
