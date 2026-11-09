// The blame run rows (schema v49, blame_runs). A run is one blame of one
// file at one commit, shared by everyone asking for it. Its row is the only
// pointer to its latest checkpoint in R2, and moves only by compare-and-set
// on the generation and restore generation a slice read, so a lost race
// wastes one slice and nothing else. The row also carries the attempt mark
// that outlives a slice which dies.
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import type { Oid } from "@fyrden/git-core";

const HOUR = 60 * 60 * 1000;

/** Runs kept per repository; a new run removes the least recently touched. */
export const BLAME_RUN_CAP = 64;

export type RunState = "initializing" | "running" | "done" | "lost";

/** What a run blames: one per commit, path, engine version and restore generation. */
export interface RunKey {
  readonly commit: Oid;
  readonly path: string;
  readonly engineVersion: number;
  readonly epochGen: number;
}

export interface RunRow extends RunKey {
  readonly runId: string;
  /** The blamed file's blob, once its text has been read. */
  readonly blobOid: Oid | null;
  readonly generation: number;
  readonly checkpointKey: string | null;
  readonly checkpointBytes: number;
  readonly state: RunState;
  readonly lines: number;
  readonly settledRanges: number;
  readonly unresolvedLines: number;
  readonly attemptGeneration: number | null;
  readonly attempts: number;
  readonly touchedAt: number;
  readonly expiresAt: number;
}

/** What a published slice moves the row to. */
export interface Published {
  readonly blobOid: Oid | null;
  readonly generation: number;
  readonly checkpointKey: string | null;
  readonly checkpointBytes: number;
  readonly state: RunState;
  readonly lines: number;
  readonly settledRanges: number;
  readonly unresolvedLines: number;
  readonly touchedAt: number;
  readonly expiresAt: number;
}

/**
 * When a run expires: an unfinished or lost run a day after it was last
 * touched; a finished one a week after it was last read, or an hour when a
 * line is refused for a reason caching or compaction can change
 * (`transient`: work_limit, object_limit).
 */
export function runExpiry(at: { state: RunState; now: number; transient: boolean }): number {
  if (at.state !== "done") return at.now + 24 * HOUR;
  return at.now + (at.transient ? HOUR : 7 * 24 * HOUR);
}

type Raw = {
  run_id: string;
  commit_oid: ArrayBuffer;
  blob_oid: ArrayBuffer | null;
  path: string;
  engine_version: number;
  epoch_gen: number;
  generation: number;
  checkpoint_key: string | null;
  checkpoint_bytes: number;
  state: RunState;
  lines: number;
  settled_ranges: number;
  unresolved_lines: number;
  attempt_generation: number | null;
  attempts: number;
  touched_at: number;
  expires_at: number;
};

const toRow = (raw: Raw): RunRow => ({
  runId: raw.run_id,
  commit: new Uint8Array(raw.commit_oid) as Oid,
  blobOid: raw.blob_oid === null ? null : (new Uint8Array(raw.blob_oid) as Oid),
  path: raw.path,
  engineVersion: raw.engine_version,
  epochGen: raw.epoch_gen,
  generation: raw.generation,
  checkpointKey: raw.checkpoint_key,
  checkpointBytes: raw.checkpoint_bytes,
  state: raw.state,
  lines: raw.lines,
  settledRanges: raw.settled_ranges,
  unresolvedLines: raw.unresolved_lines,
  attemptGeneration: raw.attempt_generation,
  attempts: raw.attempts,
  touchedAt: raw.touched_at,
  expiresAt: raw.expires_at,
});

export class BlameRuns {
  constructor(private readonly storage: Pick<DurableObjectStorage, "sql">) {}

  #rows(query: string, ...bindings: unknown[]): RunRow[] {
    return this.storage.sql
      .exec<Raw>(query, ...bindings)
      .toArray()
      .map(toRow);
  }

  find(key: RunKey): RunRow | undefined {
    return this.#rows(
      `SELECT * FROM blame_runs
       WHERE commit_oid = ? AND path = ? AND engine_version = ? AND epoch_gen = ?`,
      key.commit,
      key.path,
      key.engineVersion,
      key.epochGen,
    )[0];
  }

  get(runId: string): RunRow | undefined {
    return this.#rows("SELECT * FROM blame_runs WHERE run_id = ?", runId)[0];
  }

  count(): number {
    const [row] = this.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM blame_runs")
      .toArray();
    return row?.n ?? 0;
  }

  /**
   * A new run, initializing at generation 0. Past the cap, the least
   * recently touched runs go, except those in `keep` (runs with a slice in
   * progress); their objects are left to cleanup.
   */
  create(key: RunKey, now: number, keep: ReadonlySet<string>): { row: RunRow; removed: string[] } {
    const runId = newUlid(now);
    this.storage.sql.exec(
      `INSERT INTO blame_runs (run_id, commit_oid, path, engine_version, epoch_gen, generation,
         checkpoint_key, checkpoint_bytes, state, lines, settled_ranges, unresolved_lines,
         touched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, 0, 'initializing', 0, 0, 0, ?, ?)`,
      runId,
      key.commit,
      key.path,
      key.engineVersion,
      key.epochGen,
      now,
      runExpiry({ state: "initializing", now, transient: false }),
    );
    const removed: string[] = [];
    let over = this.count() - BLAME_RUN_CAP;
    if (over > 0) {
      const oldest = this.storage.sql
        .exec<{ run_id: string }>(
          "SELECT run_id FROM blame_runs WHERE run_id <> ? ORDER BY touched_at, run_id",
          runId,
        )
        .toArray();
      for (const { run_id } of oldest) {
        if (over <= 0) break;
        if (keep.has(run_id)) continue;
        this.remove(run_id);
        removed.push(run_id);
        over--;
      }
    }
    return { row: this.get(runId) as RunRow, removed };
  }

  /**
   * Moves the row to `next` if it's still at the generation and restore
   * generation the slice read, clearing the attempt mark. False when it moved
   * or went meanwhile.
   */
  publish(
    runId: string,
    expect: { readonly generation: number; readonly epochGen: number },
    next: Published,
  ): boolean {
    const cursor = this.storage.sql.exec(
      `UPDATE blame_runs SET blob_oid = ?, generation = ?, checkpoint_key = ?, checkpoint_bytes = ?, state = ?,
         lines = ?, settled_ranges = ?, unresolved_lines = ?, touched_at = ?, expires_at = ?,
         attempts = 0, attempt_generation = NULL
       WHERE run_id = ? AND generation = ? AND epoch_gen = ?`,
      next.blobOid,
      next.generation,
      next.checkpointKey,
      next.checkpointBytes,
      next.state,
      next.lines,
      next.settledRanges,
      next.unresolvedLines,
      next.touchedAt,
      next.expiresAt,
      runId,
      expect.generation,
      expect.epochGen,
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * Marks a run lost: its slices kept dying. The row stays, found by what it
   * blames, until it expires, so the run isn't started again only to die the
   * same way. Its checkpoint is no longer referenced, so cleanup takes it.
   */
  markLost(runId: string, now: number): void {
    this.storage.sql.exec(
      `UPDATE blame_runs SET state = 'lost', checkpoint_key = NULL, checkpoint_bytes = 0,
         touched_at = ?, expires_at = ?
       WHERE run_id = ?`,
      now,
      runExpiry({ state: "lost", now, transient: false }),
      runId,
    );
  }

  remove(runId: string): void {
    this.storage.sql.exec("DELETE FROM blame_runs WHERE run_id = ?", runId);
  }

  /** Moves a read run's touch and expiry, at most once an hour. True when it moved. */
  touch(runId: string, now: number, expiresAt: number): boolean {
    const cursor = this.storage.sql.exec(
      `UPDATE blame_runs SET touched_at = ?, expires_at = ?
       WHERE run_id = ? AND touched_at <= ?`,
      now,
      expiresAt,
      runId,
      now - HOUR,
    );
    return cursor.rowsWritten > 0;
  }

  /** Every checkpoint a run names. */
  checkpointKeys(): string[] {
    return this.storage.sql
      .exec<{ checkpoint_key: string }>(
        "SELECT checkpoint_key FROM blame_runs WHERE checkpoint_key IS NOT NULL",
      )
      .toArray()
      .map((r) => r.checkpoint_key);
  }

  /** The earliest expiry among runs not in `skip`, or undefined when there are none. */
  nextExpiry(skip: ReadonlySet<string>): number | undefined {
    for (const row of this.storage.sql
      .exec<{ run_id: string; expires_at: number }>(
        "SELECT run_id, expires_at FROM blame_runs ORDER BY expires_at, run_id",
      )
      .toArray())
      if (!skip.has(row.run_id)) return row.expires_at;
    return undefined;
  }

  /** Runs expired by `now`, the earliest expiry first. */
  expired(now: number, limit: number): RunRow[] {
    return this.#rows(
      "SELECT * FROM blame_runs WHERE expires_at <= ? ORDER BY expires_at, run_id LIMIT ?",
      now,
      limit,
    );
  }

  /**
   * Records an attempt on the run's checkpoint `generation` and answers how
   * many there have been on it, this one included; 0 for a run that's gone.
   */
  beginAttempt(runId: string, generation: number): number {
    const [row] = this.storage.sql
      .exec<{ attempts: number }>(
        `UPDATE blame_runs
         SET attempts = CASE WHEN attempt_generation = ? THEN attempts + 1 ELSE 1 END,
             attempt_generation = ?
         WHERE run_id = ? RETURNING attempts`,
        generation,
        generation,
        runId,
      )
      .toArray();
    return row?.attempts ?? 0;
  }

  /** The attempts recorded on `generation`, without recording one. */
  peekAttempt(runId: string, generation: number): number {
    const row = this.get(runId);
    return row?.attemptGeneration === generation ? row.attempts : 0;
  }

  clearAttempts(runId: string): void {
    this.storage.sql.exec(
      "UPDATE blame_runs SET attempts = 0, attempt_generation = NULL WHERE run_id = ?",
      runId,
    );
  }
}
