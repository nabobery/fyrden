import { LIVE_DAILY, LIVE_NOW, LIVE_PROTECTED, type LiveRecipientType } from "./budget.js";

/*
 * Who keeps an object busy, and for how long (migration 0035). A funded
 * physical operation on an object is an owner: admitted, all of a request's
 * owners or none, within the deployment's and each object's caps (cleanup's
 * places never taken by ordinary work), before it is dispatched; marked
 * dispatched with its start before the work begins; observed once (its
 * physical finish and what is charged through, its tail included); settled
 * a page of days at a time against the holds its grant reserved (what it
 * used past them charged to the day it was used on and owed as duration
 * debt, what it left unused refunded only while the grant's hold is still
 * in escrow); then released. An owner that cannot be shown finished is
 * uncertain and keeps its place: nothing reclaims it by time. A result's
 * deadline, a socket's close, a receipt's expiry or a day's pruning never
 * release one.
 *
 * Accounting helpers: their caller pays for its own work, theirs
 * included. Nothing in production calls them yet.
 */

const DAY = 86_400_000;
const N = LIVE_NOW;
const D = `CAST(${N} / ${DAY} AS INTEGER)`;

/** Days a settlement page covers at most. */
export const LIVE_OWNER_PAGE_DAYS = 4;

/** Owners one request admits at most (a caller and its callees). */
export const LIVE_OWNERS_PER_REQUEST = 4;

/** Places owners may hold (caps across days and instances). Declared by the caller: no production values yet. */
export interface LiveOwnerLimits {
  readonly deploymentTotal: number;
  readonly deploymentOrdinary: number;
  readonly deploymentCleanup: number;
  readonly perObjectOrdinary: number;
  readonly perObjectCleanup: number;
}

export interface LiveOwnerRef {
  readonly ownerId: string;
  readonly operationId: string;
  readonly objectType: LiveRecipientType;
  readonly objectId: string;
  readonly incarnation: string;
  readonly epoch: number;
}

export interface LiveOwnerHold {
  readonly day: number;
  readonly ms: number;
}

/**
 * Owners to admit together (a caller and its callees): each funded by its
 * own grant, whose recipient is its object and whose holds are its holds
 * (never the caller's say), one owner a grant, ever.
 */
export interface LiveOwnerRequest {
  readonly incarnation: string;
  readonly class: "ordinary" | "cleanup";
  readonly dispatchFrom: number;
  readonly dispatchUntil: number;
  readonly owners: readonly {
    readonly operationId: string;
    readonly role: string;
    readonly parentRole?: string;
  }[];
}

/** What a finished operation used: from its start to its physical finish, charged through its tail. */
export interface LiveOwnerObservation {
  readonly startedAt: number;
  readonly physicalFinishedAt: number;
  readonly chargedThrough: number;
}

export type LiveOwnerRefusal =
  | "capacity"
  | "blocked"
  | "unfunded"
  | "duplicate"
  | "invalid"
  | "temporary";

/** An owner's identity: its operation and its role in it (the same attempt never mints another). */
export const liveOwnerId = (operationId: string, role: string) => `${operationId}/${role}`;

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

function requestError(r: LiveOwnerRequest, limits: LiveOwnerLimits): boolean {
  const roles = r.owners.map((o) => o.role);
  const operations = r.owners.map((o) => o.operationId);
  return (
    r.owners.length < 1 ||
    r.owners.length > LIVE_OWNERS_PER_REQUEST ||
    new Set(roles).size !== roles.length ||
    new Set(operations).size !== operations.length ||
    !isCount(r.dispatchFrom) ||
    !isCount(r.dispatchUntil) ||
    r.dispatchUntil <= r.dispatchFrom ||
    !Object.values(limits).every(isCount) ||
    limits.deploymentOrdinary + limits.deploymentCleanup > limits.deploymentTotal ||
    !r.owners.every(
      (o) =>
        /^[a-z][a-z0-9_]{0,31}$/.test(o.role) &&
        o.operationId.length > 0 &&
        o.operationId.length <= 300 &&
        (o.parentRole === undefined || (o.parentRole !== o.role && roles.includes(o.parentRole))),
    )
  );
}

/** Values bound by position, each distinct value once. */
function bound(build: (b: (value: string | number) => string) => string): {
  sql: string;
  values: (string | number)[];
} {
  const values: (string | number)[] = [];
  const sql = build((value) => {
    const at = values.indexOf(value);
    if (at >= 0) return `?${at + 1}`;
    values.push(value);
    return `?${values.length}`;
  });
  return { sql, values };
}

const prepared = (db: D1Database, build: (b: (value: string | number) => string) => string) => {
  const { sql, values } = bound(build);
  return db.prepare(sql).bind(...values);
};

/**
 * Whether ordinary duration may be admitted now: not blocked, the day's
 * reserve not spent, and the debt owed with what ordinary work used today
 * leaving room within its part of the allowance.
 */
const ORDINARY_DURATION_OPEN = `(SELECT s.ordinary_duration_blocked = 0
    AND (s.duration_reserve_ms = 0
      OR coalesce((SELECT reserve_used_ms FROM live_budget_days WHERE day = ${D}), 0) < s.duration_reserve_ms)
    AND coalesce((SELECT do_duration_ms - protected_do_duration_ms + debt_withheld_ms
        FROM live_budget_days WHERE day = ${D}), 0)
      + s.duration_debt_ms + s.duration_reserve_ms
      < ${LIVE_DAILY.do_duration_ms - LIVE_PROTECTED.do_duration_ms}
  FROM live_budget_state s WHERE s.id = 1)`;

/**
 * Admits a request's owners, all or none, in one batch: the ledger's owner
 * transition (its incarnation; each owner's grant live, unsettled, of the
 * class, its validity covering the dispatch window, which is not over, and
 * never an owner's before; the deployment's places and each object's for
 * the class, with those already held, uncertain ones included; ordinary
 * duration open), then each owner from its grant's receipt (its object,
 * epoch and holds), repeating that this batch's transition is the one that
 * happened.
 */
export async function admitLiveOwners(
  db: D1Database,
  request: LiveOwnerRequest,
  limits: LiveOwnerLimits,
): Promise<
  | { readonly status: "admitted"; readonly owners: readonly LiveOwnerRef[] }
  | { readonly status: "refused"; readonly reason: LiveOwnerRefusal }
> {
  const refused = (reason: LiveOwnerRefusal) => ({ status: "refused" as const, reason });
  if (requestError(request, limits)) return refused("invalid");
  const mint = crypto.randomUUID();
  const ids = request.owners.map((o) => liveOwnerId(o.operationId, o.role));
  const ordinary = request.class === "ordinary";
  const n = request.owners.length;
  const perObject = ordinary ? limits.perObjectOrdinary : limits.perObjectCleanup;
  const classLimit = ordinary ? limits.deploymentOrdinary : limits.deploymentCleanup;
  type Bind = (value: string | number) => string;
  const ops = (b: Bind) => request.owners.map((o) => b(o.operationId)).join(", ");
  /** Each grant funding its owner now (and never an owner before). */
  const funds = (b: Bind) => `r.incarnation = ${b(request.incarnation)}
        AND r.class = ${b(request.class)} AND r.settled_at IS NULL AND ${N} < r.valid_until
        AND r.valid_from <= ${request.dispatchFrom} AND ${request.dispatchUntil} <= r.valid_until
        AND json_array_length(r.released_owners) = 0`;
  const gate = prepared(db, (b) => {
    const list = ops(b);
    return `UPDATE live_budget_state SET owner_mint = ${b(mint)}
  WHERE id = 1 AND incarnation = ${b(request.incarnation)}
    AND ${N} < ${request.dispatchUntil}
    AND (SELECT count(*) FROM live_budget_receipts r
      WHERE r.operation_id IN (${list}) AND ${funds(b)}) = ${n}
    AND NOT EXISTS (SELECT 1 FROM live_duration_owners WHERE operation_id IN (${list}))
    AND (SELECT count(*) FROM live_duration_owners) + ${n} <= ${limits.deploymentTotal}
    AND (SELECT count(*) FROM live_duration_owners WHERE class = ${b(request.class)}) + ${n} <= ${classLimit}
    -- Each object's places: those held, and this request's own for it.
    AND NOT EXISTS (SELECT 1 FROM live_budget_receipts r WHERE r.operation_id IN (${list})
      AND (SELECT count(*) FROM live_duration_owners o
           WHERE o.object_type = r.recipient_type AND o.object_id = r.recipient
             AND o.class = ${b(request.class)})
        + (SELECT count(*) FROM live_budget_receipts x WHERE x.operation_id IN (${list})
           AND x.recipient_type = r.recipient_type AND x.recipient = r.recipient) > ${perObject})
    AND ${ordinary ? ORDINARY_DURATION_OPEN : "1"}`;
  });
  const inserts = request.owners.map((o, i) =>
    prepared(
      db,
      (b) => `INSERT INTO live_duration_owners (owner_id, operation_id, object_type, object_id,
    parent_id, class, epoch, incarnation, dispatch_from, dispatch_until, holds, status, admitted_at)
  SELECT ${b(ids[i] as string)}, r.operation_id, r.recipient_type, r.recipient,
    ${o.parentRole === undefined ? "NULL" : b(ids[request.owners.findIndex((p) => p.role === o.parentRole)] as string)},
    r.class, r.epoch, r.incarnation, ${request.dispatchFrom}, ${request.dispatchUntil},
    (SELECT json_group_array(json_object(
        'day', CAST(json_extract(c.value, '$.day') AS INTEGER),
        'ms', CAST(json_extract(c.value, '$.duration.ms') AS INTEGER)))
      FROM json_each(r.plan, '$.charges') c WHERE json_extract(c.value, '$.duration') IS NOT NULL),
    'reserved', ${N}
  FROM live_budget_receipts r WHERE r.operation_id = ${b(o.operationId)}
    AND EXISTS (SELECT 1 FROM live_budget_state WHERE id = 1 AND owner_mint = ${b(mint)})`,
    ),
  );
  // What happened, and if nothing did, why: read in the same batch.
  const why = prepared(db, (b) => {
    const list = ops(b);
    return `SELECT (SELECT owner_mint FROM live_budget_state WHERE id = 1) = ${b(mint)} AS admitted,
    (SELECT incarnation FROM live_budget_state WHERE id = 1) = ${b(request.incarnation)} AS current,
    ${N} < ${request.dispatchUntil} AND (SELECT count(*) FROM live_budget_receipts r
      WHERE r.operation_id IN (${list}) AND (${funds(b)}
        OR json_array_length(r.released_owners) > 0)) = ${n} AS funded,
    (EXISTS (SELECT 1 FROM live_duration_owners WHERE operation_id IN (${list}))
      OR EXISTS (SELECT 1 FROM live_budget_receipts r WHERE r.operation_id IN (${list})
        AND json_array_length(r.released_owners) > 0)) AS duplicate,
    ${ordinary ? ORDINARY_DURATION_OPEN : "1"} AS open`;
  });
  const admitted = prepared(
    db,
    (b) => `SELECT owner_id, operation_id, object_type, object_id, incarnation, epoch
  FROM live_duration_owners WHERE owner_id IN (${ids.map((id) => b(id)).join(", ")})`,
  );
  let row: { admitted: number; current: number; funded: number; duplicate: number; open: number };
  let owners: {
    owner_id: string;
    operation_id: string;
    object_type: LiveRecipientType;
    object_id: string;
    incarnation: string;
    epoch: number;
  }[];
  try {
    const results = await db.batch([gate, ...inserts, why, admitted]);
    row = results.at(-2)?.results[0] as typeof row;
    owners = (results.at(-1)?.results ?? []) as typeof owners;
  } catch {
    return refused("temporary");
  }
  if (!row) return refused("temporary");
  if (row.admitted === 1)
    return {
      status: "admitted",
      owners: ids.map((id) => {
        const o = owners.find((x) => x.owner_id === id);
        if (!o) throw new Error(`owner ${id} admitted but not read back`);
        return {
          ownerId: o.owner_id,
          operationId: o.operation_id,
          objectType: o.object_type,
          objectId: o.object_id,
          incarnation: o.incarnation,
          epoch: o.epoch,
        };
      }),
    };
  if (row.duplicate === 1) return refused("duplicate");
  if (row.current !== 1 || row.funded !== 1) return refused("unfunded");
  if (row.open !== 1) return refused("blocked");
  return refused("capacity");
}

/**
 * Marks an admitted owner dispatched by `instance`, its work starting
 * `startedAt` (within its dispatch window), before the work begins.
 * `already` when it was marked before: never permission to dispatch again.
 */
export async function markLiveOwnerDispatched(
  db: D1Database,
  ownerId: string,
  dispatch: { readonly instance: string; readonly startedAt: number },
): Promise<"dispatched" | "already" | "blocked" | "missing" | "invalid"> {
  if (!isCount(dispatch.startedAt) || dispatch.instance.length === 0) return "invalid";
  const [marked, row] = await db.batch<{ status?: string; class?: string; open?: number }>([
    db
      .prepare(
        `UPDATE live_duration_owners SET status = 'dispatched', instance = ?2, started_at = ?3
         WHERE owner_id = ?1 AND status = 'reserved'
           AND ?3 >= dispatch_from AND ?3 < dispatch_until AND ${N} < dispatch_until
           -- Ordinary work only while ordinary duration is open (as it may have closed since).
           AND (class = 'cleanup' OR ${ORDINARY_DURATION_OPEN})`,
      )
      .bind(ownerId, dispatch.instance, dispatch.startedAt),
    db
      .prepare(
        `SELECT status, class, ${ORDINARY_DURATION_OPEN} AS open
         FROM live_duration_owners WHERE owner_id = ?`,
      )
      .bind(ownerId),
  ]);
  if ((marked?.meta.changes ?? 0) > 0) return "dispatched";
  const held = row?.results[0];
  if (held?.status === undefined) return "missing";
  if (held.status !== "reserved") return "already";
  return held.class === "ordinary" && held.open !== 1 ? "blocked" : "invalid";
}

/**
 * Marks dispatched owners uncertain (their work's end cannot be shown: the
 * instance that held it is gone). They keep their places; how many changed.
 */
export async function quarantineLiveOwners(
  db: D1Database,
  ownerIds: readonly string[],
): Promise<number> {
  if (ownerIds.length === 0) return 0;
  const { meta } = await db
    .prepare(
      `UPDATE live_duration_owners SET status = 'uncertain'
       WHERE owner_id IN (SELECT value FROM json_each(?1)) AND status = 'dispatched'`,
    )
    .bind(JSON.stringify(ownerIds))
    .run();
  return meta.changes ?? 0;
}

function observationError(o: LiveOwnerObservation): boolean {
  return (
    !isCount(o.startedAt) ||
    !isCount(o.physicalFinishedAt) ||
    !isCount(o.chargedThrough) ||
    o.physicalFinishedAt < o.startedAt ||
    o.chargedThrough < o.physicalFinishedAt
  );
}

/**
 * Accepts a dispatched (or uncertain) owner's observation once: its start
 * must be the one it was dispatched with. The same observation again is a
 * duplicate; another is refused and changes nothing.
 */
export async function observeLiveOwner(
  db: D1Database,
  ownerId: string,
  observation: LiveOwnerObservation,
): Promise<"accepted" | "duplicate" | "invalid" | "missing"> {
  if (observationError(observation)) return "invalid";
  const { startedAt, physicalFinishedAt, chargedThrough } = observation;
  const [accepted, row] = await db.batch<{
    started_at?: number;
    finished_at?: number | null;
    charged_through?: number | null;
  }>([
    db
      .prepare(
        `UPDATE live_duration_owners SET status = 'observing', finished_at = ?3,
           charged_through = ?4,
           -- From its earliest day: the start's, or a held day before it.
           cursor = min(?5, coalesce((SELECT min(CAST(json_extract(value, '$.day') AS INTEGER))
             FROM json_each(live_duration_owners.holds)), ?5))
         WHERE owner_id = ?1 AND status IN ('dispatched', 'uncertain') AND started_at = ?2`,
      )
      .bind(ownerId, startedAt, physicalFinishedAt, chargedThrough, Math.floor(startedAt / DAY)),
    db
      .prepare(
        "SELECT started_at, finished_at, charged_through FROM live_duration_owners WHERE owner_id = ?",
      )
      .bind(ownerId),
  ]);
  if ((accepted?.meta.changes ?? 0) > 0) return "accepted";
  const held = row?.results[0];
  if (held === undefined) return "missing";
  return held.started_at === startedAt &&
    held.finished_at === physicalFinishedAt &&
    held.charged_through === chargedThrough
    ? "duplicate"
    : "invalid";
}

/** How much of `[from, until)` falls on `day`. */
const overlap = (from: number, until: number, day: number) =>
  Math.max(0, Math.min(until, (day + 1) * DAY) - Math.max(from, day * DAY));

interface OwnerRow {
  owner_id: string;
  operation_id: string;
  incarnation: string;
  class: "ordinary" | "cleanup";
  holds: string;
  status: string;
  started_at: number | null;
  finished_at: number | null;
  charged_through: number | null;
  cursor: number | null;
}

/** An owner's per-day adjustment: what it used past its hold, and what of the hold it did not use. */
export function liveOwnerAdjustment(
  observation: LiveOwnerObservation,
  holds: readonly LiveOwnerHold[],
  day: number,
): { readonly used: number; readonly correction: number; readonly unused: number } {
  const used = overlap(observation.startedAt, observation.chargedThrough, day);
  const held = holds.find((h) => h.day === day)?.ms ?? 0;
  return { used, correction: Math.max(0, used - held), unused: Math.max(0, held - used) };
}

/**
 * Settles one page of an observed owner's days (at most `days`, from its
 * cursor), in one batch: the owner's transition (still observed as read,
 * its cursor where it was: two runners never apply a page twice, and a lost
 * reply is replayed against the cursor that committed), then each day's
 * correction (charged on that day whatever its allowance, and marked a
 * breach past it; a day pruned long ago keeps no row, the owner's interval
 * keeps the record) with its hold's refund while still in escrow (the
 * escrow entry then goes, so the grant's own settlement cannot refund it
 * again), and the corrections owed as duration debt. `accounted` once its
 * last day is settled.
 */
export async function settleLiveOwnerPage(
  db: D1Database,
  ownerId: string,
  days = LIVE_OWNER_PAGE_DAYS,
): Promise<
  | {
      readonly status: "settled" | "duplicate";
      readonly cursor: number;
      readonly accounted: boolean;
    }
  | { readonly status: "invalid" | "missing" }
> {
  if (!Number.isSafeInteger(days) || days < 1 || days > LIVE_OWNER_PAGE_DAYS)
    return { status: "invalid" };
  const owner = await db
    .withSession("first-primary")
    .prepare(
      `SELECT owner_id, operation_id, incarnation, class, holds, status, started_at, finished_at,
         charged_through, cursor FROM live_duration_owners WHERE owner_id = ?`,
    )
    .bind(ownerId)
    .first<OwnerRow>();
  if (!owner) return { status: "missing" };
  if (owner.status === "accounted")
    return { status: "duplicate", cursor: owner.cursor as number, accounted: true };
  if (owner.status !== "observing") return { status: "invalid" };
  const observation = {
    startedAt: owner.started_at as number,
    physicalFinishedAt: owner.finished_at as number,
    chargedThrough: owner.charged_through as number,
  };
  const holds = JSON.parse(owner.holds) as LiveOwnerHold[];
  const lastDay =
    observation.chargedThrough > observation.startedAt
      ? Math.floor((observation.chargedThrough - 1) / DAY)
      : Math.floor(observation.startedAt / DAY);
  // Every day the run touched or a hold names.
  const finalDay = Math.max(lastDay, ...holds.map((h) => h.day));
  const from = owner.cursor as number;
  const to = Math.min(from + days - 1, finalDay);
  const next = to + 1;
  const accounted = next > finalDay;
  const mint = crypto.randomUUID();
  const op = owner.operation_id;
  const cleanup = owner.class === "cleanup";
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE live_duration_owners SET cursor = ?3, accounting_mint = ?4,
           status = CASE WHEN ?5 THEN 'accounted' ELSE 'observing' END
         WHERE owner_id = ?1 AND status = 'observing' AND cursor = ?2
           AND started_at = ?6 AND finished_at = ?7 AND charged_through = ?8`,
      )
      .bind(
        ownerId,
        from,
        next,
        mint,
        accounted ? 1 : 0,
        observation.startedAt,
        observation.physicalFinishedAt,
        observation.chargedThrough,
      ),
  ];
  const applied = `EXISTS (SELECT 1 FROM live_duration_owners WHERE owner_id = ?1 AND accounting_mint = ?2)`;
  let corrections = 0;
  for (let day = from; day <= to; day++) {
    const { correction, unused } = liveOwnerAdjustment(observation, holds, day);
    const held = holds.find((h) => h.day === day)?.ms ?? 0;
    corrections += correction;
    if (correction === 0 && held === 0) continue;
    // The hold's refund, while the grant's escrow still holds it and the receipt may settle.
    const inEscrow = `EXISTS (SELECT 1 FROM json_each(live_budget_days.escrow)
        WHERE json_extract(value, '$.id') = ?3 AND json_extract(value, '$.ms') = ?5)`;
    // (Never under another incarnation of the ledger: a restored one's credit is not this one's.)
    const refundable = `(${inEscrow} AND EXISTS (SELECT 1 FROM live_budget_receipts
        WHERE operation_id = ?3 AND settled_at IS NULL AND ${N} < settle_until
          AND incarnation = (SELECT incarnation FROM live_budget_state WHERE id = 1)))`;
    statements.push(
      db
        .prepare(
          `INSERT INTO live_budget_days (day, do_requests, do_rows_read, do_rows_written,
             do_duration_ms, d1_rows_read, d1_rows_written, queue_ops, protected_do_duration_ms,
             reserve_used_ms, duration_breach, retain_until, cleanup_debt)
           SELECT ?4, 0, 0, 0, ?6, 0, 0, 0, ?7, ?6, ?6 > ${LIVE_DAILY.do_duration_ms},
             (?4 + 5) * ${DAY}, json_object('do_requests', 0, 'do_rows_read', 0,
               'do_rows_written', 0, 'do_duration_ms', 0, 'd1_rows_read', 0,
               'd1_rows_written', 0, 'queue_ops', 0)
           WHERE ${applied} AND ?6 > 0
             AND (?4 >= ${D} - 7 OR EXISTS (SELECT 1 FROM live_budget_days WHERE day = ?4))
           ON CONFLICT (day) DO UPDATE SET
             do_duration_ms = do_duration_ms + ?6
               - CASE WHEN ${refundable} THEN ?8 ELSE 0 END,
             protected_do_duration_ms = protected_do_duration_ms + ?7
               - CASE WHEN ${refundable} AND ?9 THEN ?8 ELSE 0 END,
             reserve_used_ms = reserve_used_ms + ?6,
             duration_breach = max(duration_breach,
               do_duration_ms + ?6 > ${LIVE_DAILY.do_duration_ms}),
             escrow = CASE WHEN ${inEscrow} THEN json_remove(escrow, '$[' || (
               SELECT key FROM json_each(live_budget_days.escrow)
               WHERE json_extract(value, '$.id') = ?3) || ']') ELSE escrow END`,
        )
        .bind(
          ownerId,
          mint,
          op,
          day,
          held,
          correction,
          cleanup ? correction : 0,
          unused,
          cleanup ? 1 : 0,
        ),
    );
    // A day with nothing to charge (its hold covered the run) still gives back its unused hold.
    if (correction === 0)
      statements.push(
        db
          .prepare(
            `UPDATE live_budget_days SET
               do_duration_ms = do_duration_ms - CASE WHEN ${refundable} THEN ?6 ELSE 0 END,
               protected_do_duration_ms = protected_do_duration_ms
                 - CASE WHEN ${refundable} AND ?7 THEN ?6 ELSE 0 END,
               escrow = CASE WHEN ${inEscrow} THEN json_remove(escrow, '$[' || (
                 SELECT key FROM json_each(live_budget_days.escrow)
                 WHERE json_extract(value, '$.id') = ?3) || ']') ELSE escrow END
             WHERE day = ?4 AND ${applied}`,
          )
          .bind(ownerId, mint, op, day, held, unused, cleanup ? 1 : 0),
      );
  }
  if (corrections > 0)
    statements.push(
      db
        .prepare(
          `UPDATE live_budget_state SET duration_debt_ms = duration_debt_ms + ?3
           WHERE id = 1 AND ${applied}`,
        )
        .bind(ownerId, mint, corrections),
    );
  statements.push(
    db
      .prepare(
        "SELECT accounting_mint, cursor, status FROM live_duration_owners WHERE owner_id = ?",
      )
      .bind(ownerId),
  );
  const results = await db.batch<{ accounting_mint: string; cursor: number; status: string }>(
    statements,
  );
  const after = results.at(-1)?.results[0];
  if (!after) return { status: "missing" };
  if (after.accounting_mint === mint) return { status: "settled", cursor: next, accounted };
  // Another runner's page (or this one's, its reply lost): as the owner stands now.
  return { status: "duplicate", cursor: after.cursor, accounted: after.status === "accounted" };
}

/**
 * Releases an owner whose duration is accounted, or one admitted but never
 * dispatched once its window has passed: its place is free again, and, while
 * its grant's receipt lives, its identity is kept there so it is never
 * admitted again. Nothing else releases one.
 */
export async function releaseLiveOwner(
  db: D1Database,
  ownerId: string,
): Promise<"released" | "held" | "missing"> {
  const releasable = `owner_id = ?1 AND (status = 'accounted'
      OR (status = 'reserved' AND dispatch_until <= ${N}))`;
  const [, removed, row] = await db.batch<{ status?: string }>([
    db
      .prepare(
        `UPDATE live_budget_receipts SET released_owners = json_insert(released_owners, '$[#]', ?1)
         WHERE operation_id = (SELECT operation_id FROM live_duration_owners WHERE ${releasable})
           AND NOT EXISTS (SELECT 1 FROM json_each(released_owners) WHERE value = ?1)`,
      )
      .bind(ownerId),
    db.prepare(`DELETE FROM live_duration_owners WHERE ${releasable}`).bind(ownerId),
    db.prepare("SELECT status FROM live_duration_owners WHERE owner_id = ?").bind(ownerId),
  ]);
  if ((removed?.meta.changes ?? 0) > 0) return "released";
  return row?.results[0] ? "held" : "missing";
}

/**
 * Serves the duration debt from today's ordinary capacity, once a day (a
 * replay, or an older day, serves nothing): up to what today's ordinary part
 * has left after its reserve, withheld from it and taken off the debt, both
 * only if the debt and the day served last are still as read. Returns what
 * was withheld.
 */
export async function serviceLiveDurationDebt(db: D1Database): Promise<number> {
  const read = await db
    .withSession("first-primary")
    .prepare(
      `SELECT ${D} AS today, s.duration_debt_ms AS debt, s.debt_service_day AS served,
         max(0, ${LIVE_DAILY.do_duration_ms - LIVE_PROTECTED.do_duration_ms} - s.duration_reserve_ms
           - coalesce((SELECT do_duration_ms - protected_do_duration_ms + debt_withheld_ms
               FROM live_budget_days WHERE day = ${D}), 0)) AS room
       FROM live_budget_state s WHERE s.id = 1`,
    )
    .first<{ today: number; debt: number; served: number; room: number }>();
  if (!read || read.served >= read.today) return 0;
  const withheld = Math.min(read.debt, read.room);
  const mint = crypto.randomUUID();
  const [served] = await db.batch([
    db
      .prepare(
        `UPDATE live_budget_state SET owner_mint = ?1, debt_service_day = ?2,
           duration_debt_ms = duration_debt_ms - ?3
         WHERE id = 1 AND ${D} = ?2 AND debt_service_day = ?4 AND duration_debt_ms = ?5`,
      )
      .bind(mint, read.today, withheld, read.served, read.debt),
    db
      .prepare(
        `INSERT INTO live_budget_days (day, do_requests, do_rows_read, do_rows_written,
           do_duration_ms, d1_rows_read, d1_rows_written, queue_ops, debt_withheld_ms,
           retain_until, cleanup_debt)
         SELECT ?2, 0, 0, 0, 0, 0, 0, 0, ?3, (?2 + 5) * ${DAY}, json_object('do_requests', 0,
           'do_rows_read', 0, 'do_rows_written', 0, 'do_duration_ms', 0, 'd1_rows_read', 0,
           'd1_rows_written', 0, 'queue_ops', 0)
         WHERE ?3 > 0 AND EXISTS (SELECT 1 FROM live_budget_state WHERE id = 1 AND owner_mint = ?1)
         ON CONFLICT (day) DO UPDATE SET debt_withheld_ms = debt_withheld_ms + excluded.debt_withheld_ms`,
      )
      .bind(mint, read.today, withheld),
  ]);
  return (served?.meta.changes ?? 0) > 0 ? withheld : 0;
}
