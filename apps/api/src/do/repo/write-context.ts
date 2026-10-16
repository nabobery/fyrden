import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { RepoAcl } from "./acl.js";
import type { RepoAuthority } from "./authority.js";
import type { FileWriteDeps } from "./file-writes.js";
import type { RepoPulls } from "./pulls.js";

/** Why the repository takes no write now (see `RepoDO`'s refusal). */
export interface WriteRefusal {
  readonly status: 404 | 409;
  readonly code: string;
  readonly error: string;
}

/**
 * What the repository object hands each workflow that changes pull
 * requests or writes their branches: its storage and bindings, who may
 * write, and the object's own steps around a change.
 */
export interface WriteContext {
  readonly git: RepoGitStorage;
  /** The Worker's bindings, read at each use (tests may replace them). */
  readonly env: () => Env;
  readonly acl: RepoAcl;
  readonly pulls: RepoPulls;
  readonly authority: RepoAuthority;
  readonly repoId: () => string;
  /** Takes the directory's epoch (a commit needs it first). */
  readonly checkEpoch: () => Promise<void>;
  /** Why the repository takes no change now: deleted or going, being transferred or generated. */
  readonly writeRefusal: () => WriteRefusal | undefined;
  /** The write deps of the current invocation (its signer is the key in use now). */
  readonly writeDeps: () => Promise<FileWriteDeps>;
  /** After a change: what the object does after any it makes (outbox, audit). */
  readonly committed: () => void;
}
