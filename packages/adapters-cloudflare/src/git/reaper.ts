import type { JobHandler, JobQueue, SliceResult } from "./jobs.js";
import { isUlid, packObjectKey, packPrefix, scratchPrefix } from "./keys.js";
import type { PackState } from "./pack-registry.js";
import type { RepoGitStorage } from "./repo-git-storage.js";
import {
  chunks,
  countRowsWritten,
  first,
  type GitStorageContext,
  placeholders,
  rows,
  run,
} from "./sql.js";
import { indexJobId, UPLOAD_TTL_MS } from "./uploads.js";

/** The reaper is one job per repository, keyed by this id. */
export const ORPHAN_REAPER_JOB_ID = "reap-orphans";

export interface OrphanReaperOptions {
  /**
   * Age after which a discarded pack, a pending pack with no upload, and an
   * object under the pack prefix with no registry row are removed. Uploads
   * use their own expiry, set when they begin. Proposed default 24 h.
   */
  readonly ttlMs?: number;
  /** R2 deletions per slice. Proposed default 100; at least 4 (two packs' files). */
  readonly maxDeletionsPerSlice?: number;
  /**
   * Wall time per slice. Proposed default 20 s, under the 30 s of CPU a
   * Durable Object alarm gets on Free (measured on Workers Free,
   * 2026-10-10); wall time bounds CPU time from above.
   */
  readonly maxSliceMs?: number;
  /** Delay before the next slice of an unfinished pass, so each alarm does bounded work. Proposed 1 s. */
  readonly continueAfterMs?: number;
  /** Delay before looking again at expired uploads that were still in use. Proposed 1 h. */
  readonly recheckMs?: number;
  /** Objects listed per R2 list call, capped by the deletions left in the slice. Proposed 100. */
  readonly listLimit?: number;
  /** The bucket's name, for cost counters. Default `fyrden-git`. */
  readonly bucketName?: string;
  /**
   * Whether this repository may sweep its network's pack prefix on its own:
   * true only while it is the network's only member. In a shared network an
   * object without a row here may belong to another member, so the network
   * object sweeps instead, asking every member (see `sweepPackPrefix`).
   * May ask the network object. Default false.
   */
  readonly sweepNetwork?: () => boolean | Promise<boolean>;
}

export const ORPHAN_REAPER_DEFAULTS: Required<OrphanReaperOptions> = {
  ttlMs: UPLOAD_TTL_MS,
  maxDeletionsPerSlice: 100,
  maxSliceMs: 20_000,
  continueAfterMs: 1_000,
  recheckMs: 60 * 60 * 1000,
  listLimit: 100,
  bucketName: "fyrden-git",
  sweepNetwork: () => false,
};

/** Schedules a reaper pass at `at`, or earlier if one is already due sooner. */
export function scheduleOrphanReaper(jobs: JobQueue, at: number): void {
  jobs.ensure("reap_orphans", ORPHAN_REAPER_JOB_ID, { runAt: at });
}

/** Where one page of the sweep of a network's pack prefix is listed. */
export interface PackPrefixListing {
  readonly bucket: R2Bucket;
  readonly networkId: string;
  /** The R2 list cursor from the previous page. */
  readonly cursor?: string;
  readonly limit: number;
  /** Objects uploaded at or before this time (ms) are old enough to delete. */
  readonly cutoff: number;
  /** Called once per R2 list call (a class A operation), for cost counters. */
  onList?(): void;
}

export interface PackPrefixSweep extends PackPrefixListing {
  /**
   * The pack ids among `packIds` that a registry still names. A repository
   * alone in its network answers from its own registry; the network object
   * answers for every member.
   */
  registered(packIds: readonly string[]): Set<string> | Promise<Set<string>>;
}

/** One listed page of `net/<nid>/p/`. */
export interface PackPrefixPage {
  /** The listed objects old enough to delete, with the pack each names (none: not a pack's file). */
  readonly old: readonly { readonly key: string; readonly packId?: string }[];
  /** The cursor of the next page, absent when the prefix is done. */
  readonly next?: string;
}

const PACK_FILE = /^([0-9A-Z]{26})\.(pack|idx)$/;

/**
 * Lists one page of `net/<nid>/p/`: its objects older than the cutoff, and
 * where the next page starts. A registry row is created before any byte of
 * a pack is stored, so an old object without one can never gain one.
 */
export async function listPackPrefix(listing: PackPrefixListing): Promise<PackPrefixPage> {
  const prefix = packPrefix(listing.networkId);
  listing.onList?.();
  const page = await listing.bucket.list({
    prefix,
    limit: listing.limit,
    ...(listing.cursor ? { cursor: listing.cursor } : {}),
  });
  const old = page.objects
    .filter((o) => o.uploaded.getTime() <= listing.cutoff)
    .map((o) => {
      const packId = PACK_FILE.exec(o.key.slice(prefix.length))?.[1];
      return packId === undefined ? { key: o.key } : { key: o.key, packId };
    });
  return { old, ...(page.truncated ? { next: page.cursor } : {}) };
}

/**
 * One page of the sweep of `net/<nid>/p/`: deletes the listed objects that
 * no registry row names and that are older than the cutoff. Returns the
 * deleted keys and the cursor of the next page (absent when the prefix is
 * done).
 */
export async function sweepPackPrefix(
  sweep: PackPrefixSweep,
): Promise<{ deleted: string[]; cursor?: string }> {
  const page = await listPackPrefix(sweep);
  const ids = [...new Set(page.old.flatMap((o) => (o.packId === undefined ? [] : [o.packId])))];
  const registered = ids.length > 0 ? await sweep.registered(ids) : new Set<string>();
  // A key that names no pack can have no row: nothing but packs is stored here.
  const deleted = page.old
    .filter((o) => o.packId === undefined || !registered.has(o.packId))
    .map((o) => o.key);
  if (deleted.length > 0) await sweep.bucket.delete(deleted);
  return { deleted, ...(page.next ? { cursor: page.next } : {}) };
}

/** Pack states an orphaned upload's packs can be in; any other means the pack is in use. */
const REAPABLE_PACK_STATES: readonly PackState[] = [
  "pending",
  "indexing",
  "indexed",
  "discarded",
  "deleted",
];

type Cursor =
  | { readonly phase: "uploads"; readonly after?: readonly [number, string] }
  | { readonly phase: "packs"; readonly after?: string }
  | { readonly phase: "sweep"; readonly list?: string };

const FIRST: Cursor = { phase: "uploads" };

function encodeCursor(cursor: Cursor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, ...cursor }));
}

/** A missing or unreadable cursor starts a new pass: every step is safe to redo. */
function decodeCursor(bytes: Uint8Array | null): Cursor {
  if (!bytes) return FIRST;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as { v?: number } & Cursor;
    if (value.v === 1 && ["uploads", "packs", "sweep"].includes(value.phase)) return value;
  } catch {
    // Fall through to a new pass.
  }
  return FIRST;
}

type RawUpload = {
  upload_id: string;
  state: string;
  expires_at: number;
  r2_key: string | null;
  multipart_id: string | null;
};
type RawPack = { pack_id: string; network_id: string; state: string };

/** Packs not owned by an upload that is still in flight (those go with their upload). */
const NO_OPEN_UPLOAD = `NOT EXISTS (SELECT 1 FROM uploads u
  WHERE u.upload_id = p.upload_id AND u.state <> 'committed')`;

class SliceBudget {
  deleted = 0;
  constructor(
    private readonly max: number,
    private readonly deadline: number,
    private readonly now: () => number,
  ) {}
  get left(): number {
    return Math.max(0, this.max - this.deleted);
  }
  fits(n: number): boolean {
    return this.deleted + n <= this.max;
  }
  spent(): boolean {
    return this.deleted >= this.max || this.now() >= this.deadline;
  }
}

/**
 * The orphan reaper, as a job handler for the repository's job queue. One
 * pass has three phases, each resumable from the job cursor:
 *
 * 1. Uploads that did not commit before their expiry: abort the upload
 *    (pending commit rows, pack rows to `discarded`, leases), abort its
 *    multipart upload by the stored id, delete its scratch objects, then
 *    each pack's files followed by its row, and finally the upload row. An
 *    upload with more files than a slice allows takes several slices.
 * 2. Discarded packs, and pending packs with no upload, older than the TTL.
 * 3. Objects under the network's pack prefix that no registry row names,
 *    older than the TTL (only when `sweepNetwork` allows it).
 *
 * Every step is safe to redo: R2 work comes before the row deletes that
 * record it, R2 deletes and multipart aborts are idempotent, and a slice
 * cut short (eviction, or a reset that loses its writes) is redone from
 * the last saved cursor. An upload that is still in use (an unexpired
 * lease on it or its packs, or a queued or running index job) is never
 * touched; committed, superseded, garbage and condemned packs never are.
 */
export function orphanReaperHandler(
  git: RepoGitStorage,
  options: OrphanReaperOptions = {},
): JobHandler {
  const config = { ...ORPHAN_REAPER_DEFAULTS, ...options };
  if (!Number.isSafeInteger(config.maxDeletionsPerSlice) || config.maxDeletionsPerSlice < 4)
    throw new RangeError("maxDeletionsPerSlice must be at least 4");
  const reaper = new OrphanReaper(git, config);
  return { runSlice: (job) => reaper.runSlice(job.cursor) };
}

class OrphanReaper {
  readonly #context: GitStorageContext;

  constructor(
    private readonly git: RepoGitStorage,
    private readonly config: Required<OrphanReaperOptions>,
  ) {
    this.#context = git.context;
  }

  async runSlice(saved: Uint8Array | null): Promise<SliceResult> {
    const now = () => this.#context.now();
    const budget = new SliceBudget(
      this.config.maxDeletionsPerSlice,
      now() + this.config.maxSliceMs,
      now,
    );
    let cursor = decodeCursor(saved);
    const pause = (): SliceResult => ({
      done: false,
      cursor: encodeCursor(cursor),
      runAfterMs: this.config.continueAfterMs,
    });
    for (;;) {
      if (budget.spent()) return pause();
      const next = await this.#step(cursor, budget);
      if (next === "pass-done") return this.#nextPass();
      if (next === "stopped") return pause();
      cursor = next;
    }
  }

  async #step(cursor: Cursor, budget: SliceBudget): Promise<Cursor | "stopped" | "pass-done"> {
    switch (cursor.phase) {
      case "uploads": {
        const upload = this.#nextExpiredUpload(cursor.after);
        if (!upload) return { phase: "packs" };
        const outcome = await this.#reapUpload(upload, budget);
        if (outcome === "incomplete") return "stopped";
        return { phase: "uploads", after: [upload.expires_at, upload.upload_id] };
      }
      case "packs": {
        const pack = this.#nextStalePack(cursor.after);
        if (!pack) return { phase: "sweep" };
        const outcome = await this.#reapPack(pack, budget);
        if (outcome === "incomplete") return "stopped";
        return { phase: "packs", after: pack.pack_id };
      }
      case "sweep": {
        if (!(await this.config.sweepNetwork())) return "pass-done";
        const { deleted, cursor: list } = await sweepPackPrefix({
          bucket: this.git.bucket,
          networkId: this.git.networkId(),
          ...(cursor.list ? { cursor: cursor.list } : {}),
          limit: Math.max(1, Math.min(this.config.listLimit, budget.left)),
          cutoff: this.#cutoff(),
          registered: (ids) => this.#registered(ids),
          onList: () => this.#countR2("list"),
        });
        budget.deleted += deleted.length;
        this.#countReaped("object", deleted.length);
        return list ? { phase: "sweep", list } : "pass-done";
      }
    }
  }

  #cutoff(): number {
    return this.#context.now() - this.config.ttlMs;
  }

  #nextExpiredUpload(after: readonly [number, string] | undefined): RawUpload | undefined {
    return first<RawUpload>(
      this.#context.storage,
      `SELECT upload_id, state, expires_at, r2_key, multipart_id FROM uploads
       WHERE state <> 'committed' AND expires_at <= ? AND (expires_at, upload_id) > (?, ?)
       ORDER BY expires_at, upload_id LIMIT 1`,
      this.#context.now(),
      after?.[0] ?? -1,
      after?.[1] ?? "",
    );
  }

  async #reapUpload(
    upload: RawUpload,
    budget: SliceBudget,
  ): Promise<"reaped" | "skipped" | "incomplete"> {
    const { storage } = this.#context;
    const uploadId = upload.upload_id;
    const packs = rows<RawPack>(
      storage,
      `SELECT pack_id, network_id, state FROM packs
       WHERE upload_id = ? OR unit_id = ? ORDER BY pack_id`,
      uploadId,
      uploadId,
    );
    if (packs.some((p) => !REAPABLE_PACK_STATES.includes(p.state as PackState))) return "skipped";
    if (this.#inUse(uploadId, packs)) return "skipped";
    // Synchronous with the check above, so nothing can start using it in between.
    this.git.uploads.abort(uploadId, upload.state === "rejected" ? "rejected" : "expired");

    if (upload.multipart_id && upload.r2_key) {
      if (!(await this.#abortMultipart(upload.r2_key, upload.multipart_id))) return "skipped";
    }
    const networkId = packs[0]?.network_id ?? this.git.networkId();
    if (
      isUlid(uploadId) &&
      !(await this.#deleteScratch(scratchPrefix(networkId, uploadId), budget))
    )
      return "incomplete";
    const files = packs.map(packFiles);
    if (files.some((f) => f === undefined)) return "skipped";
    // Pack by pack, each row deleted once its files are: an upload with more
    // files than a slice may delete (interrupted attempts accumulate) is
    // removed over several slices, each continuing with the rows left.
    for (const [i, pack] of packs.entries()) {
      const keys = files[i] as string[];
      if (!budget.fits(keys.length)) return "incomplete";
      await this.git.bucket.delete(keys);
      budget.deleted += keys.length;
      const reaped = storage.transactionSync(
        () =>
          run(storage, "DELETE FROM leases WHERE pack_id = ?", pack.pack_id) +
          run(
            storage,
            "DELETE FROM packs WHERE pack_id = ? AND state IN ('discarded', 'deleted')",
            pack.pack_id,
          ),
      );
      countRowsWritten(this.#context, "reaper.upload", reaped);
      if (reaped > 0) this.#countReaped("pack", 1);
    }

    const written = run(
      storage,
      "DELETE FROM uploads WHERE upload_id = ? AND state IN ('rejected', 'expired')",
      uploadId,
    );
    countRowsWritten(this.#context, "reaper.upload", written);
    this.#countReaped("upload", 1);
    return "reaped";
  }

  /** An unexpired lease held by the upload or on its packs, or an index job still to run. */
  #inUse(uploadId: string, packs: readonly RawPack[]): boolean {
    const { storage } = this.#context;
    const now = this.#context.now();
    if (
      first(
        storage,
        "SELECT 1 AS one FROM leases WHERE holder = ? AND expires_at > ?",
        uploadId,
        now,
      )
    )
      return true;
    if (this.git.leases.leased(packs.map((p) => p.pack_id as never)).size > 0) return true;
    return (
      first(
        storage,
        "SELECT 1 AS one FROM jobs WHERE job_id = ? AND state IN ('queued', 'running')",
        indexJobId(uploadId),
      ) !== undefined
    );
  }

  /**
   * Aborts a multipart upload by its stored id. Aborting twice succeeds
   * (measured on Workers Free, 2026-10-10). R2 reports an upload it no
   * longer knows as "does not exist (10024)" (measured for parts and
   * completion; unverified for abort), which counts as aborted. Any other
   * error leaves the upload for the next pass.
   */
  async #abortMultipart(key: string, multipartId: string): Promise<boolean> {
    try {
      await this.git.bucket.resumeMultipartUpload(key, multipartId).abort();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/does not exist|\(10024\)/.test(message)) return true;
      this.#countReaped("abort_failed", 1);
      return false;
    }
  }

  /** Deletes an upload's scratch objects within the budget. True when none are left. */
  async #deleteScratch(prefix: string, budget: SliceBudget): Promise<boolean> {
    for (;;) {
      if (budget.left === 0) return false;
      this.#countR2("list");
      const page = await this.git.bucket.list({ prefix, limit: Math.min(1_000, budget.left) });
      const keys = page.objects.map((o) => o.key);
      if (keys.length > 0) await this.git.bucket.delete(keys);
      budget.deleted += keys.length;
      this.#countReaped("scratch", keys.length);
      if (!page.truncated) return true;
    }
  }

  #nextStalePack(after: string | undefined): RawPack | undefined {
    const cutoff = this.#cutoff();
    return first<RawPack>(
      this.#context.storage,
      `SELECT pack_id, network_id, state FROM packs p
       WHERE pack_id > ?
         AND ((state = 'discarded' AND last_touched_at <= ?) OR (state = 'pending' AND created_at <= ?))
         AND ${NO_OPEN_UPLOAD}
       ORDER BY pack_id LIMIT 1`,
      after ?? "",
      cutoff,
      cutoff,
    );
  }

  async #reapPack(
    pack: RawPack,
    budget: SliceBudget,
  ): Promise<"reaped" | "skipped" | "incomplete"> {
    const { storage } = this.#context;
    if (this.git.leases.leased([pack.pack_id as never]).size > 0) return "skipped";
    const keys = packFiles(pack);
    if (!keys) return "skipped";
    if (!budget.fits(keys.length)) return "incomplete";
    if (pack.state === "pending") {
      const moved = this.git.registry.transition(pack.pack_id, ["pending"], "discarded");
      countRowsWritten(this.#context, "reaper.pack", moved);
      if (moved === 0) return "skipped";
    }
    await this.git.bucket.delete(keys);
    budget.deleted += keys.length;
    const written = storage.transactionSync(
      () =>
        run(storage, "DELETE FROM leases WHERE pack_id = ?", pack.pack_id) +
        run(storage, "DELETE FROM packs WHERE pack_id = ? AND state = 'discarded'", pack.pack_id),
    );
    countRowsWritten(this.#context, "reaper.pack", written);
    if (written > 0) this.#countReaped("pack", 1);
    return "reaped";
  }

  #registered(packIds: readonly string[]): Set<string> {
    const out = new Set<string>();
    for (const batch of chunks(packIds)) {
      for (const row of rows<{ pack_id: string }>(
        this.#context.storage,
        `SELECT pack_id FROM packs WHERE pack_id IN (${placeholders(batch.length)})`,
        ...batch,
      ))
        out.add(row.pack_id);
    }
    return out;
  }

  /**
   * Ends a pass: schedules the next one when the earliest remaining
   * candidate comes due, or finishes the job when there is none (a new
   * upload schedules it again).
   */
  #nextPass(): SliceResult {
    const { storage } = this.#context;
    const now = this.#context.now();
    const at = (query: string) => first<{ at: number | null }>(storage, query)?.at ?? null;
    const due = [
      at("SELECT min(expires_at) AS at FROM uploads WHERE state <> 'committed'"),
      plus(
        at(
          `SELECT min(last_touched_at) AS at FROM packs p WHERE state = 'discarded' AND ${NO_OPEN_UPLOAD}`,
        ),
        this.config.ttlMs,
      ),
      plus(
        at(
          `SELECT min(created_at) AS at FROM packs p WHERE state = 'pending' AND ${NO_OPEN_UPLOAD}`,
        ),
        this.config.ttlMs,
      ),
    ].filter((t): t is number => t !== null);
    if (due.length === 0) return { done: true };
    const next = Math.min(...due);
    // Due now means it was skipped as in use: look again later.
    return {
      done: false,
      cursor: null,
      runAfterMs: next > now ? next - now : this.config.recheckMs,
    };
  }

  #countReaped(what: string, n: number): void {
    if (n > 0) this.#context.metrics.count("git.reaped", { what }, n);
  }

  #countR2(op: string): void {
    this.#context.metrics.count("r2.class_a", { bucket: this.config.bucketName, op });
  }
}

function plus(at: number | null, ms: number): number | null {
  return at === null ? null : at + ms;
}

/**
 * A pack's R2 objects (pack file and index), built from its validated ids;
 * undefined for a row whose ids are not valid, which is left alone.
 */
function packFiles(pack: RawPack): string[] | undefined {
  try {
    return [
      packObjectKey(pack.network_id, pack.pack_id, "pack"),
      packObjectKey(pack.network_id, pack.pack_id, "idx"),
    ];
  } catch {
    return undefined;
  }
}
