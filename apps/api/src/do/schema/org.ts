import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * OrgDO schema: one account (an organization, or a user's own namespace)
 * and the access to its repositories. Released migrations never change;
 * add a new version instead.
 *
 * - `org_meta`: the account, its restore generation (`epoch_gen`, from the
 *   directory's `source_epochs`) and `acl_version`, bumped by every change
 *   of access in the change's transaction.
 * - `members`: an organization's members, their roles and handles (for
 *   listing in handle order).
 * - `pending_audit`: audit rows of access changes, written in the change's
 *   transaction and delivered to the directory's `audit_log` (then
 *   deleted); the alarm retries what could not be delivered.
 */
export const orgSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "org_core",
    sql: `
      CREATE TABLE org_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('org', 'user')),
        epoch_gen INTEGER NOT NULL,
        epoch_uuid TEXT NOT NULL,
        acl_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE members (
        principal_id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        added_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX members_owners ON members (principal_id) WHERE role = 'owner';
      CREATE INDEX members_handle ON members (handle COLLATE NOCASE);

      CREATE TABLE pending_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT NOT NULL CHECK (json_valid(details)),
        request_id TEXT
      ) STRICT;
    `,
  },
];
