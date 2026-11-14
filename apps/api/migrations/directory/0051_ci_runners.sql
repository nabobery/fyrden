-- Self-hosted runners and the work they are given. A runner belongs to one account (an
-- organization or a user's namespace) and serves that account's repositories.

-- One-time registration tokens (`fyrden_run_`), by SHA-256. Register consumes one and stamps it
-- with a fresh nonce, and inserts the runner only from the row bearing that nonce, so of two
-- Register calls racing for one token exactly one inserts a runner.
CREATE TABLE ci_runner_registrations (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, consume_nonce TEXT
) STRICT;

-- Registered runners; `token_hash` is the SHA-256 of the runner's credential (`fyrden_rnr_`).
-- A Register whose answer is lost leaves a runner whose credential nobody holds: it never declares,
-- shows in the list with no declared_at, and an owner deletes it and mints a new registration token.
CREATE TABLE ci_runners (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '',
  labels TEXT NOT NULL DEFAULT '[]', ephemeral INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, declared_at INTEGER, revoked_at INTEGER,
  task_confirmed_at INTEGER,             -- an ephemeral runner's one task was confirmed
  expires_at INTEGER                     -- a spent ephemeral runner's end: its task's completion + 10 min
) STRICT;
CREATE INDEX ci_runners_account ON ci_runners (account_id, id);

-- Per account, the version runners poll against: it changes when queued jobs are published.
CREATE TABLE ci_dispatch (account_id TEXT PRIMARY KEY, tasks_version INTEGER NOT NULL) STRICT;

-- One row per queued job instance, published by its run; a claim is a lease, never a delete.
CREATE TABLE ci_pending_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
  job_id INTEGER NOT NULL, attempt INTEGER NOT NULL, labels TEXT NOT NULL, queued_at INTEGER NOT NULL,
  claimed_by INTEGER, claim_until INTEGER, claim_nonce TEXT,
  UNIQUE (run_id, job_id)                -- job ids are never reused in a run
) STRICT;
CREATE INDEX ci_pending_account ON ci_pending_jobs (account_id, id);
CREATE INDEX ci_pending_claims ON ci_pending_jobs (account_id, claim_until) WHERE claim_until IS NOT NULL;

-- Tasks offered to runners; `id` is the task id the runner protocol carries.
CREATE TABLE ci_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, job_id INTEGER NOT NULL,
  task INTEGER,                          -- the run's task number, set once the assignment succeeds
  runner_id INTEGER NOT NULL, offered_version INTEGER NOT NULL,   -- the version echoed with the task
  created_at INTEGER NOT NULL, confirmed_at INTEGER, ended_at INTEGER, superseded_at INTEGER
) STRICT;
CREATE INDEX ci_tasks_runner_open ON ci_tasks (runner_id) WHERE confirmed_at IS NULL AND superseded_at IS NULL AND ended_at IS NULL;

-- Which task a job token serves; a job token with no row here is refused.
CREATE TABLE ci_job_tokens (
  token_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX ci_job_tokens_task ON ci_job_tokens (task_id);
