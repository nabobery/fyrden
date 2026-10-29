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
 * including theirs. Nothing in production calls them yet.
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
  | "mark"
  | "maintenance"
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
  "mark",
  "maintenance",
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

export type LiveGrantResult =
  | { readonly status: "granted"; readonly replay: boolean; readonly grant: LiveEnvelope }
  | { readonly status: "refused"; readonly reason: LiveRefusal };

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

/** When a grant's settlement window closes, and when its receipt may be removed. */
export function liveReceiptDeadlines(plan: LiveGrantPlan): {
  readonly settleUntil: number;
  readonly expiresAt: number;
} {
  const covered = plan.charges.flatMap((c) => (c.duration ? [c.duration.until] : []));
  const settleUntil =
    covered.length > 0 ? Math.max(plan.validUntil, Math.max(...covered) + DAY) : plan.validUntil;
  return { settleUntil, expiresAt: Math.max(plan.validUntil + 2 * DAY, settleUntil) };
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
    if (hold === null) {
      if (charge.resources.do_duration_ms !== 0) return "duration";
      continue;
    }
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

/** The ordinary-debt and day-debt each charge would add: for days without a row yet. */
function addedDebt(plan: LiveGrantPlan, r: DiscretionaryResource): string {
  const newDays = plan.charges
    .map(
      (c) =>
        `(CASE WHEN EXISTS (SELECT 1 FROM live_budget_days WHERE day = ${c.day}) THEN 0 ELSE ${plan.dayCleanupDebt[r]} END)`,
    )
    .join(" + ");
  return `(${plan.directoryCleanupDebt[r] + plan.localCleanupDebt[r]} + ${newDays})`;
}

/** Whether each charge fits its day (all of it, and ordinary work outside the protected part). */
function fits(charge: LiveDayCharge, ordinary: boolean): string {
  const parts = R.filter((r) => charge.resources[r] > 0).flatMap((r) => [
    `coalesce((SELECT ${r} FROM live_budget_days WHERE day = ${charge.day}), 0) + ${charge.resources[r]} <= ${LIVE_DAILY[r]}`,
    ...(ordinary
      ? [
          `coalesce((SELECT ${r} - protected_${r} FROM live_budget_days WHERE day = ${charge.day}), 0) + ${charge.resources[r]} <= ${LIVE_DAILY[r] - LIVE_PROTECTED[r]}`,
        ]
      : []),
  ]);
  if (charge.duration)
    parts.push(
      `coalesce((SELECT json_array_length(escrow) FROM live_budget_days WHERE day = ${charge.day}), 0) < ${LIVE_ESCROW_ENTRIES}`,
    );
  return parts.length > 0 ? parts.join(" AND ") : "1";
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
): Promise<LiveGrantResult> {
  const refused = (reason: LiveRefusal): LiveGrantResult => ({ status: "refused", reason });
  const plan = request.plan;
  if (livePlanError(plan) !== null || !(await identityHolds(request))) return refused("invalid");
  const mint = crypto.randomUUID();
  const { settleUntil, expiresAt } = liveReceiptDeadlines(plan);
  const ordinary = plan.class === "ordinary";
  const planText = canonicalPlan(plan);
  const source = feedEpochSource(plan.recipient);
  const first = plan.charges[0] as LiveDayCharge;
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
      const epochCurrent =
        plan.recipientType === "UserDO"
          ? `${plan.epoch} = coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ${b(source)}), 0)`
          : "1";
      const targetCurrent = plan.producesLocal
        ? `NOT EXISTS (SELECT 1 FROM live_recovery_targets WHERE feed = ${b(plan.recipient)} AND incarnation <> ${b(plan.incarnation)})`
        : "1";
      const ordinaryGates = ordinary
        ? [
            ...R.map((r) => `debt_${r} + ${addedDebt(plan, r)} <= ${LIVE_ORDINARY_DEBT_LIMIT[r]}`),
            `NOT EXISTS (SELECT 1 FROM live_budget_receipts WHERE expires_at <= ${N} ORDER BY expires_at, seq LIMIT 1)`,
            `NOT EXISTS (SELECT 1 FROM live_budget_days WHERE day < ${D} - 7 AND retain_until <= ${N} ORDER BY day LIMIT 1)`,
          ].join("\n    AND ")
        : "1";
      return `UPDATE live_budget_state
  SET grant_seq = grant_seq + 1, last_mint = ${b(mint)}, last_mint_at = ${N},
    ${R.map((r) => `debt_${r} = debt_${r} + ${addedDebt(plan, r)}`).join(",\n    ")}
  WHERE id = 1 AND incarnation = ${b(plan.incarnation)} AND grant_seq < ${MAX}
    AND ${plan.validFrom} <= ${N} AND ${N} < ${plan.validUntil}
    AND ${first.day} = ${D}
    AND NOT EXISTS (SELECT 1 FROM live_budget_receipts WHERE operation_id = ${b(request.operationId)})
    AND ${plan.charges.map((c) => fits(c, ordinary)).join("\n    AND ")}
    AND ${ordinaryGates}
    AND ${epochCurrent}
    AND ${targetCurrent}`;
    }),
  );
  for (const charge of plan.charges) {
    const held = charge.duration?.ms ?? 0;
    statements.push(
      statement(db, (b) => {
        const entry = `json_object('id', ${b(request.operationId)}, 'ms', ${held})`;
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
    (feed, incarnation, through_seq, next_attempt_at, attempts, local_cleanup_debt)
  SELECT ${b(plan.recipient)}, ${b(plan.incarnation)}, seq, ${plan.validUntil}, 0,
    ${b(vectorJson(plan.localCleanupDebt))}
  FROM live_budget_receipts WHERE operation_id = ${b(request.operationId)} AND ${G(b)}
  ON CONFLICT (feed) DO UPDATE SET
    through_seq = excluded.through_seq,
    next_attempt_at = min(live_recovery_targets.next_attempt_at, excluded.next_attempt_at),
    local_cleanup_debt = json_object(${R.map(
      (r) =>
        `'${r}', ${v("live_recovery_targets.local_cleanup_debt", r)} + ${v("excluded.local_cleanup_debt", r)}`,
    ).join(", ")})
  WHERE live_recovery_targets.incarnation = excluded.incarnation`,
      ),
    );
  // What happened, and if nothing did, why: read in the same batch.
  const firstDayFails = R.filter((r) => first.resources[r] > 0)
    .flatMap((r) => [
      `coalesce((SELECT ${r} FROM live_budget_days WHERE day = ${first.day}), 0) + ${first.resources[r]} > ${LIVE_DAILY[r]}`,
      ...(ordinary
        ? [
            `coalesce((SELECT ${r} - protected_${r} FROM live_budget_days WHERE day = ${first.day}), 0) + ${first.resources[r]} > ${LIVE_DAILY[r] - LIVE_PROTECTED[r]}`,
          ]
        : []),
    ])
    .join(" OR ");
  statements.push(
    statement(
      db,
      (b) => `SELECT ${N} AS now, ${D} AS today,
    (SELECT incarnation FROM live_budget_state WHERE id = 1) AS incarnation,
    ${plan.recipientType === "UserDO" ? `coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ${b(source)}), 0)` : "NULL"} AS epoch,
    (SELECT ${firstDayFails || "0"}) AS daily,
    r.seq, r.mint, r.plan, r.incarnation AS receipt_incarnation, r.granted_at, r.settled_at,
    r.valid_until
  FROM (SELECT 1) LEFT JOIN live_budget_receipts r ON r.operation_id = ${b(request.operationId)}`,
    ),
  );
  let rows: {
    now: number;
    today: number;
    incarnation: string;
    epoch: number | null;
    daily: number;
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
    return refused("temporary");
  }
  const row = rows[0];
  if (!row) return refused("temporary");
  const envelope = (): LiveEnvelope => ({
    protocol: 1,
    operationId: request.operationId,
    seq: row.seq as number,
    ledgerAt: row.granted_at as number,
    plan,
  });
  if (row.seq !== null) {
    if (row.plan !== canonicalPlan(plan) || row.receipt_incarnation !== plan.incarnation)
      return refused("invalid");
    // `mint` is private to this call: equal only when this batch granted it.
    if (row.mint === mint) return { status: "granted", replay: false, grant: envelope() };
    if (row.settled_at !== null || row.now >= (row.valid_until as number))
      return refused("expired");
    // A replay is fenced as a new grant would be (a restore, another incarnation since).
    if (row.incarnation !== plan.incarnation) return refused("fenced");
    if (plan.recipientType === "UserDO" && row.epoch !== plan.epoch) return refused("fenced");
    return { status: "granted", replay: true, grant: envelope() };
  }
  if (row.now >= plan.validUntil) return refused("expired");
  if (row.incarnation !== plan.incarnation) return refused("fenced");
  if (plan.recipientType === "UserDO" && row.epoch !== plan.epoch) return refused("fenced");
  if (row.now >= plan.validFrom && first.day === row.today && row.daily === 1)
    return refused("daily");
  return refused("temporary");
}

/**
 * Whether `envelope` is a grant the ledger holds for this recipient and
 * kind (the receipt by its identity, its stored plan and sequence equal,
 * unexpired and unsettled), read with D1's time, the ledger's incarnation,
 * the feed's epoch and the principal's lifecycle in one statement.
 */
export async function validateLiveCoverage(
  db: D1Database,
  envelope: LiveEnvelope,
  expected: {
    readonly recipientType: LiveRecipientType;
    readonly recipient: string;
    readonly kind: LiveUnit;
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
        r.seq, r.plan, r.valid_until, r.expires_at, r.settled_at
      FROM (SELECT 1) LEFT JOIN live_budget_receipts r ON r.operation_id = ?1`,
    )
    .bind(envelope.operationId, feedEpochSource(plan.recipient), plan.recipient)
    .first<{
      now: number;
      incarnation: string;
      epoch: number;
      lifecycle: string | null;
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
