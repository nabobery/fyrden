import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { OrgRole } from "@fyrden/domain";

/*
 * The directory's `memberships`: which organizations a principal may belong
 * to, by its id. A copy that finds organizations to ask and decides nothing:
 * the organization's object says who its members are (`OrgDO.accountRole`).
 */

export interface Member {
  readonly id: string;
  readonly role: OrgRole;
  readonly at: number;
}

const UPSERT = `INSERT INTO memberships (org_id, principal_id, role, created_at)
  SELECT ?1, m.value ->> 'id', m.value ->> 'role', m.value ->> 'at' FROM json_each(?2) m
  WHERE EXISTS (SELECT 1 FROM principals WHERE id = ?1)
    AND EXISTS (SELECT 1 FROM principals WHERE id = m.value ->> 'id')
  ON CONFLICT (org_id, principal_id) DO UPDATE SET role = excluded.role
  WHERE memberships.role <> excluded.role`;

const ids = (members: readonly Member[]) => JSON.stringify(members.map((m) => m.id));

/**
 * Records what `principals` are in the organization now: `members`, those of
 * them who are members. One the directory does not know, or any while it
 * does not know the organization, is left out: a foreign key that failed
 * would hold back the audit rows of the same batch.
 */
export function recordMembers(
  db: D1Database,
  orgId: string,
  principals: readonly string[],
  members: readonly Member[],
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM memberships WHERE org_id = ?1
           AND principal_id IN (SELECT value FROM json_each(?2))
           AND principal_id NOT IN (SELECT value FROM json_each(?3))`,
      )
      .bind(orgId, JSON.stringify(principals), ids(members)),
    db.prepare(UPSERT).bind(orgId, JSON.stringify(members)),
  ];
}

/** Makes the organization's record exactly `members`. */
export function recordAllMembers(
  db: D1Database,
  orgId: string,
  members: readonly Member[],
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `DELETE FROM memberships WHERE org_id = ?1
           AND principal_id NOT IN (SELECT value FROM json_each(?2))`,
      )
      .bind(orgId, ids(members)),
    db.prepare(UPSERT).bind(orgId, JSON.stringify(members)),
  ];
}

const PASS_EVERY_MS = 24 * 60 * 60 * 1000;
const ORGS_PER_RUN = 10;

interface Pass {
  readonly lastAsked: string | null;
  readonly started_at: number;
}

/**
 * One run of the pass that makes every organization's record equal to its
 * members, started once a day: what a restore or a lost write left wrong,
 * and the organizations older than the record. One that fails waits for the
 * next pass; the run then throws.
 */
export async function reconcileMemberships(
  env: Env,
  options: { readonly now: number; readonly metrics?: Metrics },
): Promise<void> {
  const { now, metrics } = options;
  const db = env.DIRECTORY.withSession("first-primary");
  metrics?.count("d1.query", { db: "directory", op: "membership_pass" });
  const saved = await db
    .prepare("SELECT value FROM deployment_settings WHERE name = 'membership_reconcile'")
    .first<{ value: string }>();
  let pass = saved ? (JSON.parse(saved.value) as Pass) : null;
  if (!pass || pass.lastAsked === null) {
    if (pass && now - pass.started_at < PASS_EVERY_MS) return;
    pass = { lastAsked: "", started_at: now };
  }
  metrics?.count("d1.query", { db: "directory", op: "membership_pass_orgs" });
  const { results: orgs } = await db
    .prepare(
      `SELECT id FROM principals WHERE id > max('org_', ?1) AND id < 'org\`' AND type = 'org'
         AND disabled_at IS NULL ORDER BY id LIMIT ?2`,
    )
    .bind(pass.lastAsked, ORGS_PER_RUN)
    .all<{ id: string }>();
  metrics?.count("do.request", { class: "OrgDO", method: "mirrorMembers" }, orgs.length);
  const failures: unknown[] = [];
  for (const { id } of orgs)
    await env.ORG.getByName(id)
      .mirrorMembers()
      .catch((error: unknown) => {
        createLogger({ op: "memberships.reconcile", orgId: id }).warn("recording failed", {
          error,
        });
        failures.push(error);
      });
  const last = orgs.length === ORGS_PER_RUN ? (orgs.at(-1)?.id ?? null) : null;
  const next: Pass = { lastAsked: last, started_at: pass.started_at };
  metrics?.count("d1.query", { db: "directory", op: "membership_pass_save" });
  await env.DIRECTORY.prepare(
    `INSERT INTO deployment_settings (name, value, updated_at)
     VALUES ('membership_reconcile', ?1, ?2)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(next), now)
    .run();
  if (failures.length > 0)
    throw new Error(`recording the members of ${failures.length} organization(s) failed`);
}
