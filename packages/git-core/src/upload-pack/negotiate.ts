import { WalkLimitError } from "../graph/errors.js";
import { canAllFromReach } from "../graph/reachability.js";
import type { Oid } from "../object/oid.js";
import type { CommitGraph } from "../ports/commit-graph.js";

/*
 * Negotiation is stateless: each round arrives as a separate request that
 * repeats the haves the server already acknowledged (git's fetch-pack
 * resends its common commits in every protocol v2 request), so every round
 * is answered from the request alone.
 */

/**
 * The haves this repository has as verified commits, in request order.
 * git acknowledges any object it holds; here only commits in this
 * repository's own commit graph count, so a have can never reveal whether
 * an object exists in a pack shared with another repository, and commits
 * of an upload that has not committed are never acknowledged.
 */
export async function commonCommits(graph: CommitGraph, haves: readonly Oid[]): Promise<Oid[]> {
  if (haves.length === 0) return [];
  const rows = await graph.read(haves, "verified");
  return haves.filter((_, i) => rows[i] !== undefined);
}

/**
 * Whether a pack can be computed now: some have is common and every
 * wanted commit reaches a common commit (git's `ok_to_give_up`, which
 * calls `can_all_from_reach_with_flag`). Wanted objects that are not
 * commits do not hold it back, as in git. A walk over its budget answers
 * "not yet": the client then sends more haves or `done`.
 */
export async function readyToSend(
  graph: CommitGraph,
  wantCommits: readonly Oid[],
  common: readonly Oid[],
  maxCommits: number,
): Promise<boolean> {
  if (common.length === 0) return false;
  if (wantCommits.length === 0) return true;
  try {
    return await canAllFromReach(graph, "verified", wantCommits, common, { maxCommits });
  } catch (error) {
    if (error instanceof WalkLimitError) return false;
    throw error;
  }
}
