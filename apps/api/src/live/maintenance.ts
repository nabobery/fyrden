import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { MAINTENANCE_OBJECT } from "../cron/maintenance.js";
import {
  expireLiveReceipts,
  LIVE_NOW,
  LIVE_RECEIPTS_DUE,
  LIVE_RECEIPTS_OVERDUE,
  liveReceiptsOverdue,
  makeLiveGrant,
  pruneLiveBudgetDays,
  reserveLive,
} from "./budget.js";
import {
  LIVE_ADMISSION,
  reapableRevocations,
  reaping,
  reapingTransports,
  reapingWindowMoved,
  sweep,
} from "./directory.js";
import { type FundedResult, liveTarget, ownedCall, planFor } from "./funding.js";
import { LIVE_PRICES, type LiveManifestEntry, liveKindOf } from "./manifest.js";
import { releaseLiveOwner, serviceLiveDurationDebt, settleLiveOwnerPage } from "./owners.js";
import {
  adoptLiveRecoveryTargets,
  LIVE_RECOVERY_DURATION,
  recoverLiveTargets,
} from "./recovery.js";

/*
 * Live maintenance, funded: a run only when something is due (one
 * existence check, so a deployment with nothing owed grants nothing; its
 * own expired receipts alone call for none: the next run removes them),
 * owners whose work ended but whose accounting or release was lost
 * settled and released first (a bounded page; one of them may be its own
 * last run's, holding the place its next needs), then its own cleanup
 * grant, owned by the maintenance object while it runs,
 * paying for bounded pages of each kind: expired receipts and old days
 * with their debt, a day's duration debt served, a few feeds' recoveries
 * (each funded by a cleanup grant of its own), leases lapsed or never
 * confirmed reaped, and revocations told to their feeds (the sockets they
 * close released here). It runs whether live is on or not, while anything
 * is owed. Each page stops once the run is given up on.
 */

/**
 * A run's pages (Proposed): what one maintenance grant pays for at most,
 * sized with its price (each page measured full) so a day's runs fit
 * cleanup's share: a run is due for expired receipts only a little before
 * they call for cleanup (`LIVE_RECEIPTS_DUE`), for lapsed leases only two hours
 * on (admission already passes over a lapsed one), and for expired
 * transports once a page of them is, or one has been for two hours, so a
 * quiet deployment runs about every two hours rather than every five
 * minutes.
 */
export const LIVE_MAINTENANCE = {
  receipts: LIVE_RECEIPTS_OVERDUE.page,
  days: 1,
  // Owners whose accounting was lost are rare: two a run (each up to two pages of days).
  owners: 2,
  recoveries: 2,
  // Each kind sized to what arrives of it: leases lapse only when a release was lost (each with
  // its dependency rows), revocations are rare, counts are one a principal a day of each, and a
  // principal may issue 60 tickets a day (each a transport).
  reap: { leases: 2, revocations: 2, counts: 8, transports: 16 },
} as const;

/**
 * A revocation page's bounds (Proposed): what one `revocation_page` grant
 * pays for at most, apart from routine maintenance (it is granted only
 * while revocations are to expand or tell): up to 8 revocations expanded,
 * 8 of their sockets' dependency rows scanned in all (one resting on no
 * socket costs no scan, so a burst of them shares a page), and one feed
 * told (its sockets resting on them closed and forgotten there, their
 * leases released here). Every five-minute check may run one.
 */
export const LIVE_REVOCATION_PAGE = { revocations: 8, scan: 8, deliveries: 1 } as const;

const N = LIVE_NOW;

/** A maintenance step that failed, logged by name (the run goes on; the next run tries it again). */
function stepFailed(step: string): (error: unknown) => void {
  return (error) =>
    createLogger({ op: "live.maintenance" }).warn("a maintenance step failed", { step, error });
}

/**
 * What live maintenance has due (one statement, nothing written): routine
 * pages, whether any but expired receipts and transports (`full`, its whole
 * price; else its light one), and revocations.
 */
export async function liveMaintenanceWork(db: D1Database): Promise<{
  readonly routine: boolean;
  readonly full: boolean;
  readonly revocations: boolean;
}> {
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT
         ${liveReceiptsOverdue(N, LIVE_RECEIPTS_DUE)}
         OR EXISTS (SELECT 1 FROM live_ticket_transports INDEXED BY live_ticket_transports_expiry
           WHERE expires_at <= ${N} - ${LIVE_RECEIPTS_OVERDUE.graceMs})
         OR (SELECT count(*) FROM (SELECT 1 FROM live_ticket_transports
           INDEXED BY live_ticket_transports_expiry WHERE expires_at <= ${N}
           LIMIT ${LIVE_MAINTENANCE.reap.transports})) >= ${LIVE_MAINTENANCE.reap.transports}
           AS light,
         EXISTS (SELECT 1 FROM live_duration_owners WHERE status IN ('observing', 'accounted')
           OR (status = 'reserved' AND dispatch_until <= ${N}))
         OR EXISTS (SELECT 1 FROM live_budget_days
           WHERE day < CAST(${N} / 86400000 AS INTEGER) - 7 AND retain_until <= ${N})
         OR EXISTS (SELECT 1 FROM live_recovery_targets INDEXED BY live_recovery_targets_due
           WHERE next_attempt_at <= ${N})
         OR EXISTS (SELECT 1 FROM live_budget_state WHERE id = 1
           AND incarnation <> targets_incarnation)
         OR EXISTS (SELECT 1 FROM live_sockets INDEXED BY live_sockets_expiry
           WHERE expires_at <= ${N} - ${LIVE_RECEIPTS_OVERDUE.graceMs})
         OR EXISTS (SELECT 1 FROM live_budget_state WHERE id = 1 AND duration_debt_ms > 0
           AND debt_service_day < CAST(${N} / 86400000 AS INTEGER)) AS full_work,
         EXISTS (SELECT 1 FROM live_admissions INDEXED BY live_admissions_day
           WHERE day < CAST(${N} / 86400000 AS INTEGER) - 1)
         OR EXISTS (SELECT 1 FROM live_ticket_days INDEXED BY live_ticket_days_day
           WHERE day < CAST(${N} / 86400000 AS INTEGER) - 1)
         OR EXISTS (${reapableRevocations(`${N} - ${LIVE_ADMISSION.keepMs}`)}) AS reaping,
         EXISTS (SELECT 1 FROM revocations INDEXED BY revocations_open WHERE expanded = 0)
         OR EXISTS (SELECT 1 FROM revocation_targets INDEXED BY revocation_targets_due
           WHERE next_attempt_at <= ${N}) AS revocations`,
    )
    .first<{ light: number; full_work: number; reaping: number; revocations: number }>();
  // Old counts and revocations call for no run of their own: a run that is due takes them too.
  return {
    routine: row?.light === 1 || row?.full_work === 1,
    full: row?.full_work === 1 || (row?.light === 1 && row?.reaping === 1),
    revocations: row?.revocations === 1,
  };
}

/** Whether live maintenance has anything due (one statement, nothing written). */
export async function liveMaintenanceDue(db: D1Database): Promise<boolean> {
  const work = await liveMaintenanceWork(db);
  return work.routine || work.revocations;
}

/**
 * One funded run of live maintenance (see the module's comment); refused
 * (nothing done) when the ledger cannot fund it now, null when nothing
 * was due.
 */
export async function runLiveMaintenance(
  env: Env,
  metrics?: Metrics,
): Promise<FundedResult<void> | null> {
  const db = env.DIRECTORY;
  metrics?.count("d1.query", { db: "directory", op: "live_maintenance_due" });
  const work = await liveMaintenanceWork(db);
  if (!work.routine && !work.revocations) return null;
  const routine = work.routine ? await runRoutine(env, work.full, metrics) : null;
  const revocations = work.revocations ? await runRevocations(env, metrics) : null;
  return routine ?? revocations;
}

/** A cleanup grant of `unit`'s owned by the maintenance object, run as `call` (see `ownedCall`). */
async function maintenanceCall(
  db: D1Database,
  unit: "maintenance" | "maintenance_light" | "revocation_page",
  call: (signal: AbortSignal) => Promise<void>,
  metrics?: Metrics,
): Promise<FundedResult<void>> {
  const target = await liveTarget(db, MAINTENANCE_OBJECT);
  const entry = LIVE_PRICES[unit] as LiveManifestEntry;
  const request = await makeLiveGrant(
    planFor(
      entry,
      {
        incarnation: target.incarnation,
        epoch: 0,
        recipientType: "MaintenanceDO",
        recipient: MAINTENANCE_OBJECT,
        class: "cleanup",
        kind: liveKindOf(unit),
        producesLocal: false,
      },
      target.ledger.now,
    ),
  );
  return ownedCall(db, request, liveKindOf(unit), (_funding, signal) => call(signal), {
    ledger: target.ledger,
    pendingMs: entry.pendingMs as number,
    ...(metrics && { metrics }),
  });
}

/**
 * Routine maintenance's pages, each on its own: under a `maintenance` grant, or,
 * with only expired receipts and transports due, a cheaper one paying for just
 * those two (anything found due meanwhile waits for the next run).
 */
async function runRoutine(env: Env, full: boolean, metrics?: Metrics): Promise<FundedResult<void>> {
  const db = env.DIRECTORY;
  if (!full)
    return maintenanceCall(
      db,
      "maintenance_light",
      async (signal) => {
        const steps: [string, () => Promise<unknown>][] = [
          ["receipts", () => expireLiveReceipts(db, LIVE_MAINTENANCE.receipts)],
          [
            "transports",
            () =>
              db.batch([
                reapingTransports(db, Date.now(), LIVE_MAINTENANCE.reap.transports),
                reapingWindowMoved(db, Date.now()),
              ]),
          ],
        ];
        for (const [name, step] of steps) {
          if (signal.aborted) return;
          await step().catch(stepFailed(name));
        }
      },
      metrics,
    );
  await settleStrandedOwners(db, LIVE_MAINTENANCE.owners).catch(stepFailed("owners"));
  return maintenanceCall(
    db,
    "maintenance",
    async (signal) => {
      const steps: [string, () => Promise<unknown>][] = [
        ["receipts", () => expireLiveReceipts(db, LIVE_MAINTENANCE.receipts)],
        ["days", () => pruneLiveBudgetDays(db, LIVE_MAINTENANCE.days)],
        ["duration_debt", () => serviceLiveDurationDebt(db)],
        ["adopt_targets", () => adoptLiveRecoveryTargets(db, LIVE_MAINTENANCE.recoveries)],
        [
          "recoveries",
          () =>
            recoverLiveTargets(db, {
              limit: LIVE_MAINTENANCE.recoveries,
              reserveTarget: (feed) => recoveryGrant(db, feed, metrics),
              proceed: () => !signal.aborted,
              tell: (request) => {
                metrics?.count("do.request", { class: "UserDO", method: "recoverLiveV1" });
                return env.USER.getByName(request.feed).recoverLiveV1(request);
              },
            }),
        ],
        ["reaping", () => db.batch(reaping(db, Date.now(), LIVE_MAINTENANCE.reap))],
      ];
      // Each page on its own: one failing leaves the others to run, and its own to the next run.
      for (const [name, step] of steps) {
        if (signal.aborted) return;
        await step().catch(stepFailed(name));
      }
    },
    metrics,
  );
}

/** A revocation page, under a `revocation_page` grant of its own (`LIVE_REVOCATION_PAGE`). */
function runRevocations(env: Env, metrics?: Metrics): Promise<FundedResult<void>> {
  const db = env.DIRECTORY;
  return maintenanceCall(
    db,
    "revocation_page",
    async (signal) => {
      await sweep(
        db,
        (feed, dependencies) => {
          metrics?.count("do.request", { class: "UserDO", method: "revoked" });
          return env.USER.getByName(feed).revoked(dependencies);
        },
        Date.now(),
        metrics,
        { ...LIVE_REVOCATION_PAGE, proceed: () => !signal.aborted },
      ).catch(stepFailed("revocations"));
    },
    metrics,
  );
}

/**
 * Settles and releases a page of owners whose work ended but whose
 * accounting or release was lost (observed, or accounted), and releases
 * owners admitted but never dispatched once their window passed. Owners
 * whose end is unknown (dispatched, uncertain) are not touched: they keep
 * their places.
 */
export async function settleStrandedOwners(db: D1Database, limit: number): Promise<number> {
  const { results } = await db
    .withSession("first-primary")
    .prepare(
      `SELECT owner_id, status FROM live_duration_owners
       WHERE status IN ('observing', 'accounted') OR (status = 'reserved' AND dispatch_until <= ${N})
       ORDER BY owner_id LIMIT ?`,
    )
    .bind(limit)
    .all<{ owner_id: string; status: string }>();
  let released = 0;
  for (const owner of results) {
    if (owner.status === "observing")
      for (let page = 0; page < 2; page++) {
        const settled = await settleLiveOwnerPage(db, owner.owner_id);
        if (settled.status !== "settled" || settled.accounted) break;
      }
    if ((await releaseLiveOwner(db, owner.owner_id)) === "released") released++;
  }
  return released;
}

/** A cleanup grant paying for one recovery page of `feed`. */
export async function recoveryGrant(db: D1Database, feed: string, metrics?: Metrics) {
  const target = await liveTarget(db, feed);
  return reserveLive(
    db,
    await makeLiveGrant(
      planFor(
        LIVE_PRICES.recovery as LiveManifestEntry,
        {
          incarnation: target.incarnation,
          epoch: target.epoch,
          recipientType: "UserDO",
          recipient: feed,
          class: "cleanup",
          kind: "recovery",
          producesLocal: false,
        },
        target.ledger.now,
        LIVE_RECOVERY_DURATION.tailMs,
      ),
    ),
    metrics,
  );
}
