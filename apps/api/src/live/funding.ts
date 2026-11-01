import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../effects/discretionary.js";
import {
  isLiveVector,
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

/** The manifest live work is priced by: a funding of another revision is refused. */
export const LIVE_MANIFEST_REVISION = 1;

export type FundedResult<T> =
  | { readonly status: "funded"; readonly value: T }
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
    ? reserveDuration(plan.validFrom, plan.validUntil, LIVE_PENDING_MS, expected.tailMs)
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
    entry.duration === "owner" ? reserveDuration(from, until, LIVE_PENDING_MS, tailMs) : [];
  const charges: LiveDayCharge[] = [...new Set([...days, ...holds.map((h) => h.day)])]
    .sort((a, b) => a - b)
    .map((day) => {
      const runs = days.includes(day);
      // An owner's hold, or a synchronous entry's allowance held on each day it may run.
      const allowance = entry.resources.do_duration_ms;
      const hold =
        entry.duration === "owner"
          ? (holds.find((h) => h.day === day) ?? null)
          : runs && allowance > 0
            ? {
                day,
                from: Math.max(from, day * DAY),
                until: Math.min(until, (day + 1) * DAY),
                ms: allowance,
              }
            : null;
      // A day it can only run into (past a midnight) pays the whole price too: its calls may land there.
      const resources = Object.fromEntries(
        R.map((r) => [r, r === "do_duration_ms" ? (hold?.ms ?? 0) : entry.resources[r]]),
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
