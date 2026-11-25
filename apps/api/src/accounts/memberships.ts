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
