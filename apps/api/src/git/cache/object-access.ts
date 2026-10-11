/*
 * The object check, as it crosses from the Worker to the repository
 * object (design: object authorization). An object is readable through
 * repository R only by way of a commit in R's own verified commit graph:
 *
 * - a commit, when it is in R's verified commits;
 * - a tree or blob, only through a commit context (commit, path) whose
 *   commit passes, so a raw SHA-addressed read needs a commit context too
 *   (`expect` pins the object the caller had in mind);
 * - a diff, when both its base and its head pass.
 *
 * Object ids travel as lowercase hex. A denial never says why: an object
 * the repository lacks and one it may not show look the same.
 */

export type ObjectAccessRequest =
  | { readonly kind: "commit"; readonly commit: string }
  | {
      readonly kind: "path";
      readonly commit: string;
      /** `a/b/c.txt`; empty for the commit's root tree. */
      readonly path: string;
      /** When set, the object at the path must be this one. */
      readonly expect?: string;
    }
  | { readonly kind: "diff"; readonly base: string; readonly head: string };

export type ObjectAccessAnswer =
  | { readonly ok: true; readonly kind: "commit" | "tree" | "blob"; readonly oid: string }
  | { readonly ok: true; readonly kind: "diff"; readonly base: string; readonly head: string }
  | { readonly ok: false };

/** Answers the object check from one repository's own verified commits. */
export interface ObjectAuthority {
  objectAccess(request: ObjectAccessRequest): Promise<ObjectAccessAnswer>;
}

export const HEX_OID = /^[0-9a-f]{40}$/;

/**
 * Longest path checked, in UTF-8 bytes. Proposed (git itself has no limit;
 * PATH_MAX is 4096 on Linux); bounds the tree walk.
 */
export const MAX_PATH_BYTES = 4096;

export const DENIED: ObjectAccessAnswer = Object.freeze({ ok: false });
