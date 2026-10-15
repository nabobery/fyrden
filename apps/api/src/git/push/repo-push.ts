import {
  indexJobId,
  type JobHandler,
  LOCK_REF_COMMIT,
  type RepoGitStorage,
  UPLOAD_TTL_MS,
  type UploadRecord,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  type BlockCache,
  type CheckedCommand,
  encodeFatalError,
  encodePushResponse,
  finalizePush,
  type IndexOutcome,
  type PackId,
  ProtocolError,
  PushIndexer,
  type PushResult,
  planPush,
  readPushBody,
  requestedSideband,
  type StoredBody,
} from "@fyrden/git-core";
import { prepareTailMerge, type TailMergeOutcome } from "../maintenance/tail-merge.js";
import { PACK_CAP_JOB_ID } from "../maintenance/tail-merge-job.js";
import { PACK_CAP_DEFAULTS, type PackCapPolicy } from "../maintenance/tail-merge-plan.js";
import {
  type CommittedTransaction,
  type PushCapGate,
  type PushDecision,
  pushCommitter,
} from "./commit.js";
import { pushIndexEnv } from "./index-env.js";
import { ACCESS_LOST } from "./reauthorize.js";
import {
  INLINE_CURSOR_BYTES,
  PushCursorStore,
  type PushRecord,
  planRecord,
  readRecord,
  restorePlan,
  type SplitBody,
} from "./record.js";
import {
  bodyKey,
  concatStoredBody,
  deleteScratch,
  headKey,
  packKey,
  r2StoredBody,
} from "./scratch.js";

/*
 * The Durable Object side of a push (the Worker side is ../receive-pack.ts):
 *
 *   begin      upload row, `pending` row for the preallocated pack, index
 *              lease, before any byte is stored; returns the body's key
 *   run        the body is stored: read the commands, plan, and start the
 *              indexing job `index:<uploadId>`, running it here within a
 *              budget; the alarm continues what is left
 *   status     how far the push is (and runs due indexing within a budget)
 *   finalize   with the Worker's re-authorization: commit, report, clean up
 *
 * The Durable Object never holds the client's connection: each call
 * returns within its budget, and the Worker waits between calls.
 */

export type PushProgress =
  | { readonly state: "indexing"; readonly sideband: boolean }
  /** Indexing has finished (or was not needed): the Worker may re-authorize and finalize. */
  | { readonly state: "ready"; readonly sideband: boolean }
  /**
   * The push is over; `response` is the whole response body. `discardBody`:
   * no upload holds the stored body any more (it expired, or the repository
   * was erased), so the Worker that stored it deletes it.
   */
  | { readonly state: "done"; readonly response: Uint8Array; readonly discardBody?: true };

export interface BeginPushInput {
  readonly principal: string;
  readonly tokenId: string;
  readonly grantId?: string | null;
}

export type BeginPushResult =
  | {
      readonly ok: true;
      readonly uploadId: string;
      readonly bodyKey: string;
      /** Rulesets check the commands before the body is stored (`precheckPush`). */
      readonly precheck?: boolean;
    }
  | { readonly ok: false; readonly error: string };

/**
 * How long the upload's index lease lasts. Proposed: as long as the upload
 * itself, so the reaper never takes a pack that indexing still writes.
 */
const INDEX_LEASE_MS = UPLOAD_TTL_MS;

/**
 * How long one indexing phase may hold the upload's index lock. Proposed
 * 5 min: a phase gets 30 s of CPU (measured for Durable Object requests and
 * alarms on Workers Free, 2026-10-10); the rest is R2 wall time. A runner
 * that dies holding it delays the job until it expires.
 */
const INDEX_LOCK_MS = 5 * 60 * 1000;
/**
 * When another runner still holds an upload's index lock (its job claim
 * expired while it waited on R2), the job tries again after this long,
 * without counting a failed attempt. Proposed.
 */
const INDEX_BUSY_RETRY_MS = 5_000;

/** How long finalize waits for the commit lock (held by other pushes and maintenance swaps). Proposed. */
const COMMIT_LOCK_WAIT_MS = 10_000;
const COMMIT_LOCK_TTL_MS = 30_000;

/** A block tier that keeps nothing (for callers without the object's memory tier). */
const noBlockCache = (): BlockCache => ({ get: async () => undefined, put: async () => {} });

const PUSH_OPTIONS = { pushOptionsAdvertised: true } as const;

/** The rulesets changed between the push's check and its commit. */
export const RULESETS_CHANGED =
  "the repository's rulesets changed while the push was checked; try the push again";

const fatal = (message: string, sideband: boolean): PushProgress => ({
  state: "done",
  response: encodeFatalError(message, sideband),
});

type Planned = NonNullable<PushRecord["planned"]>;

export interface PushLogMeta {
  readonly requestId?: string;
  readonly repoId?: string;
  /** The default branch the push sets as it commits (an import's), for the rulesets. */
  readonly head?: string;
  /**
   * Runs in the transaction that commits the upload (an import sets its
   * default branch there): what it writes commits with the refs, or not at all.
   */
  readonly inCommit?: () => void;
}

export class RepoPush {
  readonly #cursors: PushCursorStore;

  /**
   * The repository's access check for the principal that started a push,
   * just before its commit: a refusal message, or undefined to go on.
   */
  accessCheck: ((principal: string) => Promise<string | undefined>) | undefined;

  /**
   * The repository's rulesets at the commit point: refusals by command
   * index (`packs` are the push's own, not live yet; `head`, a default
   * branch the push sets as it commits, as an import's), and a stamp of
   * what they were checked against (the rulesets' version, HEAD, the
   * pusher's effective role), which `restamp` takes again: the commit is
   * refused when it differs then, and when that role does not allow
   * writing (`writable`: an agent whose owner lost access since the last
   * check writes no more than its owner could).
   */
  rules:
    | {
        readonly check: (input: {
          readonly principal: string;
          /** The delegation grant the push is made under; null for none. */
          readonly grantId: string | null;
          readonly uploadId: string;
          readonly packs: readonly PackId[];
          readonly head: string | undefined;
          readonly commands: readonly CheckedCommand[];
          /** An atomic push: one refused update fails them all. */
          readonly atomic: boolean;
        }) => Promise<{
          stamp: string;
          restamp: () => string;
          writable: boolean;
          refusals: ReadonlyMap<number, string>;
        }>;
      }
    | undefined;

  /** Why the repository takes no change now (deleted, being transferred), checked in each commit. */
  frozen: (() => string | undefined) | undefined;

  /**
   * The account's storage quota: at the commit point, after the access
   * check, `charge` holds the upload's stored bytes (a refusal message
   * when they do not fit); in the commit's transaction, `owe` records
   * that the account must be told; once committed, `confirm` makes them
   * the repository's usage (or leaves them owed, told later); an upload
   * aborted without committing `release`s what it held.
   */
  storage:
    | {
        readonly charge: (uploadId: string, bytes: number) => Promise<string | undefined>;
        readonly owe: (uploadId: string, bytes: number) => void;
        readonly confirm: (uploadId: string, bytes: number) => Promise<void>;
        readonly release: (uploadId: string) => Promise<void>;
      }
    | undefined;

  constructor(
    private readonly git: RepoGitStorage,
    private readonly metrics: Metrics,
    private readonly log: Logger,
    /** The pack-count cap in force (read at each commit, so operators and tests can change it). */
    private readonly packCap: () => PackCapPolicy = () => PACK_CAP_DEFAULTS,
    /** The object's long-lived in-memory pack block tier (thin bases and link checks read through it). */
    private readonly memoryBlocks: () => BlockCache = noBlockCache,
    /** Largest indexing cursor kept in its row; larger ones go to R2 (tests lower it). */
    inlineCursorBytes = INLINE_CURSOR_BYTES,
  ) {
    this.#cursors = new PushCursorStore(git, metrics, inlineCursorBytes);
  }

  begin(input: BeginPushInput): BeginPushResult {
    const networkId = this.git.networkId();
    const upload = this.git.uploads.begin({
      networkId,
      principal: input.principal,
      tokenId: input.tokenId,
      grantId: input.grantId ?? null,
      commands: [],
      atomic: false,
      withPack: true,
      ttlMs: UPLOAD_TTL_MS,
      leaseTtlMs: INDEX_LEASE_MS,
    });
    return { ok: true, uploadId: upload.uploadId, bodyKey: bodyKey(networkId, upload.uploadId) };
  }

  /**
   * A chunked upload's or import's head and pack are stored: from here on
   * the upload is read as one body, as a receive-pack request is. False if
   * the upload is not open.
   */
  splitBodyStored(uploadId: string, body: SplitBody): boolean {
    if (this.git.uploads.get(uploadId)?.state !== "open") return false;
    const record: PushRecord = { v: 1, bodyBytes: body.headBytes + body.packBytes, body };
    this.git.uploads.recordCommands(uploadId, record);
    return this.git.uploads.markBodyStored(uploadId);
  }

  /** The Worker could not store the body: the upload ends here. */
  async abort(uploadId: string): Promise<void> {
    await this.#discard(uploadId);
  }

  /**
   * The body (`bodyBytes` long) is stored at the upload's body key: plan
   * the push and index for up to `budgetMs`.
   */
  async run(uploadId: string, bodyBytes: number, budgetMs: number): Promise<PushProgress> {
    const upload = this.git.uploads.get(uploadId);
    if (!upload)
      return {
        state: "done",
        response: encodeFatalError("this push has expired; push again", false),
        discardBody: true,
      };
    if (upload.state === "open") {
      if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0) throw new RangeError("bad body size");
      this.git.uploads.recordCommands(uploadId, { v: 1, bodyBytes });
      this.git.uploads.markBodyStored(uploadId);
    }
    return this.status(uploadId, budgetMs);
  }

  /** Where the push stands; indexing that is due runs here for up to `budgetMs`. */
  async status(uploadId: string, budgetMs: number): Promise<PushProgress> {
    const upload = this.git.uploads.get(uploadId);
    if (!upload) return fatal("this push has expired; push again", false);
    const record = readRecord(this.git, uploadId);
    switch (upload.state) {
      case "open":
        return fatal("the push body was never stored; push again", false);
      case "committed": {
        const response = this.#cursors.response(uploadId);
        return response
          ? { state: "done", response }
          : fatal("this push has already been committed", record?.planned?.sideband ?? false);
      }
      case "rejected":
      case "expired":
        return fatal("this push was cancelled; push again", record?.planned?.sideband ?? false);
      case "indexed":
        return { state: "ready", sideband: record?.planned?.sideband ?? false };
    }
    if (!record) return fatal("this push has no record; push again", false);
    try {
      const planned = record.planned ?? (await this.#plan(upload, record));
      if ("state" in planned) return planned;
      if (!planned.indexing) return { state: "ready", sideband: planned.sideband };
      const job = this.git.jobs.get(indexJobId(uploadId));
      // Planned but never queued (the object was reset in between): queue it now.
      if (!job) this.git.jobs.ensure("index", indexJobId(uploadId));
      if (job?.state === "done") return { state: "ready", sideband: planned.sideband };
      if (job?.state === "failed") {
        this.log.error("push indexing failed", { uploadId, attempts: job.attempts });
        await this.#discard(uploadId);
        return fatal("the server could not index the pushed objects; try again", planned.sideband);
      }
      const ran = await this.git.jobs.runJob(
        indexJobId(uploadId),
        this.indexHandler(),
        this.git.memory,
        this.git.context.now() + budgetMs,
      );
      return { state: ran.state === "done" ? "ready" : "indexing", sideband: planned.sideband };
    } catch (error) {
      this.log.error("push could not be prepared", { uploadId, error });
      await this.#discard(uploadId);
      return fatal(
        "the server could not read the push; try again",
        record.planned?.sideband ?? false,
      );
    }
  }

  /**
   * Reads the command section, plans the push against the current refs,
   * records the plan and starts the index job. A malformed request ends
   * the push with git's error.
   */
  async #plan(upload: UploadRecord, stored: PushRecord): Promise<Planned | PushProgress> {
    const { bodyBytes } = stored;
    const body = this.#body(upload.uploadId, stored);
    let parsed: Awaited<ReturnType<typeof readPushBody>>;
    try {
      parsed = await readPushBody(body, PUSH_OPTIONS);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      const sideband = await requestedSideband(body);
      await this.#discard(upload.uploadId);
      return fatal(error.message, sideband);
    }
    const plan = planPush(parsed.request, this.git.refStore.readRefsSync());
    const record = planRecord(bodyBytes, parsed.packOffset, plan, stored.body);
    const planned = record.planned as Planned;
    if (planned.indexing) {
      await this.#cursors.save(
        upload.uploadId,
        PushIndexer.start({
          uploadId: upload.uploadId,
          packOffset: parsed.packOffset,
          plan,
        }).checkpoint(),
      );
      this.git.jobs.ensure("index", indexJobId(upload.uploadId));
    } else if (upload.packId) {
      // Nothing to index: the preallocated pack is never written.
      this.git.registry.transition(upload.packId, ["pending"], "discarded");
      this.git.uploads.markIndexed(upload.uploadId, { deps: [] });
    }
    this.git.uploads.recordCommands(upload.uploadId, record);
    return planned;
  }

  /** The `index` job: one indexing phase per slice, each ending at a saved cursor. */
  indexHandler(): JobHandler {
    return {
      runSlice: async (job) => {
        const uploadId = job.jobId.slice("index:".length);
        const phase = await this.#indexPhase(uploadId);
        if (phase === "done") return { done: true };
        return {
          done: false,
          cursor: null,
          runAfterMs: phase === "busy" ? INDEX_BUSY_RETRY_MS : 0,
        };
      },
    };
  }

  /**
   * Runs one phase: "done" when indexing is over (or there is nothing to
   * do), "busy" when another runner is indexing the upload.
   */
  async #indexPhase(uploadId: string): Promise<"done" | "more" | "busy"> {
    const upload = this.git.uploads.get(uploadId);
    const record = readRecord(this.git, uploadId);
    if (upload?.state !== "indexing" || !record?.planned?.indexing || !upload.packId) return "done";
    const lock = this.git.locks.tryAcquire(`push-index:${uploadId}`, "index", INDEX_LOCK_MS);
    if (!lock) return "busy";
    try {
      const indexer = PushIndexer.resume(await this.#cursors.load(uploadId));
      if (indexer.phase !== "done") {
        await indexer.step(
          await pushIndexEnv(
            this.git,
            { uploadId, packId: upload.packId },
            this.metrics,
            this.memoryBlocks(),
          ),
          this.#body(uploadId, record),
        );
        // The phase counts only while this runner still holds the lock: one
        // that outlived it (another runner may have finished the upload
        // meanwhile) publishes nothing, however late its write lands.
        const held = this.git.locks.renew(lock, INDEX_LOCK_MS);
        if (!held) return "busy";
        const published = await this.#cursors.save(
          uploadId,
          indexer.checkpoint(),
          () => this.git.locks.isHeld(held) && this.git.uploads.get(uploadId)?.state === "indexing",
        );
        if (!published) return "busy";
      } else if (!this.git.locks.isHeld(lock)) {
        return "busy";
      }
      if (indexer.phase !== "done") return "more";
      const outcome = indexer.outcome();
      if (outcome.ok) {
        this.git.uploads.markIndexed(uploadId, {
          deps: outcome.deps,
          objectCount: outcome.objectCount,
        });
      }
      return "done";
    } finally {
      this.git.locks.release(lock);
    }
  }

  /**
   * Commits the push with the Worker's re-authorization and returns the
   * response body. An upload that does not commit is aborted; the scratch
   * body is deleted either way.
   */
  async finalize(
    uploadId: string,
    decision: PushDecision,
    meta: PushLogMeta = {},
  ): Promise<Uint8Array> {
    const progress = await this.status(uploadId, 0);
    if (progress.state === "done") return progress.response;
    const sideband = progress.sideband;
    if (progress.state !== "ready")
      return encodeFatalError("the push is still being indexed", sideband);
    const upload = this.git.uploads.get(uploadId) as UploadRecord;
    const record = readRecord(this.git, uploadId);
    const planned = record?.planned;
    if (!record || !planned)
      return encodeFatalError("this push has no record; push again", sideband);

    const committed: CommittedTransaction[] = [];
    const merged: TailMergeOutcome[] = [];
    let rulesStamp:
      | { readonly stamp: string; readonly restamp: () => string; readonly writable: boolean }
      | undefined;
    const rules = this.rules;
    const outcome = await this.git.locks.withLock(
      LOCK_REF_COMMIT,
      `push:${uploadId}`,
      { ttlMs: COMMIT_LOCK_TTL_MS, waitMs: COMMIT_LOCK_WAIT_MS },
      async (lock) => {
        const { request } = await readPushBody(this.#body(uploadId, record), PUSH_OPTIONS);
        const plan = planPush(request, this.git.refStore.readRefsSync());
        restorePlan(plan, planned);
        const indexed: IndexOutcome | undefined = planned.indexing
          ? PushIndexer.resume(await this.#cursors.load(uploadId)).outcome()
          : undefined;
        const result = await finalizePush(plan, indexed, uploadId, {
          commitGraph: this.git.commitGraph,
          // The caller's decision (token, repository), then the object's
          // own access check for the pusher.
          reauthorize: async () =>
            decision.refusal ??
            (await this.accessCheck?.(upload.principal)) ??
            (await this.storage?.charge(uploadId, record.bodyBytes)),
          ...(rules && {
            checkCommands: async (commands: readonly CheckedCommand[]) => {
              const checked = await rules.check({
                principal: upload.principal,
                grantId: upload.grantId,
                uploadId,
                packs: indexed?.ok ? indexed.packs : [],
                head: meta.head,
                commands,
                atomic: plan.capabilities.atomic,
              });
              rulesStamp = checked;
              return checked.refusals;
            },
          }),
          commit: pushCommitter(
            this.git,
            upload,
            decision,
            lock,
            committed,
            this.#capGate(uploadId, merged),
            // In the commit's transaction: the pusher's effective role still
            // allows writing, and the rulesets checked are still the current ones.
            () =>
              this.frozen?.() ??
              (rulesStamp === undefined
                ? undefined
                : !rulesStamp.writable
                  ? ACCESS_LOST
                  : rulesStamp.restamp() !== rulesStamp.stamp
                    ? RULESETS_CHANGED
                    : undefined),
            // In the commit's transaction: the account is owed its confirmation (told after,
            // or later should that fail), and the caller's own writes.
            () => {
              this.storage?.owe(uploadId, record.bodyBytes);
              meta.inCommit?.();
            },
          ),
        });
        return { plan, indexed, result };
      },
    );
    if (!outcome.ok) {
      await this.#discard(uploadId);
      return encodeFatalError("the repository is busy; try the push again", sideband);
    }
    const { plan, indexed, result } = outcome.value;
    const response = encodePushResponse(result.report, plan.capabilities, result.messages);
    if (result.uploadCommitted) {
      await this.storage?.confirm(uploadId, record.bodyBytes);
      const cursorObject = this.#cursors.objectKey(uploadId);
      this.#cursors.saveResponse(uploadId, response);
      await deleteScratch(
        this.git.bucket,
        this.git.networkId(),
        uploadId,
        cursorObject ? [cursorObject] : [],
      ).catch(() => {});
    } else {
      await this.#discard(uploadId);
    }
    this.#report(meta, uploadId, record.bodyBytes, decision, indexed, result, committed, merged);
    return response;
  }

  /**
   * The pack-count cap for this push's commit: the tail merge it needs
   * (recorded in `merged` for the push event), and what happens when the
   * cap cannot be met now (compaction is scheduled; the push is refused).
   */
  #capGate(uploadId: string, merged: TailMergeOutcome[]): PushCapGate {
    return {
      prepare: async () => {
        const started = Date.now();
        const outcome = await prepareTailMerge(this.git, { policy: this.packCap(), uploadId });
        merged.push(outcome);
        if (outcome.kind === "merged") {
          this.log.info("git.tail_merge", {
            uploadId,
            sources: outcome.merge.removePacks.length + (outcome.merge.withIncoming ? 1 : 0),
            sourceBytes: outcome.merge.sourceBytes,
            objects: outcome.merge.objectCount,
            ms: Date.now() - started,
          });
        }
        return outcome;
      },
      onOverBudget: (reason) => {
        this.git.jobs.ensure("compact", PACK_CAP_JOB_ID);
        this.log.warn("push refused at the pack-count cap", { uploadId, reason });
      },
      onError: (error) => {
        this.log.error("tail merge failed", { uploadId, error });
      },
    };
  }

  /** Aborts an upload that will not commit and deletes what it stored (the reaper retries what fails). */
  async #discard(uploadId: string): Promise<void> {
    const cursorObject = this.#cursors.objectKey(uploadId);
    const aborted = this.git.uploads.abort(uploadId);
    // Only an upload this aborted (not one committed meanwhile) frees what it held.
    if (aborted) await this.storage?.release(uploadId);
    const keys = aborted ?? [];
    const networkId = this.git.networkId();
    const files = keys.flatMap((key) => [key, key.replace(/\.pack$/, ".idx")]);
    try {
      if (files.length > 0) await this.git.bucket.delete(files);
      await deleteScratch(this.git.bucket, networkId, uploadId, cursorObject ? [cursorObject] : []);
    } catch (error) {
      this.log.warn("push cleanup left objects for the reaper", { uploadId, error });
    }
  }

  /** The stored body: one request body, or a chunked upload's or import's head and pack. */
  #body(uploadId: string, record: PushRecord): StoredBody {
    const networkId = this.git.networkId();
    const { body } = record;
    if (!body) {
      return r2StoredBody(
        this.git.bucket,
        bodyKey(networkId, uploadId),
        record.bodyBytes,
        this.metrics,
      );
    }
    return concatStoredBody(
      r2StoredBody(this.git.bucket, headKey(networkId, uploadId), body.headBytes, this.metrics),
      r2StoredBody(this.git.bucket, packKey(networkId, uploadId), body.packBytes, this.metrics),
    );
  }

  /** The push's log line and counters (its events go through the outbox with each commit). */
  #report(
    meta: PushLogMeta,
    uploadId: string,
    bodyBytes: number,
    decision: PushDecision,
    indexed: IndexOutcome | undefined,
    result: PushResult,
    committed: readonly CommittedTransaction[],
    merged: readonly TailMergeOutcome[],
  ): void {
    const failed = result.report.commands.filter((c) => c.error !== undefined).length;
    const outcome =
      result.report.unpackError !== undefined
        ? "failed"
        : decision.refusal !== undefined
          ? "refused"
          : result.applied.length === 0
            ? "rejected"
            : failed > 0
              ? "partial"
              : "committed";
    const objects = indexed?.ok ? indexed.objectCount : 0;
    const packs: readonly PackId[] = indexed?.ok ? indexed.packs : [];
    this.log.info("git.push", {
      ...meta,
      uploadId,
      outcome,
      commands: result.report.commands.length,
      applied: result.applied.map((u) => u.name),
      rejected: failed,
      objects,
      packs: packs.length,
      bodyBytes,
      pushOptions: result.pushOptions.length,
      versions: committed.map((t) => t.version),
      packCap: merged[0]?.kind ?? "not-needed",
    });
    const count = (what: string, value: number) =>
      this.metrics.count("git.push", { outcome, what }, value);
    count("pushes", 1);
    count("objects", objects);
    count("bytes", bodyBytes);
    count("refs", result.applied.length);
  }
}
