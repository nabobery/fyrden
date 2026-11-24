import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { type Oid, oidFromBytes } from "@fyrden/git-core";

/**
 * The ids (old and new, each once) that reflog entries within the retention
 * name: what they reach is kept as what the refs reach is. An id may be of
 * an object lost before: the caller decides what that means.
 */
export function reflogRoots(git: RepoGitStorage, retentionMs: number): Oid[] {
  const since = git.context.now() - retentionMs;
  return git.context.storage.sql
    .exec<{ oid: ArrayBuffer }>(
      `SELECT old_oid AS oid FROM reflog WHERE at >= ? AND old_oid IS NOT NULL
       UNION SELECT new_oid FROM reflog WHERE at >= ? AND new_oid IS NOT NULL`,
      since,
      since,
    )
    .toArray()
    .map((row) => oidFromBytes(new Uint8Array(row.oid)));
}
