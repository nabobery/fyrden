import type { Oid } from "../object/oid.js";
import type { CommitGraph, CommitInfo } from "../ports/commit-graph.js";
import { computeGenerations } from "./generation.js";
import { OidTable } from "./oid-table.js";

/**
 * Inserts new commits from an upload as pending rows, with both generation
 * numbers computed. Commits already visible to the upload (verified, or its
 * own pending rows) are skipped. Every parent must be in `commits` or
 * visible to the upload; otherwise nothing is inserted and the call throws
 * `MissingCommitError` naming those parents. Returns the number of rows
 * inserted.
 *
 * The batch is held in memory while generations are computed, so very large
 * imports call this in parent-first batches.
 */
export async function addPendingCommits(
  graph: CommitGraph,
  uploadId: string,
  commits: readonly CommitInfo[],
): Promise<number> {
  const view = { uploadId };
  const batch = new OidTable(commits.length);
  for (const commit of commits) batch.add(commit.oid);
  const existing = await graph.read([...batch], view);
  const fresh = commits.filter((commit) => !existing[batch.indexOf(commit.oid)]);
  if (fresh.length === 0) return 0;

  const freshOids = new OidTable(fresh.length);
  for (const commit of fresh) freshOids.add(commit.oid);
  const external = new OidTable();
  for (const commit of fresh) {
    for (const parent of commit.parents) if (!freshOids.has(parent)) external.add(parent);
  }
  const parentRows = await graph.read([...external], view);
  const level = new Float64Array(external.size);
  const generation = new Float64Array(external.size);
  const found = new Uint8Array(external.size);
  parentRows.forEach((row, i) => {
    if (!row) return;
    level[i] = row.level;
    generation[i] = row.generation;
    found[i] = 1;
  });

  const rows = computeGenerations(fresh, (oid: Oid) => {
    const i = external.indexOf(oid);
    return i >= 0 && found[i] === 1
      ? { level: level[i] as number, generation: generation[i] as number }
      : undefined;
  });
  await graph.insertPending(uploadId, rows);
  return rows.length;
}
