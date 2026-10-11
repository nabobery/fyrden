import type { FetchArgs } from "@fyrden/git-core";
import type { PackBlockStats } from "../cache/pack-blocks.js";

/**
 * The deployment's Workers plan, which decides how pack bytes reach the
 * client. `paid`: the Worker frames side-band while streaming stored
 * bytes. `free`: the repository object writes a side-band framed copy
 * once and the Worker only pipes it natively, because per-chunk
 * JavaScript in a Free Worker does not fit its CPU budget.
 */
export type WorkersPlan = "free" | "paid";

/** What the Worker asks the repository object to plan. */
export interface FetchPlanRequest {
  /** The repository's immutable id (cache keys of materialised packs include it). */
  readonly repoId: string;
  readonly args: FetchArgs;
  readonly plan: WorkersPlan;
  /** Recorded on the leases this request takes (the request id). */
  readonly holder: string;
}

/** Stored bytes the Worker reads with one ranged GET. */
export interface StoredRange {
  /** The R2 key, from the repository's pack registry. */
  readonly key: string;
  readonly offset: number;
  readonly length: number;
}

/** One piece of the response, in order. */
export type WirePart =
  /** pkt-lines sent as they are. */
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  /**
   * Stored bytes sent on side-band 1: already framed (`framed: true`, piped
   * through natively), or raw pack bytes the Worker frames.
   */
  | ({ readonly kind: "stored"; readonly framed: boolean } & StoredRange)
  /**
   * Several stored packs joined into one pack (new header, each pack's
   * entries, a new trailer hashed over the stream), framed by the Worker.
   */
  | {
      readonly kind: "stitched";
      readonly header: Uint8Array;
      readonly segments: readonly (StoredRange & { readonly packId: string })[];
      /** Pack bytes, header and trailer included. */
      readonly length: number;
      readonly objectCount: number;
    };

/** Calls the repository object made while planning, for the subrequest budgets. */
export interface FetchPlanCalls {
  /** R2 binding calls (internal-services budget). */
  readonly r2: number;
  /** Cache API calls (the 50-per-request budget on Free). */
  readonly cacheApi: number;
}

/** How the request is counted in metrics. */
export type FetchRequestKind = "clone" | "fetch" | "negotiate" | "refused";

export type FetchPlanReply =
  | {
      readonly ok: true;
      readonly parts: readonly WirePart[];
      readonly kind: Exclude<FetchRequestKind, "refused">;
      readonly pack: "as-is" | "stitched" | "regenerated" | "none";
      readonly cached: boolean;
      /** The read lease on every stored object the parts name; release it when done. */
      readonly lease?: { readonly leaseId: string; readonly expiresAt: number };
      readonly calls: FetchPlanCalls;
      /** Where the plan's pack block reads were answered. */
      readonly blocks: PackBlockStats;
    }
  | {
      readonly ok: false;
      /** Sent to the client as an `ERR` packet. */
      readonly message: string;
      readonly calls: FetchPlanCalls;
      /** Present when planning started reading packs. */
      readonly blocks?: PackBlockStats;
    };
