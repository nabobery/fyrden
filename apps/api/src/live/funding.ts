import { feedEpochSource } from "../do/user/feed.js";
import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../effects/discretionary.js";
import { clock } from "../services.js";
import {
  isLiveVector,
  LIVE_NOW,
  type LiveDayCharge,
  type LiveEnvelope,
  type LiveGrantPlan,
  type LiveGrantRequest,
  type LiveRecipientType,
  type LiveUnit,
  livePlanError,
  reserveLive,
  validateLiveCoverage,
} from "./budget.js";
import { LIVE_PENDING_MS, reserveDuration } from "./duration.js";
import type { LiveManifestEntry, LiveValidity } from "./manifest.js";
import {
  admitLiveOwners,
  LIVE_OWNER_LIMITS,
  type LiveOwnerLimits,
  markLiveOwnerDispatched,
  observeLiveOwner,
  releaseLiveOwner,
  settleLiveOwnerPage,
} from "./owners.js";

/*
 * Live work funded before it runs: the Worker (or an object calling
 * another) builds the work's plan from its manifest entry, grants it from
 * the ledger, then hands its recipient a funding: the grant's envelope, the
 * manifest revision it was priced by, the quantity it covers and the owner
 * admitted for its duration. The recipient checks the funding is for
 * itself, this kind and class, by the manifest it knows, within the
 * entry's validity, paying the entry's price on every day the work may run
 * (another day's charge pays nothing of today's) and its cleanup, with
 * that owner, before it does anything else (a cheap shape check first,
 * then the ledger's coverage in one statement): an internally made one-row
 * grant never pays for a pump. A refusal the caller can act on is a daily
 * one (until the next UTC day, by D1's clock) or a temporary one; an
 * invalid, expired or fenced grant says nothing of the day's allowance, so
 * is temporary too.
 */

const R = DISCRETIONARY_RESOURCES;
const DAY = 86_400_000;

/**
 * The manifest live work is priced by: a funding of another revision is
 * refused. Raised whenever its prices change (2: marks, tickets and the pump
 * measured again, prunes bounded), so a funding in flight across a deploy
 * never pays old prices for new work.
 */
export const LIVE_MANIFEST_REVISION = 2;

export type FundedResult<T> =
  | {
      readonly status: "funded";
      readonly value: T;
      /** An owned run's owner observed, settled and released (false: left for recovery). */
      readonly accounted?: boolean;
    }
  | { readonly status: "refused"; readonly reason: "daily"; readonly retryAt: number }
  | { readonly status: "refused"; readonly reason: "temporary" };

/** What a recipient is handed with funded work. */
export interface LiveFunding {
  readonly protocol: 1;
  readonly revision: number;
  readonly envelope: LiveEnvelope;
  /** The units of its kind it covers (32 controls of a block, say), at most its entry's. */
  readonly quantity: number;
  /** The owner admitted for its duration, or null for a synchronous unit. */
  readonly ownerId: string | null;
}

/** What a recipient expects of funding: its manifest entry's, for this recipient, kind and class. */
export interface LiveFundingExpectation {
  readonly recipientType: LiveRecipientType;
  readonly recipient: string;
  readonly kind: LiveUnit;
  readonly class: "ordinary" | "cleanup";
  /** One admission's price (its entry's, its whole quantity included), on each day it may run. */
  readonly price: ResourceVector;
  readonly maxQuantity: number;
  /** An owner's duration (held, named) or a synchronous entry's (its allowance in the price). */
  readonly owned: boolean;
  readonly validity: LiveValidity;
  readonly directoryCleanupDebt: ResourceVector;
  readonly localCleanupDebt: ResourceVector;
  readonly dayCleanupDebt: ResourceVector;
  /** An owned unit's tail past its pending bound: its holds must cover any run of both. */
  readonly tailMs: number;
  /** An owned unit's pending bound (its caller waits no longer). */
  readonly pendingMs: number;
}

/** The expectation of funding priced by `entry` (an owned unit's runs lasting its pending bound and `tailMs`). */
export function expectationOf(
  entry: LiveManifestEntry,
  target: Pick<LiveFundingExpectation, "recipientType" | "recipient" | "kind" | "class">,
  tailMs = 0,
): LiveFundingExpectation {
  return {
    ...target,
    tailMs,
    pendingMs: entry.pendingMs ?? LIVE_PENDING_MS,
    price: entry.resources,
    maxQuantity: entry.maxQuantity,
    owned: entry.duration === "owner",
    validity: entry.validity,
    directoryCleanupDebt: entry.directoryCleanupDebt,
    localCleanupDebt: entry.localCleanupDebt,
    dayCleanupDebt: entry.dayCleanupDebt,
  };
}

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** The UTC days work valid over `[from, until)` may run on. */
const runDays = (from: number, until: number) => {
  const days: number[] = [];
  for (let day = Math.floor(from / DAY); day <= Math.floor((until - 1) / DAY); day++)
    days.push(day);
  return days;
};

const covers = (paid: ResourceVector, owed: ResourceVector, except?: (typeof R)[number]) =>
  R.every((r) => r === except || paid[r] >= owed[r]);

/**
 * Why `funding` cannot be what `expected` describes, decided from its
 * shape alone (no database read), or null.
 */
export function fundingShapeError(
  funding: unknown,
  expected: LiveFundingExpectation,
): string | null {
  if (typeof funding !== "object" || funding === null) return "not a funding";
  const f = funding as Partial<LiveFunding>;
  if (f.protocol !== 1) return "an unknown protocol";
  if (f.revision !== LIVE_MANIFEST_REVISION) return "another manifest's prices";
  const envelope = f.envelope;
  if (typeof envelope !== "object" || envelope === null || envelope.protocol !== 1)
    return "not an envelope";
  if (
    typeof envelope.operationId !== "string" ||
    envelope.operationId.length < 1 ||
    envelope.operationId.length > 300 ||
    !isCount(envelope.seq) ||
    envelope.seq < 1 ||
    !isCount(envelope.ledgerAt)
  )
    return "not an envelope";
  if (livePlanError(envelope.plan) !== null) return "not a plan";
  const { plan } = envelope;
  if (plan.recipientType !== expected.recipientType || plan.recipient !== expected.recipient)
    return "another recipient's";
  if (plan.kind !== expected.kind) return "another kind's";
  if (plan.class !== expected.class) return "another class's";
  const quantity = f.quantity;
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1)
    return "its quantity is not a count";
  if ((quantity as number) > expected.maxQuantity) return "more than a unit covers";
  if (expected.owned ? typeof f.ownerId !== "string" || f.ownerId === "" : f.ownerId !== null)
    return expected.owned ? "no owner named" : "an owner named for a synchronous unit";
  if (!isLiveVector(expected.price)) return "an expectation without a price";
  const days = runDays(plan.validFrom, plan.validUntil);
  if (
    plan.validUntil - plan.validFrom > expected.validity.maxMs ||
    days.length > expected.validity.days
  )
    return "valid longer than its unit";
  for (const [name, debt] of [
    ["directoryCleanupDebt", plan.directoryCleanupDebt],
    ["localCleanupDebt", plan.localCleanupDebt],
    ["dayCleanupDebt", plan.dayCleanupDebt],
  ] as const)
    if (!covers(debt, expected[name])) return `less ${name} than its unit leaves`;
  // Local cleanup it leaves is retired by its feed's recovery: only a plan that registers one.
  if (R.some((r) => plan.localCleanupDebt[r] > 0) && !plan.producesLocal)
    return "local cleanup without its recovery";
  // An owned unit's holds: what any run starting while it is valid, lasting its pending bound and
  // tail, may overlap each day (a run may go on past midnight into a day it cannot start on).
  if (!Number.isSafeInteger(expected.tailMs) || expected.tailMs < 0)
    return "an expectation without a tail";
  const holds = expected.owned
    ? reserveDuration(plan.validFrom, plan.validUntil, expected.pendingMs, expected.tailMs)
    : [];
  // Every day it may touch pays the whole price itself: another day's charge pays nothing of it.
  for (const day of [...new Set([...days, ...holds.map((h) => h.day)])]) {
    const charge = plan.charges.find((c) => c.day === day);
    if (!charge) return `nothing charged to day ${day} it may run on`;
    for (const r of R)
      if (r !== "do_duration_ms" && charge.resources[r] < expected.price[r])
        return `less ${r} than its price on day ${day}`;
    const need = holds.find((h) => h.day === day);
    if (need) {
      const held = charge.duration;
      if (!held || held.ms < need.ms || held.from > need.from || held.until < need.until)
        return `less duration held on day ${day} than its runs may take`;
    } else if (!expected.owned && charge.resources.do_duration_ms < expected.price.do_duration_ms)
      return `less do_duration_ms than its price on day ${day}`;
  }
  return null;
}

/**
 * Whether `envelope`'s grant pays for one run of `entry`'s unit at today's
 * prices for `target` (its shape alone): a grant made before a price rose
 * (a deploy since) does not, and pays for nothing of it.
 */
export function paysToday(
  envelope: LiveEnvelope,
  entry: LiveManifestEntry,
  target: Pick<LiveFundingExpectation, "recipientType" | "recipient" | "kind" | "class">,
): boolean {
  const funding: LiveFunding = {
    protocol: 1,
    revision: LIVE_MANIFEST_REVISION,
    envelope,
    quantity: 1,
    ownerId: entry.duration === "owner" ? "owner" : null,
  };
  return fundingShapeError(funding, expectationOf(entry, target)) === null;
}

/**
 * Whether `funding` pays for what `expected` describes: its shape, then
 * the ledger's coverage of its grant (with its owner, when owned).
 */
export async function validateFunding(
  db: D1Database,
  funding: unknown,
  expected: LiveFundingExpectation,
): Promise<
  | { readonly status: "valid"; readonly funding: LiveFunding; readonly ledgerAt: number }
  | { readonly status: "refused"; readonly reason: string }
> {
  const shape = fundingShapeError(funding, expected);
  if (shape) return { status: "refused", reason: shape };
  const f = funding as LiveFunding;
  const coverage = await validateLiveCoverage(db, f.envelope, {
    recipientType: expected.recipientType,
    recipient: expected.recipient,
    kind: expected.kind,
    ...(f.ownerId !== null && { ownerId: f.ownerId }),
  });
  if (coverage.status !== "valid") return { status: "refused", reason: coverage.reason };
  return { status: "valid", funding: f, ledgerAt: coverage.ledgerAt };
}

/**
 * The plan of one admission of `entry`'s unit for `target`, valid from
 * `from` for the entry's validity: its price charged to every day it may
 * run on or into, an owned unit's duration held for any run starting while
 * it is valid (its pending bound and `tailMs`), its cleanup debts (local
 * ones only with a recovery registered: `producesLocal`).
 */
export function planFor(
  entry: LiveManifestEntry,
  target: Pick<
    LiveGrantPlan,
    "incarnation" | "recipientType" | "recipient" | "epoch" | "kind" | "class" | "producesLocal"
  >,
  from: number,
  tailMs = 0,
): LiveGrantPlan {
  const until = from + entry.validity.maxMs;
  const days = runDays(from, until);
  if (days.length > entry.validity.days) throw new RangeError("valid over more days than its unit");
  if (!Number.isSafeInteger(tailMs) || tailMs < 0) throw new RangeError("a tail is a count");
  if (R.some((r) => entry.localCleanupDebt[r] > 0) && !target.producesLocal)
    throw new RangeError("local cleanup without its recovery");
  const holds =
    entry.duration === "owner"
      ? reserveDuration(from, until, entry.pendingMs ?? LIVE_PENDING_MS, tailMs)
      : [];
  const charges: LiveDayCharge[] = [...new Set([...days, ...holds.map((h) => h.day)])]
    .sort((a, b) => a - b)
    .map((day) => {
      const runs = days.includes(day);
      // An owner's hold (settled by what it ran), or a synchronous entry's allowance debited
      // outright on each day it may run (never refunded, so never held in escrow).
      const hold = entry.duration === "owner" ? (holds.find((h) => h.day === day) ?? null) : null;
      const duration =
        entry.duration === "owner" ? (hold?.ms ?? 0) : runs ? entry.resources.do_duration_ms : 0;
      // A day it can only run into (past a midnight) pays the whole price too: its calls may land there.
      const resources = Object.fromEntries(
        R.map((r) => [r, r === "do_duration_ms" ? duration : entry.resources[r]]),
      ) as ResourceVector;
      return { day, resources, duration: hold };
    });
  return {
    protocol: 1,
    ...target,
    validFrom: from,
    validUntil: until,
    charges,
    directoryCleanupDebt: entry.directoryCleanupDebt,
    localCleanupDebt: entry.localCleanupDebt,
    dayCleanupDebt: entry.dayCleanupDebt,
  };
}

/**
 * Grants `request` from the ledger: its envelope, or why not as a caller
 * acts on it (a daily refusal until the next UTC day by D1's clock, else
 * temporary).
 */
export async function fund(
  db: D1Database,
  request: LiveGrantRequest,
): Promise<FundedResult<LiveEnvelope>> {
  const result = await reserveLive(db, request);
  if (result.status === "granted") return { status: "funded", value: result.grant };
  if (result.reason === "daily" && result.retryAt !== undefined)
    return { status: "refused", reason: "daily", retryAt: result.retryAt };
  return { status: "refused", reason: "temporary" };
}

/**
 * The ledger's time (D1's) as sampled, and this Worker's clock once it was
 * read: a run is timed from both. D1's time is whole seconds and reached
 * this Worker some time after it was taken, so at `at` the ledger's time
 * was `now` or up to `slack` past it.
 */
export interface LedgerClock {
  readonly now: number;
  readonly at: number;
  readonly slack: number;
}

/**
 * What a plan for `recipient` needs of the ledger now: its incarnation, the
 * feed's epoch, D1's time (the ledger's clock, which a plan's validity is
 * judged by: it starts there, never ahead of it) with when it was read, and
 * the tickets issued to `recipient` today (D1's day) with the next day's
 * start.
 */
export async function liveTarget(
  db: D1Database,
  recipient: string,
): Promise<{
  readonly incarnation: string;
  readonly epoch: number;
  readonly ledger: LedgerClock;
  readonly ticketsToday: number;
  readonly tomorrow: number;
  /**
   * Whether the feed holds a turn's grant still to run: unsettled, its
   * owner never released (a turn that ran released it), valid five minutes on.
   */
  readonly turnHeld: boolean;
  /** Whether the feed holds a block of controls (of marks) still valid half an hour on. */
  readonly controlsHeld: boolean;
  readonly marksHeld: boolean;
}> {
  const day = `CAST(${LIVE_NOW} / ${DAY} AS INTEGER)`;
  const sent = clock();
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT (SELECT incarnation FROM live_budget_state WHERE id = 1) AS incarnation,
         coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ?1), 0) AS epoch,
         ${LIVE_NOW} AS now,
         coalesce((SELECT issued FROM live_ticket_days WHERE principal_id = ?2 AND day = ${day}), 0)
           AS tickets,
         (${day} + 1) * ${DAY} AS tomorrow,
         EXISTS (SELECT 1 FROM live_budget_receipts INDEXED BY live_budget_receipts_recipient
           WHERE recipient = ?2 AND kind = 'pump' AND settled_at IS NULL
             AND valid_until > ${LIVE_NOW} + 300000
             AND json_array_length(released_owners) = 0
             AND incarnation = (SELECT incarnation FROM live_budget_state WHERE id = 1)
             AND epoch = coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ?1), 0))
           AS turn_held,
         ${["control", "mark"]
           .map(
             (kind) => `EXISTS (SELECT 1 FROM live_budget_receipts
               INDEXED BY live_budget_receipts_recipient
               WHERE recipient = ?2 AND kind = '${kind}' AND settled_at IS NULL
                 AND valid_until > ${LIVE_NOW} + 1800000
                 AND incarnation = (SELECT incarnation FROM live_budget_state WHERE id = 1)
                 AND epoch = coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ?1), 0))
               AS ${kind}s_held`,
           )
           .join(",\n")}`,
    )
    .bind(feedEpochSource(recipient), recipient)
    .first<{
      incarnation: string;
      epoch: number;
      now: number;
      tickets: number;
      tomorrow: number;
      turn_held: number;
      controls_held: number;
      marks_held: number;
    }>();
  if (!row?.incarnation) throw new Error("the live ledger has no incarnation");
  const at = clock();
  return {
    incarnation: row.incarnation,
    epoch: row.epoch,
    // Its second's remainder and the time the answer took: what the ledger's time may be past.
    ledger: { now: row.now, at, slack: 1_000 + Math.max(0, at - sent) },
    ticketsToday: row.tickets,
    tomorrow: row.tomorrow,
    turnHeld: row.turn_held === 1,
    controlsHeld: row.controls_held === 1,
    marksHeld: row.marks_held === 1,
  };
}

/**
 * Runs `call` as owned live work: `request` granted, then run as
 * `ownedRun` runs a grant.
 */
export async function ownedCall<T>(
  db: D1Database,
  request: LiveGrantRequest,
  role: string,
  call: (funding: LiveFunding, signal: AbortSignal) => Promise<T>,
  options: OwnedRunOptions = {},
): Promise<FundedResult<T>> {
  const granted = await fund(db, request);
  if (granted.status !== "funded") return granted;
  return ownedRun(db, granted.value, role, call, options);
}

export interface OwnedRunOptions {
  /** How long the call is waited for at most (its unit's pending bound): then given up on. */
  readonly pendingMs?: number;
  readonly limits?: LiveOwnerLimits;
  readonly quantity?: number;
  /** The ledger's clock as sampled: the owner's run is timed on it (its grant's own clock). */
  readonly ledger?: LedgerClock;
  /**
   * Told the call's own end (which may come after it was given up on): what
   * its caller holds for it is held until then.
   */
  readonly physical?: (ended: Promise<void>) => void;
}

/**
 * Runs `call` as owned live work paid for by `envelope`: its owner admitted
 * and recorded dispatched before the call, the call made with its funding
 * and a signal aborted once it outlasts its pending bound (the call checks
 * it after each await, and stops: nothing more done, what it took given
 * back), then its run observed on the ledger's clock, settled and
 * released. A call that fails or is given up on (an answer lost, the
 * object unreachable, too slow) is refused for now and leaves its owner
 * dispatched: its work may still run, so maintenance recovers it as
 * uncertain, its place kept.
 */
export async function ownedRun<T>(
  db: D1Database,
  envelope: LiveEnvelope,
  role: string,
  call: (funding: LiveFunding, signal: AbortSignal) => Promise<T>,
  options: OwnedRunOptions = {},
): Promise<FundedResult<T>> {
  const { plan } = envelope;
  // Its owner admitted and its dispatch recorded before the call: nothing runs otherwise.
  let ownerId: string;
  let begun: number;
  let startedAt: number;
  try {
    const admitted = await admitLiveOwners(
      db,
      {
        incarnation: plan.incarnation,
        class: plan.class,
        dispatchFrom: plan.validFrom,
        dispatchUntil: plan.validUntil,
        owners: [{ operationId: envelope.operationId, role }],
      },
      options.limits ?? LIVE_OWNER_LIMITS,
    );
    if (admitted.status !== "admitted") return { status: "refused", reason: "temporary" };
    ownerId = admitted.owners[0]?.ownerId as string;
    // Its run on the ledger's clock: D1's time when sampled, moved on by what this Worker
    // measured since (to its dispatch, then to its end).
    begun = clock();
    startedAt = options.ledger ? options.ledger.now + (begun - options.ledger.at) : begun;
    if (
      (await markLiveOwnerDispatched(db, ownerId, {
        instance: crypto.randomUUID(),
        startedAt,
      })) !== "dispatched"
    )
      return { status: "refused", reason: "temporary" };
  } catch {
    // Nothing called: an owner admitted but never recorded dispatched is released once its window
    // passed; one whose dispatch was recorded, its answer lost, is recovered as uncertain.
    return { status: "refused", reason: "temporary" };
  }
  // Waited for no longer than its pending bound: past it the call is given up on (its owner left
  // dispatched, for recovery), and told, so it stops rather than apply late.
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let value: T;
  try {
    const called = call(
      {
        protocol: 1,
        revision: LIVE_MANIFEST_REVISION,
        envelope,
        quantity: options.quantity ?? 1,
        ownerId,
      },
      deadline.signal,
    );
    options.physical?.(
      called.then(
        () => {},
        () => {},
      ),
    );
    value = await Promise.race([
      called,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          deadline.abort();
          reject(new Error("live work outlasted its pending bound"));
        }, options.pendingMs ?? LIVE_PENDING_MS);
      }),
    ]);
  } catch {
    deadline.abort();
    return { status: "refused", reason: "temporary" };
  } finally {
    clearTimeout(timer);
  }
  // Its end as late as the ledger's time may be (so a run reaching past midnight is charged
  // there); accounted, then released. Its result stands whatever the accounting does: an owner
  // not released keeps its place until recovery accounts for it.
  const finishedAt = startedAt + Math.max(0, clock() - begun) + (options.ledger?.slack ?? 0);
  let accounted = false;
  try {
    await observeLiveOwner(db, ownerId, {
      startedAt,
      physicalFinishedAt: finishedAt,
      chargedThrough: finishedAt,
    });
    for (let page = 0; page < 2; page++) {
      const settled = await settleLiveOwnerPage(db, ownerId);
      if (settled.status === "duplicate" || (settled.status === "settled" && settled.accounted))
        break;
      if (settled.status !== "settled") break;
    }
    accounted = (await releaseLiveOwner(db, ownerId)) === "released";
  } catch {}
  return { status: "funded", value, accounted };
}
