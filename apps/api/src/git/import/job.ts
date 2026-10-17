import {
  DEFAULT_JOB_POLICY,
  type JobHandler,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger, Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { RepoRole } from "@fyrden/domain";
import { FetchClientError, ProtocolError, SmartHttpClient } from "@fyrden/git-core";
import { buildCommandHead, type RefUpdateSpec, readPushReport } from "../chunked/head.js";
import { CHUNKED_TUNING_DEFAULTS } from "../chunked/tuning.js";
import { reauthorizeByToken } from "../push/reauthorize-token.js";
import type { RepoPush } from "../push/repo-push.js";
import { BUCKET_NAME, headKey, packKey } from "../push/scratch.js";
import { type ImportNetwork, importPolicy } from "./network.js";
import { MultipartPackSink } from "./pack-parts.js";
import { IMPORT_REF_PREFIXES, MAX_IMPORT_REFS, selectImportRefs } from "./refs.js";
import { type ImportPace, SourceTooSlowError, TransferWatch, type WatchClock } from "./watch.js";

/*
 * Server-side import, in the repository object. One import at a time, into
 * an empty repository, as an upload that goes through the push path:
 *
 *   fetching    connect to the source (smart HTTP, protocol v2), list its
 *               branches and tags, write the command section that creates
 *               them, and fetch one pack into an R2 multipart upload; one
 *               alarm slice, bounded in bytes and time, a slow or stalled
 *               source stopped early (./watch.ts)
 *   indexing    the push path's resumable index job (fsck, connectivity)
 *   committing  re-authorize the importer by token id, then the push
 *               commit: every ref in one transaction
 *   committed / failed
 *
 * Every request goes through the outbound URL guard. The import's record
 * is one storage value (the repository's latest import).
 */

export type ImportState = "fetching" | "indexing" | "committing" | "committed" | "failed";

export interface ImportLimits {
  readonly maxBytes: number;
  readonly maxMs: number;
  readonly partBytes: number;
  /*
   * How slow the source may be (./watch.ts); absent in the records of
   * imports begun before these limits existed, which take the defaults.
   */
  readonly discoveryMs?: number;
  readonly idleMs?: number;
  readonly minBytesPerSecond?: number;
}

/** The watch's limits for an import. */
function paceOf(limits: ImportLimits): ImportPace {
  const defaults = CHUNKED_TUNING_DEFAULTS;
  return {
    maxMs: limits.maxMs,
    discoveryMs: limits.discoveryMs ?? defaults.importDiscoveryMs,
    idleMs: limits.idleMs ?? defaults.importIdleMs,
    minBytesPerSecond: limits.minBytesPerSecond ?? defaults.minImportBytesPerSecond,
  };
}

export interface ImportRecord {
  readonly v: 1;
  readonly uploadId: string;
  readonly url: string;
  readonly ownHosts: readonly string[];
  readonly principal: string;
  readonly tokenId: string;
  /** The delegation grant the import is made under; null or absent for none. */
  readonly grantId?: string | null;
  readonly repoId: string;
  /** The request that started the import, for the commit's audit row. */
  readonly requestId?: string | null;
  readonly limits: ImportLimits;
  readonly state: ImportState;
  readonly bytes: number;
  readonly refs: readonly string[];
  readonly skipped: readonly { readonly ref: string; readonly reason: string }[];
  readonly head?: string;
  /** The repository's owner generation when the import began (a transfer since bumps it). */
  readonly ownerGen?: number;
  readonly error?: string;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface BeginImport {
  readonly principal: string;
  readonly tokenId: string;
  /** The delegation grant the write is made under (an agent acting for `principal`); null for none. */
  readonly grantId?: string | null;
  readonly repoId: string;
  readonly url: string;
  readonly ownHosts: readonly string[];
  readonly limits: ImportLimits;
  /** The request starting the import. */
  readonly requestId?: string | null;
}

const RECORD_KEY = "git-import";
const AGENT = "fyrden";

export function importJobId(uploadId: string): string {
  return `import:${uploadId}`;
}

/** How long to wait before looking at a running fetch or index job again. Proposed. */
const BUSY_RETRY_MS = 30_000;
const INDEX_POLL_MS = 1_000;

export class RepoImports {
  constructor(
    private readonly git: RepoGitStorage,
    private readonly push: RepoPush,
    private readonly env: Env,
    /** The object's key-value storage, for the import record. */
    private readonly kv: Pick<DurableObjectStorage, "get" | "put">,
    private readonly metrics: Metrics,
    private readonly log: Logger,
    /** Read on each fetch, so tests can replace it. */
    private readonly network: () => ImportNetwork,
    /** The time the fetch's watch keeps; read on each fetch, so tests can replace it. */
    private readonly clock: () => WatchClock,
    /** A principal's role for a write, from the repository's ACL snapshot. */
    private readonly writerRole: (principalId: string) => Promise<RepoRole | null>,
    /** The repository's owner generation (bumped by a transfer); undefined without an identity. */
    private readonly ownerGen: () => number | undefined,
    /** The rulesets' refusal of the ref updates, before anything is fetched or stored. */
    private readonly precheck: (
      principal: string,
      updates: readonly RefUpdateSpec[],
      grantId: string | null,
      /** The default branch the import sets as it commits. */
      head: string | undefined,
    ) => Promise<string | undefined>,
  ) {}

  async record(): Promise<ImportRecord | undefined> {
    return this.kv.get<ImportRecord>(RECORD_KEY);
  }

  async begin(
    input: BeginImport,
  ): Promise<{ ok: true; record: ImportRecord } | { ok: false; code: string; error: string }> {
    const current = await this.record();
    if (current && !["committed", "failed"].includes(current.state))
      return { ok: false, code: "import_running", error: "An import is already running." };
    if (this.git.refStore.readRefsSync().refs.size > 0)
      return { ok: false, code: "repo_not_empty", error: "Import needs an empty repository." };
    const begun = this.push.begin({
      principal: input.principal,
      tokenId: input.tokenId,
      grantId: input.grantId ?? null,
    });
    if (!begun.ok) return { ok: false, code: "import_refused", error: begun.error };
    const now = this.git.context.now();
    const ownerGen = this.ownerGen();
    const record: ImportRecord = {
      v: 1,
      uploadId: begun.uploadId,
      url: input.url,
      ownHosts: [...input.ownHosts],
      principal: input.principal,
      tokenId: input.tokenId,
      ...(input.grantId && { grantId: input.grantId }),
      repoId: input.repoId,
      ...(input.requestId && { requestId: input.requestId }),
      limits: input.limits,
      state: "fetching",
      bytes: 0,
      refs: [],
      skipped: [],
      ...(ownerGen !== undefined && { ownerGen }),
      startedAt: now,
      updatedAt: now,
    };
    await this.#save(record);
    this.git.jobs.ensure("import", importJobId(begun.uploadId));
    return { ok: true, record };
  }

  /** The `import` job: one state step per slice. */
  handler(): JobHandler {
    return {
      runSlice: async (job) => {
        const uploadId = job.jobId.slice("import:".length);
        const record = await this.record();
        if (!record || record.uploadId !== uploadId) return { done: true };
        let next: { state: ImportState; retryMs?: number };
        try {
          next = await this.#step(record);
        } catch (error) {
          // Retried by the job queue (a D1 or R2 hiccup); the last attempt ends the import.
          if (job.attempts + 1 < DEFAULT_JOB_POLICY.maxAttempts) throw error;
          await this.#fail(record, error);
          return { done: true };
        }
        if (next.state === "committed" || next.state === "failed") return { done: true };
        return { done: false, cursor: null, runAfterMs: next.retryMs ?? 0 };
      },
    };
  }

  async #step(record: ImportRecord): Promise<{ state: ImportState; retryMs?: number }> {
    switch (record.state) {
      case "fetching":
        return this.#fetching(record);
      case "indexing":
        return this.#indexing(record);
      case "committing":
        return { state: (await this.#commit(record)).state };
      default:
        return { state: record.state };
    }
  }

  async #fetching(record: ImportRecord): Promise<{ state: ImportState; retryMs?: number }> {
    const upload = this.git.uploads.get(record.uploadId);
    if (upload?.state === "indexing" || upload?.state === "indexed") {
      // An earlier attempt stored the pack and was cut short after that
      // (the alarm's time ran out): continue with its indexing.
      return { state: (await this.#save({ ...record, state: "indexing" })).state };
    }
    if (upload?.state !== "open") {
      const error = new ImportError("the import's upload expired or was cancelled; start it again");
      return { state: (await this.#fail(record, error)).state };
    }
    const lock = this.git.locks.tryAcquire(
      `import-fetch:${record.uploadId}`,
      "import",
      record.limits.maxMs + 60_000,
    );
    if (!lock) return { state: "fetching", retryMs: BUSY_RETRY_MS };
    try {
      // The part buffer and its copy, from the operation pool, only while
      // the pack streams in: indexing reserves from the same pool, so the
      // import must not hold them while it waits for indexing.
      const memory = this.git.memory.tryReserve(2 * record.limits.partBytes);
      if (!memory) return { state: "fetching", retryMs: BUSY_RETRY_MS };
      let fetched: ImportRecord;
      try {
        fetched = await this.#fetch(record);
      } finally {
        memory.release();
      }
      if (fetched.state !== "indexing") return { state: fetched.state };
      // Plan the push and queue its index job (indexing runs in later slices).
      const progress = await this.push.status(fetched.uploadId, 0);
      if (progress.state === "done") throw new ImportError(failureOf(progress.response));
      return { state: fetched.state };
    } catch (error) {
      return { state: (await this.#fail(record, error)).state };
    } finally {
      this.git.locks.release(lock);
    }
  }

  /** Fetches the source's pack into the upload; the record comes back `indexing` (or done). */
  async #fetch(record: ImportRecord): Promise<ImportRecord> {
    // A fetch cut short by a reset left a multipart upload: abort it and start over.
    await this.#abortMultipart(record.uploadId);
    const watch = new TransferWatch(paceOf(record.limits), this.clock());
    try {
      return await this.#fetchWatched(record, watch);
    } finally {
      watch.stop();
    }
  }

  async #fetchWatched(record: ImportRecord, watch: TransferWatch): Promise<ImportRecord> {
    const { uploadId } = record;
    const network = this.network();
    const policy = importPolicy(record.ownHosts, network.resolver(watch.signal));
    const transport = watch.transport(network.transport(policy, watch.signal));
    const { client, advertised } = await watch.run("discovery", async () => {
      const client = await SmartHttpClient.connect({
        transport,
        url: record.url,
        agent: AGENT,
        limits: { maxPackBytes: record.limits.maxBytes, maxRefs: MAX_IMPORT_REFS * 2 },
      });
      const advertised = await client.lsRefs({ prefixes: IMPORT_REF_PREFIXES, symrefs: true });
      return { client, advertised };
    });
    const selection = selectImportRefs(advertised);
    if (selection.updates.length > MAX_IMPORT_REFS)
      throw new ImportError(`the source has more than ${MAX_IMPORT_REFS} branches and tags`);
    const listed = {
      ...record,
      refs: selection.updates.map((u) => u.ref),
      skipped: selection.skipped,
      ...(selection.head ? { head: selection.head } : {}),
    };
    if (selection.updates.length === 0) {
      // An empty source: nothing to store or commit.
      await this.push.abort(uploadId);
      return this.#save({ ...listed, state: "committed" });
    }
    // Refs a ruleset refuses: the import fails before anything is fetched or stored.
    const refused = await this.precheck(
      record.principal,
      selection.updates,
      record.grantId ?? null,
      selection.head,
    );
    if (refused !== undefined) throw new ImportError(refused);

    const networkId = this.git.networkId();
    const head = buildCommandHead(selection.updates);
    this.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "put_head" });
    await this.git.bucket.put(headKey(networkId, uploadId), head);
    const key = packKey(networkId, uploadId);
    let saving = Promise.resolve();
    const sink = new MultipartPackSink(this.git.bucket, key, record.limits.partBytes, {
      metrics: this.metrics,
      onCreated: (multipartId) => {
        if (!this.git.uploads.recordMultipart(uploadId, multipartId, key))
          throw new ImportError(UPLOAD_NOT_OPEN);
      },
      // Progress for the status operation, one write per part.
      onPart: (bytes) => {
        saving = saving.then(async () => void (await this.#save({ ...listed, bytes })));
        return saving;
      },
    });
    await watch.run("transfer", () => client.fetchPack(selection.wants, watch.sink(sink)));
    const size = await sink.finish();
    this.git.uploads.clearMultipart(uploadId);
    if (size !== sink.bytes) throw new ImportError("the stored pack has the wrong length");
    if (
      !this.push.splitBodyStored(uploadId, {
        kind: "parts",
        headBytes: head.length,
        packBytes: size,
      })
    )
      throw new ImportError(UPLOAD_NOT_OPEN);
    return this.#save({ ...listed, bytes: size, state: "indexing" });
  }

  async #indexing(record: ImportRecord): Promise<{ state: ImportState; retryMs?: number }> {
    const progress = await this.push.status(record.uploadId, 0);
    if (progress.state === "indexing") return { state: "indexing", retryMs: INDEX_POLL_MS };
    if (progress.state === "done") {
      return {
        state: (await this.#fail(record, new ImportError(failureOf(progress.response)))).state,
      };
    }
    const committing = await this.#save({ ...record, state: "committing" });
    return { state: (await this.#commit(committing)).state };
  }

  async #commit(record: ImportRecord): Promise<ImportRecord> {
    const ownerGen = record.ownerGen ?? this.ownerGen();
    const decision = await reauthorizeByToken(this.env.DIRECTORY, record, this.writerRole);
    const { head } = record;
    const report = readPushReport(
      await this.push.finalize(record.uploadId, decision, {
        repoId: record.repoId,
        // The rulesets see the default branch the import is about to set.
        ...(head && {
          head,
          // The new default branch (and its snapshot event) commits with the refs, so no
          // push in between sees the old one; not once the repository was transferred
          // after the import began (its new owner decides).
          inCommit: () => {
            if (this.ownerGen() === ownerGen) this.git.refStore.setHead(head);
          },
        }),
      }),
    );
    if (!report.ok) return this.#save({ ...record, state: "failed", error: report.error });
    return this.#save({ ...record, state: "committed" });
  }

  async #fail(record: ImportRecord, error: unknown): Promise<ImportRecord> {
    const message = importErrorMessage(error);
    if (!reportedAsIs(error)) this.log.warn("import failed", { uploadId: record.uploadId, error });
    await this.#abortMultipart(record.uploadId);
    await this.push.abort(record.uploadId);
    return this.#save({ ...record, state: "failed", error: message });
  }

  async #abortMultipart(uploadId: string): Promise<void> {
    const multipart = this.git.uploads.multipartOf(uploadId);
    if (!multipart) return;
    try {
      this.metrics.count("r2.class_a", { bucket: BUCKET_NAME, op: "abort_multipart" });
      await this.git.bucket.resumeMultipartUpload(multipart.key, multipart.multipartId).abort();
      this.git.uploads.clearMultipart(uploadId);
    } catch (error) {
      // Left recorded: the orphan reaper aborts it once the upload expires.
      this.log.warn("import multipart abort failed", { uploadId, error });
    }
  }

  async #save(record: ImportRecord): Promise<ImportRecord> {
    const saved = { ...record, updatedAt: this.git.context.now() };
    await this.kv.put(RECORD_KEY, saved);
    return saved;
  }
}

/** The upload ended while the pack was being fetched (expired, or cancelled by another step). */
const UPLOAD_NOT_OPEN =
  "the import's upload expired or was cancelled during the fetch; start it again";

/** A failure the import reports as it is (its message names no secret). */
class ImportError extends Error {
  override name = "ImportError";
}

/** A failure whose message the import status shows as it is. */
function reportedAsIs(error: unknown): error is Error {
  return (
    error instanceof ImportError ||
    error instanceof FetchClientError ||
    error instanceof SourceTooSlowError
  );
}

/** What the import status shows for a failure: known errors as they are, others generically. */
function importErrorMessage(error: unknown): string {
  if (reportedAsIs(error)) return error.message;
  if (error instanceof ProtocolError) return `the source broke the git protocol: ${error.message}`;
  if (error instanceof Error && error.name === "SsrfError") return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "the source took too long";
  return "the import failed; try again";
}

function failureOf(response: Uint8Array): string {
  const report = readPushReport(response);
  return report.ok ? "the import was refused" : report.error;
}
