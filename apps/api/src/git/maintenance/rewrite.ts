import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  type PackKind,
  type PackUploadState,
  packObjectKey,
  type RepoGitStorage,
  ResumablePackUpload,
} from "@fyrden/adapters-cloudflare/git";
import {
  type BitSet,
  type BlockCache,
  Compaction,
  type CompactionOptions,
  type CompactionSource,
  type ObjectReader,
  type PackId,
} from "@fyrden/git-core";
import type { MaintenancePolicy } from "./policy.js";
import {
  BUCKET,
  type CallCounter,
  countingStore,
  deleteScratch,
  getScratch,
  LoadedPacks,
  openReader,
  putScratch,
} from "./storage.js";

/*
 * One output pack of a repack or collection, written across alarm slices
 *: the sources are compacted (each source's entries copied in
 * order, deltas kept, no delta search), optionally keeping only some
 * entries per source. Each slice ends at a checkpoint: the pack writer's
 * state and the bytes not yet in a whole part go to one scratch object
 * (numbered, so a reset that loses the job's cursor finds the previous one
 * intact), the multipart state goes to the job's cursor. The last slice
 * completes the upload and stores the `.idx`; the pack is then `indexing`,
 * waiting for its swap.
 *
 * The pack is leased (kind `maintenance`) while it is written, so the
 * reapers leave it alone until its run is over or has been dead a while.
 */

export interface RewriteSpec {
  readonly kind: PackKind;
  /** Source packs, in output order (oldest first keeps history order). */
  readonly sources: readonly PackId[];
  /** Per source, the `.idx` positions to keep; absent: every entry. */
  readonly keep?: readonly (BitSet | undefined)[];
}

/** Where an unfinished output stands (kept in the job's cursor). */
export interface RewriteState {
  readonly packId: PackId;
  readonly upload: PackUploadState;
  /** The scratch checkpoint the next slice continues from. */
  readonly seq: number;
  readonly leaseId: string | null;
}

export type RewriteOutcome =
  | { readonly done: false; readonly state: RewriteState }
  | {
      readonly done: true;
      readonly packId: PackId;
      readonly objectCount: number;
      readonly bytes: number;
    };

export interface RewriteContext {
  readonly git: RepoGitStorage;
  readonly policy: MaintenancePolicy;
  /** The run's id: its scratch objects are under it. */
  readonly runId: string;
  /** Holder of the output's lease (the job's id). */
  readonly holder: string;
  readonly counter: CallCounter;
  readonly blocks?: BlockCache;
  /** When the slice must save its place. */
  readonly deadline: number;
}

/** Entries copied between budget checks. */
const STEP_ENTRIES = 256;

const checkpointName = (packId: PackId, seq: number) => `rw-${packId.toLowerCase()}-${seq}`;

/** Runs one slice of an output; resumes from `state` when given. */
export async function rewriteSlice(
  context: RewriteContext,
  spec: RewriteSpec,
  state: RewriteState | undefined,
): Promise<RewriteOutcome> {
  const { git, policy, counter } = context;
  if (state !== undefined) {
    // The last slice finished the pack but its cursor was not saved (the
    // object was evicted right after): the pack is done.
    const finished = finishedOutput(git, state.packId);
    if (finished) return finished;
  }
  const loaded = await LoadedPacks.load(git, spec.sources, counter);
  const partReservation = await git.memory.reserve(policy.partBytes);
  const sources: CompactionSource[] = loaded.packs.map((p, i) => {
    const keep = spec.keep?.[i];
    return { packId: p.packId, packLength: p.bytes, idx: p.idx, ...(keep ? { keep } : {}) };
  });
  const zlib = createWorkersZlib();
  let reader: Promise<ObjectReader> | undefined;
  const options = (sink: ResumablePackUpload): CompactionOptions => ({
    read: countingStore(git, counter).openRange,
    sink,
    zlib,
    memory: git.memory,
    // Whole objects for deltas whose base is not written, read from the sources.
    resolveObject: async (oid) => {
      reader ??= openReader(git, loaded.packs, counter, context.blocks);
      const found = await (await reader).readObject(oid);
      return found && { type: found.type, data: found.bytes };
    },
  });
  let compaction: Compaction | undefined;
  try {
    let upload: ResumablePackUpload;
    let seq: number;
    if (state === undefined) {
      upload = ResumablePackUpload.begin(git, spec.kind, { partBytes: policy.partBytes });
      seq = 0;
      compaction = await Compaction.start(sources, options(upload));
    } else {
      const saved = await getScratch(
        git,
        context.runId,
        checkpointName(state.packId, state.seq),
        counter,
      );
      const { tail, checkpoint } = splitCheckpoint(saved);
      upload = ResumablePackUpload.resume(git, state.upload, tail);
      seq = state.seq;
      compaction = await Compaction.resume(sources, checkpoint, options(upload));
      // The cursor has moved past the previous checkpoint: it is not needed again.
      if (seq > 1) await deleteScratch(git, context.runId, [checkpointName(state.packId, seq - 1)]);
    }
    const leaseId = holdLease(context, upload.packId, state?.leaseId ?? null);
    const startBytes = upload.bytes;
    let done = false;
    let copied = 0;
    for (;;) {
      const step = Math.max(1, Math.min(STEP_ENTRIES, policy.sliceObjects - copied));
      done = await compaction.run(step);
      copied += step;
      if (done) break;
      if (
        copied >= policy.sliceObjects ||
        git.context.now() >= context.deadline ||
        upload.bytes - startBytes >= policy.sliceBytes ||
        counter.calls >= policy.sliceR2Calls
      )
        break;
    }
    if (!done) {
      const checkpoint = await compaction.checkpoint();
      compaction.release();
      compaction = undefined;
      const { state: uploadState, tail } = upload.save();
      await putScratch(
        git,
        context.runId,
        checkpointName(upload.packId, seq + 1),
        joinCheckpoint(tail, checkpoint),
        counter,
      );
      return {
        done: false,
        state: { packId: upload.packId, upload: uploadState, seq: seq + 1, leaseId },
      };
    }
    const finished = await compaction.finish();
    compaction = undefined;
    try {
      const info = await upload.finish();
      if (info.bytes !== finished.packLength)
        throw new Error(
          `pack ${upload.packId}: wrote ${info.bytes} of ${finished.packLength} bytes`,
        );
      counter.calls++;
      git.context.metrics.count("r2.class_a", { bucket: BUCKET, op: "put_idx" });
      await git.bucket.put(
        packObjectKey(git.networkId(), upload.packId, "idx"),
        finished.idx.bytes,
      );
      git.registry.transition(upload.packId, ["indexing"], "indexing", {
        objectCount: finished.objectCount,
        trailerSha: new Uint8Array(finished.checksum).buffer,
      });
      if (seq > 0) await deleteScratch(git, context.runId, [checkpointName(upload.packId, seq)]);
      return {
        done: true,
        packId: upload.packId,
        objectCount: finished.objectCount,
        bytes: info.bytes,
      };
    } finally {
      finished.release();
    }
  } finally {
    compaction?.release();
    partReservation.release();
    if (reader) void reader.then((r) => r.release()).catch(() => {});
    loaded.release();
  }
}

function finishedOutput(git: RepoGitStorage, packId: PackId): RewriteOutcome | undefined {
  const row = git.context.storage.sql
    .exec<{ state: string; object_count: number | null; bytes: number | null }>(
      "SELECT state, object_count, bytes FROM packs WHERE pack_id = ?",
      packId,
    )
    .toArray()[0];
  if (row?.state !== "indexing" || row.object_count === null || row.bytes === null)
    return undefined;
  return { done: true, packId, objectCount: row.object_count, bytes: row.bytes };
}

/** Keeps the output leased while it is written: renews the slice's lease, or takes a new one. */
function holdLease(context: RewriteContext, packId: PackId, leaseId: string | null): string | null {
  const { git, policy } = context;
  if (leaseId !== null && git.leases.renew(leaseId, policy.outputLeaseMs) !== undefined)
    return leaseId;
  const grant = git.leases.grant("maintenance", [packId], context.holder, policy.outputLeaseMs);
  return grant.ok ? grant.leaseId : null;
}

/** Releases an output's lease once its run no longer needs it. */
export function releaseOutputLease(
  git: RepoGitStorage,
  state: { leaseId: string | null } | undefined,
): void {
  if (state?.leaseId) git.leases.release(state.leaseId);
}

function joinCheckpoint(tail: Uint8Array, checkpoint: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + tail.length + checkpoint.length);
  new DataView(out.buffer).setUint32(0, tail.length);
  out.set(tail, 4);
  out.set(checkpoint, 4 + tail.length);
  return out;
}

function splitCheckpoint(bytes: Uint8Array): { tail: Uint8Array; checkpoint: Uint8Array } {
  if (bytes.length < 4) throw new Error("maintenance checkpoint is truncated");
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  if (4 + length > bytes.length) throw new Error("maintenance checkpoint is truncated");
  return { tail: bytes.subarray(4, 4 + length), checkpoint: bytes.subarray(4 + length) };
}
