import type { DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * RunDO schema: one CI run. Released migrations never change; add a new
 * version instead. Every released version gets a fixture in
 * test/fixtures/do-schemas/RunDO/.
 *
 * - `runs`: the run (one row): what the trigger gave it (commit, ref, event,
 *   actor, workflow source and contexts), its current attempt, and counters
 *   that never go back: task numbers, job ids, task ends, and the queue
 *   revision with the watermarks its hooks advance.
 * - `run_attempts`: one per attempt (a re-run is a new one): status,
 *   conclusion, cancel mode, who started it, its workflow concurrency group,
 *   the plan's errors, and its instance and output budgets.
 * - `run_nodes`: one per workflow job per attempt.
 * - `run_instances`: one per matrix combination (and one for a job that
 *   never expanded); `job_id` is the API's job id. A task, once assigned,
 *   identifies it to the runner.
 * - `run_checks`: the check outbox, one row per published check, its desired
 *   state and revision against what the repository acknowledged.
 * - `run_owners`: the concurrency scopes the run holds or waits for.
 * - `run_faults`: background work that exhausted its attempts, shown on the run.
 * - `run_erasure`: present once the run was erased; only its identity remains.
 * - `run_identity`: the immutable repository and spec reservation, made before registration.
 * - `jobs`: this object's background work (the same table the repository
 *   objects use, so the same job queue runs it).
 *
 * v3 (the runner protocol):
 * - `ci_tasks`: the directory task id, local job and task numbers, offered runner,
 *   and the time the runner first reported.
 *
 * v4 (job logs):
 * - `ci_logs`: contiguous acknowledged positions, completion state and stored
 *   row and byte counts per task, and `omitted_rows`: positions acknowledged
 *   as omitted (a row too large for any request), never decreased; a log with
 *   one is never `complete`.
 * - `ci_log_chunks`: the stored ranges and their authoritative R2 objects (an
 *   omission is a range of one position whose object holds its record).
 */
export const runSchema: readonly DoMigration[] = [
  {
    version: 1,
    name: "run_core",
    sql: `
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        run_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        sha TEXT NOT NULL,
        ref TEXT NOT NULL,
        event TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        workflow_path TEXT NOT NULL,
        workflow_source TEXT NOT NULL,
        contexts TEXT NOT NULL,
        spec_digest TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        task_seq INTEGER NOT NULL DEFAULT 0,
        job_seq INTEGER NOT NULL DEFAULT 0,
        task_end_seq INTEGER NOT NULL DEFAULT 0,
        task_end_acked INTEGER NOT NULL DEFAULT 0,
        queue_rev INTEGER NOT NULL DEFAULT 0,
        queue_synced_rev INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE run_attempts (
        attempt INTEGER PRIMARY KEY CHECK (attempt BETWEEN 1 AND 51),
        status TEXT NOT NULL CHECK (status IN ('queued', 'pending', 'in_progress', 'completed')),
        conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'cancelled')),
        cancel TEXT NOT NULL DEFAULT 'none' CHECK (cancel IN ('none', 'graceful', 'force')),
        cancelled_by TEXT,
        triggering_actor_id TEXT NOT NULL,
        group_key TEXT,
        group_name TEXT,
        cancel_in_progress INTEGER,
        errors TEXT,
        used_instances INTEGER NOT NULL,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        CHECK ((status = 'completed') = (conclusion IS NOT NULL))
      ) STRICT;

      CREATE TABLE run_nodes (
        attempt INTEGER NOT NULL,
        job_key TEXT NOT NULL,
        ord INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('waiting', 'running', 'done', 'skipped', 'failed', 'cancelled')),
        result TEXT CHECK (result IN ('success', 'failure', 'cancelled', 'skipped')),
        reserved INTEGER NOT NULL,
        fail_fast INTEGER,
        max_parallel INTEGER,
        declares TEXT,
        error TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (attempt, job_key)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE run_instances (
        job_id INTEGER PRIMARY KEY,
        attempt INTEGER NOT NULL,
        job_key TEXT NOT NULL,
        idx INTEGER NOT NULL,
        total INTEGER NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        instance TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('blocked', 'queued', 'in_progress', 'cancelling', 'completed')),
        conclusion TEXT
          CHECK (conclusion IN ('success', 'failure', 'cancelled', 'skipped', 'timed_out')),
        cancel_reason TEXT
          CHECK (cancel_reason IN ('cancel', 'fail_fast', 'timeout', 'displaced', 'evicted')),
        continue_on_error INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL,
        group_key TEXT,
        group_name TEXT,
        group_cancel INTEGER,
        task INTEGER UNIQUE,
        assign_key TEXT,
        task_end_seq INTEGER UNIQUE,
        queued_at INTEGER,
        started_at INTEGER,
        heartbeat_at INTEGER,
        cancel_at INTEGER,
        completed_at INTEGER,
        outputs TEXT,
        error TEXT,
        log_complete INTEGER,
        check_code TEXT,
        UNIQUE (attempt, job_key, idx),
        CHECK ((status = 'completed') = (conclusion IS NOT NULL))
      ) STRICT;
      CREATE INDEX run_instances_live ON run_instances (attempt, status);

      CREATE TABLE run_checks (
        attempt INTEGER NOT NULL,
        name_key TEXT NOT NULL,
        name TEXT NOT NULL,
        start_key TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        supersedes TEXT,
        check_attempt INTEGER,
        desired TEXT NOT NULL,
        rev INTEGER NOT NULL,
        sent_rev INTEGER NOT NULL DEFAULT 0,
        parked TEXT,
        PRIMARY KEY (attempt, name_key)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX run_checks_dirty ON run_checks (attempt) WHERE parked IS NULL AND sent_rev < rev;

      CREATE TABLE run_owners (
        owner_key TEXT PRIMARY KEY,
        group_key TEXT NOT NULL,
        group_name TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('admitting', 'pending', 'owner', 'releasing', 'ended')),
        outcome TEXT,
        cancel_in_progress INTEGER NOT NULL DEFAULT 0,
        generation INTEGER,
        lease_valid_until INTEGER,
        renew_at INTEGER,
        hold_ms INTEGER
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE run_faults (
        kind TEXT NOT NULL,
        job_id TEXT NOT NULL,
        error TEXT NOT NULL,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        count INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY (kind, job_id)
      ) STRICT, WITHOUT ROWID;

      CREATE TABLE run_erasure (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        erased_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed')),
        cursor BLOB,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        claim INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX jobs_due ON jobs (state, next_run_at);
    `,
  },
  {
    version: 2,
    name: "run_identity",
    sql: `
      CREATE TABLE run_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repo_id TEXT NOT NULL,
        spec_digest TEXT
      ) STRICT;
      INSERT INTO run_identity (id, repo_id, spec_digest)
        SELECT id, repo_id, spec_digest FROM runs;
    `,
  },
  {
    version: 3,
    name: "ci_tasks",
    sql: `
      CREATE TABLE ci_tasks (
        wire_id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL,
        task INTEGER NOT NULL,
        runner_id INTEGER NOT NULL,
        confirmed_at INTEGER
      ) STRICT;
      CREATE INDEX ci_tasks_task ON ci_tasks (task);
    `,
  },
  {
    version: 4,
    name: "ci_logs",
    sql: `
      CREATE TABLE ci_logs (
        task INTEGER PRIMARY KEY,
        ack_index INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'streaming'
          CHECK (state IN ('streaming', 'complete', 'incomplete')),
        rows INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        omitted_rows INTEGER NOT NULL DEFAULT 0 CHECK (omitted_rows >= 0),
        updated_at INTEGER NOT NULL,
        CHECK (state <> 'complete' OR omitted_rows = 0)
      ) STRICT;

      CREATE TABLE ci_log_chunks (
        task INTEGER NOT NULL,
        start_index INTEGER NOT NULL,
        end_index INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        r2_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (task, start_index)
      ) STRICT, WITHOUT ROWID;
    `,
  },
  {
    version: 5,
    name: "ci_log_masks",
    sql: `
      CREATE TABLE ci_log_masks (
        task INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('job_token', 'add_mask')),
        from_index INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (task, seq)
      ) STRICT;

      ALTER TABLE ci_logs ADD COLUMN mask_carry TEXT;
      ALTER TABLE ci_logs ADD COLUMN ended_at INTEGER;
      ALTER TABLE ci_logs ADD COLUMN gap_remaining INTEGER NOT NULL DEFAULT 0 CHECK (gap_remaining >= 0);
      ALTER TABLE ci_logs ADD COLUMN finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1));
      UPDATE ci_logs SET finalized = 1 WHERE state = 'complete';

      CREATE TABLE ci_log_tickets (
        hash TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        credential_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX ci_log_tickets_expiry ON ci_log_tickets (expires_at);
    `,
  },
];
