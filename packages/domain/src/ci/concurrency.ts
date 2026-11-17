/*
 * Concurrency groups, as GitHub Actions defines them: in a repository, at
 * most one job or workflow of a group runs; a newcomer waits as the single
 * pending owner and displaces the one waiting before it; with
 * `cancel-in-progress` the running owner is cancelled too.
 *
 * Fyrden adds what a distributed owner needs. Every request is answered
 * once and its receipt answers every repeat, so a retry never queues again.
 * A release is by owner identity, which names one attempt or one job
 * instance and never requests twice. An owner keeps the group while its
 * run's lease holds; one whose lease expired, or which was asked to cancel,
 * is evicted only after its release deadline, which is never before a lease
 * it was granted. The repository object stores the rows and applies these
 * functions in one transaction each.
 */

/** A group's name, in characters. Proposed: GitHub documents none. */
export const MAX_CONCURRENCY_GROUP_LENGTH = 400;

/** The registry's key for a group: "The concurrency group name is case insensitive" (GitHub). */
export function concurrencyGroupKey(group: string): string {
  return group.toLowerCase();
}

/** Who holds or wants a group: a run and one of its scopes (an attempt, or one job instance). */
export interface OwnerRef {
  readonly runId: string;
  /** `a<attempt>` for a workflow group, `a<attempt>/j<job id>` for a job group. */
  readonly ownerKey: string;
}

export interface GroupOwner {
  readonly ref: OwnerRef;
  /** Increases at every change of owner, across the repository. */
  readonly generation: number;
  /** The longest the owner said it may still need (its jobs' timeouts plus grace). */
  readonly holdMs: number;
  /** When it was asked to cancel (by cancel-in-progress or because its lease expired). */
  readonly cancelRequestedAt: number | null;
  /** Once asked to cancel: when it is evicted if it has not released. Never moves later. */
  readonly releaseDeadline: number | null;
}

export interface GroupState {
  /** The group as evaluated, folded (GitHub: "The concurrency group name is case insensitive"). */
  readonly key: string;
  /** The latest spelling. */
  readonly name: string;
  readonly owner: GroupOwner | null;
  readonly pending: {
    readonly ref: OwnerRef;
    readonly since: number;
    /** The hold it stated when it asked, its hold once promoted. */
    readonly holdMs: number;
  } | null;
}

export type ReceiptOutcome = "owner" | "pending" | "displaced" | "evicted" | "released";

/** The answer to one request, kept and repeated to every later ask. */
export interface Receipt {
  readonly outcome: ReceiptOutcome;
  /** The generation it owned with, once it did. */
  readonly generation: number | null;
}

export type SignalKind = "acquired" | "cancel" | "displaced" | "evicted";

/** A hint to the owner's run that its receipt changed; the run acts only through fenced calls. */
export interface Signal {
  readonly ref: OwnerRef;
  readonly kind: SignalKind;
  /** The generation concerned; 0 for a request that never owned. */
  readonly generation: number;
}

export interface ConcurrencyContext {
  readonly now: number;
  /** A lease's length (Proposed: 10 minutes). */
  readonly leaseMs: number;
  /** The next repository-wide generation. */
  nextGeneration(): number;
  /** When the run's lease, shared by all its scopes, expires; undefined if it has none. */
  leaseExpiry(runId: string): number | undefined;
}

/** What one operation changed: the group (null: delete its row), receipts and signals to write, leases to grant. */
export interface Outcome {
  readonly group: GroupState | null;
  readonly receipts: readonly { readonly ref: OwnerRef; readonly receipt: Receipt }[];
  readonly signals: readonly Signal[];
  /** Runs whose lease must reach at least `now + leaseMs`: a new owner gets a full lease. */
  readonly leaseGrants: readonly string[];
}

export interface AcquireOptions {
  readonly name: string;
  readonly cancelInProgress: boolean;
  readonly holdMs: number;
}

export function sameRef(a: OwnerRef, b: OwnerRef): boolean {
  return a.runId === b.runId && a.ownerKey === b.ownerKey;
}

const unchanged = (group: GroupState | null): Outcome => ({
  group,
  receipts: [],
  signals: [],
  leaseGrants: [],
});

/** The owner asked to cancel now: its deadline is its hold from now, and never before its granted lease. */
function cancelOwner(owner: GroupOwner, ctx: ConcurrencyContext, from = ctx.now): GroupOwner {
  if (owner.cancelRequestedAt !== null) return owner;
  const lease = ctx.leaseExpiry(owner.ref.runId) ?? ctx.now;
  return {
    ...owner,
    cancelRequestedAt: ctx.now,
    releaseDeadline: Math.max(from + owner.holdMs, lease),
  };
}

/** The group once its owner has gone: the pending owner promoted, or the group free (null). */
function promote(
  group: GroupState,
  ctx: ConcurrencyContext,
): {
  group: GroupState | null;
  receipts: Outcome["receipts"];
  signals: Signal[];
  grants: string[];
} {
  if (!group.pending) return { group: null, receipts: [], signals: [], grants: [] };
  const { ref, holdMs } = group.pending;
  const generation = ctx.nextGeneration();
  return {
    group: {
      ...group,
      owner: { ref, generation, holdMs, cancelRequestedAt: null, releaseDeadline: null },
      pending: null,
    },
    receipts: [{ ref, receipt: { outcome: "owner", generation } }],
    signals: [{ ref, kind: "acquired", generation }],
    grants: [ref.runId],
  };
}

/**
 * A request for the group by `ref`. A repeat (a receipt exists) is answered
 * with that receipt and changes nothing.
 */
export function acquire(
  group: GroupState | null,
  key: string,
  ref: OwnerRef,
  options: AcquireOptions,
  receipt: Receipt | undefined,
  ctx: ConcurrencyContext,
): Outcome & { readonly receipt: Receipt } {
  if (receipt) return { ...unchanged(group), receipt };
  if (!group?.owner) {
    const generation = ctx.nextGeneration();
    const owned: Receipt = { outcome: "owner", generation };
    return {
      group: {
        key,
        name: options.name,
        owner: {
          ref,
          generation,
          holdMs: options.holdMs,
          cancelRequestedAt: null,
          releaseDeadline: null,
        },
        pending: null,
      },
      receipts: [{ ref, receipt: owned }],
      signals: [],
      leaseGrants: [ref.runId],
      receipt: owned,
    };
  }
  const receipts: { ref: OwnerRef; receipt: Receipt }[] = [];
  const signals: Signal[] = [];
  if (group.pending) {
    const displaced = group.pending.ref;
    receipts.push({ ref: displaced, receipt: { outcome: "displaced", generation: null } });
    signals.push({ ref: displaced, kind: "displaced", generation: 0 });
  }
  let owner = group.owner;
  if (options.cancelInProgress && owner.cancelRequestedAt === null) {
    owner = cancelOwner(owner, ctx);
    signals.push({ ref: owner.ref, kind: "cancel", generation: owner.generation });
  }
  const waiting: Receipt = { outcome: "pending", generation: null };
  receipts.push({ ref, receipt: waiting });
  return {
    group: {
      ...group,
      name: options.name,
      owner,
      pending: { ref, since: ctx.now, holdMs: options.holdMs },
    },
    receipts,
    signals,
    leaseGrants: [],
    receipt: waiting,
  };
}

/**
 * `ref` gives the group up: the owner releases (its generation, when given,
 * must match) and the pending owner is promoted; a pending owner withdraws.
 * Anyone else changes nothing: a release from an older owner never frees the
 * group.
 */
export function release(
  group: GroupState | null,
  ref: OwnerRef,
  generation: number | undefined,
  ctx: ConcurrencyContext,
): Outcome {
  if (!group) return unchanged(group);
  const owner = group.owner;
  if (owner && sameRef(owner.ref, ref)) {
    if (generation !== undefined && generation !== owner.generation) return unchanged(group);
    const next = promote(group, ctx);
    return {
      group: next.group,
      receipts: [
        { ref, receipt: { outcome: "released", generation: owner.generation } },
        ...next.receipts,
      ],
      signals: next.signals,
      leaseGrants: next.grants,
    };
  }
  if (group.pending && sameRef(group.pending.ref, ref))
    return {
      group: { ...group, pending: null },
      receipts: [{ ref, receipt: { outcome: "released", generation: null } }],
      signals: [],
      leaseGrants: [],
    };
  return unchanged(group);
}

export type RenewAnswer =
  | { readonly ok: true; readonly grantedUntil: number; readonly cancelRequested: boolean }
  | { readonly ok: false };

/**
 * Whether `ref` still owns the group with `generation`, and until when its
 * grant runs: the run's lease (`runLease`, after the caller extended it), cut
 * at the release deadline once a cancel was requested, so renewals never
 * postpone an eviction.
 */
export function renewScope(
  group: GroupState | null,
  ref: OwnerRef,
  generation: number,
  runLease: number,
): RenewAnswer {
  const owner = group?.owner;
  if (!owner || !sameRef(owner.ref, ref) || owner.generation !== generation) return { ok: false };
  const grantedUntil =
    owner.releaseDeadline === null ? runLease : Math.min(runLease, owner.releaseDeadline);
  return { ok: true, grantedUntil, cancelRequested: owner.cancelRequestedAt !== null };
}

/** The owner's hold as it last stated it (a renew may restate it). */
export function withHold(group: GroupState, holdMs: number): GroupState {
  if (!group.owner || group.owner.cancelRequestedAt !== null) return group;
  return { ...group, owner: { ...group.owner, holdMs } };
}

/**
 * The group at `now`: an owner whose run's lease expired is asked to cancel
 * (deadline: the expiry plus its hold); one past its release deadline is
 * evicted and the pending owner promoted.
 */
export function settle(group: GroupState | null, ctx: ConcurrencyContext): Outcome {
  const owner = group?.owner;
  if (!group || !owner) return unchanged(group);
  if (owner.releaseDeadline !== null) {
    if (ctx.now < owner.releaseDeadline) return unchanged(group);
    const next = promote(group, ctx);
    return {
      group: next.group,
      receipts: [
        { ref: owner.ref, receipt: { outcome: "evicted", generation: owner.generation } },
        ...next.receipts,
      ],
      signals: [{ ref: owner.ref, kind: "evicted", generation: owner.generation }, ...next.signals],
      leaseGrants: next.grants,
    };
  }
  const lease = ctx.leaseExpiry(owner.ref.runId);
  if (lease !== undefined && ctx.now < lease) return unchanged(group);
  const cancelled = cancelOwner(owner, ctx, lease ?? ctx.now);
  return {
    group: { ...group, owner: cancelled },
    receipts: [],
    signals: [{ ref: owner.ref, kind: "cancel", generation: owner.generation }],
    leaseGrants: [],
  };
}

/** When `settle` next has something to do for this group, or undefined. */
export function nextSettleAt(
  group: GroupState,
  leaseExpiry: number | undefined,
): number | undefined {
  const owner = group.owner;
  if (!owner) return undefined;
  return owner.releaseDeadline ?? leaseExpiry;
}
