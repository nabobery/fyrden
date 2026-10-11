/*
 * What the network object and the repository objects of a fork network
 * exchange over RPC. Plain data only (structured clone).
 */

/** A pack in a repository's view, as a fork borrows it. */
export interface ViewPack {
  readonly packId: string;
  readonly networkId: string;
  readonly r2Key: string;
  readonly kind: string;
  readonly origin: "own" | "borrowed";
  readonly bytes: number;
  readonly objectCount: number | null;
  readonly unitId: string | null;
  readonly createdAt: number;
}

/** A ref a fork starts with. */
export interface ExportedRef {
  readonly name: string;
  readonly oid: Uint8Array;
}

/**
 * What a parent hands a new fork: its branches and tags, where HEAD points,
 * the commits those refs reach first (annotated tags peeled), and its live
 * packs, read-leased for the fork until the network has recorded its claims.
 */
export interface ForkExport {
  readonly refs: readonly ExportedRef[];
  readonly head: string | null;
  readonly version: number;
  readonly tips: readonly Uint8Array[];
  readonly packs: readonly ViewPack[];
  readonly leaseId: string | null;
}

/** One verified commit-graph row, as the graph copy moves it. */
export interface CommitRowData {
  readonly oid: Uint8Array;
  readonly tree: Uint8Array;
  readonly parents: Uint8Array;
  readonly commitTime: number;
  readonly generation: number;
  readonly level: number;
  readonly signature: string | null;
}

/** A page of a parent's commit-graph closure and where the next page starts. */
export interface CommitPage {
  readonly rows: readonly CommitRowData[];
  /** Commits still to visit (hex). Empty when the closure is done. */
  readonly frontier: readonly string[];
}

/** A registry row of a member, as the network collection snapshots it. */
export interface MemberPack {
  readonly packId: string;
  readonly networkId: string;
  readonly state: string;
  readonly origin: string;
}

/** A member's answer to "condemn these shared packs". */
export type CondemnAnswer =
  | { readonly ok: true; readonly leasesUntil: number }
  /** The pack is still in the member's live view: the network's claims were out of date. */
  | { readonly ok: false; readonly inView: readonly string[] };

export type NetworkFailure = {
  readonly ok: false;
  readonly code:
    | "network_busy"
    | "not_member"
    | "parent_detaching"
    | "export_failed"
    | "not_found"
    | "bad_state";
  readonly error: string;
};
