import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { MAINTENANCE_OBJECT } from "../cron/maintenance.js";
import {
  expireLiveReceipts,
  LIVE_NOW,
  makeLiveGrant,
  pruneLiveBudgetDays,
  reserveLive,
} from "./budget.js";
import { reaping, sweep } from "./directory.js";
import { type FundedResult, liveTarget, ownedCall, planFor } from "./funding.js";
import { LIVE_PRICES, type LiveManifestEntry } from "./manifest.js";
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

/** A run's pages (Proposed): what one maintenance grant pays for at most. */
export const LIVE_MAINTENANCE = {
  receipts: 32,
  days: 8,
  owners: 8,
  recoveries: 2,
  reap: 100,
  deliveries: 16,
  revocations: 8,
} as const;

const N = LIVE_NOW;

/** Whether live maintenance has anything due (one statement, nothing written). */
export async function liveMaintenanceDue(db: D1Database): Promise<boolean> {
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM live_budget_receipts INDEXED BY live_budget_receipts_expiry
           WHERE expires_at <= ${N} AND kind <> 'maintenance')
         OR EXISTS (SELECT 1 FROM live_duration_owners WHERE status IN ('observing', 'accounted')
           OR (status = 'reserved' AND dispatch_until <= ${N}))
         OR EXISTS (SELECT 1 FROM live_budget_days
           WHERE day < CAST(${N} / 86400000 AS INTEGER) - 7 AND retain_until <= ${N})
         OR EXISTS (SELECT 1 FROM live_recovery_targets INDEXED BY live_recovery_targets_due
           WHERE next_attempt_at <= ${N})
         OR EXISTS (SELECT 1 FROM revocations INDEXED BY revocations_open WHERE expanded = 0)
         OR EXISTS (SELECT 1 FROM revocation_targets INDEXED BY revocation_targets_due
           WHERE next_attempt_at <= ${N})
         OR EXISTS (SELECT 1 FROM live_sockets INDEXED BY live_sockets_expiry
           WHERE expires_at <= ${N})
         OR EXISTS (SELECT 1 FROM live_budget_state WHERE id = 1 AND duration_debt_ms > 0
           AND debt_service_day < CAST(${N} / 86400000 AS INTEGER)) AS due`,
    )
    .first<{ due: number }>();
  return row?.due === 1;
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
  if (!(await liveMaintenanceDue(db))) return null;
  await settleStrandedOwners(db, LIVE_MAINTENANCE.owners).catch(() => {});
  const target = await liveTarget(db, MAINTENANCE_OBJECT);
  const request = await makeLiveGrant(
    planFor(
      LIVE_PRICES.maintenance as LiveManifestEntry,
      {
        incarnation: target.incarnation,
        epoch: 0,
        recipientType: "MaintenanceDO",
        recipient: MAINTENANCE_OBJECT,
        class: "cleanup",
        kind: "maintenance",
        producesLocal: false,
      },
      target.ledger.now,
    ),
  );
  return ownedCall(
    db,
    request,
    "maintenance",
    async (_funding, signal) => {
      const steps: (() => Promise<unknown>)[] = [
        () => expireLiveReceipts(db, LIVE_MAINTENANCE.receipts),
        () => pruneLiveBudgetDays(db, LIVE_MAINTENANCE.days),
        () => serviceLiveDurationDebt(db),
        () => adoptLiveRecoveryTargets(db, LIVE_MAINTENANCE.recoveries),
        () =>
          recoverLiveTargets(db, {
            limit: LIVE_MAINTENANCE.recoveries,
            reserveTarget: (feed) => recoveryGrant(db, feed),
            proceed: () => !signal.aborted,
            tell: (request) => {
              metrics?.count("do.request", { class: "UserDO", method: "recoverLiveV1" });
              return env.USER.getByName(request.feed).recoverLiveV1(request);
            },
          }),
        () => db.batch(reaping(db, Date.now(), LIVE_MAINTENANCE.reap)),
        () =>
          sweep(
            db,
            (feed, dependencies) => {
              metrics?.count("do.request", { class: "UserDO", method: "revoked" });
              return env.USER.getByName(feed).revoked(dependencies);
            },
            Date.now(),
            metrics,
            {
              deliveries: LIVE_MAINTENANCE.deliveries,
              revocations: LIVE_MAINTENANCE.revocations,
              proceed: () => !signal.aborted,
            },
          ),
      ];
      // Each page on its own: one failing leaves the others to run, and its own to the next run.
      for (const step of steps) {
        if (signal.aborted) return;
        await step().catch(() => {});
      }
    },
    {
      ledger: target.ledger,
      pendingMs: (LIVE_PRICES.maintenance as LiveManifestEntry).pendingMs as number,
    },
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
async function recoveryGrant(db: D1Database, feed: string) {
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
  );
}
