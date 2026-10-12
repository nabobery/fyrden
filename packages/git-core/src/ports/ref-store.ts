import type { Oid } from "../object/oid.js";
import type { PackId } from "./pack-store.js";

/** One compare-and-set on a ref. `null` means "does not exist". */
export interface RefUpdate {
  /** The full name, e.g. `refs/heads/main`; must pass `isValidRefname`. */
  readonly name: string;
  readonly oldOid: Oid | null;
  readonly newOid: Oid | null;
}

export interface RefCommitRequest {
  readonly addPacks: readonly PackId[];
  readonly removePacks: readonly PackId[];
  readonly refUpdates: readonly RefUpdate[];
  /** The version the caller read; the commit fails if it has moved. */
  readonly expectedVersion: number;
}

export type RefCommitResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: "version-conflict"; readonly version: number }
  | { readonly ok: false; readonly reason: "ref-conflict"; readonly ref: string }
  | { readonly ok: false; readonly reason: "unknown-pack"; readonly packId: PackId }
  /**
   * Creating `ref` would leave a ref and another ref below it (`refs/heads/a`
   * and `refs/heads/a/b`); `conflictsWith` is the other one, existing or
   * created by the same request.
   */
  | {
      readonly ok: false;
      readonly reason: "refname-conflict";
      readonly ref: string;
      readonly conflictsWith: string;
    };

export interface RefSnapshot {
  /** Increments by one on every successful commit. */
  readonly version: number;
  readonly refs: ReadonlyMap<string, Oid>;
  /** The ref HEAD points to, or null when HEAD is unset. */
  readonly head: string | null;
}

export interface ReflogEntry {
  /** The version the change was committed at. */
  readonly version: number;
  readonly oldOid: Oid | null;
  readonly newOid: Oid | null;
  /** Milliseconds since the epoch. */
  readonly at: number;
}

/**
 * Refs, the pack registry and the reflog. `commit` is the single atomic
 * commit point: it checks `expectedVersion` and every ref's old value, then
 * applies all ref updates, pack additions and removals, and reflog entries
 * together, or none of them.
 */
export interface RefStore {
  readRefs(): Promise<RefSnapshot>;
  /**
   * Up to `limit` entries for one ref, newest first. Rejects with RangeError
   * unless `limit` is a whole number, 0 or more.
   */
  readReflog(name: string, limit: number): Promise<readonly ReflogEntry[]>;
  /**
   * Rejects with RangeError for a malformed request (an invalid ref name, or
   * one ref or pack named twice). Returns a failure result for a conflict:
   * the version moved, a ref's old value differs, a created ref collides
   * with a ref above or below it (deletions in the request free their
   * names), or a pack cannot be added (not finished, or already live) or
   * removed (not live).
   */
  commit(request: RefCommitRequest): Promise<RefCommitResult>;
}
