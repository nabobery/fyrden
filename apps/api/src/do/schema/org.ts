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
 * - `collaborators` (v2): principals with a role on one repository.
 * - `teams`, `team_members`, `team_repos` (v2): an organization's teams,
 *   their members (members of the organization) and their roles on its
 *   repositories.
 * - `forgotten_repos` (v2): deleted repositories, so a grant that arrives
 *   after their records were removed is refused.
 * - `quota_limits`, `quota_usage`, `quota_holds`, `quota_confirmed` (v3):
 *   the account's quotas, the storage its repositories' committed uploads
 *   use, and what uploads not committed yet hold.
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
  {
    version: 2,
    // Collaborators (any account's repository) and teams (organizations):
    // flat teams, their members, and the role each team has on repositories.
    name: "org_grants",
    sql: `
      CREATE TABLE collaborators (
        repo_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (repo_id, principal_id)
      ) STRICT;
      CREATE INDEX collaborators_handle ON collaborators (repo_id, handle COLLATE NOCASE);

      CREATE TABLE teams (
        team_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE team_members (
        team_id TEXT NOT NULL REFERENCES teams (team_id),
        principal_id TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, principal_id)
      ) STRICT;
      CREATE INDEX team_members_principal ON team_members (principal_id);

      CREATE TABLE team_repos (
        team_id TEXT NOT NULL REFERENCES teams (team_id),
        repo_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('read', 'triage', 'write', 'maintain', 'admin')),
        added_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, repo_id)
      ) STRICT;
      CREATE INDEX team_repos_repo ON team_repos (repo_id);

      -- Deleted repositories: no grant names them again.
      CREATE TABLE forgotten_repos (
        repo_id TEXT PRIMARY KEY,
        forgotten_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "quotas",
    // Limits (null: the instance default); bytes each repository's
    // committed uploads stored; holds of uploads not committed yet (a
    // reservation while one is stored, a charge from its commit until it
    // is confirmed), which lapse at `expires_at`; uploads confirmed, so a
    // confirmation counts once.
    sql: `
      CREATE TABLE quota_limits (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        max_repos INTEGER CHECK (max_repos >= 0),
        max_storage_bytes INTEGER CHECK (max_storage_bytes >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE quota_usage (
        repo_id TEXT PRIMARY KEY,
        bytes INTEGER NOT NULL CHECK (bytes >= 0)
      ) STRICT;

      CREATE TABLE quota_holds (
        upload_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('reserved', 'charged')),
        bytes INTEGER NOT NULL CHECK (bytes >= 0),
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX quota_holds_expiry ON quota_holds (expires_at);
      CREATE INDEX quota_holds_repo ON quota_holds (repo_id);

      CREATE TABLE quota_confirmed (
        upload_id TEXT PRIMARY KEY,
        confirmed_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX quota_confirmed_at ON quota_confirmed (confirmed_at);
    `,
  },
];
