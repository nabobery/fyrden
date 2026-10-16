/**
 * Chunked upload and import limits. Each can be overridden with an
 * optional Worker variable of the same name; the defaults apply when it is
 * absent or not a whole number in range.
 */
export interface ChunkedTuning {
  /**
   * Length of every part but the last. Proposed 16 MiB: R2 multipart needs
   * every part but the last to be at least 5 MiB and all the same length,
   * at most 10,000 parts (measured on Workers Free, 2026-10-10), and each
   * part is one request body, under the plan's 100 MiB body limit.
   */
  readonly partBytes: number;
  /** Largest pack a session or an import takes. Proposed 8 GiB. */
  readonly maxUploadBytes: number;
  /**
   * How long one `complete` call waits for indexing before it answers
   * `indexing` (the client calls again). Proposed 20 s.
   */
  readonly completeWaitMs: number;
  /** Largest pack an import fetches. Proposed 4 GiB. */
  readonly maxImportBytes: number;
  /**
   * Longest an import's fetch may take. Proposed 10 min: it runs in one
   * alarm invocation, whose wall-clock limit is about 15 min (unverified).
   */
  readonly maxImportMs: number;
  /*
   * The next three keep a slow or stalled source from holding the
   * repository object (billed for its wall-clock time while it waits) for
   * the whole `maxImportMs`.
   */
  /**
   * Longest an import's source may take to list its branches and tags,
   * connecting included. Proposed 30 s: a healthy server answers in a few
   * seconds, even with the 10,000 refs an import takes at most.
   */
  readonly importDiscoveryMs: number;
  /**
   * Longest an import's source may send nothing while the pack streams.
   * Proposed 60 s: git's upload-pack sends a keepalive every 5 s by default
   * while it prepares the pack (`uploadpack.keepAlive`, git-config(1)).
   */
  readonly importIdleMs: number;
  /**
   * Least an import's pack must bring per second, over every minute after
   * its first two; 0 for no floor. Proposed 16 KiB/s: a 4 GiB import needs
   * about 7 MiB/s to finish within its 10 minutes, so the floor stops only a
   * source hundreds of times slower than that.
   */
  readonly minImportBytesPerSecond: number;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** R2's smallest part but the last (verified: developers.cloudflare.com/r2/objects/upload-objects/). */
export const MIN_PART_BYTES = 5 * MiB;
/** R2's most parts per multipart upload (same source). */
export const MAX_PARTS = 10_000;

export const CHUNKED_TUNING_DEFAULTS: ChunkedTuning = Object.freeze({
  partBytes: 16 * MiB,
  maxUploadBytes: 8 * GiB,
  completeWaitMs: 20_000,
  maxImportBytes: 4 * GiB,
  maxImportMs: 10 * 60 * 1000,
  importDiscoveryMs: 30_000,
  importIdleMs: 60_000,
  minImportBytesPerSecond: 16 * 1024,
});

const VARIABLES: Record<keyof ChunkedTuning, { name: string; min: number }> = {
  partBytes: { name: "GIT_UPLOAD_PART_BYTES", min: MIN_PART_BYTES },
  maxUploadBytes: { name: "GIT_UPLOAD_MAX_BYTES", min: 32 },
  completeWaitMs: { name: "GIT_UPLOAD_COMPLETE_WAIT_MS", min: 0 },
  maxImportBytes: { name: "GIT_IMPORT_MAX_BYTES", min: 32 },
  maxImportMs: { name: "GIT_IMPORT_MAX_MS", min: 1_000 },
  importDiscoveryMs: { name: "GIT_IMPORT_DISCOVERY_MS", min: 1_000 },
  importIdleMs: { name: "GIT_IMPORT_IDLE_MS", min: 1_000 },
  minImportBytesPerSecond: { name: "GIT_IMPORT_MIN_BYTES_PER_SECOND", min: 0 },
};

/** The tuning for this Worker: defaults, overridden by any variables set. */
export function chunkedTuning(env: object): ChunkedTuning {
  const vars = env as Partial<Record<string, unknown>>;
  const out: Record<string, number> = { ...CHUNKED_TUNING_DEFAULTS };
  for (const [key, { name, min }] of Object.entries(VARIABLES)) {
    const raw = vars[name];
    const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(value) && value >= min) out[key] = value;
  }
  return out as unknown as ChunkedTuning;
}
