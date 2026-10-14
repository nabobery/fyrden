import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  type Job,
  type JobHandler,
  newUlid,
  type RepoGitStorage,
  scratchPrefix,
} from "@fyrden/adapters-cloudflare/git";
import { currentInvocation } from "@fyrden/adapters-cloudflare/obs";
import {
  type ArchiveEntry,
  type ArchiveEntryKind,
  type BlockCache,
  FILE_MODES,
  GitObjectError,
  gzipMember,
  isTreeMode,
  oidFromHex,
  oidToHex,
  tarCommitHeader,
  tarEnd,
  tarEntry,
  treeEntries,
  ZIP_LIMITS,
  type ZipRecord,
  zipEnd,
  zipEntry,
} from "@fyrden/git-core";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import { type Browsed, fail } from "./browse.js";

/*
 * Archives of a commit (tar.gz or zip, everything under one top directory,
 * as GitHub's tarball and zipball), built by the `archive` job in slices so
 * a large tree never has to fit one invocation: each slice walks on from
 * its cursor (a depth-first stack of trees and byte offsets into them),
 * encodes a bounded amount, and writes one segment to R2: for tar.gz a gzip
 * member (gzip reads consecutive members as one stream), for zip the local
 * entries, and at the end the tar trailer or the zip central directory.
 * Every attempt writes its segment under a key of its own, and only the
 * runner holding the job's claim records it (with its zip records) as the
 * segment of its sequence number, so a runner that lost its claim, or a
 * slice run again after an eviction, never changes bytes already served.
 * One slice runs at a time per repository. The Worker streams the recorded
 * segments in order. Archives are kept a week, keyed by commit, format and
 * top directory; a download leases its archive, and pruning first marks an
 * archive `deleting` (so it is no longer found) only when no lease holds it.
 */

export type ArchiveFormat = "tar.gz" | "zip";

export interface ArchivePolicy {
  /** File content one archive holds at most (uncompressed). */
  readonly maxBytes: number;
  /** Largest single file in an archive (the reader holds it whole). */
  readonly maxFileBytes: number;
  /**
   * Work one slice does before it writes its segment: bytes encoded
   * (headers and content) and tree bytes inflated.
   */
  readonly sliceBytes: number;
  /** Entries one slice encodes at most. */
  readonly sliceEntries: number;
  /** R2 reads after which a slice stops at the next entry. */
  readonly sliceReads: number;
  /** Memory one slice reserves: its segment, the file and the trees it holds, compression. */
  readonly sliceMemoryBytes: number;
  /** Tree bodies one slice keeps while it walks below them (beyond it, a parent is read again). */
  readonly heldTreeBytes: number;
  /** Segments one archive has at most: a download reads each from R2. */
  readonly maxSegments: number;
  /** A zip's central directory at most, read whole when the zip is finished. */
  readonly maxZipDirectoryBytes: number;
  /**
   * A build's cursor at most, kept in one row (SQLite's limit is 2 MB):
   * directories that nest deeper fail the build.
   */
  readonly maxCursorBytes: number;
  /** How long a built archive is kept. */
  readonly retentionMs: number;
  /** Expired archives one request clears at most. */
  readonly pruneBatch: number;
  /** How long a download holds its archive against pruning. */
  readonly leaseMs: number;
}

/** Limits of archives. Proposed. */
export const ARCHIVE_POLICY: ArchivePolicy = {
  maxBytes: 1024 * 1024 * 1024,
  maxFileBytes: 24 * 1024 * 1024,
  sliceBytes: 8 * 1024 * 1024,
  sliceEntries: 5_000,
  sliceReads: 400,
  sliceMemoryBytes: 40 * 1024 * 1024,
  heldTreeBytes: 8 * 1024 * 1024,
  maxSegments: 300,
  maxZipDirectoryBytes: 16 * 1024 * 1024,
  maxCursorBytes: 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  pruneBatch: 3,
  leaseMs: 60 * 60 * 1000,
};

/** Calls to R2, D1 and Durable Objects one Free invocation allows, and room kept for a slice's own writes. */
const INVOCATION_CALLS = 1_000;
const CALLS_HEADROOM = 100;
/** Fewest reads a slice starts with; fewer, and it waits for the next invocation. */
const MIN_SLICE_READS = 20;
/** Objects of one directory whose lookups a slice batches at most. */
const PREFETCH_BATCH = 500;
/** A build that has not moved for this long is stale, and may be pruned once expired. */
const STALE_BUILD_MS = 60 * 60 * 1000;
/** The lock one slice holds, so slices (and their memory) never overlap in one object. */
const SLICE_LOCK = "archive-slice";
const SLICE_LOCK_MS = 120_000;

export type ArchiveStatus =
  | {
      readonly state: "ready";
      readonly commit: string;
      /** The segments' R2 keys, in order. */
      readonly keys: string[];
      readonly bytes: number;
    }
  | { readonly state: "building"; readonly commit: string; readonly bytes: number };

interface Frame {
  /** Tree id, hex. */
  readonly tree: string;
  /** Where the next entry starts in the tree's body. */
  offset: number;
  /**
   * The tree's directory name and a slash (the top one's: the prefix), as
   * base64 of its bytes: its entries' path is the stack's names in order, so
   * a cursor grows with a path's length, not with its square.
   */
  readonly name: string;
}

interface Cursor {
  readonly runId: string;
  readonly format: ArchiveFormat;
  readonly commit: string;
  readonly mtime: number;
  readonly networkId: string;
  /** The top directory, as base64 of its bytes (written in the first segment). */
  readonly prefix: string;
  readonly stack: Frame[];
  /** The next segment's number. */
  readonly seq: number;
  /** Bytes of the segments written so far. */
  readonly written: number;
  /** File content read so far. */
  readonly content: number;
  readonly entries: number;
  /** A zip's central directory size so far. */
  readonly directory: number;
}

type Row = {
  commit_id: string;
  format: ArchiveFormat;
  prefix: string;
  run_id: string;
  network_id: string;
  state: "building" | "ready" | "failed" | "deleting";
  segments: number;
  bytes: number;
  error: string | null;
  created_at: number;
};

export interface ArchiveDeps {
  readonly git: RepoGitStorage;
  readonly memoryBlocks: BlockCache;
  /** Replaces limits of `ARCHIVE_POLICY` (tests). */
  readonly policy?: Partial<ArchivePolicy>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function archiveJobId(runId: string): string {
  return `archive:${runId}`;
}

export class RepoArchives {
  readonly #policy: ArchivePolicy;

  constructor(private readonly deps: ArchiveDeps) {
    this.#policy = { ...ARCHIVE_POLICY, ...deps.policy };
  }

  /**
   * The archive of `commit` in `format` under `prefix`: ready (its
   * segments, leased to the caller for a download), or being built,
   * starting it when there is none (a failed one is started again). Runs
   * the build for up to `budgetMs` here.
   */
  async request(input: {
    readonly commit: string;
    readonly mtime: number;
    readonly format: ArchiveFormat;
    readonly prefix: string;
    readonly budgetMs: number;
  }): Promise<Browsed<ArchiveStatus>> {
    const { git } = this.deps;
    await this.#prune();
    let row = this.#row(input);
    if (row?.state === "failed") {
      await this.#remove([row.run_id]);
      // Another request may have started its replacement meanwhile: join it.
      row = this.#row(input);
    }
    row ??= this.#start(input);
    if (row.state === "building") {
      const jobId = archiveJobId(row.run_id);
      await git.jobs.runJob(jobId, this.handler(), git.memory, git.context.now() + input.budgetMs);
      // A job out of attempts leaves its archive failed (the next request starts it again).
      if (git.jobs.get(jobId)?.state === "failed" && this.#row(input)?.state === "building")
        this.#setState(row.run_id, "failed", "The archive could not be built; try again.");
      row = this.#row(input) as Row;
    }
    if (row.state === "failed")
      return fail(422, "archive_failed", row.error ?? "The archive could not be built.");
    if (row.state === "building")
      return { ok: true, value: { state: "building", commit: row.commit_id, bytes: row.bytes } };
    // Leased in the same step it is read: pruning cannot take it between the two.
    git.context.storage.sql.exec(
      "UPDATE archives SET leased_until = ? WHERE run_id = ?",
      git.context.now() + this.#policy.leaseMs,
      row.run_id,
    );
    const keys = git.context.storage.sql
      .exec<{ key: string }>(
        "SELECT key FROM archive_segments WHERE run_id = ? AND seq < ? ORDER BY seq",
        row.run_id,
        row.segments,
      )
      .toArray()
      .map((r) => r.key);
    return {
      ok: true,
      value: { state: "ready", commit: row.commit_id, bytes: row.bytes, keys },
    };
  }

  /** The `archive` job: one segment per slice. */
  handler(): JobHandler {
    return {
      memoryBytes: this.#policy.sliceMemoryBytes,
      runSlice: async (job) => {
        const cursor = job.cursor ? (JSON.parse(decoder.decode(job.cursor)) as Cursor) : undefined;
        if (!cursor) return { done: true };
        if (this.#rowByRun(cursor.runId)?.state !== "building") return { done: true };
        const { git } = this.deps;
        const lock = git.locks.tryAcquire(SLICE_LOCK, job.jobId, SLICE_LOCK_MS);
        // Another archive's slice is running here: this one goes on later.
        if (!lock) return { done: false, cursor: job.cursor, runAfterMs: 1_000 };
        // A build being worked on is not stale: pruning leaves it alone.
        git.context.storage.sql.exec(
          "UPDATE archives SET updated_at = ? WHERE run_id = ?",
          git.context.now(),
          cursor.runId,
        );
        let next: Cursor | "done" | "wait";
        try {
          next = await this.#slice(cursor, job);
        } catch (error) {
          if (!(error instanceof ArchiveRefused)) throw error;
          this.#setState(cursor.runId, "failed", error.message, job);
          return { done: true };
        } finally {
          git.locks.release(lock);
        }
        if (next === "done") return { done: true };
        // Too few calls left in this invocation: the next one goes on.
        if (next === "wait") return { done: false, cursor: job.cursor, runAfterMs: 0 };
        return { done: false, cursor: encoder.encode(JSON.stringify(next)) };
      },
    };
  }

  #start(input: {
    readonly commit: string;
    readonly mtime: number;
    readonly format: ArchiveFormat;
    readonly prefix: string;
  }): Row {
    const { git } = this.deps;
    const now = git.context.now();
    const runId = newUlid(now);
    const networkId = git.networkId();
    const tree = git.commitGraph.readSync([oidFromHex(input.commit)], "verified")[0]?.tree;
    if (!tree) throw new Error(`commit ${input.commit} is not in the commit graph`);
    const prefix = encoder.encode(input.prefix);
    const cursor: Cursor = {
      runId,
      format: input.format,
      commit: input.commit,
      mtime: input.mtime,
      networkId,
      prefix: toBase64(prefix),
      stack: [{ tree: oidToHex(tree), offset: 0, name: toBase64(concat(prefix, SLASH)) }],
      seq: 0,
      written: 0,
      content: 0,
      entries: 0,
      directory: 0,
    };
    git.context.storage.transactionSync(() => {
      git.context.storage.sql.exec(
        `INSERT INTO archives (commit_id, format, prefix, run_id, network_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'building', ?, ?)`,
        input.commit,
        input.format,
        input.prefix,
        runId,
        networkId,
        now,
        now,
      );
      git.jobs.ensure("archive", archiveJobId(runId), {
        cursor: encoder.encode(JSON.stringify(cursor)),
      });
    });
    return this.#row(input) as Row;
  }

  /**
   * One slice: walks on from `cursor`, writes one segment, and says where
   * to go on ("wait": too few calls left in this invocation).
   */
  async #slice(cursor: Cursor, job: Job): Promise<Cursor | "done" | "wait"> {
    const { git } = this.deps;
    const policy = this.#policy;
    const spent = currentInvocation()?.tally.internal ?? 0;
    const maxReads = Math.min(2 * policy.sliceReads, INVOCATION_CALLS - CALLS_HEADROOM - spent);
    if (maxReads < MIN_SLICE_READS) return "wait";
    const counts = { reads: 0 };
    const reader = await openLiveReader(this.deps, {
      deltaBaseCacheBytes: 4 * 1024 * 1024,
      maxCacheCalls: 40,
      maxReads,
      counts,
    });
    if (!reader) throw new Error("the repository has commits but no packs");
    const zlib = createWorkersZlib();
    const stack = cursor.stack.map((f) => ({ ...f }));
    const names = stack.map((f) => fromBase64(f.name));
    const parts: Uint8Array[] = [];
    const records: ZipRecord[] = [];
    let offset = cursor.format === "zip" ? cursor.written : 0;
    let content = cursor.content;
    let entries = cursor.entries;
    let directory = cursor.directory;
    /** Work done: bytes encoded and tree bytes inflated. */
    let work = 0;
    let done = 0;
    /** Directories finished: progress too, though they write nothing. */
    let left = 0;
    const emit = (entry: ArchiveEntry) => {
      let bytes: Uint8Array;
      if (cursor.format === "zip") {
        let record: ZipRecord;
        try {
          ({ bytes, record } = zipEntry(zlib, entry, cursor.mtime, offset));
        } catch (error) {
          if (error instanceof RangeError)
            throw new ArchiveRefused(`${error.message}; use tar.gz.`);
          throw error;
        }
        directory += 46 + record.name.length;
        if (entries + 1 > ZIP_LIMITS.maxEntries || directory > policy.maxZipDirectoryBytes)
          throw new ArchiveRefused("The commit has too many files for a zip; use tar.gz.");
        records.push(record);
        offset += bytes.length;
      } else bytes = tarEntry(entry, cursor.mtime);
      parts.push(bytes);
      work += bytes.length;
      entries++;
      done++;
    };
    /** Whether this slice has done its share (after one entry at least, so every slice gets on). */
    const full = () =>
      done > 0 &&
      (work >= policy.sliceBytes ||
        done >= policy.sliceEntries ||
        counts.reads >= policy.sliceReads);
    // The trees of the stack are kept within `heldTreeBytes` (the deepest
    // first); one let go is read again when the walk returns to it.
    const held = new Map<string, Uint8Array>();
    let heldBytes = 0;
    const hold = (tree: string, body: Uint8Array) => {
      held.set(tree, body);
      heldBytes += body.length;
      for (const frame of stack) {
        if (heldBytes <= policy.heldTreeBytes) break;
        const kept = held.get(frame.tree);
        if (!kept || frame.tree === tree) continue;
        held.delete(frame.tree);
        heldBytes -= kept.length;
      }
    };
    const letGo = (tree: string) => {
      const kept = held.get(tree);
      if (kept) heldBytes -= kept.length;
      held.delete(tree);
    };
    try {
      if (cursor.seq === 0) {
        if (cursor.format === "tar.gz") parts.push(tarCommitHeader(cursor.commit, cursor.mtime));
        emit({ path: fromBase64(cursor.prefix), kind: "dir", data: new Uint8Array(0) });
      }
      walk: while (stack.length > 0) {
        const frame = stack.at(-1) as Frame;
        let body = held.get(frame.tree);
        if (!body) {
          if (full()) break;
          const header = await reader.readHeader(oidFromHex(frame.tree));
          if (header?.type !== "tree")
            throw new ArchiveRefused("A tree of the commit cannot be read.");
          if (header.size > policy.heldTreeBytes)
            throw new ArchiveRefused(
              "A directory of the commit is too large to archive here; clone it instead.",
            );
          const object = await reader.readObject(oidFromHex(frame.tree));
          if (object?.type !== "tree")
            throw new ArchiveRefused("A tree of the commit cannot be read.");
          body = object.bytes;
          work += body.length;
          hold(frame.tree, body);
          // The directory's files and subtrees are looked up together.
          const ahead: Uint8Array[] = [];
          for (const e of treeEntries(body, frame.offset)) {
            if (ahead.length >= PREFETCH_BATCH) break;
            if (e.mode !== FILE_MODES.gitlink) ahead.push(e.oid);
          }
          await reader.prefetch(ahead);
        }
        const base = concatAll(names);
        for (const e of treeEntries(body, frame.offset)) {
          if (full()) break walk;
          const path = concat(base, e.name);
          const kind = kindOf(e.mode);
          if (kind === "dir") {
            emit({ path, kind, data: new Uint8Array(0) });
            frame.offset = e.end;
            const name = concat(e.name, SLASH);
            stack.push({ tree: oidToHex(e.oid), offset: 0, name: toBase64(name) });
            names.push(name);
            continue walk;
          }
          if (kind === "submodule") emit({ path, kind, data: new Uint8Array(0) });
          else {
            const header = await reader.readHeader(e.oid);
            if (header?.type !== "blob")
              throw new ArchiveRefused("A file of the commit cannot be read.");
            if (header.size > policy.maxFileBytes)
              throw new ArchiveRefused(
                `A file is larger than ${policy.maxFileBytes} bytes; clone the repository instead.`,
              );
            if (content + header.size > policy.maxBytes)
              throw new ArchiveRefused(
                `The commit holds more than ${policy.maxBytes} bytes; clone the repository instead.`,
              );
            const object = await reader.readObject(e.oid);
            if (object?.type !== "blob")
              throw new ArchiveRefused("A file of the commit cannot be read.");
            content += header.size;
            emit({ path, kind, data: object.bytes });
          }
          frame.offset = e.end;
        }
        // The tree is done.
        stack.pop();
        names.pop();
        letGo(frame.tree);
        left++;
      }
    } catch (error) {
      if (error instanceof GitObjectError)
        throw new ArchiveRefused("A tree of the commit cannot be read.");
      // Out of reads: what is done so far makes this slice's segment (climbing
      // out of deep directories, it may hold no entry); with nothing done,
      // the slice runs again in a later invocation.
      if (!(error instanceof ReadBudgetError) || (done === 0 && left === 0)) throw error;
    } finally {
      reader.release();
    }

    const finished = stack.length === 0;
    if (!finished && cursor.seq + 1 >= policy.maxSegments)
      throw new ArchiveRefused("The commit has too many files to archive here; clone it instead.");
    // The cursor is kept in one row: a stack too deep for it ends the build here.
    if (
      !finished &&
      encoder.encode(JSON.stringify({ ...cursor, stack })).length > policy.maxCursorBytes
    )
      throw new ArchiveRefused(
        "The commit's directories nest too deeply to archive here; clone it instead.",
      );
    if (finished && cursor.format === "zip")
      parts.push(
        zipEnd([...this.#records(cursor.runId, cursor.entries), ...records], offset, cursor.mtime),
      );
    let segment = concatAll(parts);
    if (cursor.format === "tar.gz") {
      if (finished) segment = concatAll([segment, tarEnd()]);
      segment = gzipMember(zlib, segment, cursor.mtime);
    }
    // A key of this attempt's own: what another attempt wrote is never touched.
    const key = `${scratchPrefix(cursor.networkId, cursor.runId)}${cursor.seq}-${newUlid()}`;
    git.context.metrics.count("r2.class_a", { bucket: "fyrden-git", op: "put_archive" });
    await git.bucket.put(key, segment);
    const written = cursor.written + segment.length;
    const recorded = this.#publish(job, cursor, {
      key,
      segmentBytes: segment.length,
      written,
      finished,
      records,
    });
    if (!recorded) {
      // Not this run's to record (its claim is gone, or the archive with it): its object goes.
      git.context.metrics.count("r2.class_a", { bucket: "fyrden-git", op: "delete_archive" });
      await git.bucket.delete(key).catch(() => undefined);
      return "done";
    }
    if (finished) return "done";
    return {
      ...cursor,
      stack,
      seq: cursor.seq + 1,
      written,
      content,
      entries,
      directory,
    };
  }

  /**
   * Records a slice's segment (and a zip's records of its entries) as the
   * segment of its sequence number, under the job's claim: a runner that
   * lost it records nothing.
   */
  #publish(
    job: Job,
    cursor: Cursor,
    slice: {
      key: string;
      segmentBytes: number;
      written: number;
      finished: boolean;
      records: readonly ZipRecord[];
    },
  ): boolean {
    const { storage } = this.deps.git.context;
    const { runId } = cursor;
    return storage.transactionSync(() => {
      if (!this.#holdsClaim(job)) return false;
      const building = storage.sql
        .exec("SELECT 1 FROM archives WHERE run_id = ? AND state = 'building'", runId)
        .toArray().length;
      if (!building) return false;
      storage.sql.exec(
        "INSERT OR REPLACE INTO archive_segments (run_id, seq, key, bytes) VALUES (?, ?, ?, ?)",
        runId,
        cursor.seq,
        slice.key,
        slice.segmentBytes,
      );
      if (slice.finished)
        storage.sql.exec("DELETE FROM archive_zip_records WHERE run_id = ?", runId);
      else
        slice.records.forEach((r, i) => {
          storage.sql.exec(
            "INSERT OR REPLACE INTO archive_zip_records (run_id, seq, record) VALUES (?, ?, ?)",
            runId,
            cursor.entries + i,
            JSON.stringify({ ...r, name: toBase64(r.name) }),
          );
        });
      storage.sql.exec(
        `UPDATE archives SET segments = ?, bytes = ?, state = ?, updated_at = ?
         WHERE run_id = ? AND state = 'building'`,
        cursor.seq + 1,
        slice.written,
        slice.finished ? "ready" : "building",
        this.deps.git.context.now(),
        runId,
      );
      return true;
    });
  }

  #holdsClaim(job: Job): boolean {
    return (
      this.deps.git.context.storage.sql
        .exec(
          "SELECT 1 FROM jobs WHERE job_id = ? AND claim = ? AND state = 'running'",
          job.jobId,
          job.claim,
        )
        .toArray().length > 0
    );
  }

  /** The zip records of the entries before `before`, as the slices that wrote them recorded them. */
  #records(runId: string, before: number): ZipRecord[] {
    return this.deps.git.context.storage.sql
      .exec<{ record: string }>(
        "SELECT record FROM archive_zip_records WHERE run_id = ? AND seq < ? ORDER BY seq",
        runId,
        before,
      )
      .toArray()
      .map((r) => {
        const record = JSON.parse(r.record) as Omit<ZipRecord, "name"> & { name: string };
        return { ...record, name: fromBase64(record.name) };
      });
  }

  #row(key: { commit: string; format: ArchiveFormat; prefix: string }): Row | undefined {
    return this.deps.git.context.storage.sql
      .exec<Row>(
        `SELECT * FROM archives WHERE commit_id = ? AND format = ? AND prefix = ?
           AND state <> 'deleting'`,
        key.commit,
        key.format,
        key.prefix,
      )
      .toArray()[0];
  }

  #rowByRun(runId: string): Row | undefined {
    return this.deps.git.context.storage.sql
      .exec<Row>("SELECT * FROM archives WHERE run_id = ?", runId)
      .toArray()[0];
  }

  /** Marks a build failed (under `job`'s claim, when a slice decides it). */
  #setState(runId: string, state: "failed", error: string, job?: Job): void {
    const { storage } = this.deps.git.context;
    storage.transactionSync(() => {
      if (job && !this.#holdsClaim(job)) return;
      storage.sql.exec(
        "UPDATE archives SET state = ?, error = ?, updated_at = ? WHERE run_id = ? AND state = 'building'",
        state,
        error,
        this.deps.git.context.now(),
        runId,
      );
      storage.sql.exec("DELETE FROM archive_zip_records WHERE run_id = ?", runId);
    });
  }

  /**
   * Deletes archives: marked `deleting` first (no longer found, so no
   * download can lease them), then their objects, then their rows.
   */
  async #remove(runIds: readonly string[]): Promise<void> {
    const { git } = this.deps;
    const sql = git.context.storage.sql;
    for (const runId of runIds) {
      const row = sql
        .exec<{ network_id: string }>("SELECT network_id FROM archives WHERE run_id = ?", runId)
        .toArray()[0];
      if (!row) continue;
      sql.exec("UPDATE archives SET state = 'deleting' WHERE run_id = ?", runId);
      const prefix = scratchPrefix(row.network_id, runId);
      for (;;) {
        git.context.metrics.count("r2.class_a", { bucket: "fyrden-git", op: "list_archive" });
        const page = await git.bucket.list({ prefix, limit: 1000 });
        const keys = page.objects.map((o) => o.key);
        if (keys.length > 0) {
          git.context.metrics.count("r2.class_a", { bucket: "fyrden-git", op: "delete_archive" });
          await git.bucket.delete(keys);
        }
        if (!page.truncated) break;
      }
      sql.exec("DELETE FROM archive_zip_records WHERE run_id = ?", runId);
      sql.exec("DELETE FROM archive_segments WHERE run_id = ?", runId);
      sql.exec("DELETE FROM archives WHERE run_id = ?", runId);
      sql.exec("DELETE FROM jobs WHERE job_id = ?", archiveJobId(runId));
    }
  }

  /**
   * Clears a few archives: older than the retention and held by no
   * download lease and no build still moving, or left `deleting` by an
   * earlier attempt. They are marked `deleting` in the same step as they
   * are chosen, so no download leases them after.
   */
  async #prune(): Promise<void> {
    const now = this.deps.git.context.now();
    const { storage } = this.deps.git.context;
    const chosen = storage.transactionSync(() => {
      const runs = storage.sql
        .exec<{ run_id: string }>(
          `SELECT run_id FROM archives
           WHERE state = 'deleting'
              OR (created_at < ? AND (leased_until IS NULL OR leased_until < ?)
                  AND NOT (state = 'building' AND updated_at > ?))
           ORDER BY created_at LIMIT ?`,
          now - this.#policy.retentionMs,
          now,
          now - STALE_BUILD_MS,
          this.#policy.pruneBatch,
        )
        .toArray()
        .map((r) => r.run_id);
      for (const runId of runs)
        storage.sql.exec("UPDATE archives SET state = 'deleting' WHERE run_id = ?", runId);
      return runs;
    });
    await this.#remove(chosen);
  }
}

/** An archive that cannot be built (too large, a file too large, a tree that cannot be read). */
class ArchiveRefused extends Error {}

const SLASH = Uint8Array.of(0x2f);

function kindOf(mode: number): ArchiveEntryKind {
  if (isTreeMode(mode)) return "dir";
  if (mode === FILE_MODES.gitlink) return "submodule";
  if (mode === FILE_MODES.symlink) return "symlink";
  return mode & 0o100 ? "executable" : "file";
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
