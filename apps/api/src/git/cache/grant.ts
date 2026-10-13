import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import {
  canAccess,
  GIT_PERMISSION,
  type RepoAccess,
  type RepoEntry,
} from "../../repos/directory.js";

/**
 * Proof that the repository-level access check allowed one caller to read
 * (or write) one repository, for the rest of one request. The only way to
 * get one is `RepoAccessGrant.check`, which runs the access check; the
 * constructor is private, and the private field makes the type nominal
 * (an object of the same shape is not a grant) and lets `isGrant` tell a
 * real grant from a forged one at run time.
 *
 * Every response cache and the object check take a grant, so no cache can
 * be consulted for a repository before the caller was authorized on it.
 * Keep a grant for one request only: access can be revoked.
 */
export class RepoAccessGrant {
  readonly #issued = true;

  private constructor(
    readonly repoId: string,
    readonly networkId: string,
    readonly visibility: RepoEntry["visibility"],
    readonly principalId: string,
    readonly access: RepoAccess,
  ) {
    Object.freeze(this);
  }

  /** The grant when `auth` may access `repo` that way; undefined otherwise. */
  static check(
    auth: TokenRecord,
    repo: RepoEntry,
    access: RepoAccess,
  ): RepoAccessGrant | undefined {
    if (!canAccess(auth, repo, GIT_PERMISSION[access])) return undefined;
    return new RepoAccessGrant(repo.id, repo.networkId, repo.visibility, auth.principalId, access);
  }

  /** Whether `value` was issued by `check` (not merely shaped like a grant). */
  static isGrant(value: unknown): value is RepoAccessGrant {
    return typeof value === "object" && value !== null && #issued in value;
  }
}

/** Throws TypeError unless `value` is a grant issued by the access check. */
export function assertGrant(value: unknown): asserts value is RepoAccessGrant {
  if (!RepoAccessGrant.isGrant(value)) throw new TypeError("not a repository access grant");
}
