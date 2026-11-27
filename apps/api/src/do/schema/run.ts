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
 *
 * v6 (the run's origin):
 * - `runs.trust` and `runs.fork`, from the trigger: whether the run's code
 *   is trusted, and whether its pull request's head is in another
 *   repository. Both default to the closed answer (untrusted, a fork) for a
 *   row written without them. `run_attempts.errors` holds the plan's errors
 *   as JSON objects (code, feature, path, line, column, message); rows
 *   written before hold strings.
 * - `run_approval`: present when the run waits for a maintainer's approval:
 *   the binding an approval must name, its state, who decided and when, its
 *   expiry, and whether the repository still has to be told of a state this
 *   object decided (cancelled, expired: `notified` 0). No attempt is
 *   admitted while it is present and not approved.
 *
 * v7 (sealed masks):
 * - `ci_log_masks`: a task's mask values (job tokens, `::add-mask::` values
 *   and delivered secrets), each sealed under the CI master key `key_id`, with
 *   the random `mask_id` its seal is bound to and its crossing length.
 * - `runs.owner_id`: the account that owned the repository when the run was
 *   created, the only one whose secrets its jobs are given; NULL for a run
 *   created without one (before this version), whose jobs get no secrets.
 *
 * v8 (CI minutes and capacity):
 * - `ci_reservations`: a queued job instance's current reservation (`seq`
 *   counts them). `ineligible_at`: found a job no runner may take, so it
 *   asks no store until the run checks again. `rebind`: made for an account
 *   that no longer owns the repository, so released and made again.
 *
 * v9 (failed deliveries):
 * - `ci_delivery_failures`: a failed delivery of a job's secrets not settled
 *   yet: the directory's offer, the task it names, and the error its job gets
 *   if the offer ended. Only the failure of that task is ever acted on. An
 *   empty error is an assignment that could not be recorded, not a failed
 *   delivery: its job never gets an error.
 *
 * v10 (steps):
 * - `run_instances.steps`: the job's steps as its runner last reported them
 *   (src/do/run/steps.ts); NULL before a report, and for tasks from before.
 *
 * v11 (repository restores):
 * - `runs.repo_epoch`: the greatest restore generation of the repository
 *   the run has seen; NULL until its first. A greater one starts the run's
 *   checks again. A run from before is set to 0, so the first it sees does
 *   (it may have missed a restore). Check rows parked as `unknown_attempt`
 *   (an attempt a restore lost) are sent again.
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
      ALTER TABLE ci_logs ADD COLUMN unmasked INTEGER NOT NULL DEFAULT 0 CHECK (unmasked IN (0, 1));
      INSERT INTO ci_logs (task, state, updated_at)
        SELECT task, 'incomplete', COALESCE((SELECT updated_at FROM runs WHERE id = 1), 0)
        FROM run_instances WHERE task IS NOT NULL
        ON CONFLICT (task) DO NOTHING;
      UPDATE ci_logs SET ended_at = (
        SELECT completed_at FROM run_instances
        WHERE run_instances.task = ci_logs.task AND status = 'completed'
      ) WHERE state = 'incomplete';
      UPDATE ci_logs SET unmasked = 1, finalized = 1,
        state = CASE WHEN state = 'complete' THEN 'complete' ELSE 'incomplete' END;

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
  {
    version: 6,
    name: "run_origin",
    sql: `
      ALTER TABLE runs ADD COLUMN trust TEXT NOT NULL DEFAULT 'untrusted'
        CHECK (trust IN ('trusted', 'untrusted'));
      ALTER TABLE runs ADD COLUMN fork INTEGER NOT NULL DEFAULT 1 CHECK (fork IN (0, 1));
      CREATE TABLE run_approval (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        binding TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('waiting', 'approved', 'cancelled', 'superseded', 'expired')),
        decided_by TEXT,
        decided_at INTEGER,
        expires_at INTEGER NOT NULL,
        notified INTEGER NOT NULL DEFAULT 1 CHECK (notified IN (0, 1))
      ) STRICT;
    `,
  },
  {
    version: 7,
    // Masks sealed at rest: `ci_log_masks` is rebuilt, since its kind CHECK cannot be altered,
    // taking `secret` (a delivered secret). Each row gets `mask_id` (random hex, bound into its
    // seal's additional data, so a row opens wherever its `seq` falls), `cross_len` (its value's
    // longest boundary-crossing variant minus one, for an omitted row's gap, read without
    // opening the value) and `key_id` (the CI master key it is sealed under; `value` is then
    // "nonce.ciphertext" in base64). Rows copied from v6 stay plain, with `key_id` NULL and a
    // `cross_len` of six times their UTF-8 length, the most any variant expands a value (a
    // control character JSON-escaped as \u0000).
    name: "ci_log_masks_sealed",
    // Only this object's code reads the table, the object migrates before it answers anything,
    // and earlier code refuses a newer schema rather than reading it.
    contract: {
      safeSince: "the release sealing log masks",
      reason: "ci_log_masks is rebuilt under its own name; only RunDO code reads it",
    },
    sql: `
      CREATE TABLE ci_log_masks_v7 (
        task INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('job_token', 'add_mask', 'secret')),
        from_index INTEGER NOT NULL,
        mask_id TEXT NOT NULL,
        cross_len INTEGER NOT NULL,
        key_id TEXT,
        value TEXT NOT NULL,
        PRIMARY KEY (task, seq)
      ) STRICT;
      INSERT INTO ci_log_masks_v7 (task, seq, kind, from_index, mask_id, cross_len, key_id, value)
        SELECT task, seq, kind, from_index, lower(hex(randomblob(16))),
          6 * length(CAST(value AS BLOB)), NULL, value
        FROM ci_log_masks;
      DROP TABLE ci_log_masks;
      ALTER TABLE ci_log_masks_v7 RENAME TO ci_log_masks;
      ALTER TABLE runs ADD COLUMN owner_id TEXT;
    `,
  },
  {
    version: 8,
    // A job instance's CI reservation (src/do/run/reservations.ts). `key` and the inputs after it
    // are written together, before the first call to a store, and cleared when `seq` moves on.
    // `price` is the ledger's; null when only the account's minutes are reserved. `asked_for` is
    // the account `refusals` were counted against; a new owner starts them again. A live log
    // ticket's budget (src/do/run/viewers.ts): null on all three `read_*` when unbudgeted.
    name: "ci_reservations",
    sql: `
      CREATE TABLE ci_reservations (
        job_id INTEGER PRIMARY KEY,
        seq INTEGER NOT NULL CHECK (seq >= 1),
        state TEXT NOT NULL CHECK (state IN
          ('wanted', 'minutes', 'reserved', 'running', 'refused', 'ending', 'settled')),
        key TEXT,
        account_id TEXT,
        agent_id TEXT,
        minutes INTEGER CHECK (minutes >= 0),
        price TEXT CHECK (price IS NULL OR json_valid(price)),
        span_ms INTEGER CHECK (span_ms > 0),
        fixed_at INTEGER,
        valid_until INTEGER,
        settle_by INTEGER,
        window_until INTEGER,
        retry_at INTEGER,
        refusals INTEGER NOT NULL DEFAULT 0 CHECK (refusals >= 0),
        waiting_for TEXT CHECK (waiting_for IN ('ci_minutes', 'daily_capacity')),
        started_at INTEGER,
        ended_at INTEGER,
        ineligible_at INTEGER CHECK (ineligible_at IS NULL OR (state = 'wanted' AND key IS NULL)),
        rebind INTEGER NOT NULL DEFAULT 0 CHECK (rebind IN (0, 1)),
        asked_for TEXT,
        CHECK ((key IS NULL) = (account_id IS NULL) AND (key IS NULL) = (minutes IS NULL)
          AND (key IS NULL) = (span_ms IS NULL) AND (key IS NULL) = (fixed_at IS NULL)
          AND (key IS NULL) = (valid_until IS NULL) AND (key IS NULL) = (settle_by IS NULL)),
        CHECK (key IS NOT NULL OR state IN ('wanted', 'ending', 'settled'))
      ) STRICT;
      -- Jobs queued before reservations existed reserve too; the run's next dispatch pass
      -- starts its reserve slice.
      INSERT INTO ci_reservations (job_id, seq, state)
        SELECT job_id, 1, 'wanted' FROM run_instances WHERE status = 'queued';
      ALTER TABLE ci_log_tickets ADD COLUMN read_bytes INTEGER CHECK (read_bytes >= 0);
      ALTER TABLE ci_log_tickets ADD COLUMN read_gets INTEGER
        CHECK (read_gets >= 0 AND (read_gets IS NULL) = (read_bytes IS NULL));
      ALTER TABLE ci_log_tickets ADD COLUMN read_checks INTEGER
        CHECK (read_checks >= 0 AND (read_checks IS NULL) = (read_bytes IS NULL));
    `,
  },
  {
    version: 9,
    // A failed delivery of a job's secrets not settled yet (src/do/run/dispatch.ts): the
    // directory's offer, and the task it names. `error` is the job's error: names and sizes,
    // never a value.
    name: "ci_delivery_failures",
    sql: `
      CREATE TABLE ci_delivery_failures (
        wire_id INTEGER PRIMARY KEY,
        job_id INTEGER NOT NULL,
        task INTEGER NOT NULL,
        error TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 10,
    name: "ci_job_steps",
    sql: "ALTER TABLE run_instances ADD COLUMN steps TEXT;",
  },
  {
    version: 11,
    name: "ci_repo_epoch",
    sql: `
      ALTER TABLE runs ADD COLUMN repo_epoch INTEGER;
      UPDATE runs SET repo_epoch = 0;
      UPDATE run_checks SET parked = NULL, check_attempt = NULL, rev = rev + 1
        WHERE parked = 'unknown_attempt';
    `,
  },
];
