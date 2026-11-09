// Cleanup of blame runs, one job per repository (blame_prune), run by the
// alarm. Each slice removes expired runs, then lists a page of the
// repository's checkpoint prefix and deletes objects no run names once
// they're past the grace time. A writer puts its checkpoint and moves its row
// within one request, far under the grace time, so a young object is never
// one a live slice is about to publish. The job runs until a whole pass finds
// no runs and no objects, and never ends while a slice is writing: an object
// orphaned by an eviction during any slice is found by a later pass.
import {
  blameCheckpointPrefix,
  type JobHandler,
  parseBlameCheckpointKey,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import { BlameRuns } from "./blame-runs.js";

const HOUR = 60 * 60 * 1000;
/** An unreferenced checkpoint younger than this, by its key's ULID, is left for a later pass. */
export const PRUNE_GRACE_MS = HOUR;
const EXPIRED_PER_SLICE = 64;
const LISTED_PER_SLICE = 100;
/** How soon to look again while a slice is writing. */
const WRITING_RECHECK_MS = 60_000;
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = HOUR;

/**
 * Where a pass is: R2's listing cursor, whether the pass removed objects or
 * left young ones, and the backoff after R2 failed.
 */
interface Pass {
  readonly c: string | null;
  readonly removed: boolean;
  readonly young: boolean;
  readonly backoff: number;
}

const START: Pass = { c: null, removed: false, young: false, backoff: 0 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodePass(cursor: Uint8Array | null): Pass {
  if (!cursor) return START;
  try {
    const value = JSON.parse(decoder.decode(cursor)) as Partial<Pass>;
    return {
      c: typeof value.c === "string" ? value.c : null,
      removed: value.removed === true,
      young: value.young === true,
      backoff: typeof value.backoff === "number" && value.backoff > 0 ? value.backoff : 0,
    };
  } catch {
    return START;
  }
}

const encodePass = (pass: Pass) => encoder.encode(JSON.stringify(pass));

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The time, in milliseconds, a ULID's first ten characters hold. */
export function ulidTime(ulid: string): number {
  let time = 0;
  for (let k = 0; k < 10; k++) time = time * 32 + CROCKFORD.indexOf(ulid[k] as string);
  return time;
}

export function blamePruneHandler(deps: {
  readonly git: RepoGitStorage;
  /** Runs with a slice in progress: their rows stay, and the job doesn't end. */
  readonly active: () => ReadonlySet<string>;
  readonly repoId: () => string;
}): JobHandler {
  return {
    async runSlice(job) {
      const { git } = deps;
      const now = git.context.now();
      const runs = new BlameRuns(git.context.storage);
      const active = deps.active();
      const pass = decodePass(job.cursor);
      for (const row of runs.expired(now, EXPIRED_PER_SLICE))
        if (!active.has(row.runId)) runs.remove(row.runId);

      const repoId = deps.repoId();
      let truncated: boolean;
      let next: string | null;
      let removed = pass.removed;
      let young = pass.young;
      try {
        const page = await git.bucket.list({
          prefix: blameCheckpointPrefix(repoId),
          limit: LISTED_PER_SLICE,
          ...(pass.c && { cursor: pass.c }),
        });
        const named = new Set(runs.checkpointKeys());
        const doomed: string[] = [];
        for (const object of page.objects) {
          const parsed = parseBlameCheckpointKey(repoId, object.key);
          // Not a checkpoint key: not this job's to remove.
          if (!parsed || named.has(object.key)) continue;
          if (now - ulidTime(parsed.ulid) < PRUNE_GRACE_MS) {
            young = true;
            continue;
          }
          doomed.push(object.key);
        }
        if (doomed.length > 0) {
          await git.bucket.delete(doomed);
          removed = true;
        }
        truncated = page.truncated;
        next = page.truncated ? page.cursor : null;
      } catch (error) {
        // A job fails for good after ten throws, so R2 failures back off instead.
        const backoff = Math.min(
          MAX_BACKOFF_MS,
          pass.backoff > 0 ? pass.backoff * 2 : FIRST_BACKOFF_MS,
        );
        git.context.metrics.count("blame.run", { event: "prune_failed" });
        console.error(
          JSON.stringify({
            message: "blame cleanup: R2 failed",
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return { done: false, cursor: encodePass({ ...pass, backoff }), runAfterMs: backoff };
      }

      if (truncated)
        return {
          done: false,
          cursor: encodePass({ c: next, removed, young, backoff: 0 }),
          runAfterMs: 0,
        };

      // A whole pass is done.
      const waiting = runs.nextExpiry(active);
      // A checkpoint a run names goes with its run, so only runs, removals, young objects
      // and writers keep the job going.
      if (waiting === undefined && !removed && !young && active.size === 0) return { done: true };
      const delays: number[] = [];
      if (waiting !== undefined) delays.push(Math.max(0, waiting - now));
      if (young) delays.push(PRUNE_GRACE_MS);
      if (active.size > 0) delays.push(WRITING_RECHECK_MS);
      // It removed objects: one more pass confirms none are left.
      if (removed && !young) delays.push(0);
      return { done: false, cursor: null, runAfterMs: Math.min(...delays) };
    },
  };
}
