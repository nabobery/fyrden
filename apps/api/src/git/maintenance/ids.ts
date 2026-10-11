import { newPackId, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";

/** A new maintenance run id: a ULID (as pack ids are), so it can key the run's scratch prefix. */
export function newRunId(git: RepoGitStorage): string {
  return String(newPackId(git.context.now()));
}
