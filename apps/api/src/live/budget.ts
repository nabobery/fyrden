import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { feedEpochSource } from "../do/user/feed.js";
import {
  DISCRETIONARY_RESOURCES,
  type DiscretionaryResource,
  type ResourceVector,
} from "../effects/discretionary.js";

/*
 * Live hints' ledger in the directory (migration 0033): a grant pays for
 * one unit of live work before it runs, debited atomically against the UTC
 * days (D1's clock) it may run on, within the deployment's daily allowance
 * for live, with what it leaves to clean up added to the ledger's debt.
 * Its receipt is the operation's immutable identity: a retry within its
 * validity gets the same grant back (never a second charge), and after its
 * receipt is gone the identity's own dates say it expired. Duration is
 * reserved per day and settled once, back to the days it was reserved on;
 * nothing else is ever refunded. A directory restored by Time Travel gets
 * a new incarnation, fencing every grant made before.
 *
 * These are accounting helpers: their caller pays for its own work,
 * including theirs.
 */

const R = DISCRETIONARY_RESOURCES;
const DAY = 86_400_000;
const MAX = Number.MAX_SAFE_INTEGER;

/** Live's daily allowance (of the deployment's Free limits), the part kept for cleanup, and the debt ordinary grants may leave. Proposed. */
export const LIVE_DAILY: ResourceVector = {
  do_requests: 30_000,
  do_rows_read: 2_000_000,
  do_rows_written: 50_000,
  do_duration_ms: 20_000_000,
  d1_rows_read: 1_000_000,
  d1_rows_written: 30_000,
  queue_ops: 0,
};
export const LIVE_PROTECTED: ResourceVector = {
  do_requests: 3_000,
  do_rows_read: 200_000,
  do_rows_written: 5_000,
  do_duration_ms: 2_000_000,
  d1_rows_read: 100_000,
  d1_rows_written: 3_000,
  queue_ops: 0,
};
export const LIVE_ORDINARY_DEBT_LIMIT: ResourceVector = {
  do_requests: 1_500,
  do_rows_read: 100_000,
  do_rows_written: 2_500,
  do_duration_ms: 1_000_000,
  d1_rows_read: 50_000,
  d1_rows_written: 1_500,
  queue_ops: 0,
};

/** Unsettled duration holds a day at most; receipts and days a cleanup call removes at most. */
export const LIVE_ESCROW_ENTRIES = 64;
export const LIVE_RECEIPT_PAGE = 32;
export const LIVE_DAY_PAGE = 8;

/** A feed's turns: their state is one turn at a time, their receipts removed by later turns. */
export const LIVE_TURN_KINDS = ["pump", "renewal"];
/** A feed's done turn receipts a turn's grant removes at most (the newest first). */
export const LIVE_TURN_RECEIPT_PAGE = 2;
/** The newest receipts of each turn kind past their validity a turn's grant looks at. */
export const LIVE_TURN_RECEIPT_LOOK = 4;

/**
 * When expired receipts hold ordinary grants back (Proposed): a page of them
 * expired for as long as two runs of the five-minute cron take, or one overdue for
 * two hours. Receipts expire in batches (an opening's ticket and transport), so a
 * page can expire between two runs. Until then a grant goes on, their debt still
 * counted and still within its limit.
 */
export const LIVE_RECEIPTS_OVERDUE = {
  page: 16,
  graceMs: 2 * 60 * 60_000,
  pageAfterMs: 10 * 60_000,
} as const;

/**
 * When a run is due for expired receipts (Proposed): before they hold ordinary
 * grants back, by about two of the five-minute cron's runs at the rate they
 * expire. So with a working cron the gate above never closes: a refused turn's
 * successor costs its feed its hints until a socket next renews.
 */
export const LIVE_RECEIPTS_DUE = { page: 13, graceMs: 105 * 60_000, pageAfterMs: 0 } as const;

/** Receipts other than maintenance's own (its runs', its revocation pages'): the overdue index's. */
const NOT_MAINTENANCE = "kind NOT IN ('maintenance', 'revocation_page')";

/**
 * Whether expired receipts call for cleanup now (`LIVE_RECEIPTS_OVERDUE`),
 * maintenance's own excepted (its runs' and revocation pages': the next
 * run removes them, and they alone never call for one): one SQL condition,
 * read through an index of the others only (a page at most, whatever
 * maintenance's own left).
 */
export function liveReceiptsOverdue(
  now: string = LIVE_NOW,
  {
    page,
    graceMs,
    pageAfterMs,
  }: {
    readonly page: number;
    readonly graceMs: number;
    readonly pageAfterMs: number;
  } = LIVE_RECEIPTS_OVERDUE,
): string {
  return `(EXISTS (SELECT 1 FROM live_budget_receipts INDEXED BY live_budget_receipts_overdue
      WHERE expires_at <= ${now} - ${graceMs} AND ${NOT_MAINTENANCE})
    OR (SELECT count(*) FROM (SELECT 1 FROM live_budget_receipts INDEXED BY live_budget_receipts_overdue
      WHERE expires_at <= ${now} - ${pageAfterMs} AND ${NOT_MAINTENANCE} LIMIT ${page})) >= ${page})`;
}

/** D1's clock in milliseconds (tests replace the marked expression). */
export const LIVE_NOW = "/*LIVE_NOW*/(unixepoch() * 1000)";
const N = LIVE_NOW;
const D = `CAST(${N} / ${DAY} AS INTEGER)`;

export type LiveUnit =
  | "ticket"
  | "upgrade_transport"
  | "admission"
  | "terminal"
  | "control"
  | "renewal"
  | "pump"
  | "org_confirmation"
  | "mark"
  | "maintenance"
  | "revocation_page"
  | "recovery"
  | "settlement";

const UNITS: readonly LiveUnit[] = [
  "ticket",
  "upgrade_transport",
  "admission",
  "terminal",
  "control",
  "renewal",
  "pump",
  "org_confirmation",
  "mark",
  "maintenance",
  "revocation_page",
  "recovery",
  "settlement",
];

/** Duration reserved on one day: for work dispatched from `from`, finishing by `until`. */
export interface LiveDurationHold {
  readonly day: number;
  readonly from: number;
  readonly until: number;
  readonly ms: number;
}

export interface LiveDayCharge {
  readonly day: number;
  readonly resources: ResourceVector;
  readonly duration: LiveDurationHold | null;
}

export type LiveRecipientType = "UserDO" | "OrgDO" | "MaintenanceDO";

export interface LiveGrantPlan {
  readonly protocol: 1;
  readonly incarnation: string;
  readonly recipientType: LiveRecipientType;
  readonly recipient: string;
  readonly epoch: number;
  readonly kind: LiveUnit;
  readonly class: "ordinary" | "cleanup";
  readonly producesLocal: boolean;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly charges: readonly LiveDayCharge[];
  readonly directoryCleanupDebt: ResourceVector;
  readonly localCleanupDebt: ResourceVector;
  readonly dayCleanupDebt: ResourceVector;
}

export interface LiveGrantRequest {
  readonly operationId: string;
  readonly nonce: string;
  readonly plan: LiveGrantPlan;
}

/** A granted operation, as its recipient receives it. */
export interface LiveEnvelope {
  readonly protocol: 1;
  readonly operationId: string;
  readonly seq: number;
  /** D1's time when it was granted. */
  readonly ledgerAt: number;
  readonly plan: LiveGrantPlan;
}

export type LiveRefusal = "daily" | "temporary" | "expired" | "fenced" | "invalid";

/**
 * Which of a grant's gates refused it, from the one list that decides it (see
 * `liveGates`); `unknown` when no gate did (an answer lost). Diagnostic: names
 * may change, so nothing but people and dashboards reads them.
 */
export type LiveGate =
  | "first_day"
  | "daily_total"
  | "ordinary_share"
  | "duration_day"
  | "second_day"
  | "duration_closed"
  | "escrow_full"
  | `debt:${DiscretionaryResource}`
  | "overdue_receipts"
  | "old_days"
  | "epoch"
  | "target_incarnation"
  | "validity"
  | "unknown";

/** Why live work was refused, whichever step refused it: a grant's gate, or what came after. */
export type LiveRefusalReason =
  | LiveGate
  | "owner:capacity"
  | "owner:blocked"
  | "owner:unfunded"
  | "allowance"
  | "admissions"
  | "tickets"
  | "feed_cap"
  | "conflict"
  | "given_up"
  | "no_controls";

/** A 4412's close reason, naming why. */
export const liveTryAgain = (reason: LiveRefusalReason) => `try again soon: ${reason}`;

export type LiveGrantResult =
  | { readonly status: "granted"; readonly replay: boolean; readonly grant: LiveEnvelope }
  | {
      readonly status: "refused";
      readonly reason: LiveRefusal;
      readonly gate: LiveGate;
      /** A daily refusal's: the start of the next UTC day, by D1's clock. */
      readonly retryAt?: number;
    };

/** What a funded operation actually used of its reserved duration, per day. */
export interface LiveDurationCompletion {
  readonly protocol: 1;
  readonly operationId: string;
  readonly incarnation: string;
  readonly recipientType: LiveRecipientType;
  readonly recipient: string;
  readonly epoch: number;
  readonly finishedAt: number;
  readonly actual: readonly { readonly day: number; readonly ms: number }[];
}

export type LiveSettlementResult = "settled" | "duplicate" | "expired" | "fenced" | "invalid";

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Whether `v` has exactly the seven resources, each a nonnegative safe integer, queues none. */
export function isLiveVector(v: unknown): v is ResourceVector {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== R.length || !R.every((r) => keys.includes(r))) return false;
  const vector = v as Record<string, unknown>;
  return R.every((r) => isCount(vector[r])) && vector.queue_ops === 0;
}

/** A vector's canonical form (the resources in their fixed order). */
export const canonicalVector = (v: ResourceVector): ResourceVector =>
  Object.fromEntries(R.map((r) => [r, v[r]])) as ResourceVector;

const vectorJson = (v: ResourceVector) => JSON.stringify(canonicalVector(v));

/** A plan's canonical JSON: its keys and vectors in a fixed order (what is stored and hashed). */
export function canonicalPlan(plan: LiveGrantPlan): string {
  return JSON.stringify({
    protocol: plan.protocol,
    incarnation: plan.incarnation,
    recipientType: plan.recipientType,
    recipient: plan.recipient,
    epoch: plan.epoch,
    kind: plan.kind,
    class: plan.class,
    producesLocal: plan.producesLocal,
    validFrom: plan.validFrom,
    validUntil: plan.validUntil,
    charges: plan.charges.map((c) => ({
      day: c.day,
      resources: canonicalVector(c.resources),
      duration: c.duration && {
        day: c.duration.day,
        from: c.duration.from,
        until: c.duration.until,
        ms: c.duration.ms,
      },
    })),
    directoryCleanupDebt: canonicalVector(plan.directoryCleanupDebt),
    localCleanupDebt: canonicalVector(plan.localCleanupDebt),
    dayCleanupDebt: canonicalVector(plan.dayCleanupDebt),
  });
}

/**
 * How long a receipt outlives its validity (Proposed), a margin for slow callers:
 * past its validity it is refused by its dates whether or not its row is there.
 */
export const LIVE_RECEIPT_MARGIN_MS = 60 * 60_000;

/** When a grant's settlement window closes, and when its receipt may be removed. */
export function liveReceiptDeadlines(plan: LiveGrantPlan): {
  readonly settleUntil: number;
  readonly expiresAt: number;
} {
  const covered = plan.charges.flatMap((c) => (c.duration ? [c.duration.until] : []));
  const settleUntil =
    covered.length > 0 ? Math.max(plan.validUntil, Math.max(...covered) + DAY) : plan.validUntil;
  return {
    settleUntil,
    expiresAt: Math.max(plan.validUntil + LIVE_RECEIPT_MARGIN_MS, settleUntil),
  };
}

/** Why a plan is malformed, or null when it holds together (its first day is D1's to check). */
export function livePlanError(plan: LiveGrantPlan): string | null {
  if (typeof plan !== "object" || plan === null) return "plan";
  if (plan.protocol !== 1) return "protocol";
  if (typeof plan.incarnation !== "string" || !/^[0-9a-f]{32}$/.test(plan.incarnation))
    return "incarnation";
  if (!["UserDO", "OrgDO", "MaintenanceDO"].includes(plan.recipientType)) return "recipientType";
  if (
    typeof plan.recipient !== "string" ||
    plan.recipient.length === 0 ||
    plan.recipient.length > 200
  )
    return "recipient";
  if (!isCount(plan.epoch)) return "epoch";
  if (!UNITS.includes(plan.kind)) return "kind";
  if (plan.class !== "ordinary" && plan.class !== "cleanup") return "class";
  if (typeof plan.producesLocal !== "boolean") return "producesLocal";
  if (!isCount(plan.validFrom) || !isCount(plan.validUntil)) return "validity";
  if (plan.validUntil <= plan.validFrom || plan.validUntil - plan.validFrom > DAY)
    return "validity";
  for (const v of [plan.directoryCleanupDebt, plan.localCleanupDebt, plan.dayCleanupDebt])
    if (!isLiveVector(v)) return "debt";
  const charges = plan.charges;
  if (!Array.isArray(charges) || charges.length < 1 || charges.length > 2) return "charges";
  for (const [i, charge] of charges.entries()) {
    if (typeof charge !== "object" || charge === null) return "charge";
    if (!isCount(charge.day) || !isLiveVector(charge.resources)) return "charge";
    if (i === 1 && charge.day !== (charges[0] as LiveDayCharge).day + 1) return "charge days";
    const hold = charge.duration;
    if (hold === undefined) return "duration";
    // No hold: any duration it pays is debited outright (a synchronous entry's fixed allowance),
    // never settled or refunded, so it takes no place in the day's escrow.
    if (hold === null) continue;
    if (
      typeof hold !== "object" ||
      hold === null ||
      hold.day !== charge.day ||
      !isCount(hold.from) ||
      !isCount(hold.until) ||
      !Number.isSafeInteger(hold.ms) ||
      hold.ms <= 0 ||
      hold.from < charge.day * DAY ||
      hold.from >= hold.until ||
      hold.until > (charge.day + 1) * DAY ||
      charge.resources.do_duration_ms !== hold.ms
    )
      return "duration";
  }
  if (plan.producesLocal && (plan.class !== "ordinary" || plan.recipientType !== "UserDO"))
    return "producesLocal";
  if (
    plan.class === "cleanup" &&
    (plan.producesLocal || R.some((r) => plan.localCleanupDebt[r] > 0))
  )
    return "cleanup";
  if (plan.kind === "recovery" && (plan.class !== "cleanup" || plan.recipientType !== "UserDO"))
    return "recovery";
  const { expiresAt } = liveReceiptDeadlines(plan);
  if (charges.some((c) => expiresAt > (c.day + 5) * DAY)) return "horizon";
  return null;
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function identityHash(plan: LiveGrantPlan, nonce: string): Promise<string> {
  const data = new TextEncoder().encode(`${canonicalPlan(plan)}\n${nonce}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

/** An operation's identity: its validity, a nonce and the hash of its plan with the nonce. */
export async function makeLiveGrant(
  plan: LiveGrantPlan,
  nonce?: string,
): Promise<LiveGrantRequest> {
  const n = nonce ?? hex(crypto.getRandomValues(new Uint8Array(16)));
  return {
    operationId: `v1.${plan.validFrom}.${plan.validUntil}.${n}.${await identityHash(plan, n)}`,
    nonce: n,
    plan,
  };
}

/** Whether a request's identity is its plan's (dates, nonce and hash). */
async function identityHolds(request: LiveGrantRequest): Promise<boolean> {
  const parts = request.operationId.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return false;
  const [, from, until, nonce, hash] = parts as [string, string, string, string, string];
  return (
    /^[0-9a-f]{32}$/.test(nonce) &&
    nonce === request.nonce &&
    from === String(request.plan.validFrom) &&
    until === String(request.plan.validUntil) &&
    hash === (await identityHash(request.plan, nonce))
  );
}

/** A statement whose values are bound by position, each distinct value once. */
function statement(
  db: D1Database,
  build: (bind: (value: string | number) => string) => string,
): D1PreparedStatement {
  const values: (string | number)[] = [];
  const sql = build((value) => {
    const at = values.indexOf(value);
    if (at >= 0) return `?${at + 1}`;
    values.push(value);
    return `?${values.length}`;
  });
  return db.prepare(sql).bind(...values);
}

/** `json_extract` of a vector column or parameter, as an integer. */
const v = (x: string, r: DiscretionaryResource) => `CAST(json_extract(${x}, '$.${r}') AS INTEGER)`;

/** Whether `plan` is a feed's turn (its state one turn at a time). */
const isTurn = (plan: LiveGrantPlan) =>
  plan.recipientType === "UserDO" && LIVE_TURN_KINDS.includes(plan.kind);

/**
 * The local debt `plan` adds to its feed's recovery target: a turn's only
 * while the target does not already owe its turn state.
 */
function addedLocal(
  plan: LiveGrantPlan,
  r: DiscretionaryResource,
  b: (value: string | number) => string,
): string {
  const local = plan.localCleanupDebt[r];
  if (!isTurn(plan) || local === 0) return String(local);
  return `(CASE WHEN EXISTS (SELECT 1 FROM live_recovery_targets WHERE feed = ${b(plan.recipient)}
      AND incarnation = ${b(plan.incarnation)} AND turn_debt = 1) THEN 0 ELSE ${local} END)`;
}

/** The ordinary-debt and day-debt each charge would add: for days without a row yet. */
function addedDebt(
  plan: LiveGrantPlan,
  r: DiscretionaryResource,
  b: (value: string | number) => string,
): string {
  const newDays = plan.charges
    .map(
      (c) =>
        `(CASE WHEN EXISTS (SELECT 1 FROM live_budget_days WHERE day = ${c.day}) THEN 0 ELSE ${plan.dayCleanupDebt[r]} END)`,
    )
    .join(" + ");
  return `(${plan.directoryCleanupDebt[r]} + ${addedLocal(plan, r, b)} + ${newDays})`;
}

/**
 * A page of `plan`'s feed's earlier turns' receipts that are done by `at`:
 * their validity over (no replay of one can be granted again), their owner
 * released, and nothing of them left in escrow (no refund still to come).
 * A turn's grant removes them, their directory debt with them, so a feed
 * always on owes a turn or two of receipts rather than days of them. Only
 * the newest few of each turn kind past their validity are looked at (an
 * index range each, newest first): one never done (its turn never ran) is
 * passed over by later turns and left to its expiry, read at most a few
 * times. The order is the index's (validity, then sequence), so every
 * statement of a batch selects the same receipts.
 */
function doneTurns(plan: LiveGrantPlan, b: (value: string | number) => string, at: string): string {
  const newest = (
    kind: string,
  ) => `SELECT * FROM (SELECT r.seq, r.valid_until FROM live_budget_receipts r
      INDEXED BY live_budget_receipts_recipient
    WHERE r.recipient = ${b(plan.recipient)} AND r.kind = '${kind}' AND r.settled_at IS NULL
      AND r.valid_until <= ${at}
    ORDER BY r.valid_until DESC, r.seq DESC LIMIT ${LIVE_TURN_RECEIPT_LOOK})`;
  // Eligibility past the window (the index's columns alone bound it): another incarnation's, or
  // another recipient type's, is passed over like one never done.
  return `SELECT c.seq FROM (${newest("pump")} UNION ALL ${newest("renewal")}) c
    JOIN live_budget_receipts r ON r.seq = c.seq
    WHERE r.recipient_type = 'UserDO' AND r.incarnation = ${b(plan.incarnation)}
      AND json_array_length(r.released_owners) > 0
      AND NOT EXISTS (SELECT 1 FROM live_duration_owners o WHERE o.operation_id = r.operation_id)
      -- Its id in a charged day's escrow text (ids are unique and of one shape: found only
      -- when held there), read without walking the day's entries.
      AND NOT EXISTS (SELECT 1 FROM json_each(r.plan, '$.charges') ch
        JOIN live_budget_days d ON d.day = json_extract(ch.value, '$.day')
        WHERE instr(d.escrow, r.operation_id) > 0)
    ORDER BY c.valid_until DESC, c.seq DESC LIMIT ${LIVE_TURN_RECEIPT_PAGE}`;
}

/**
 * The directory debt of `plan`'s feed's done turn receipts (see `doneTurns`),
 * taken off: each resource's, summed once a statement (a table `retired`,
 * of one row, that `retiredDebt` reads), or nothing for any other plan.
 */
function retiring(plan: LiveGrantPlan, b: (value: string | number) => string): string {
  if (!isTurn(plan)) return "";
  return `WITH retired AS MATERIALIZED (SELECT ${R.map(
    (r) => `coalesce(sum(${v("directory_cleanup_debt", r)}), 0) AS ${r}`,
  ).join(", ")}
    FROM live_budget_receipts WHERE seq IN (${doneTurns(plan, b, N)}))
`;
}

/** `r`'s part of what `retiring` takes off (its statement's `retired`), or nothing. */
function retiredDebt(plan: LiveGrantPlan, r: DiscretionaryResource): string {
  return isTurn(plan) ? `(SELECT ${r} FROM retired)` : "0";
}

/** One condition a grant must meet, with the name a refusal reports it by. */
interface Gate {
  readonly name: LiveGate;
  readonly holds: string;
  /**
   * Implied by a later gate, so the grant's transition need not read it: only a
   * refusal does, to say which of the two failed.
   */
  readonly reportOnly?: true;
}

/** What each charge's fit to its day asks (all of it, and ordinary work outside the protected part). */
function chargeGates(charge: LiveDayCharge, first: boolean, ordinary: boolean): Gate[] {
  // The first day's duration apart from its other room: what grants hold of it can come back today.
  const total = (r: DiscretionaryResource): LiveGate =>
    !first ? "second_day" : r === "do_duration_ms" ? "duration_day" : "daily_total";
  const share = (r: DiscretionaryResource): LiveGate =>
    !first ? "second_day" : r === "do_duration_ms" ? "duration_day" : "ordinary_share";
  const used = (r: DiscretionaryResource) =>
    `coalesce((SELECT ${r} - protected_${r} FROM live_budget_days WHERE day = ${charge.day}), 0) + ${charge.resources[r]} <= ${LIVE_DAILY[r] - LIVE_PROTECTED[r]}`;
  const gates: Gate[] = R.filter((r) => charge.resources[r] > 0).map((r) => ({
    name: total(r),
    holds: `coalesce((SELECT ${r} FROM live_budget_days WHERE day = ${charge.day}), 0) + ${charge.resources[r]} <= ${LIVE_DAILY[r]}`,
  }));
  if (ordinary)
    for (const r of R.filter((x) => charge.resources[x] > 0))
      if (r !== "do_duration_ms") gates.push({ name: share(r), holds: used(r) });
      else
        gates.push(
          { name: share(r), holds: used(r), reportOnly: true },
          {
            // Ordinary duration leaves the day's reserve, its withheld debt and the debt owed.
            name: "duration_closed",
            holds: `coalesce((SELECT do_duration_ms - protected_do_duration_ms + debt_withheld_ms FROM live_budget_days WHERE day = ${charge.day}), 0) + ${charge.resources[r]}
                + (SELECT duration_reserve_ms + duration_debt_ms FROM live_budget_state WHERE id = 1)
                <= ${LIVE_DAILY[r] - LIVE_PROTECTED[r]}`,
          },
        );
  if (ordinary && charge.resources.do_duration_ms > 0)
    // Not while ordinary duration is blocked, or once the day's reserve is spent.
    gates.push({
      name: "duration_closed",
      holds: `(SELECT ordinary_duration_blocked = 0 AND (duration_reserve_ms = 0
      OR coalesce((SELECT reserve_used_ms FROM live_budget_days WHERE day = ${charge.day}), 0)
        < duration_reserve_ms) FROM live_budget_state WHERE id = 1)`,
    });
  if (charge.duration)
    gates.push({
      name: "escrow_full",
      holds: `coalesce((SELECT json_array_length(escrow) FROM live_budget_days WHERE day = ${charge.day}), 0) < ${LIVE_ESCROW_ENTRIES}`,
    });
  return gates;
}

/** The sum of what `escrow` (a day's column) holds; its ordinary grants' only, when asked. */
function heldInEscrow(escrow: string, ordinaryOnly = false): string {
  const ms = ordinaryOnly
    ? `CASE WHEN json_extract(value, '$.class') = 'cleanup' THEN 0 ELSE json_extract(value, '$.ms') END`
    : `json_extract(value, '$.ms')`;
  return `(SELECT coalesce(sum(${ms}), 0) FROM json_each(${escrow}))`;
}

/**
 * Whether `plan` would fit today's duration (`d`, a day's row) were all that grants hold given back.
 * A cleanup grant's refund leaves the day's total, and leaves the ordinary share as it was.
 */
function durationReopens(plan: LiveGrantPlan): string {
  const charge = plan.charges[0]?.resources.do_duration_ms ?? 0;
  const wanted = `d.do_duration_ms + ${charge}`;
  const total = `${wanted} - ${heldInEscrow("d.escrow")} <= ${LIVE_DAILY.do_duration_ms}`;
  return plan.class === "ordinary"
    ? `${total} AND ${wanted} - d.protected_do_duration_ms - ${heldInEscrow("d.escrow", true)} <= ${LIVE_DAILY.do_duration_ms - LIVE_PROTECTED.do_duration_ms}`
    : total;
}

/**
 * Everything that decides whether `plan` may be granted, read against
 * `live_budget_state` (its columns unqualified): the grant's transition ANDs
 * them and a refusal names the first that fails, so the two cannot disagree.
 * In the order a refusal is told by: a plan that is not valid now first, then
 * the day's room (a refusal until tomorrow), then the rest.
 */
function liveGates(
  plan: LiveGrantPlan,
  b: (value: string | number) => string,
  source: string,
): readonly Gate[] {
  const ordinary = plan.class === "ordinary";
  const first = plan.charges[0] as LiveDayCharge;
  const charges = plan.charges.flatMap((c) => chargeGates(c, c === first, ordinary));
  const inOrder: LiveGate[] = [
    "daily_total",
    "ordinary_share",
    "duration_day",
    "second_day",
    "duration_closed",
    "escrow_full",
  ];
  return [
    { name: "validity", holds: `${plan.validFrom} <= ${N} AND ${N} < ${plan.validUntil}` },
    { name: "first_day", holds: `${first.day} = ${D}` },
    ...inOrder.flatMap((name) => charges.filter((g) => g.name === name)),
    ...(ordinary
      ? [
          ...R.map(
            // After what it retires: a turn that owes no more than it takes off is let through.
            (r): Gate => ({
              name: `debt:${r}`,
              holds: `debt_${r} + ${addedDebt(plan, r, b)} - ${retiredDebt(plan, r)} <= ${LIVE_ORDINARY_DEBT_LIMIT[r]}`,
            }),
          ),
          // Expired receipts once they call for cleanup (maintenance's own never do).
          { name: "overdue_receipts", holds: `NOT ${liveReceiptsOverdue(N)}` } as Gate,
          {
            name: "old_days",
            holds: `NOT EXISTS (SELECT 1 FROM live_budget_days WHERE day < ${D} - 7 AND retain_until <= ${N} ORDER BY day LIMIT 1)`,
          } as Gate,
        ]
      : []),
    ...(plan.recipientType === "UserDO"
      ? [
          {
            name: "epoch",
            holds: `${plan.epoch} = coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ${b(source)}), 0)`,
          } as Gate,
        ]
      : []),
    ...(plan.producesLocal
      ? [
          {
            name: "target_incarnation",
            holds: `NOT EXISTS (SELECT 1 FROM live_recovery_targets WHERE feed = ${b(plan.recipient)} AND incarnation <> ${b(plan.incarnation)})`,
          } as Gate,
        ]
      : []),
  ];
}

/** A day's use, as `liveOpeningFits` compares it. */
export type LiveDayView = Readonly<Record<DiscretionaryResource, number>> & {
  readonly protectedUse: Readonly<Record<DiscretionaryResource, number>>;
  readonly escrow: number;
  /** What grants hold of its duration: the most that settling them could give back. */
  readonly heldMs: number;
  /** What ordinary grants hold of it: all that settling can give the ordinary share. */
  readonly heldOrdinaryMs: number;
  readonly reserveUsedMs: number;
  readonly debtWithheldMs: number;
};

/** What the ledger holds now, read in the one statement before an opening's grants. */
export interface LiveLedgerView {
  readonly today: number;
  readonly debts: Readonly<Record<DiscretionaryResource, number>>;
  readonly ordinaryDurationBlocked: boolean;
  readonly durationReserveMs: number;
  readonly durationDebtMs: number;
  readonly days: Readonly<Record<number, LiveDayView>>;
  readonly receiptsOverdue: boolean;
  readonly oldDays: boolean;
  readonly targetElsewhere: boolean;
  /** Places left for another ordinary owner of this feed: the deployment's and its own. */
  readonly ownerRoom: number;
}

/** The columns `parseLiveLedgerView` reads: `recipient` is a parameter holding the feed. */
export function liveLedgerViewColumns(recipient: string): string {
  return `(SELECT json_object(${R.map((r) => `'${r}', debt_${r}`).join(", ")},
      '_blocked', ordinary_duration_blocked, '_reserve', duration_reserve_ms,
      '_durationDebt', duration_debt_ms)
      FROM live_budget_state WHERE id = 1) AS view_state,
    (SELECT json_group_array(json_object('_day', day, ${R.map((r) => `'${r}', ${r}, 'p_${r}', protected_${r}`).join(", ")},
      '_escrow', json_array_length(escrow),
      '_held', ${heldInEscrow("escrow")}, '_heldOrdinary', ${heldInEscrow("escrow", true)},
      '_reserveUsed', reserve_used_ms,
      '_withheld', debt_withheld_ms))
      FROM live_budget_days WHERE day IN (${D}, ${D} + 1)) AS view_days,
    ${liveReceiptsOverdue(N)} AS view_overdue,
    EXISTS (SELECT 1 FROM live_budget_days WHERE day < ${D} - 7 AND retain_until <= ${N}
      ORDER BY day LIMIT 1) AS view_old_days,
    EXISTS (SELECT 1 FROM live_recovery_targets WHERE feed = ${recipient}
      AND incarnation <> (SELECT incarnation FROM live_budget_state WHERE id = 1)) AS view_elsewhere,
    ${D} AS view_today`;
}

/** What `liveLedgerViewColumns` answered, with the places left for owners. */
export function parseLiveLedgerView(
  row: {
    view_state: string;
    view_days: string;
    view_overdue: number;
    view_old_days: number;
    view_elsewhere: number;
    view_today: number;
  },
  ownerRoom: number,
): LiveLedgerView {
  const state = JSON.parse(row.view_state) as Record<string, number>;
  const rows = JSON.parse(row.view_days) as Record<string, number>[];
  const part = (source: Record<string, number>, prefix: string) =>
    Object.fromEntries(R.map((r) => [r, source[`${prefix}${r}`] as number])) as Record<
      DiscretionaryResource,
      number
    >;
  return {
    today: row.view_today,
    debts: part(state, ""),
    ordinaryDurationBlocked: state._blocked !== 0,
    durationReserveMs: state._reserve as number,
    durationDebtMs: state._durationDebt as number,
    days: Object.fromEntries(
      rows.map((day) => [
        day._day,
        {
          ...part(day, ""),
          protectedUse: part(day, "p_"),
          escrow: day._escrow as number,
          heldMs: day._held as number,
          heldOrdinaryMs: day._heldOrdinary as number,
          reserveUsedMs: day._reserveUsed as number,
          debtWithheldMs: day._withheld as number,
        },
      ]),
    ),
    receiptsOverdue: row.view_overdue === 1,
    oldDays: row.view_old_days === 1,
    targetElsewhere: row.view_elsewhere === 1,
    ownerRoom,
  };
}

export type LiveOpeningFit =
  | { readonly fits: true }
  | {
      readonly fits: false;
      readonly reason: "daily" | "temporary";
      readonly gate: LiveRefusalReason;
      readonly retryAt?: number;
    };

/**
 * Whether all of an ordinary opening's `plans`, granted one after another, can
 * fit the ledger as `view` shows it, and if not which gate stops them, in
 * `liveGates`' order. `reserveLive` still decides: this reads no more than one
 * statement's worth, to refuse without charging. It counts a turn's debt in full
 * and nothing it might retire, so it may refuse slightly early but never lets an
 * opening through that a later grant must fail (a test runs both at each limit).
 */
export function liveOpeningFits(
  view: LiveLedgerView,
  plans: readonly LiveGrantPlan[],
  ownerPlaces = 0,
): LiveOpeningFit {
  const days = [...new Set(plans.flatMap((p) => p.charges.map((c) => c.day)))].sort(
    (a, b) => a - b,
  );
  const charged = (day: number, r: DiscretionaryResource) =>
    plans.reduce((n, p) => n + (p.charges.find((c) => c.day === day)?.resources[r] ?? 0), 0);
  const inOrder: { gate: LiveGate; closed: boolean }[] = [];
  for (const day of days) {
    const row = view.days[day];
    const first = day === view.today;
    const used = (r: DiscretionaryResource) => row?.[r] ?? 0;
    const ordinaryUsed = (r: DiscretionaryResource) => used(r) - (row?.protectedUse[r] ?? 0);
    const costly = R.filter((r) => charged(day, r) > 0);
    for (const r of costly)
      inOrder.push(
        {
          gate: !first ? "second_day" : r === "do_duration_ms" ? "duration_day" : "daily_total",
          closed: used(r) + charged(day, r) > LIVE_DAILY[r],
        },
        {
          gate: !first ? "second_day" : r === "do_duration_ms" ? "duration_day" : "ordinary_share",
          closed: ordinaryUsed(r) + charged(day, r) > LIVE_DAILY[r] - LIVE_PROTECTED[r],
        },
      );
    if (charged(day, "do_duration_ms") > 0)
      inOrder.push({
        gate: "duration_closed",
        closed:
          ordinaryUsed("do_duration_ms") +
            (row?.debtWithheldMs ?? 0) +
            charged(day, "do_duration_ms") +
            view.durationReserveMs +
            view.durationDebtMs >
            LIVE_DAILY.do_duration_ms - LIVE_PROTECTED.do_duration_ms ||
          view.ordinaryDurationBlocked ||
          (view.durationReserveMs !== 0 && (row?.reserveUsedMs ?? 0) >= view.durationReserveMs),
      });
    const holds = plans.filter((p) => p.charges.some((c) => c.day === day && c.duration)).length;
    if (holds > 0)
      inOrder.push({
        gate: "escrow_full",
        closed: (row?.escrow ?? 0) + holds > LIVE_ESCROW_ENTRIES,
      });
  }
  const order: LiveGate[] = [
    "daily_total",
    "ordinary_share",
    "duration_day",
    "second_day",
    "duration_closed",
    "escrow_full",
  ];
  const closed = order.find((gate) => inOrder.some((g) => g.gate === gate && g.closed));
  // Today's duration comes back as grants settle, if all they hold would make room: a cleanup
  // grant's refund leaves the day's total, and leaves the ordinary share as it was.
  const today = view.days[view.today];
  const wanted = (today?.do_duration_ms ?? 0) + charged(view.today, "do_duration_ms");
  const reopens =
    wanted - (today?.heldMs ?? 0) <= LIVE_DAILY.do_duration_ms &&
    wanted - (today?.protectedUse.do_duration_ms ?? 0) - (today?.heldOrdinaryMs ?? 0) <=
      LIVE_DAILY.do_duration_ms - LIVE_PROTECTED.do_duration_ms;
  if (
    closed === "daily_total" ||
    closed === "ordinary_share" ||
    (closed === "duration_day" && !reopens)
  )
    return { fits: false, reason: "daily", gate: closed, retryAt: (view.today + 1) * DAY };
  const added = (r: DiscretionaryResource) =>
    plans.reduce(
      (n, p) =>
        n +
        p.directoryCleanupDebt[r] +
        p.localCleanupDebt[r] +
        p.charges.filter((c) => !view.days[c.day]).length * p.dayCleanupDebt[r],
      0,
    );
  const refusedFor = (gate: LiveRefusalReason): LiveOpeningFit => ({
    fits: false,
    reason: "temporary",
    gate,
  });
  if (closed) return refusedFor(closed);
  const owing = R.find((r) => view.debts[r] + added(r) > LIVE_ORDINARY_DEBT_LIMIT[r]);
  if (owing) return refusedFor(`debt:${owing}`);
  if (view.receiptsOverdue) return refusedFor("overdue_receipts");
  if (view.oldDays) return refusedFor("old_days");
  if (view.targetElsewhere && plans.some((p) => p.producesLocal))
    return refusedFor("target_incarnation");
  if (ownerPlaces > view.ownerRoom) return refusedFor("owner:capacity");
  return { fits: true };
}

/**
 * Grants a plan's operation in one batch: the ledger's conditional
 * transition (its incarnation, the identity unused, D1's time within the
 * validity and on the first charge's day, every charged day within the
 * allowance and escrow, ordinary work within its part, its debt and no
 * overdue cleanup, a feed's epoch current), then each day's debit, the
 * receipt and the feed's recovery target, each repeating that this batch's
 * transition (or receipt) is the one that happened. The same identity
 * again, while valid, gets the first grant back.
 */
export async function reserveLive(
  db: D1Database,
  request: LiveGrantRequest,
  metrics?: Metrics,
): Promise<LiveGrantResult> {
  const plan = request.plan;
  const refused = (reason: LiveRefusal, gate: LiveGate, retryAt?: number): LiveGrantResult => {
    metrics?.count("live.grant_refusal", { unit: plan.kind, gate });
    return { status: "refused", reason, gate, ...(retryAt !== undefined && { retryAt }) };
  };
  if (livePlanError(plan) !== null || !(await identityHolds(request)))
    return refused("invalid", "validity");
  const mint = crypto.randomUUID();
  const { settleUntil, expiresAt } = liveReceiptDeadlines(plan);
  const ordinary = plan.class === "ordinary";
  const planText = canonicalPlan(plan);
  const source = feedEpochSource(plan.recipient);
  type Bind = (value: string | number) => string;
  const M = (b: Bind) =>
    `EXISTS (SELECT 1 FROM live_budget_state WHERE id = 1 AND last_mint = ${b(mint)})`;
  const G = (b: Bind) => `EXISTS (SELECT 1 FROM live_budget_receipts r
      JOIN live_budget_state s ON s.id = 1 AND s.grant_seq = r.seq AND s.last_mint = r.mint
      WHERE r.operation_id = ${b(request.operationId)} AND r.mint = ${b(mint)}
        AND r.incarnation = ${b(plan.incarnation)} AND r.plan = ${b(planText)})`;
  const statements: D1PreparedStatement[] = [];
  statements.push(
    statement(db, (b) => {
      const gates = liveGates(plan, b, source)
        .filter((gate) => !gate.reportOnly)
        .map((gate) => gate.holds);
      return `${retiring(plan, b)}UPDATE live_budget_state
  SET grant_seq = grant_seq + 1, last_mint = ${b(mint)}, last_mint_at = ${N},
    ${R.map((r) => `debt_${r} = debt_${r} + ${addedDebt(plan, r, b)} - ${retiredDebt(plan, r)}`).join(",\n    ")}
  WHERE id = 1 AND incarnation = ${b(plan.incarnation)} AND grant_seq < ${MAX}
    AND NOT EXISTS (SELECT 1 FROM live_budget_receipts WHERE operation_id = ${b(request.operationId)})
    AND ${gates.join("\n    AND ")}`;
    }),
  );
  for (const charge of plan.charges) {
    const held = charge.duration?.ms ?? 0;
    statements.push(
      statement(db, (b) => {
        const entry = `json_object('id', ${b(request.operationId)}, 'ms', ${held}, 'class', '${plan.class}')`;
        return `INSERT INTO live_budget_days
    (day, ${R.join(", ")}, ${R.map((r) => `protected_${r}`).join(", ")}, escrow, retain_until, cleanup_debt)
  SELECT ${charge.day}, ${R.map((r) => charge.resources[r]).join(", ")},
    ${R.map((r) => (ordinary ? 0 : charge.resources[r])).join(", ")},
    ${held === 0 ? "'[]'" : `json_array(${entry})`}, ${expiresAt}, ${b(vectorJson(plan.dayCleanupDebt))}
  WHERE ${M(b)}
  ON CONFLICT (day) DO UPDATE SET
    ${R.map((r) => `${r} = live_budget_days.${r} + excluded.${r}`).join(",\n    ")},
    ${R.map((r) => `protected_${r} = live_budget_days.protected_${r} + excluded.protected_${r}`).join(",\n    ")},
    escrow = ${held === 0 ? "live_budget_days.escrow" : `json_insert(live_budget_days.escrow, '$[#]', ${entry})`},
    retain_until = max(live_budget_days.retain_until, excluded.retain_until)`;
      }),
    );
  }
  statements.push(
    statement(
      db,
      (b) => `INSERT INTO live_budget_receipts (seq, operation_id, mint, incarnation,
    recipient_type, recipient, kind, class, epoch, produces_local, valid_from, valid_until,
    granted_at, plan, directory_cleanup_debt, settle_until, expires_at)
  SELECT grant_seq, ${b(request.operationId)}, ${b(mint)}, incarnation, ${b(plan.recipientType)},
    ${b(plan.recipient)}, ${b(plan.kind)}, ${b(plan.class)}, ${plan.epoch}, ${plan.producesLocal ? 1 : 0},
    ${plan.validFrom}, ${plan.validUntil}, last_mint_at, ${b(planText)},
    ${b(vectorJson(plan.directoryCleanupDebt))}, ${settleUntil}, ${expiresAt}
  FROM live_budget_state WHERE id = 1 AND last_mint = ${b(mint)}`,
    ),
  );
  if (plan.producesLocal)
    statements.push(
      statement(
        db,
        (b) => `INSERT INTO live_recovery_targets
    (feed, incarnation, through_seq, next_attempt_at, attempts, local_cleanup_debt, turn_debt)
  SELECT ${b(plan.recipient)}, ${b(plan.incarnation)}, seq, ${plan.validUntil}, 0,
    ${b(vectorJson(plan.localCleanupDebt))}, ${isTurn(plan) ? 1 : 0}
  FROM live_budget_receipts WHERE operation_id = ${b(request.operationId)} AND ${G(b)}
  ON CONFLICT (feed) DO UPDATE SET
    through_seq = excluded.through_seq,
    -- Due once the last grant it covers has expired: recovery cleans through the newest
    -- sequence, so it waits for all of them (credit valid a day among them).
    next_attempt_at = max(live_recovery_targets.next_attempt_at, excluded.next_attempt_at),
    -- A turn's state owed once (the ledger's debt was added the same way).
    local_cleanup_debt = CASE WHEN excluded.turn_debt = 1 AND live_recovery_targets.turn_debt = 1
      THEN live_recovery_targets.local_cleanup_debt
      ELSE json_object(${R.map(
        (r) =>
          `'${r}', ${v("live_recovery_targets.local_cleanup_debt", r)} + ${v("excluded.local_cleanup_debt", r)}`,
      ).join(", ")}) END,
    turn_debt = max(live_recovery_targets.turn_debt, excluded.turn_debt)
  WHERE live_recovery_targets.incarnation = excluded.incarnation`,
      ),
    );
  // Their receipts go once the transition took their debt off (by its own time, the same
  // receipts: nothing of the batch between changes which are done).
  if (isTurn(plan))
    statements.push(
      statement(
        db,
        (b) => `DELETE FROM live_budget_receipts
  WHERE seq IN (${doneTurns(plan, b, "(SELECT last_mint_at FROM live_budget_state WHERE id = 1)")})
    AND ${M(b)}`,
      ),
    );
  // What happened, and if nothing did, why: read in the same batch. Which gate failed is read only
  // with no receipt to show for it, so a granted path pays nothing for it.
  statements.push(
    statement(
      db,
      (b) => `SELECT ${N} AS now, ${D} AS today,
    (SELECT incarnation FROM live_budget_state WHERE id = 1) AS incarnation,
    ${plan.recipientType === "UserDO" ? `coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ${b(source)}), 0)` : "NULL"} AS epoch,
    CASE WHEN r.seq IS NULL THEN (${retiring(plan, b)}SELECT CASE
      ${liveGates(plan, b, source)
        .map((gate) => `WHEN NOT (${gate.holds}) THEN '${gate.name}'`)
        .join("\n      ")}
      ELSE 'unknown' END FROM live_budget_state WHERE id = 1) END AS gate,
    CASE WHEN r.seq IS NULL THEN (SELECT ${durationReopens(plan)}
      FROM live_budget_days d WHERE d.day = ${D}) END AS duration_reopens,
    r.seq, r.mint, r.plan, r.incarnation AS receipt_incarnation, r.granted_at, r.settled_at,
    r.valid_until
  FROM (SELECT 1) LEFT JOIN live_budget_receipts r ON r.operation_id = ${b(request.operationId)}`,
    ),
  );
  let rows: {
    now: number;
    today: number;
    duration_reopens: number | null;
    incarnation: string;
    epoch: number | null;
    gate: LiveGate | null;
    seq: number | null;
    mint: string | null;
    plan: string | null;
    receipt_incarnation: string | null;
    granted_at: number | null;
    settled_at: number | null;
    valid_until: number | null;
  }[];
  try {
    const results = await db.batch(statements);
    rows = (results.at(-1)?.results ?? []) as typeof rows;
  } catch {
    // An answer lost or a statement failed: unknown, retried with the same identity.
    return refused("temporary", "unknown");
  }
  const row = rows[0];
  if (!row) return refused("temporary", "unknown");
  const envelope = (): LiveEnvelope => ({
    protocol: 1,
    operationId: request.operationId,
    seq: row.seq as number,
    ledgerAt: row.granted_at as number,
    plan,
  });
  if (row.seq !== null) {
    if (row.plan !== canonicalPlan(plan) || row.receipt_incarnation !== plan.incarnation)
      return refused("invalid", "validity");
    // `mint` is private to this call: equal only when this batch granted it.
    if (row.mint === mint) return { status: "granted", replay: false, grant: envelope() };
    if (row.settled_at !== null || row.now >= (row.valid_until as number))
      return refused("expired", "validity");
    // A replay is fenced as a new grant would be (a restore, another incarnation since).
    if (row.incarnation !== plan.incarnation) return refused("fenced", "target_incarnation");
    if (plan.recipientType === "UserDO" && row.epoch !== plan.epoch)
      return refused("fenced", "epoch");
    return { status: "granted", replay: true, grant: envelope() };
  }
  if (row.now >= plan.validUntil) return refused("expired", "validity");
  if (row.incarnation !== plan.incarnation) return refused("fenced", "target_incarnation");
  if (plan.recipientType === "UserDO" && row.epoch !== plan.epoch)
    return refused("fenced", "epoch");
  const gate = row.gate ?? "unknown";
  // The first day's own room gone: nothing frees it before tomorrow. Its duration, though, comes
  // back as grants settle, if all they hold would make room.
  if (
    gate === "daily_total" ||
    gate === "ordinary_share" ||
    (gate === "duration_day" && row.duration_reopens !== 1)
  )
    return refused("daily", gate, (row.today + 1) * DAY);
  return refused("temporary", gate);
}

/**
 * Whether `envelope` is a grant the ledger holds for this recipient and
 * kind (the receipt by its identity, its stored plan and sequence equal,
 * unexpired and unsettled), read with D1's time, the ledger's incarnation,
 * the feed's epoch and the principal's lifecycle in one statement; with
 * `ownerId`, also that the owner was admitted for this very operation and
 * recipient and is not yet accounted (else `invalid`).
 */
export async function validateLiveCoverage(
  db: D1Database,
  envelope: LiveEnvelope,
  expected: {
    readonly recipientType: LiveRecipientType;
    readonly recipient: string;
    readonly kind: LiveUnit;
    readonly ownerId?: string;
  },
): Promise<
  | {
      readonly status: "valid";
      readonly ledgerAt: number;
      readonly epoch: number;
      readonly lifecycle: string | null;
    }
  | { readonly status: "refused"; readonly reason: "invalid" | "expired" | "fenced" }
> {
  const plan = envelope.plan;
  if (
    envelope.protocol !== 1 ||
    livePlanError(plan) !== null ||
    plan.recipientType !== expected.recipientType ||
    plan.recipient !== expected.recipient ||
    plan.kind !== expected.kind
  )
    return { status: "refused", reason: "invalid" };
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT ${N} AS now,
        (SELECT incarnation FROM live_budget_state WHERE id = 1) AS incarnation,
        coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ?2), 0) AS epoch,
        (SELECT lifecycle FROM principals WHERE id = ?3) AS lifecycle,
        (SELECT count(*) FROM live_duration_owners o WHERE o.owner_id = ?4
          AND o.operation_id = ?1 AND o.object_type = ?5 AND o.object_id = ?3
          AND o.status <> 'accounted') AS owned,
        r.seq, r.plan, r.valid_until, r.expires_at, r.settled_at
      FROM (SELECT 1) LEFT JOIN live_budget_receipts r ON r.operation_id = ?1`,
    )
    .bind(
      envelope.operationId,
      feedEpochSource(plan.recipient),
      plan.recipient,
      expected.ownerId ?? null,
      plan.recipientType,
    )
    .first<{
      now: number;
      incarnation: string;
      epoch: number;
      lifecycle: string | null;
      owned: number;
      seq: number | null;
      plan: string | null;
      valid_until: number | null;
      expires_at: number | null;
      settled_at: number | null;
    }>();
  if (!row) return { status: "refused", reason: "invalid" };
  if (row.incarnation !== plan.incarnation) return { status: "refused", reason: "fenced" };
  if (row.seq === null) return { status: "refused", reason: "expired" };
  if (row.seq !== envelope.seq || row.plan !== canonicalPlan(plan))
    return { status: "refused", reason: "invalid" };
  if (row.settled_at !== null || row.now >= (row.valid_until as number))
    return { status: "refused", reason: "expired" };
  if (plan.recipientType === "UserDO" && row.epoch !== plan.epoch)
    return { status: "refused", reason: "fenced" };
  if (expected.ownerId !== undefined && row.owned !== 1)
    return { status: "refused", reason: "invalid" };
  return { status: "valid", ledgerAt: row.now, epoch: row.epoch, lifecycle: row.lifecycle };
}

/** A completion's canonical JSON (what a settlement stores and compares). */
export function canonicalCompletion(c: LiveDurationCompletion): string {
  return JSON.stringify({
    protocol: c.protocol,
    operationId: c.operationId,
    incarnation: c.incarnation,
    recipientType: c.recipientType,
    recipient: c.recipient,
    epoch: c.epoch,
    finishedAt: c.finishedAt,
    actual: c.actual.map((a) => ({ day: a.day, ms: a.ms })),
  });
}

/**
 * Whether `c` is a well-formed completion of `grant`: its identity,
 * exactly its held days, each within its hold, finished within them.
 */
export function isLiveCompletionOf(grant: LiveEnvelope, c: unknown): c is LiveDurationCompletion {
  if (completionError(c as LiveDurationCompletion)) return false;
  const completion = c as LiveDurationCompletion;
  const plan = grant.plan;
  const held = plan.charges.filter((charge) => charge.duration).map((charge) => charge.day);
  return (
    completion.operationId === grant.operationId &&
    completion.incarnation === plan.incarnation &&
    completion.recipientType === plan.recipientType &&
    completion.recipient === plan.recipient &&
    completion.epoch === plan.epoch &&
    completion.actual.length === held.length &&
    completion.actual.every((a) => {
      const hold = plan.charges.find((charge) => charge.day === a.day)?.duration;
      return hold !== null && hold !== undefined && a.ms <= hold.ms;
    }) &&
    plan.charges.some(
      (charge) =>
        charge.duration !== null &&
        completion.finishedAt >= charge.duration.from &&
        completion.finishedAt <= charge.duration.until,
    )
  );
}

function completionError(c: LiveDurationCompletion): boolean {
  return (
    typeof c !== "object" ||
    c === null ||
    c.protocol !== 1 ||
    typeof c.operationId !== "string" ||
    c.operationId.length > 300 ||
    typeof c.incarnation !== "string" ||
    !["UserDO", "OrgDO", "MaintenanceDO"].includes(c.recipientType) ||
    typeof c.recipient !== "string" ||
    !isCount(c.epoch) ||
    !isCount(c.finishedAt) ||
    !Array.isArray(c.actual) ||
    c.actual.length < 1 ||
    c.actual.length > 2 ||
    !c.actual.every(
      (a) => typeof a === "object" && a !== null && isCount(a.day) && isCount(a.ms),
    ) ||
    new Set(c.actual.map((a) => a.day)).size !== c.actual.length
  );
}

/**
 * Settles a grant's duration once: accepted only for the receipt it names
 * (its recipient, epoch and incarnation, the ledger's), unsettled, before
 * its settlement deadline, with exactly the days it reserved, each at most
 * what was reserved, its finish within the holds, and every hold still in
 * escrow; then each day gets back its own unused part (never another day)
 * and loses the hold. The same completion again is a duplicate; another is
 * refused. Nothing but duration is ever refunded.
 */
export async function settleLiveDuration(
  db: D1Database,
  completion: LiveDurationCompletion,
): Promise<LiveSettlementResult> {
  if (completionError(completion)) return "invalid";
  const mint = crypto.randomUUID();
  const text = canonicalCompletion(completion);
  const op = completion.operationId;
  /** The reserved hold of a charge on `day` (`json_each` over the receipt's charges). */
  const held = (day: string, field: "ms" | "from" | "until") =>
    `(SELECT CAST(json_extract(c.value, '$.duration.${field}') AS INTEGER)
       FROM json_each(r.plan, '$.charges') c
       WHERE json_extract(c.value, '$.day') = ${day} AND json_extract(c.value, '$.duration') IS NOT NULL)`;
  const accepted = (b: (value: string | number) => string) =>
    `EXISTS (SELECT 1 FROM live_budget_receipts WHERE operation_id = ${b(op)}
      AND settlement_mint = ${b(mint)} AND completion = ${b(text)})`;
  const statements = [
    statement(
      db,
      (b) => `UPDATE live_budget_receipts AS r
  SET settled_at = ${N}, completion = ${b(text)}, settlement_mint = ${b(mint)}
  WHERE operation_id = ${b(op)} AND incarnation = ${b(completion.incarnation)}
    AND incarnation = (SELECT incarnation FROM live_budget_state WHERE id = 1)
    -- An operation with owners is settled by them alone.
    AND NOT EXISTS (SELECT 1 FROM live_duration_owners WHERE operation_id = r.operation_id)
    AND recipient_type = ${b(completion.recipientType)} AND recipient = ${b(completion.recipient)}
    AND epoch = ${completion.epoch} AND settled_at IS NULL AND ${N} < settle_until
    -- Exactly the reserved days, each within its hold and still in escrow.
    AND (SELECT count(*) FROM json_each(r.plan, '$.charges') c
         WHERE json_extract(c.value, '$.duration') IS NOT NULL) = ${completion.actual.length}
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${b(text)}, '$.actual') a
      WHERE coalesce(json_extract(a.value, '$.ms') > ${held("json_extract(a.value, '$.day')", "ms")}, 1)
        OR NOT EXISTS (
          SELECT 1 FROM live_budget_days d, json_each(d.escrow) e
          WHERE d.day = json_extract(a.value, '$.day')
            AND json_extract(e.value, '$.id') = r.operation_id
            AND json_extract(e.value, '$.ms') = ${held("json_extract(a.value, '$.day')", "ms")}))
    AND ${completion.finishedAt} >= (SELECT min(CAST(json_extract(c.value, '$.duration.from') AS INTEGER))
         FROM json_each(r.plan, '$.charges') c WHERE json_extract(c.value, '$.duration') IS NOT NULL)
    AND ${completion.finishedAt} <= (SELECT max(CAST(json_extract(c.value, '$.duration.until') AS INTEGER))
         FROM json_each(r.plan, '$.charges') c WHERE json_extract(c.value, '$.duration') IS NOT NULL)`,
    ),
    ...completion.actual.map((a) =>
      statement(
        db,
        (b) => `UPDATE live_budget_days
  SET do_duration_ms = do_duration_ms - (reserved.ms - ${a.ms}),
    protected_do_duration_ms = protected_do_duration_ms
      - CASE WHEN reserved.class = 'cleanup' THEN reserved.ms - ${a.ms} ELSE 0 END,
    escrow = json_remove(escrow, '$[' || (
      SELECT key FROM json_each(live_budget_days.escrow)
      WHERE json_extract(value, '$.id') = ${b(op)}) || ']')
  FROM (SELECT r.class, ${held(String(a.day), "ms")} AS ms
        FROM live_budget_receipts r WHERE r.operation_id = ${b(op)}) AS reserved
  WHERE day = ${a.day} AND ${accepted(b)}
    AND EXISTS (SELECT 1 FROM json_each(live_budget_days.escrow)
      WHERE json_extract(value, '$.id') = ${b(op)} AND json_extract(value, '$.ms') = reserved.ms)`,
      ),
    ),
    statement(
      db,
      (
        b,
      ) => `SELECT ${N} AS now, (SELECT incarnation FROM live_budget_state WHERE id = 1) AS incarnation,
    r.settlement_mint, r.completion, r.settle_until, r.incarnation AS receipt_incarnation
  FROM (SELECT 1) LEFT JOIN live_budget_receipts r ON r.operation_id = ${b(op)}`,
    ),
  ];
  let row:
    | {
        now: number;
        incarnation: string;
        settlement_mint: string | null;
        completion: string | null;
        settle_until: number | null;
        receipt_incarnation: string | null;
      }
    | undefined;
  try {
    const results = await db.batch(statements);
    row = (results.at(-1)?.results ?? [])[0] as typeof row;
  } catch {
    return "invalid";
  }
  if (!row) return "invalid";
  if (row.settlement_mint === mint) return "settled";
  if (row.completion !== null) return row.completion === text ? "duplicate" : "invalid";
  if (row.receipt_incarnation === null) return "expired";
  if (row.incarnation !== completion.incarnation || row.receipt_incarnation !== row.incarnation)
    return "fenced";
  if (row.now >= (row.settle_until as number)) return "expired";
  return "invalid";
}

/** A page size within its declared bound. */
function page(limit: number | undefined, max: number): number {
  const n = limit ?? max;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new RangeError(`limit ${n}`);
  return n;
}

/**
 * Removes up to a page of receipts past their expiry (the earliest first):
 * their escrow holds go from the days they name (their duration stays
 * charged: an unsettled hold is never refunded), and their directory
 * cleanup debt leaves the ledger, in one batch whose every statement
 * repeats that each receipt is selected and still expired (one gone
 * meanwhile subtracts nothing). Targets and local watermarks are not
 * touched: a receipt's expiry is not its feed's cleanup.
 */
export async function expireLiveReceipts(
  db: D1Database,
  limit?: number,
): Promise<{ readonly expired: number }> {
  const n = page(limit, LIVE_RECEIPT_PAGE);
  const primary = db.withSession("first-primary");
  const { results } = await primary
    .prepare(
      `SELECT seq, plan FROM live_budget_receipts INDEXED BY live_budget_receipts_expiry
       WHERE expires_at <= ${N} ORDER BY expires_at, seq LIMIT ?`,
    )
    .bind(n)
    .all<{ seq: number; plan: string }>();
  if (results.length === 0) return { expired: 0 };
  const selected = JSON.stringify(results.map((r) => r.seq));
  const eligible = `seq IN (SELECT value FROM json_each(?1)) AND expires_at <= ${N}`;
  const days = [
    ...new Set(
      results.flatMap((r) =>
        (JSON.parse(r.plan) as LiveGrantPlan).charges.filter((c) => c.duration).map((c) => c.day),
      ),
    ),
  ];
  const statements = [
    ...days.map((day) =>
      db
        .prepare(
          `UPDATE live_budget_days SET escrow = (
             SELECT json_group_array(json(value)) FROM (
               SELECT value FROM json_each(live_budget_days.escrow)
               WHERE json_extract(value, '$.id') NOT IN (
                 SELECT operation_id FROM live_budget_receipts WHERE ${eligible})
               ORDER BY key))
           WHERE day = ?2 AND EXISTS (
             SELECT 1 FROM json_each(live_budget_days.escrow) j
               JOIN live_budget_receipts r ON r.operation_id = json_extract(j.value, '$.id')
             WHERE r.seq IN (SELECT value FROM json_each(?1)) AND r.expires_at <= ${N})`,
        )
        .bind(selected, day),
    ),
    db
      .prepare(
        `UPDATE live_budget_state SET ${R.map(
          (r) =>
            `debt_${r} = debt_${r} - coalesce((SELECT sum(${v("directory_cleanup_debt", r)})
               FROM live_budget_receipts WHERE ${eligible}), 0)`,
        ).join(", ")}
         WHERE id = 1`,
      )
      .bind(selected),
    db.prepare(`DELETE FROM live_budget_receipts WHERE ${eligible} RETURNING seq`).bind(selected),
  ];
  const out = await db.batch(statements);
  return { expired: out.at(-1)?.results.length ?? 0 };
}

/**
 * Removes up to a page of day rows older than a week that no receipt may
 * still need (`retain_until` passed), their own cleanup debt leaving the
 * ledger with them, once.
 */
export async function pruneLiveBudgetDays(
  db: D1Database,
  limit?: number,
): Promise<{ readonly removed: number }> {
  const n = page(limit, LIVE_DAY_PAGE);
  const { results } = await db
    .withSession("first-primary")
    .prepare(
      `SELECT day FROM live_budget_days WHERE day < ${D} - 7 AND retain_until <= ${N}
       ORDER BY day LIMIT ?`,
    )
    .bind(n)
    .all<{ day: number }>();
  if (results.length === 0) return { removed: 0 };
  const selected = JSON.stringify(results.map((r) => r.day));
  const eligible = `day IN (SELECT value FROM json_each(?1)) AND day < ${D} - 7 AND retain_until <= ${N}`;
  const out = await db.batch([
    db
      .prepare(
        `UPDATE live_budget_state SET ${R.map(
          (r) =>
            `debt_${r} = debt_${r} - coalesce((SELECT sum(${v("cleanup_debt", r)})
               FROM live_budget_days WHERE ${eligible}), 0)`,
        ).join(", ")}
         WHERE id = 1`,
      )
      .bind(selected),
    db.prepare(`DELETE FROM live_budget_days WHERE ${eligible} RETURNING day`).bind(selected),
  ]);
  return { removed: out.at(-1)?.results.length ?? 0 };
}
