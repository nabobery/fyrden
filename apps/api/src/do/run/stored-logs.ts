import type { DoMemoryBudget } from "@fyrden/adapters-cloudflare/git";
import type { RunEngine } from "./engine.js";
import { LOG_READER_POLICY } from "./log-reader.js";
import { LOG_LATE_MS } from "./logs.js";

type MemoryReservation = NonNullable<ReturnType<DoMemoryBudget["tryReserve"]>>;

export interface JobLog {
  readonly task: number | null;
  /** Whether ingestion finalized or its late window ended, or the job ended without a task. */
  readonly ended: boolean;
  readonly state: "complete" | "incomplete" | null;
  /** The end of the last stored chunk: positions below it are stored lines. */
  readonly linesEnd: number;
  /** Stored before masking: never read. */
  readonly unmasked: boolean;
}

/** A stored chunk, as the manifest names it: lines `[start, end)`. */
export interface LogChunk {
  readonly task: number;
  readonly start: number;
  readonly end: number;
  readonly bytes: number;
  readonly key: string;
}

type ChunkRow = { start_index: number; end_index: number; bytes: number; r2_key: string };

const chunkOf = (task: number, row: ChunkRow): LogChunk => ({
  task,
  start: row.start_index,
  end: row.end_index,
  bytes: row.bytes,
  key: row.r2_key,
});

export interface StoredLogsHost {
  readonly engine: RunEngine;
  readonly memory: DoMemoryBudget;
  now(): number;
  dropViewerCaches(): void;
  dropMaskCaches(): void;
}

/** A read in progress: an upload that needs its memory aborts it, and waits until it finished. */
export interface LogRead {
  readonly signal: AbortSignal;
  finish(): void;
}

/** Parser buffers, the small-row batch and encoded frame scratch. Proposed. */
const LOG_READER_SCRATCH_BYTES = 7 * 512 * 1024;

export class StoredLogs {
  readonly #reads = new Set<{
    readonly abort: AbortController;
    readonly finished: Promise<void>;
  }>();

  constructor(private readonly host: StoredLogsHost) {}

  jobLog(jobId: number): JobLog {
    const { engine } = this.host;
    const instance = engine.instance(jobId);
    const task = instance?.task ?? null;
    if (task === null)
      return {
        task: null,
        ended: instance === undefined || instance.status === "completed",
        state: "complete",
        linesEnd: 0,
        unmasked: false,
      };
    const log = engine.rows<{
      state: string;
      finalized: number;
      unmasked: number;
      ended_at: number | null;
      lines_end: number | null;
    }>(
      `SELECT l.state, l.finalized, l.unmasked, l.ended_at,
         CASE WHEN l.unmasked = 1 THEN 0
           ELSE (SELECT c.end_index FROM ci_log_chunks c WHERE c.task = l.task
                 ORDER BY c.start_index DESC LIMIT 1) END AS lines_end
       FROM ci_logs l WHERE l.task = ?`,
      task,
    )[0];
    const state =
      log?.unmasked === 1
        ? "incomplete"
        : log?.state === "complete" || log?.state === "incomplete"
          ? log.state
          : null;
    return {
      task,
      ended:
        log?.finalized === 1 ||
        state === "complete" ||
        (log?.ended_at !== null &&
          log?.ended_at !== undefined &&
          log.ended_at + LOG_LATE_MS <= this.host.now()),
      state,
      linesEnd: log?.lines_end ?? 0,
      unmasked: log?.unmasked === 1,
    };
  }

  chunkAt(task: number, index: number): LogChunk | null {
    // Chunks never overlap, so the last to start at or before it is the only one that may.
    const row = this.host.engine.rows<ChunkRow>(
      `SELECT start_index, end_index, bytes, r2_key FROM ci_log_chunks
       WHERE task = ? AND start_index <= ? ORDER BY start_index DESC LIMIT 1`,
      task,
      index,
    )[0];
    return row && row.end_index > index ? chunkOf(task, row) : null;
  }

  chunksFrom(task: number, index: number, limit: number): LogChunk[] {
    return this.host.engine
      .rows<ChunkRow>(
        `SELECT start_index, end_index, bytes, r2_key FROM ci_log_chunks
         WHERE task = ? AND start_index >= ? ORDER BY start_index LIMIT ?`,
        task,
        index,
        limit,
      )
      .map((row) => chunkOf(task, row));
  }

  /** The last first. */
  chunksBefore(task: number, index: number, limit: number): LogChunk[] {
    return this.host.engine
      .rows<ChunkRow>(
        `SELECT start_index, end_index, bytes, r2_key FROM ci_log_chunks
         WHERE task = ? AND start_index < ? ORDER BY start_index DESC LIMIT ?`,
        task,
        index,
        limit,
      )
      .map((row) => chunkOf(task, row));
  }

  /**
   * Memory to parse a chunk of `bytes`, and `extra` besides; undefined when
   * the pool is short even after what is only kept for speed gave way.
   */
  reserve(bytes: number, extra = 0): MemoryReservation | undefined {
    const { memory } = this.host;
    const need =
      2 * Math.min(LOG_READER_POLICY.maxDecodedUnits, bytes) + LOG_READER_SCRATCH_BYTES + extra;
    let reservation = memory.tryReserve(need);
    if (!reservation) {
      this.host.dropViewerCaches();
      reservation = memory.tryReserve(need);
    }
    if (!reservation) {
      // Kept matchers only save rebuilding: they give way, or a large chunk could never be read.
      this.host.dropMaskCaches();
      reservation = memory.tryReserve(need);
    }
    return reservation ?? undefined;
  }

  /** A read begins; whatever it reserved must be released before it finishes. */
  beginRead(): LogRead {
    const abort = new AbortController();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const read = { abort, finished };
    this.#reads.add(read);
    return {
      signal: abort.signal,
      finish: () => {
        this.#reads.delete(read);
        finish();
      },
    };
  }

  /** Aborts every read in progress; resolves once they all finished. False when there were none. */
  abortReads(): false | Promise<unknown> {
    const reads = [...this.#reads];
    if (reads.length === 0) return false;
    for (const read of reads) read.abort.abort();
    return Promise.all(reads.map((read) => read.finished));
  }
}
