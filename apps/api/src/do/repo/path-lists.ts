import { MemoryWaitTimeoutError, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  type CursorName,
  compareTreeEntries,
  DIFF_START,
  type DiffCursor,
  diffTreesFrom,
  GitObjectError,
  isTreeMode,
  type MemoryBudget,
  type MemoryReservation,
  type ObjectReader,
  type Oid,
  oidToHex,
  ReadDeferred,
  ReaderWorkSpent,
  TreeDiffLimitError,
  type TreeEntry,
} from "@fyrden/git-core";
import { ReadBudgetError } from "../../git/live-reader.js";
import { type Browsed, fail, type RepoBrowse, TOO_EXPENSIVE } from "./browse.js";
import { sameCursor } from "./diff-cursors.js";
import {
  type HeldReads,
  ReadsBudgetSpent,
  ReadsMemoryBusy,
  ReadsTooLargeError,
  UnreadableObjectError,
  withHeldReads,
} from "./held-reads.js";

/*
 * A tree's file paths in pages. A page's cursor alone can resume the walk: it
 * holds the commit and the last path consumed, so a stored list only saves
 * work, and losing one (eviction, a restore, a failed write) never changes an
 * answer. Lists are stored for the default branch's tip only: other refs walk
 * each time and write nothing, so reads cannot spend the day's row writes.
 *
 * A client's cursor seeks only inside a tree the caller may already read. It
 * never writes: a build appends from its row's own position, and starts only
 * from a request with no cursor at all. Its numbers change what that caller is
 * told, for the pages it asks for.
 */

export interface PathsPolicy {
  /** Paths one list holds at most; a tree of exactly this many is complete. */
  readonly maxPaths: number;
  /** Bytes one list charges at most: each path's length plus one, left-out names too. */
  readonly maxListBytes: number;
  /** The longest path. */
  readonly maxPathBytes: number;
  /** Directories deep a path may be. */
  readonly maxDepth: number;
  /** The largest tree read: about 37,000 entries. */
  readonly maxTreeBytes: number;
  /** Bytes one slice takes, the same charge: one segment row (a row may hold 2 MB). */
  readonly sliceBytes: number;
  /** Paths one slice takes. */
  readonly sliceEntries: number;
  /** Tree entries one slice reads. */
  readonly sliceScanned: number;
  /** Tree bytes one slice reads; holds at most about 54 MiB of the object's 72 MiB. */
  readonly sliceTreeBytes: number;
  /** A page's JSON, escapes counted (control characters can expand a page about sixfold). */
  readonly maxPageJsonBytes: number;
  /** R2 reads after which a slice ends. */
  readonly walkReads: number;
  /** R2 reads a request makes at most. */
  readonly maxReads: number;
  /** Bytes the request's reader may build. */
  readonly maxBuiltBytes: number;
  /** Slices one stored build writes; past it the row stops growing and answers walk on. */
  readonly maxBuildSlices: number;
  /** A list finishing in its first slice having read fewer trees is not stored. */
  readonly keepMinTrees: number;
  /** Lists stored per repository: two tips cover readers across one push. */
  readonly maxLists: number;
  /** Bytes stored per repository: two lists at the byte cap. */
  readonly maxKeptBytes: number;
  /** How long a `busy` answer asks a client to wait. */
  readonly busyRetryMs: number;
}

/** Proposed values (to be measured on Workers Free). */
export const PATHS_POLICY: PathsPolicy = {
  maxPaths: 200_000,
  maxListBytes: 16 * 1024 * 1024,
  maxPathBytes: 4096,
  maxDepth: 64,
  maxTreeBytes: 1024 * 1024,
  sliceBytes: 512 * 1024,
  sliceEntries: 10_000,
  sliceScanned: 200_000,
  sliceTreeBytes: 2 * 1024 * 1024,
  maxPageJsonBytes: 1024 * 1024,
  walkReads: 400,
  maxReads: 800,
  maxBuiltBytes: 64 * 1024 * 1024,
  maxBuildSlices: 256,
  keepMinTrees: 16,
  maxLists: 2,
  maxKeptBytes: 32 * 1024 * 1024,
  busyRetryMs: 500,
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A path's text, or undefined when it is not UTF-8 (a decoder shared: a slice decodes 10,000). */
function pathText(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/** A tree the walk cannot page through: see `wellFormed`. */
class MalformedTree extends Error {
  override name = "MalformedTree";
}

/**
 * Whether a tree's entries are strictly in git's order, with no name holding a
 * slash. A cursor's seek relies on both, and they are what makes a position
 * only ever move forward: over a tree without them (a push refuses one, but
 * nothing else promises it) a cursor can go round for ever with no path taken,
 * and no cap would end that.
 */
function wellFormed(entries: readonly TreeEntry[]): boolean {
  let previous: TreeEntry | undefined;
  for (const entry of entries) {
    if (entry.name.includes(0x2f)) return false;
    if (previous && compareTreeEntries(previous, entry) >= 0) return false;
    previous = entry;
  }
  return true;
}

/** Memory a slice takes at a time for the paths it holds. */
const MEMORY_BLOCK_BYTES = 1024 * 1024;
/** Subtrees looked up together after a tree is read. */
const PREFETCH_SUBTREES = 1000;
/** git's empty tree, which a repository need not store. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * What the walker holds per path it took: the path's bytes and text, its entry's
 * name and id, and a cursor with an array of its ancestors. Measured in Node with
 * the real walker and tree parser (not in workerd, nor through pack decoding):
 * 1,100 bytes a path of 6 bytes, 1,172 of 25 bytes at depth 2, 2,847 of 510 bytes
 * at depth 63. This charges 1,312, 1,450 and 8,520 for them.
 */
const pathMemoryBytes = (pathBytes: number, depth: number) => 2 * pathBytes + 1200 + 100 * depth;

export type FinalReason =
  | "too_many_paths"
  | "too_many_bytes"
  | "tree_too_large"
  | "too_deep"
  | "path_too_long"
  | "malformed_tree";

export type PathsReason = FinalReason | "more_pages" | "too_much_work" | "busy" | "unreadable";

/** A position as a cursor carries it: a path's bytes (base64) and what its last name is. */
export type WirePosition = readonly [path: string, kind: 0 | 1 | 2];

/** A page's cursor, as the API encodes it. */
export interface PathCursor {
  /** The commit, hex. */
  readonly c: string;
  /** Paths visited. */
  readonly n: number;
  /** Bytes charged. */
  readonly b: number;
  /** The walk's position; null at the start. */
  readonly w: WirePosition | null;
}

export interface PathsInput {
  readonly ref?: string;
  readonly cursor?: PathCursor;
  readonly perPage: number;
}

export interface PathsPage {
  readonly commit: string;
  readonly tree: string;
  readonly state: "complete" | "incomplete" | "unavailable";
  readonly reason: PathsReason | null;
  readonly paths: string[];
  readonly visited: number;
  readonly totalPaths: number | null;
  readonly unlistedNames: number;
  readonly next: PathCursor | null;
  readonly retryAfterMs: number | null;
}

/** The parts of a browse request a page uses. */
export type PathBrowse = Pick<RepoBrowse, "resolveTree" | "isDefaultTip" | "reads"> & {
  reader(): Promise<Pick<ObjectReader, "readHeader" | "readObject" | "prefetch">>;
};

/** Test seams: an await before a keep, each statement's row counts, each slice's trees. */
export interface PathListHooks {
  readonly beforeKeep?: () => void | Promise<void>;
  readonly rows?: (read: number, written: number) => void;
  readonly sliced?: (trees: number) => void;
}

export interface PathListsDeps {
  readonly git: {
    readonly context: RepoGitStorage["context"];
    readonly memory: MemoryBudget;
  };
  readonly epochGen: () => number;
  readonly policy: () => PathsPolicy;
  readonly log: () => { warn(message: string, fields?: Record<string, unknown>): void };
  readonly hooks?: PathListHooks;
}

interface ListRow extends Record<string, SqlStorageValue> {
  tree_sha: string;
  limits: string;
  epoch_gen: number;
  state: "building" | "complete" | "capped" | "walk_only";
  reason: FinalReason | null;
  cursor: string | null;
  visited: number;
  bytes: number;
  slices: number;
}

/** A path as a page consumes it: its bytes, and its text unless it is not UTF-8. */
interface Taken {
  readonly bytes: Uint8Array;
  readonly text: string | undefined;
}

interface Slice {
  readonly taken: readonly Taken[];
  readonly next: DiffCursor | null;
  readonly final: FinalReason | null;
  /** The walk reached the tree's end. */
  readonly done: boolean;
  /** Memory ran out: what stopped it may free up shortly. */
  readonly busy: boolean;
  readonly unreadable: boolean;
  readonly trees: number;
}

/** Where a request walks from, and the numbers it continues. */
interface Walk {
  readonly from: DiffCursor | null;
  readonly visited: number;
  readonly bytes: number;
}

interface Context {
  readonly commit: string;
  readonly tree: string;
  readonly limits: string;
  readonly policy: PathsPolicy;
  readonly input: PathsInput;
}

const INVALID_CURSOR = fail(422, "invalid_cursor", "The cursor is not one this API returned.");

export class PathLists {
  constructor(private readonly deps: PathListsDeps) {}

  /** One page of `input`'s commit: from a stored list when one covers it, else one walked slice. */
  async page(browse: PathBrowse, input: PathsInput): Promise<Browsed<PathsPage>> {
    let at: Awaited<ReturnType<PathBrowse["resolveTree"]>>;
    try {
      at = await browse.resolveTree(input.cursor ? input.cursor.c : input.ref);
    } catch (error) {
      // Peeling a tag spent the reader's building budget: `guarded` knows only its reads.
      if (error instanceof ReaderWorkSpent) return TOO_EXPENSIVE;
      throw error;
    }
    if (!at.ok) return at;
    const policy = this.deps.policy();
    const ctx: Context = {
      commit: oidToHex(at.value.commit),
      tree: oidToHex(at.value.tree),
      limits: limitsKey(policy),
      policy,
      input,
    };
    const n = input.cursor?.n ?? 0;
    let row = this.#row(ctx.tree, ctx.limits);
    // A build from before a restore is dropped when found, not continued.
    if (row?.state === "building" && row.epoch_gen !== this.deps.epochGen()) {
      this.#dropFound(row);
      row = undefined;
    }
    if (row && n < row.visited) return this.#stored(ctx, row, n);
    if (row && (row.state === "complete" || row.state === "capped")) {
      if (n > row.visited) return INVALID_CURSOR;
      return this.#answer(ctx, {
        state: row.state === "complete" ? "complete" : "incomplete",
        reason: row.reason,
        visited: row.visited,
        totalPaths: row.state === "complete" ? row.visited : null,
      });
    }
    const appending = row?.state === "building" && n === row.visited ? row : undefined;
    const starting = !row && input.cursor === undefined && browse.isDefaultTip(at.value.commit);
    const walk: Walk = appending
      ? {
          from: positionOf(parseRowCursor(appending.cursor)),
          visited: appending.visited,
          bytes: appending.bytes,
        }
      : {
          from: positionOf(input.cursor?.w ?? null),
          visited: n,
          bytes: input.cursor?.b ?? 0,
        };
    const keeping = appending !== undefined || starting;
    const slice = await this.#slice(
      browse,
      at.value.tree,
      ctx,
      walk,
      keeping ? null : input.perPage,
    );
    this.deps.hooks?.sliced?.(slice.trees);
    if (slice.unreadable)
      return this.#answer(ctx, { state: "unavailable", reason: "unreadable", visited: n });
    const stuck =
      slice.taken.length === 0 &&
      !slice.done &&
      slice.final === null &&
      sameCursor(slice.next, walk.from ?? DIFF_START);
    if (stuck) {
      if (slice.busy) return this.#busy(ctx);
      return this.#answer(ctx, {
        state: "incomplete",
        reason: "too_much_work",
        visited: n,
      });
    }
    let kept = false;
    if (keeping) {
      const small =
        starting && (slice.done || slice.final !== null) && slice.trees < policy.keepMinTrees;
      if (!small) kept = await this.#keep(ctx, appending, walk, slice);
    }
    return this.#fromSlice(ctx, walk, slice, kept);
  }

  /** A page out of one stored segment; it walks nothing, whatever the row's state. */
  #stored(ctx: Context, row: ListRow, n: number): Browsed<PathsPage> {
    const [segment] = this.#exec<{ first: number; count: number; body: ArrayBuffer }>(
      `SELECT first, count, body FROM path_list_segments
       WHERE tree_sha = ? AND limits = ? AND first <= ? ORDER BY first DESC LIMIT 1`,
      ctx.tree,
      ctx.limits,
      n,
    );
    if (!segment) throw new Error("a path list's segment is missing");
    const body = new Uint8Array(segment.body);
    let hold: MemoryReservation | undefined;
    try {
      hold = this.deps.git.memory.tryReserve(Math.max(1, 2 * body.length + 100 * segment.count));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    if (!hold) return this.#busy(ctx);
    try {
      const taken = splitSegment(body, n - segment.first, ctx.input.perPage);
      if (taken.length === 0) throw new Error("a path list's segment ends before its row says");
      const page = cutPage(taken, ctx.input.perPage, ctx.policy.maxPageJsonBytes);
      const visited = n + page.consumed;
      const totalPaths = row.state === "complete" ? row.visited : null;
      const finished = row.state === "complete" || row.state === "capped";
      if (visited === row.visited && finished)
        return this.#answer(ctx, {
          state: row.state === "complete" ? "complete" : "incomplete",
          reason: row.reason,
          paths: page.paths,
          visited,
          totalPaths,
          unlistedNames: page.unlisted,
        });
      return this.#answer(ctx, {
        state: "incomplete",
        reason: "more_pages",
        paths: page.paths,
        visited,
        totalPaths,
        unlistedNames: page.unlisted,
        next: {
          c: ctx.commit,
          n: visited,
          b: (ctx.input.cursor?.b ?? 0) + page.charged,
          w: [base64(page.last), 0],
        },
      });
    } finally {
      hold.release();
    }
  }

  /** One slice of the walk: paths up to `wanted` valid ones, or a full slice when null. */
  async #slice(
    browse: PathBrowse,
    tree: Oid,
    ctx: Context,
    walk: Walk,
    wanted: number | null,
  ): Promise<Slice> {
    const { policy } = ctx;
    const stop = (fields: Partial<Slice>): Slice => ({
      taken,
      next: walk.from ?? DIFF_START,
      final,
      done: false,
      busy,
      unreadable: false,
      trees,
      ...fields,
    });
    const taken: Taken[] = [];
    let final: FinalReason | null = null;
    let busy = false;
    let trees = 0;
    if (ctx.tree === EMPTY_TREE) return stop({ next: null, done: true });
    let reader: Awaited<ReturnType<PathBrowse["reader"]>>;
    try {
      reader = await browse.reader();
    } catch (error) {
      if (error instanceof MemoryWaitTimeoutError) return stop({ busy: true });
      if (error instanceof ReadBudgetError) return stop({});
      throw error;
    }
    const holds: MemoryReservation[] = [];
    let heldBytes = 0;
    let neededBytes = 0;
    let sliceBytes = 0;
    let valid = 0;
    let charged = 0;
    const accept = (change: { pathBytes: Uint8Array; cursor: DiffCursor }): boolean => {
      const charge = change.pathBytes.length + 1;
      if (sliceBytes + charge > policy.sliceBytes) return false;
      if (taken.length >= policy.sliceEntries) return false;
      if (wanted !== null && valid >= wanted) return false;
      if (walk.visited + taken.length >= policy.maxPaths) {
        final = "too_many_paths";
        return false;
      }
      if (walk.bytes + charged + charge > policy.maxListBytes) {
        final = "too_many_bytes";
        return false;
      }
      neededBytes += pathMemoryBytes(change.pathBytes.length, change.cursor.path.length);
      while (neededBytes > heldBytes) {
        const block = this.deps.git.memory.tryReserve(MEMORY_BLOCK_BYTES);
        if (!block) {
          busy = true;
          return false;
        }
        holds.push(block);
        heldBytes += MEMORY_BLOCK_BYTES;
      }
      const text = pathText(change.pathBytes);
      taken.push({ bytes: change.pathBytes, text });
      sliceBytes += charge;
      charged += charge;
      if (text !== undefined) valid++;
      return true;
    };
    const readTree = (reads: HeldReads) => async (oid: Oid) => {
      if (browse.reads >= policy.walkReads) throw new ReadDeferred();
      let entries: Awaited<ReturnType<HeldReads["readTree"]>>;
      try {
        entries = await reads.readTree(oid);
      } catch (error) {
        if (error instanceof ReadsMemoryBusy || error instanceof MemoryWaitTimeoutError) {
          busy = true;
          throw new ReadDeferred();
        }
        if (
          error instanceof ReadBudgetError ||
          error instanceof ReaderWorkSpent ||
          error instanceof ReadsBudgetSpent
        )
          throw new ReadDeferred();
        throw error;
      }
      trees++;
      if (!wellFormed(entries)) throw new MalformedTree();
      // Only a hint, and the one place the walk reads ahead: a cold reader needs it.
      const subtrees: Oid[] = [];
      for (const entry of entries) {
        if (subtrees.length >= PREFETCH_SUBTREES) break;
        if (isTreeMode(entry.mode)) subtrees.push(entry.oid);
      }
      if (subtrees.length > 0) {
        try {
          await reader.prefetch(subtrees);
        } catch (error) {
          if (!(error instanceof ReadBudgetError || error instanceof MemoryWaitTimeoutError))
            throw error;
        }
      }
      return entries;
    };
    try {
      const listed = await withHeldReads(
        reader,
        this.deps.git.memory,
        { maxTreeBytes: policy.maxTreeBytes, maxReadBytes: policy.sliceTreeBytes },
        (reads) =>
          diffTreesFrom(readTree(reads), null, tree, walk.from, {
            // `accept` is the only stop on paths: a slice ending at the last path walks on to the end.
            maxChanges: policy.sliceEntries + 1,
            maxScanned: policy.sliceScanned,
            maxDepth: policy.maxDepth,
            maxPathBytes: policy.maxPathBytes,
            accept,
          }),
      );
      return stop({ next: listed.next, done: listed.stop === "done" });
    } catch (error) {
      const position = taken.at(-1);
      const next: DiffCursor | null = position
        ? fileCursor(position.bytes)
        : (walk.from ?? DIFF_START);
      if (error instanceof TreeDiffLimitError)
        return stop({ next, final: error.limit === "depth" ? "too_deep" : "path_too_long" });
      if (error instanceof MalformedTree) return stop({ next, final: "malformed_tree" });
      // Its subclasses were turned into a deferred read above.
      if (error instanceof ReadsTooLargeError) return stop({ next, final: "tree_too_large" });
      if (error instanceof UnreadableObjectError || error instanceof GitObjectError)
        return stop({ unreadable: true });
      throw error;
    } finally {
      for (const hold of holds) hold.release();
    }
  }

  /** The answer of a walked slice: the part of it this page consumes. */
  #fromSlice(ctx: Context, walk: Walk, slice: Slice, kept: boolean): Browsed<PathsPage> {
    const page =
      slice.taken.length > 0
        ? cutPage(slice.taken, ctx.input.perPage, ctx.policy.maxPageJsonBytes)
        : { paths: [], consumed: 0, unlisted: 0, charged: 0, last: new Uint8Array(0) };
    const visited = walk.visited + page.consumed;
    const bytes = walk.bytes + page.charged;
    const totalPaths = kept && slice.done ? walk.visited + slice.taken.length : null;
    const common = {
      paths: page.paths,
      visited,
      totalPaths,
      unlistedNames: page.unlisted,
    };
    if (page.consumed < slice.taken.length)
      return this.#answer(ctx, {
        ...common,
        state: "incomplete",
        reason: "more_pages",
        next: { c: ctx.commit, n: visited, b: bytes, w: [base64(page.last), 0] },
      });
    // First: a cap's refused path leaves the walker's cursor unmoved, and that is not a stall.
    if (slice.final !== null)
      return this.#answer(ctx, { ...common, state: "incomplete", reason: slice.final });
    if (slice.done) return this.#answer(ctx, { ...common, state: "complete", reason: null });
    return this.#answer(ctx, {
      ...common,
      state: "incomplete",
      reason: "more_pages",
      next: { c: ctx.commit, n: visited, b: bytes, w: wireOf(slice.next as DiffCursor) },
    });
  }

  /**
   * Stores `slice` if the row is still as read; another request may have got
   * there first, and either's answer is right. A failing write (the day's
   * quota spent) is logged and counted: the answer still goes out.
   */
  async #keep(
    ctx: Context,
    appending: ListRow | undefined,
    walk: Walk,
    slice: Slice,
  ): Promise<boolean> {
    const { storage } = this.deps.git.context;
    try {
      await this.deps.hooks?.beforeKeep?.();
      const visited = walk.visited + slice.taken.length;
      const bytes = walk.bytes + slice.taken.reduce((total, t) => total + t.bytes.length + 1, 0);
      const slices = (appending?.slices ?? 0) + 1;
      const state: ListRow["state"] = slice.done
        ? "complete"
        : slice.final !== null
          ? "capped"
          : slices >= ctx.policy.maxBuildSlices
            ? "walk_only"
            : "building";
      const cursor = state === "building" ? JSON.stringify(wireOf(slice.next as DiffCursor)) : null;
      return storage.transactionSync(() => {
        const now = this.#row(ctx.tree, ctx.limits);
        const same = appending
          ? now?.state === "building" &&
            now.visited === appending.visited &&
            now.cursor === appending.cursor &&
            now.epoch_gen === appending.epoch_gen
          : now === undefined;
        if (!same) return false;
        if (slice.taken.length > 0)
          this.#exec(
            `INSERT INTO path_list_segments (tree_sha, limits, first, count, body)
             VALUES (?, ?, ?, ?, ?)`,
            ctx.tree,
            ctx.limits,
            walk.visited,
            slice.taken.length,
            joinSegment(slice.taken),
          );
        if (appending)
          this.#exec(
            `UPDATE path_lists SET state = ?, reason = ?, cursor = ?, visited = ?, bytes = ?, slices = ?
             WHERE tree_sha = ? AND limits = ?`,
            state,
            slice.final,
            cursor,
            visited,
            bytes,
            slices,
            ctx.tree,
            ctx.limits,
          );
        else
          this.#exec(
            `INSERT INTO path_lists
               (tree_sha, limits, epoch_gen, state, reason, cursor, visited, bytes, slices, seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT coalesce(max(seq), 0) + 1 FROM path_lists))`,
            ctx.tree,
            ctx.limits,
            this.deps.epochGen(),
            state,
            slice.final,
            cursor,
            visited,
            bytes,
            slices,
          );
        this.#evict(ctx);
        return true;
      });
    } catch (error) {
      this.#writeFailed(error);
      return false;
    }
  }

  /**
   * Stored lists only save work: a failed write costs that, never an answer.
   * Counted under the rows-written metric with its own `op`, which adds one per
   * failure to a sum over every `op` (limits.md says so); no metric name of its own.
   */
  #writeFailed(error: unknown): void {
    const { metrics, doClass } = this.deps.git.context;
    this.deps.log().warn("keeping a path list failed", { error });
    metrics.count("do.rows_written", { class: doClass, op: "path_lists.write_failed" });
  }

  /** Drops the oldest lists, finished or not, past the bounds; never the current one. */
  #evict(ctx: Context): void {
    const rows = this.#exec<{ tree_sha: string; limits: string; bytes: number }>(
      "SELECT tree_sha, limits, bytes FROM path_lists ORDER BY seq",
    );
    let count = rows.length;
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const row of rows) {
      if (count <= ctx.policy.maxLists && total <= ctx.policy.maxKeptBytes) break;
      if (row.tree_sha === ctx.tree && row.limits === ctx.limits) continue;
      this.#drop(row.tree_sha, row.limits);
      count--;
      total -= row.bytes;
    }
  }

  #dropFound(row: ListRow): void {
    const { storage } = this.deps.git.context;
    try {
      storage.transactionSync(() => this.#drop(row.tree_sha, row.limits));
    } catch (error) {
      this.#writeFailed(error);
    }
  }

  #drop(tree: string, limits: string): void {
    this.#exec("DELETE FROM path_list_segments WHERE tree_sha = ? AND limits = ?", tree, limits);
    this.#exec("DELETE FROM path_lists WHERE tree_sha = ? AND limits = ?", tree, limits);
  }

  #row(tree: string, limits: string): ListRow | undefined {
    return this.#exec<ListRow>(
      `SELECT tree_sha, limits, epoch_gen, state, reason, cursor, visited, bytes, slices
       FROM path_lists WHERE tree_sha = ? AND limits = ?`,
      tree,
      limits,
    )[0];
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const { storage, metrics, doClass } = this.deps.git.context;
    const cursor = storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.deps.hooks?.rows?.(cursor.rowsRead, cursor.rowsWritten);
    if (cursor.rowsWritten > 0)
      metrics.count(
        "do.rows_written",
        { class: doClass, op: "path_lists.write" },
        cursor.rowsWritten,
      );
    return rows;
  }

  #busy(ctx: Context): Browsed<PathsPage> {
    return this.#answer(ctx, {
      state: "unavailable",
      reason: "busy",
      visited: ctx.input.cursor?.n ?? 0,
      next: ctx.input.cursor ?? null,
      retryAfterMs: ctx.policy.busyRetryMs,
    });
  }

  #answer(
    ctx: Context,
    page: Pick<PathsPage, "state" | "reason" | "visited"> & Partial<PathsPage>,
  ): Browsed<PathsPage> {
    return {
      ok: true,
      value: {
        commit: ctx.commit,
        tree: ctx.tree,
        paths: [],
        totalPaths: null,
        unlistedNames: 0,
        next: null,
        retryAfterMs: null,
        ...page,
      },
    };
  }
}

/** What goes in a stored list's key: the limits that change its answers, so a change retires it. */
function limitsKey(policy: PathsPolicy): string {
  return [
    policy.maxPaths,
    policy.maxListBytes,
    policy.maxPathBytes,
    policy.maxDepth,
    policy.maxTreeBytes,
  ].join(":");
}

/** Up to `perPage` valid paths, `maxJson` bytes of JSON at most, one path at least. */
function cutPage(taken: readonly Taken[], perPage: number, maxJson: number) {
  const paths: string[] = [];
  let consumed = 0;
  let unlisted = 0;
  let charged = 0;
  let json = 2;
  for (const path of taken) {
    if (path.text === undefined) unlisted++;
    else {
      const cost = jsonBytes(path.bytes);
      if (paths.length > 0 && json + cost > maxJson) break;
      paths.push(path.text);
      json += cost;
    }
    consumed++;
    charged += path.bytes.length + 1;
    if (paths.length >= perPage) break;
  }
  return {
    paths,
    consumed,
    unlisted,
    charged,
    last: (taken[consumed - 1] as Taken).bytes,
  };
}

/** A path's bytes in a JSON array of strings: its quotes, a comma, and escapes (6 at most). */
function jsonBytes(bytes: Uint8Array): number {
  let total = bytes.length + 3;
  for (const byte of bytes) {
    if (byte < 0x20) total += 5;
    else if (byte === 0x22 || byte === 0x5c) total += 1;
  }
  return total;
}

function joinSegment(taken: readonly Taken[]): Uint8Array {
  const out = new Uint8Array(taken.reduce((n, t) => n + t.bytes.length + 1, -1));
  let at = 0;
  for (const [i, path] of taken.entries()) {
    if (i > 0) at++;
    out.set(path.bytes, at);
    at += path.bytes.length;
  }
  return out;
}

/** A segment's paths after the first `skip`, decoded only up to `perPage` valid ones. */
function splitSegment(body: Uint8Array, skip: number, perPage: number): Taken[] {
  const out: Taken[] = [];
  let at = 0;
  let index = 0;
  let valid = 0;
  while (at <= body.length && valid < perPage) {
    const end = body.indexOf(0, at);
    const stop = end < 0 ? body.length : end;
    if (index++ >= skip) {
      const bytes = body.subarray(at, stop);
      const text = pathText(bytes);
      out.push({ bytes, text });
      if (text !== undefined) valid++;
    }
    at = stop + 1;
  }
  return out;
}

function fileCursor(pathBytes: Uint8Array): DiffCursor {
  return positionOf([base64(pathBytes), 0]) as DiffCursor;
}

function wireOf(cursor: DiffCursor): WirePosition | null {
  if (cursor.path.length === 0) return null;
  const size = cursor.path.reduce((n, name) => n + name.name.length + 1, -1);
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const [i, name] of cursor.path.entries()) {
    if (i > 0) bytes[at++] = 0x2f;
    bytes.set(name.name, at);
    at += name.name.length;
  }
  const last = cursor.path.at(-1) as CursorName;
  return [base64(bytes), cursor.enter ? 2 : last.tree ? 1 : 0];
}

function positionOf(wire: WirePosition | null): DiffCursor | null {
  if (wire === null) return null;
  const [path, kind] = wire;
  const bytes = unbase64(path);
  const names: CursorName[] = [];
  let at = 0;
  for (;;) {
    const slash = bytes.indexOf(0x2f, at);
    if (slash < 0) break;
    names.push({ name: bytes.subarray(at, slash), tree: true });
    at = slash + 1;
  }
  names.push({ name: bytes.subarray(at), tree: kind !== 0 });
  return { path: names, enter: kind === 2 };
}

function parseRowCursor(cursor: string | null): WirePosition | null {
  return cursor === null ? null : (JSON.parse(cursor) as WirePosition | null);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
