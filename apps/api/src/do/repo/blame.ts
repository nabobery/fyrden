// Blame inside the repository object: a run per file and commit, walked in
// slices a request at a time, checkpointed in R2 under its row, and
// delivered in pages a continuation names, or as a window.
//
// A request, in order: the continuation's shape (no reads); one memory
// share for the whole request; the call allowance from the invocation's
// tally; one reader, opened lazily with blame's limits; the ref resolved
// through it; then the run: initialized, sliced, or delivered as it is.
import {
  blameCheckpointKey,
  MemoryWaitTimeoutError,
  newUlid,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import { currentInvocation } from "@fyrden/adapters-cloudflare/obs";
import {
  advanceBlame,
  BLAME_DECODING_WORK,
  BLAME_ENGINE_VERSION,
  type BlameRange,
  BlameReadsSpent,
  type BlameSliceLimits,
  type BlameSource,
  type BlameState,
  BlameStateError,
  BlameStateTooLarge,
  type BlockCache,
  blameRanges,
  createPrepaidMemory,
  createReaderWorkMeter,
  DEFAULT_BLAME_SLICE,
  decodeBlameState,
  encodeBlameState,
  MAX_STATE_BYTES,
  type ObjectReader,
  type Oid,
  oidFromHex,
  oidToHex,
  PackError,
  type ReaderWorkKind,
  ReaderWorkSpent,
  refuseHead,
  startBlame,
  UNRESOLVED_REASONS,
} from "@fyrden/git-core";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import { peelOid } from "../../git/peel.js";
import { resolveRef } from "../../git/resolve-ref.js";
import { afterSlice, RunRowAttemptLedger, sliceAttempt } from "./blame-attempts.js";
import {
  BlameCheckpointRefused,
  type CheckpointIdentity,
  openCheckpoint,
  sealCheckpoint,
} from "./blame-checkpoint.js";
import { BlameRuns, type RunKey, type RunRow, type RunState, runExpiry } from "./blame-runs.js";
import { repoBlameSource } from "./blame-source.js";
import { type BlameToken, decodeBlameToken, encodeBlameToken, pathDigest } from "./blame-token.js";

const MiB = 1024 * 1024;
/**
 * The request's one memory share, taken whole before any reading; Proposed.
 * It holds the reader's buffers and caches for one phase at a time, which
 * phases reuse, and ROOM_BYTES for the pack view and the live state, which
 * are counted exactly. Over half the object's operation pool, so one blame
 * request runs per object at a time: a second waits for the share, then
 * answers 503 blame_busy.
 */
export const BLAME_SHARE_BYTES = 48 * MiB;
/** The one cleanup job of a repository's blame runs. */
export const BLAME_PRUNE_JOB = "blame_prune";
const SHARE_WAIT_MS = 2_000;
/** The view and the live state together; each pack in the view counts 1 KiB. */
const ROOM_BYTES = 8 * MiB;
const VIEW_ENTRY_BYTES = 1024;
/**
 * Storage calls (index and pack range reads, the checkpoint's writes) an
 * invocation may make before blame stops; Proposed. It's the line the job
 * queue's default draws, below the 1,000 internal calls an invocation has on
 * Workers Free (FREE_INTERNAL_CALLS, measured). CALL_RESERVE of them pay for
 * the checkpoint, and one request reads with at most MAX_ALLOWANCE.
 */
const CALL_BUDGET = 800;
const CALL_RESERVE = 4;
const MAX_ALLOWANCE = 600;
const MIN_ALLOWANCE = 50;
const MAX_OBJECT_BYTES = 4 * MiB;
const DELTA_CACHE_BYTES = 8 * MiB;
const PREPAID_BYTES = 12 * MiB;
const CACHE_CALLS = 40;
const MAX_TAG_BYTES = 64 * 1024;
/**
 * Resolving a ref has its own small budget, so peeling a tag doesn't spend the
 * walk's allowance. A tag chain of at most 64 tags of at most 64 KiB fits.
 */
const RESOLVE_CALLS = 96;
const RESOLVE_WORK = 16 * MiB;
/** A checkpoint's state, plus its envelope's header and hash. */
const MAX_CHECKPOINT_BYTES = MAX_STATE_BYTES + 64 * 1024;
const MAX_WINDOW_LINES = 5_000;
const DEFAULT_PER_PAGE = 1_000;
const MAX_PER_PAGE = 5_000;
const RETRY_SECONDS = 1;
/** Reasons a cache or a compaction can change: a finished run with one expires sooner. */
const TRANSIENT = new Set(
  ["work_limit", "object_limit"].map((r) => UNRESOLVED_REASONS.indexOf(r as never)),
);

export interface BlameRequest {
  readonly path: string;
  readonly ref?: string;
  readonly continuation?: string;
  readonly perPage?: number;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

export interface BlameAnswer {
  readonly commit: string;
  readonly path: string;
  readonly blob: string;
  readonly lines: number;
  readonly state: "complete" | "partial";
  readonly resolved_lines: number;
  readonly unresolved_lines: number;
  readonly pending_lines: number;
  readonly ranges: (
    | { start_line: number; line_count: number; commit: string; source_start_line: number }
    | { start_line: number; line_count: number; unresolved: string }
  )[];
  readonly commits: Record<
    string,
    { summary: string; author: { name: string; email: string; date: string } }
  >;
  readonly next_continuation: string | null;
  readonly retry_after_seconds?: number;
}

export interface BlameFailure {
  readonly status: 404 | 409 | 422 | 503;
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: number;
}

export type BlameResult =
  | { readonly ok: true; readonly value: BlameAnswer }
  | { readonly ok: false; readonly failure: BlameFailure };

export interface RepoBlameDeps {
  readonly git: RepoGitStorage;
  readonly memoryBlocks: BlockCache;
  readonly repoId: () => string;
  readonly epochGen: () => number;
  /** Where the attempt mark is made durable: the object's storage, for `sync()`. */
  readonly storage: Pick<DurableObjectStorage, "sync">;
  readonly now?: () => number;
  /** Internal calls the invocation has made so far; the invocation's tally by default. */
  readonly spentCalls?: () => number;
  /** Slice limits over the defaults; tests walk a run in small slices with it. */
  readonly slice?: Partial<Omit<BlameSliceLimits, "stepIsFresh">>;
  /** A walking request's decoding work in place of `BLAME_DECODING_WORK`; tests run it out with it. */
  readonly decodingWork?: {
    readonly limit: number;
    readonly weights?: Partial<Record<ReaderWorkKind, number>>;
  };
}

const fail = (
  status: BlameFailure["status"],
  code: string,
  message: string,
  retryAfter?: number,
): BlameResult => ({
  ok: false,
  failure: { status, code, message, ...(retryAfter !== undefined && { retryAfter }) },
});
const busy = (message: string) => fail(503, "blame_busy", message, RETRY_SECONDS);
/** A run whose slices kept dying at the same point: final for this file and commit until it expires. */
const lost = () =>
  fail(
    422,
    "work_limit",
    "This file's blame kept failing at the same point, and can't be finished for now.",
  );
/**
 * Deaths after which a start is given up, or a run is kept lost: the third
 * attempt refused the step, and it died even so.
 */
const GIVE_UP_DEATHS = 3;
/** Whether a request still has its whole allowance: only then may a recovery attempt run. */
const fresh = (request: Request) =>
  request.allowance === MAX_ALLOWANCE && request.counts.reads === 0 && request.work.spent() === 0;
const invalidContinuation = () =>
  fail(422, "invalid_continuation", "The continuation doesn't belong to this blame.");
const restarted = () =>
  fail(
    409,
    "blame_restarted",
    "The blame this continuation reads has started over; start again from the beginning.",
  );

/** A ref resolved and pinned, or the answer refusing it. */
type Resolved = { ok: true; commit: Oid } | { ok: false; result: BlameResult };

/** A run's checkpoint read: its state, a reason to replace the run, or an answer. */
type Loaded =
  | { ok: true; state: BlameState }
  | { ok: false; replace: string }
  | { ok: false; result: BlameResult };

/** A request's reads and work, for one reader opened on first use. */
interface Request {
  readonly allowance: number;
  readonly counts: { reads: number };
  readonly work: ReturnType<typeof createReaderWorkMeter>;
  reader(): Promise<ObjectReader | undefined>;
  release(): void;
}

/** The path's segments, or undefined for a path blame can't take. */
function segments(path: string): Uint8Array[] | undefined {
  if (path.length === 0 || path.length > 4096) return undefined;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.includes("\0"))) return undefined;
  const encoder = new TextEncoder();
  return parts.map((p) => encoder.encode(p));
}

export class RepoBlame {
  readonly #runs: BlameRuns;
  readonly #ledger: RunRowAttemptLedger;
  /**
   * Runs with a slice in progress, entered before its first write: the run
   * cap and cleanup leave these rows alone, and cleanup doesn't end while
   * one is here.
   */
  readonly #active = new Set<string>();

  /** Runs with a slice in progress now. */
  activeRuns(): ReadonlySet<string> {
    return this.#active;
  }

  /**
   * After a restore: every run goes. A restored database can't know about
   * runs newer than its backup, so their objects have no rows; cleanup finds
   * them under the prefix.
   */
  restored(): void {
    this.deps.git.context.storage.sql.exec("DELETE FROM blame_runs");
    this.#ensureCleanup();
  }

  /** Queues the cleanup job; a failed one is queued again. */
  #ensureCleanup(): void {
    this.deps.git.jobs.ensure("blame_prune", BLAME_PRUNE_JOB);
  }
  readonly #now: () => number;

  constructor(private readonly deps: RepoBlameDeps) {
    this.#runs = new BlameRuns(deps.git.context.storage);
    this.#ledger = new RunRowAttemptLedger(this.#runs, deps.storage);
    this.#now = deps.now ?? Date.now;
  }

  async answer(input: BlameRequest): Promise<BlameResult> {
    const windowed = input.lineStart !== undefined || input.lineEnd !== undefined;
    let token: BlameToken | undefined;
    if (input.continuation !== undefined) {
      token = decodeBlameToken(input.continuation);
      if (!token || windowed) return invalidContinuation();
    }
    if (windowed) {
      const { lineStart: start, lineEnd: end } = input;
      if (
        start === undefined ||
        end === undefined ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 1 ||
        end < start ||
        end - start >= MAX_WINDOW_LINES
      )
        return fail(
          422,
          "invalid_window",
          "A window needs a first and last line, at most 5,000 apart.",
        );
    }
    const perPage = input.perPage ?? DEFAULT_PER_PAGE;
    if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE)
      return fail(422, "invalid_per_page", "per_page is from 1 to 5,000.");
    const path = segments(input.path);
    if (!path) return fail(422, "invalid_path", "That isn't a path in a repository.");

    const signal = AbortSignal.timeout(SHARE_WAIT_MS);
    let share: { release(): void };
    try {
      share = await this.deps.git.memory.begin(BLAME_SHARE_BYTES, signal);
    } catch (error) {
      if (signal.aborted || error instanceof MemoryWaitTimeoutError)
        return busy("Blame is busy in this repository; ask again shortly.");
      throw error;
    }
    try {
      return await this.#answer(input, token, path, windowed, perPage);
    } finally {
      share.release();
    }
  }

  /**
   * A reader's allowance from what the invocation has left: the walk's up to
   * 600 calls with the full decoding work, or, for resolving a ref, a small
   * fixed budget of its own. Resolution's calls stay in the invocation's
   * tally, so the walk's allowance is taken after it.
   */
  #request(kind: "walk" | "resolve" = "walk"): Request {
    const spent = this.deps.spentCalls?.() ?? currentInvocation()?.tally.internal ?? 0;
    const left = CALL_BUDGET - spent - CALL_RESERVE;
    const allowance = Math.min(kind === "walk" ? MAX_ALLOWANCE : RESOLVE_CALLS, left);
    const counts = { reads: 0 };
    const work = createReaderWorkMeter(
      kind === "walk"
        ? (this.deps.decodingWork ?? BLAME_DECODING_WORK)
        : { limit: RESOLVE_WORK, weights: BLAME_DECODING_WORK.weights },
    );
    let opened: Promise<ObjectReader | undefined> | undefined;
    return {
      allowance,
      counts,
      work,
      reader: () => {
        opened ??= openLiveReader(
          { git: this.deps.git, memoryBlocks: this.deps.memoryBlocks },
          {
            deltaBaseCacheBytes: DELTA_CACHE_BYTES,
            maxCacheCalls: CACHE_CALLS,
            maxReads: Math.max(0, allowance),
            counts,
            maxObjectBytes: MAX_OBJECT_BYTES,
            strictDeltaCache: true,
            memory: createPrepaidMemory(PREPAID_BYTES),
            work,
          },
        );
        return opened;
      },
      release: () => {
        void opened?.then((reader) => reader?.release());
      },
    };
  }

  async #answer(
    input: BlameRequest,
    token: BlameToken | undefined,
    path: Uint8Array[],
    windowed: boolean,
    perPage: number,
  ): Promise<BlameResult> {
    const repoId = this.deps.repoId();
    const epochGen = this.deps.epochGen();
    const digest = await pathDigest(input.path);
    let commit: Oid;
    if (token) {
      if (token.repo !== repoId || token.engine !== BLAME_ENGINE_VERSION || token.path !== digest)
        return invalidContinuation();
      if (token.epoch !== epochGen) return restarted();
      commit = oidFromHex(token.commit);
    } else {
      // The commit is resolved and pinned first, on a budget of its own, so peeling a
      // tag doesn't spend the walk's allowance: a recovery needs that allowance whole.
      const resolution = this.#request("resolve");
      let resolved: Resolved;
      try {
        resolved = await this.#resolveCommit(input.ref, resolution);
      } finally {
        resolution.release();
      }
      if (!resolved.ok) return resolved.result;
      commit = resolved.commit;
    }
    const request = this.#request();
    try {
      return await this.#run(input, token, commit, path, windowed, perPage, digest, request);
    } finally {
      request.release();
    }
  }

  async #run(
    input: BlameRequest,
    token: BlameToken | undefined,
    commit: Oid,
    path: Uint8Array[],
    windowed: boolean,
    perPage: number,
    digest: string,
    request: Request,
  ): Promise<BlameResult> {
    const repoId = this.deps.repoId();
    const epochGen = this.deps.epochGen();
    const key: RunKey = { commit, path: input.path, engineVersion: BLAME_ENGINE_VERSION, epochGen };
    let row: RunRow | undefined;
    if (token) {
      row = this.#runs.get(token.run);
      if (!row) return restarted();
      if (
        oidToHex(row.commit) !== token.commit ||
        row.path !== input.path ||
        row.epochGen !== epochGen
      )
        return invalidContinuation();
    } else {
      row = this.#runs.find(key);
    }
    const identity = (r: RunRow): CheckpointIdentity => ({
      repoId,
      epochGen,
      commit: oidToHex(r.commit),
      path: r.path,
      engineVersion: r.engineVersion,
      generation: r.generation,
    });

    const offset = token?.offset ?? 0;
    if (row && row.expiresAt <= this.#now()) this.#ensureCleanup();
    if (row?.state === "lost") return lost();
    let state: BlameState | undefined;
    let retry = false;
    if (!row || row.state === "initializing") {
      if (row) {
        const deaths = this.#ledger.peek(row.runId, 0);
        if (deaths >= GIVE_UP_DEATHS) {
          // Kept as a tombstone until it expires: the next viewer mustn't start the
          // same dying work again with a fresh count.
          this.#runs.markLost(row.runId, this.#now());
          this.#event("start_given_up", row.runId);
          return lost();
        }
        if (deaths >= 1 && !fresh(request))
          return busy("This file's blame is recovering; ask again shortly.");
      }
      if (request.allowance < MIN_ALLOWANCE)
        return busy("Too little of this request is left to start a blame.");
      const made = await this.#initialize(key, row, path, request, identity);
      if (!made.ok) return made.result;
      ({ row, state } = made);
    } else {
      // Whether this request walks is decided from the row, before the checkpoint
      // is decoded: decoding may be what kills a slice, so the attempt is marked first.
      const walks = row.state !== "done" && (windowed || offset >= row.settledRanges);
      let attempt = 0;
      if (walks && request.allowance - request.counts.reads >= MIN_ALLOWANCE) {
        const deaths = this.#ledger.peek(row.runId, row.generation);
        if (deaths >= GIVE_UP_DEATHS) {
          this.#runs.markLost(row.runId, this.#now());
          this.#event("lost", row.runId);
          return lost();
        }
        if (deaths >= 1 && !fresh(request))
          return busy("This file's blame is recovering; ask again shortly.");
        attempt = await this.#ledger.begin(row.runId, row.generation);
      } else if (walks) {
        retry = true;
      }
      const marked = row;
      let loaded: Loaded;
      try {
        loaded = await this.#load(row, identity(row));
      } catch (error) {
        // A failure the request reports isn't a death: take the attempt back.
        if (attempt > 0) this.#ledger.release(marked.runId, marked.generation);
        throw error;
      }
      if (!loaded.ok) {
        if ("replace" in loaded) {
          this.#runs.remove(row.runId);
          this.#event("replaced", row.runId, loaded.replace);
          if (token) return restarted();
          return this.#run(input, undefined, commit, path, windowed, perPage, digest, request);
        }
        if (attempt > 0) this.#ledger.release(marked.runId, marked.generation);
        return loaded.result;
      }
      state = loaded.state;
      if (attempt > 0) {
        ({ row, state } = await this.#slice(row, state, request, identity, attempt));
      } else if (row.state === "done") {
        this.#runs.touch(row.runId, this.#now(), this.#expiry(row.state, state));
      }
      return {
        ok: true,
        value: this.#deliver(row, state, input, digest, offset, windowed, perPage, retry),
      };
    }

    // A run just started: walk on in the same request when enough of it is left.
    if (row.state !== "done") {
      if (request.allowance - request.counts.reads >= MIN_ALLOWANCE) {
        const attempt = await this.#ledger.begin(row.runId, row.generation);
        ({ row, state } = await this.#slice(row, state, request, identity, attempt));
      } else {
        retry = true;
      }
    }
    return {
      ok: true,
      value: this.#deliver(row, state, input, digest, offset, windowed, perPage, retry),
    };
  }

  async #resolveCommit(
    ref: string | undefined,
    request: Request,
  ): Promise<{ ok: true; commit: Oid } | { ok: false; result: BlameResult }> {
    const { git } = this.deps;
    const direct = (name: string): Oid | undefined => {
      const [row] = git.context.storage.sql
        .exec<{ oid: ArrayBuffer }>("SELECT oid FROM refs WHERE name = ? AND kind = 'direct'", name)
        .toArray();
      return row ? (new Uint8Array(row.oid) as Oid) : undefined;
    };
    const verified = (oid: Oid) => git.commitGraph.readBounded(oid, 0) !== undefined;
    let tooLarge = false;
    try {
      const resolved = await resolveRef(ref, {
        head: () => {
          const name = git.refStore.head();
          return name ? direct(name) : undefined;
        },
        ref: direct,
        isVerified: verified,
        commitOf: async (oid) => {
          if (verified(oid)) return oid;
          const reader = await request.reader();
          if (!reader) return undefined;
          const peeled = await peelOid(
            {
              readHeader: (o) => reader.readHeader(o),
              readObject: async (o) => {
                const header = await reader.readHeader(o);
                if (header?.type === "tag" && header.size > MAX_TAG_BYTES) {
                  tooLarge = true;
                  return undefined;
                }
                return reader.readObject(o);
              },
            },
            oid,
          );
          return peeled && verified(peeled) ? peeled : undefined;
        },
      });
      if (tooLarge)
        return { ok: false, result: fail(422, "ref_unreadable", "The tag is too large to read.") };
      if (resolved.ok) return { ok: true, commit: resolved.commit };
      return {
        ok: false,
        result:
          resolved.reason === "repo_empty"
            ? fail(409, "repo_empty", "The repository is empty.")
            : fail(404, "ref_not_found", `No commit ${ref} was found.`),
      };
    } catch (error) {
      // Resolution has a small budget of its own: a tag that needs more is refused.
      const spent =
        error instanceof ReadBudgetError ||
        error instanceof ReaderWorkSpent ||
        (error instanceof PackError &&
          (error.code === "delta-too-deep" || error.code === "object-too-large"));
      if (spent)
        return {
          ok: false,
          result: fail(422, "ref_unreadable", "The tag takes more than blame reads to peel."),
        };
      throw error;
    }
  }

  /** A failure before any line exists: a refusal to answer, or undefined to throw. */
  #initRefusal(error: unknown, request: Request): BlameResult | undefined {
    if (error instanceof PackError && error.code === "object-too-large")
      return fail(422, "object_limit", "Finding the file needs an object larger than blame reads.");
    const spent =
      error instanceof ReadBudgetError ||
      error instanceof BlameReadsSpent ||
      error instanceof ReaderWorkSpent;
    const deep = error instanceof PackError && error.code === "delta-too-deep";
    if (spent || deep) {
      if (deep || request.allowance === MAX_ALLOWANCE)
        return fail(422, "work_limit", "Finding the file takes more work than one request may do.");
      return busy("Too little of this request is left to start a blame.");
    }
    return undefined;
  }

  /**
   * Starts a run. Its row is created, or reused when an earlier start died,
   * as initializing, and the attempt is marked before the starting text is
   * read, so a start that dies is counted. A start that fails in a way it can
   * answer creates no run: its row goes.
   */
  async #initialize(
    key: RunKey,
    existing: RunRow | undefined,
    path: Uint8Array[],
    request: Request,
    identity: (r: RunRow) => CheckpointIdentity,
  ): Promise<{ ok: true; row: RunRow; state: BlameState } | { ok: false; result: BlameResult }> {
    const reader = await request.reader();
    if (!reader) return { ok: false, result: fail(409, "repo_empty", "The repository is empty.") };
    const run = existing ?? this.#runs.create(key, this.#now(), this.#active).row;
    if (!existing) this.#ensureCleanup();
    this.#active.add(run.runId);
    const giveUp = (result: BlameResult) => {
      this.#runs.remove(run.runId);
      return { ok: false as const, result };
    };
    try {
      await this.#ledger.begin(run.runId, 0);
      const base = repoBlameSource(reader, this.deps.git.commitGraph, request.work);
      let blob: Oid | undefined;
      // The starting file's blob is the first fileAt answer: startBlame looks it up first.
      const source: BlameSource = {
        ...base,
        fileAt: async (tree, segs) => {
          const found = await base.fileAt(tree, segs);
          blob ??= found?.oid;
          return found;
        },
      };
      let started: Awaited<ReturnType<typeof startBlame>>;
      try {
        started = await startBlame(source, key.commit, path, { maxLiveStateBytes: this.#room() });
      } catch (error) {
        const refused = this.#initRefusal(error, request);
        if (refused) return giveUp(refused);
        throw error;
      }
      if ("failure" in started) {
        switch (started.failure) {
          case "path_not_found":
            return giveUp(fail(404, "path_not_found", "No file is at that path at this commit."));
          case "file_too_large":
            return giveUp(
              fail(
                422,
                "file_too_large",
                "The file is over 1 MiB or 100,000 lines, more than blame reads.",
              ),
            );
          case "commit_missing":
            return giveUp(fail(404, "ref_not_found", "The commit isn't in this repository."));
          case "state_too_large":
            return giveUp(busy("Blame has no room for this file right now."));
        }
      }
      // Publishing clears the attempt mark.
      const published = await this.#publish(run, started, blob ?? null, identity);
      return { ok: true, row: published, state: started };
    } catch (error) {
      // A failure the request reports (R2, say) isn't a death. A run this request
      // created goes, as a start that answers does; one an earlier start left keeps
      // its earlier deaths, less this attempt.
      if (existing) this.#ledger.release(run.runId, 0);
      else this.#runs.remove(run.runId);
      throw error;
    } finally {
      this.#active.delete(run.runId);
    }
  }

  /** Writes `state` as the run's next checkpoint and moves its row; the row as it now is. */
  async #publish(
    row: RunRow,
    state: BlameState,
    blob: Oid | null,
    identity: (r: RunRow) => CheckpointIdentity,
  ): Promise<RunRow> {
    const { git } = this.deps;
    const now = this.#now();
    const generation = row.generation + 1;
    const runState: RunState = state.queue.length === 0 ? "done" : "running";
    let checkpointKey: string | null = null;
    let checkpointBytes = 0;
    if (state.lines > 0) {
      const sealed = await sealCheckpoint(
        identity({ ...row, generation }),
        encodeBlameState(state),
      );
      checkpointKey = blameCheckpointKey({
        repoId: this.deps.repoId(),
        runId: row.runId,
        generation,
        ulid: newUlid(now),
      });
      checkpointBytes = sealed.length;
      await git.bucket.put(checkpointKey, sealed);
    }
    const counts = tally(state);
    const moved = this.#runs.publish(
      row.runId,
      { generation: row.generation, epochGen: row.epochGen },
      {
        blobOid: blob ?? row.blobOid,
        generation,
        checkpointKey,
        checkpointBytes,
        state: runState,
        lines: state.lines,
        settledRanges: state.rangeCount,
        unresolvedLines: counts.unresolved,
        touchedAt: now,
        expiresAt: this.#expiry(runState, state),
      },
    );
    if (!moved) {
      // Another slice, a restore or cleanup moved the row first: this object is no one's.
      if (checkpointKey) await git.bucket.delete(checkpointKey);
      const now = this.#runs.get(row.runId);
      if (now) return now;
      // The row is gone: deliver what this slice computed, as it would have stood. A
      // continuation naming the gone run starts over.
      return {
        ...row,
        blobOid: blob ?? row.blobOid,
        generation,
        state: runState,
        lines: state.lines,
      };
    }
    if (row.checkpointKey) await git.bucket.delete(row.checkpointKey).catch(() => {});
    return this.#runs.get(row.runId) as RunRow;
  }

  async #load(
    row: RunRow,
    identity: CheckpointIdentity,
  ): Promise<
    | { ok: true; state: BlameState }
    | { ok: false; replace: string }
    | { ok: false; result: BlameResult }
  > {
    if (row.state === "initializing" || row.state === "lost" || row.checkpointKey === null) {
      if (row.state === "done" && row.lines === 0) return { ok: true, state: emptyState(row) };
      return { ok: false, replace: `a ${row.state} run without a checkpoint` };
    }
    if (row.checkpointBytes > MAX_CHECKPOINT_BYTES)
      return { ok: false, replace: "checkpoint over its limit" };
    const object = await this.deps.git.bucket.get(row.checkpointKey);
    if (!object) return { ok: false, replace: "checkpoint missing" };
    if (object.size !== row.checkpointBytes) {
      await object.body.cancel();
      return { ok: false, replace: "checkpoint of the wrong size" };
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== row.checkpointBytes)
      return { ok: false, replace: "checkpoint of the wrong size" };
    let stateBytes: Uint8Array;
    try {
      stateBytes = await openCheckpoint(identity, bytes, MAX_CHECKPOINT_BYTES);
    } catch (error) {
      if (error instanceof BlameCheckpointRefused)
        return { ok: false, replace: `checkpoint ${error.reason}` };
      throw error;
    }
    try {
      return { ok: true, state: decodeBlameState(stateBytes, { maxLiveStateBytes: this.#room() }) };
    } catch (error) {
      if (error instanceof BlameStateTooLarge)
        return { ok: false, result: busy("Blame has no room for this file right now.") };
      if (error instanceof BlameStateError)
        return { ok: false, replace: "checkpoint state malformed" };
      throw error;
    }
  }

  /**
   * One slice of a running run, as attempt `attempt` on its checkpoint:
   * the whole slice, one step on a recovery, or the head step refused as
   * step_lost after two deaths. Publishing clears the mark; a slice that
   * publishes nothing clears it, unless `afterSlice` says it counts as a death.
   */
  async #slice(
    row: RunRow,
    state: BlameState,
    request: Request,
    identity: (r: RunRow) => CheckpointIdentity,
    attempt: number,
  ): Promise<{ row: RunRow; state: BlameState }> {
    this.#active.add(row.runId);
    try {
      const reader = await request.reader();
      if (!reader) {
        this.#ledger.release(row.runId, row.generation);
        return { row, state };
      }
      const walked = await this.#walk(row, state, request, identity, reader, attempt);
      if (!walked.published) {
        const pending = walked.state.queue.length > 0 && !walked.state.stateLimit;
        if (afterSlice({ attempt, steps: walked.steps, pending }) === "release")
          this.#ledger.release(row.runId, row.generation);
      }
      return walked;
    } catch (error) {
      // A failure the request reports is not a death: take this attempt back.
      this.#ledger.release(row.runId, row.generation);
      throw error;
    } finally {
      this.#active.delete(row.runId);
    }
  }

  async #walk(
    row: RunRow,
    state: BlameState,
    request: Request,
    identity: (r: RunRow) => CheckpointIdentity,
    reader: ObjectReader,
    attempt: number,
  ): Promise<{ row: RunRow; state: BlameState; published: boolean; steps: number }> {
    const limits: BlameSliceLimits = {
      ...DEFAULT_BLAME_SLICE,
      ...this.deps.slice,
      maxLiveStateBytes: this.#room(),
      // A fresh step began with the whole allowance untouched: only such a step can be refused as too large.
      stepIsFresh: () =>
        request.allowance === MAX_ALLOWANCE &&
        request.counts.reads === 0 &&
        request.work.spent() === 0,
    };
    const plan = sliceAttempt(attempt, limits);
    let steps = 0;
    if (plan.kind === "refuse") {
      refuseHead(state, "step_lost", limits);
      steps = 1;
    } else {
      const before = encodeBlameState(state);
      const source = repoBlameSource(reader, this.deps.git.commitGraph, request.work);
      steps = (await advanceBlame(state, source, plan.limits)).steps;
      // Nothing moved (the allowance ran out before a step): nothing to write.
      if (sameBytes(before, encodeBlameState(state)))
        return { row, state, published: false, steps };
    }
    const published = await this.#publish(row, state, null, identity);
    if (published.generation !== row.generation + 1) {
      // The row moved under this slice: deliver what it now holds.
      const loaded = await this.#load(published, identity(published));
      return { row: published, state: loaded.ok ? loaded.state : state, published: true, steps };
    }
    return { row: published, state, published: true, steps };
  }

  /** A run event: a metric, and an error log for an operator. */
  #event(event: "lost" | "start_given_up" | "replaced", runId: string, detail?: string): void {
    this.deps.git.context.metrics.count("blame.run", { event });
    console.error(
      JSON.stringify({
        message: event === "replaced" ? "blame run replaced" : "blame run lost",
        event,
        run: runId,
        ...(detail && { detail }),
      }),
    );
  }

  #room(): number {
    const packs = this.deps.git.registry.inState("live").length;
    return ROOM_BYTES - packs * VIEW_ENTRY_BYTES;
  }

  #expiry(runState: RunState, state: BlameState): number {
    let transient = false;
    for (let k = 0; k < state.rangeCount && !transient; k++) {
      const reference = state.ranges[4 * k + 2] as number;
      if (reference < 0 && TRANSIENT.has(-1 - reference)) transient = true;
    }
    return runExpiry({ state: runState, now: this.#now(), transient });
  }

  #deliver(
    row: RunRow,
    state: BlameState,
    input: BlameRequest,
    digest: string,
    offset: number,
    windowed: boolean,
    perPage: number,
    retry: boolean,
  ): BlameAnswer {
    const settled = state.rangeCount;
    const derived = state.stateLimit ? blameRanges(state, settled, Number.MAX_SAFE_INTEGER) : [];
    const total = settled + derived.length;
    let ranges: BlameRange[];
    let next: number | undefined;
    if (windowed) {
      const start = input.lineStart as number;
      const end = input.lineEnd as number;
      ranges = clipped([...blameRanges(state, 0, settled), ...derived], start, end);
      next = undefined;
    } else {
      const from = Math.min(offset, total);
      ranges =
        from < settled
          ? blameRanges(state, from, perPage)
          : derived.slice(from - settled, from - settled + perPage);
      const reached = from + ranges.length;
      next = row.state === "done" && reached >= total ? undefined : reached;
    }
    const counts = tally(state);
    const commits: BlameAnswer["commits"] = {};
    const wire = ranges.map((range) => {
      if ("unresolved" in range)
        return {
          start_line: range.startLine,
          line_count: range.lineCount,
          unresolved: range.unresolved,
        };
      const hex = oidToHex(range.commit);
      const fact = state.facts[hex];
      if (fact && !commits[hex])
        commits[hex] = {
          summary: fact.summary,
          author: { name: fact.name, email: fact.email, date: fact.date },
        };
      return {
        start_line: range.startLine,
        line_count: range.lineCount,
        commit: hex,
        source_start_line: range.sourceStartLine,
      };
    });
    const token =
      next === undefined
        ? null
        : encodeBlameToken({
            v: 1,
            repo: this.deps.repoId(),
            epoch: row.epochGen,
            commit: oidToHex(row.commit),
            path: digest,
            engine: row.engineVersion,
            run: row.runId,
            offset: next,
          });
    return {
      commit: oidToHex(row.commit),
      path: row.path,
      blob: row.blobOid ? oidToHex(row.blobOid) : "",
      lines: state.lines,
      state: row.state === "done" ? "complete" : "partial",
      resolved_lines: counts.resolved,
      unresolved_lines: counts.unresolved,
      pending_lines: state.lines - counts.resolved - counts.unresolved,
      ranges: wire,
      commits,
      next_continuation: token,
      ...(retry && { retry_after_seconds: RETRY_SECONDS }),
    };
  }
}

/** Lines settled to a commit and lines refused, with a flagged state's derived ranges counted. */
function tally(state: BlameState): { resolved: number; unresolved: number } {
  let resolved = 0;
  let unresolved = 0;
  for (let k = 0; k < state.rangeCount; k++) {
    const count = state.ranges[4 * k + 1] as number;
    if ((state.ranges[4 * k + 2] as number) >= 0) resolved += count;
    else unresolved += count;
  }
  if (state.stateLimit) unresolved = state.lines - resolved;
  return { resolved, unresolved };
}

/** The ranges overlapping lines `start` to `end`, cut to them, in line order. */
function clipped(ranges: BlameRange[], start: number, end: number): BlameRange[] {
  const out: BlameRange[] = [];
  for (const range of ranges) {
    const first = Math.max(range.startLine, start);
    const last = Math.min(range.startLine + range.lineCount - 1, end);
    if (first > last) continue;
    const cut = first - range.startLine;
    out.push(
      "unresolved" in range
        ? { startLine: first, lineCount: last - first + 1, unresolved: range.unresolved }
        : {
            startLine: first,
            lineCount: last - first + 1,
            commit: range.commit,
            sourceStartLine: range.sourceStartLine + cut,
          },
    );
  }
  return out.sort((a, b) => a.startLine - b.startLine);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, k) => v === b[k]);
}

/** The state of an empty file's finished run: no lines, nothing stored. */
function emptyState(row: RunRow): BlameState {
  return {
    commit: row.commit,
    path: [],
    lines: 0,
    steps: 0,
    queue: [],
    ranges: new Int32Array(0),
    rangeCount: 0,
    facts: {},
    factOrder: [],
    stateLimit: false,
  } as BlameState;
}
