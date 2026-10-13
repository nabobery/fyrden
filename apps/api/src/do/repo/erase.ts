import {
  isUlid,
  packR2Keys,
  type RepoGitStorage,
  scratchPrefix,
} from "@fyrden/adapters-cloudflare/git";
import { decodeJson } from "../../git/maintenance/storage.js";

/**
 * R2 calls one erase call makes at most, well within an invocation's 1,000
 * internal calls; the deletion job calls again for the rest. Proposed.
 */
export const ERASE_R2_CALLS = 200;

/**
 * How long a push may still be storing its body after it was admitted: an
 * upload still open that recently is waited for, since the Worker writes
 * its body to R2 outside this object. Later, the Worker deletes a body
 * whose repository was erased meanwhile. Proposed.
 */
export const OPEN_UPLOAD_WAIT_MS = 15 * 60 * 1000;

/** Keys one R2 delete takes at most. */
const DELETE_BATCH = 1_000;

/**
 * `partial`: the budget ran out, call again. `busy`: a read lease is held
 * (a clone or a fork reading the packs), or a push may still be storing
 * its body; try again later.
 */
export type EraseOutcome = "erased" | "partial" | "busy";

/** Records that the repository is (or was) in `networkId`. */
export function recordNetwork(
  storage: Pick<DurableObjectStorage, "sql">,
  networkId: string,
  at: number,
): void {
  storage.sql.exec(
    "INSERT INTO networks (network_id, recorded_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
    networkId,
    at,
  );
}

type PackRow = {
  pack_id: string;
  network_id: string;
  r2_key: string;
  kind: string;
  origin: string;
};

/**
 * Erases what a deleted (frozen) repository stored outside its object, so
 * its storage can then be deleted. The caller makes sure nothing else runs
 * in the object and no job or upload can start, so only read leases (held
 * by clones and forks elsewhere) are waited for; the leases of its own
 * uploads and jobs belong to work that has stopped. Every step is safe to
 * redo, and each call finishes at least one item, so retries progress:
 *
 * 1. Scratch objects of its uploads and maintenance runs, under every
 *    network it has packs in (a detach moves new writes to a new network),
 *    and the multipart uploads of uploads that did not commit.
 * 2. Pack bytes: only those of packs it wrote (`own`) that its fork network
 *    does not share. Borrowed packs and shared ones are the network's,
 *    deleted by the network once nobody claims them; a pack the network
 *    does not know but the repository borrowed is never deleted here (the
 *    network's collection repairs such records). Candidates are condemned,
 *    under a check that no lease is held, before any byte goes, so no new
 *    lease can be granted on them; a row is marked deleted after its bytes.
 * 3. Its membership of every such network, which releases its claims (its
 *    forks keep theirs). Pack rows stay until the storage goes, so a retry
 *    still knows every network. Then its account's collaborators and team
 *    grants of it.
 */
export async function eraseRepository(
  git: RepoGitStorage,
  env: Env,
  repoId: string,
  /** The account whose access records name the repository; none for an object without identity. */
  accountId: string | undefined,
): Promise<EraseOutcome> {
  const { storage, now, metrics } = git.context;
  const sql = storage.sql;
  const leased = () =>
    sql
      .exec<{ held: number }>(
        "SELECT EXISTS (SELECT 1 FROM leases WHERE kind = 'read' AND expires_at > ?) AS held",
        now(),
      )
      .one().held === 1;
  if (leased()) return "busy";
  const storing = sql
    .exec<{ open: number }>(
      "SELECT EXISTS (SELECT 1 FROM uploads WHERE state = 'open' AND created_at > ?) AS open",
      now() - OPEN_UPLOAD_WAIT_MS,
    )
    .one().open;
  if (storing) return "busy";

  let calls = 0;
  const spent = () => calls >= ERASE_R2_CALLS;
  const r2 = (op: string, kind: "class_a" | "class_b") => {
    calls++;
    metrics.count(`r2.${kind}`, { bucket: "fyrden-git", op });
  };
  const networks = [
    ...new Set([
      git.networkId(),
      ...sql
        .exec<{ network_id: string }>(
          "SELECT network_id FROM networks UNION SELECT DISTINCT network_id FROM packs",
        )
        .toArray()
        .map((r) => r.network_id),
    ]),
  ];

  // 1. Scratch and multipart uploads. A run's or upload's row goes once
  // its objects are gone in every network.
  const uploads = sql
    .exec<{ upload_id: string; r2_key: string | null; multipart_id: string | null; state: string }>(
      // A committed upload's scratch is deleted with its commit, but only as
      // far as that went: every upload is swept.
      "SELECT upload_id, r2_key, multipart_id, state FROM uploads ORDER BY upload_id",
    )
    .toArray();
  for (const upload of uploads) {
    if (spent()) return "partial";
    if (upload.multipart_id && upload.r2_key && upload.state !== "committed") {
      r2("abort_multipart", "class_a");
      try {
        await git.bucket.resumeMultipartUpload(upload.r2_key, upload.multipart_id).abort();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/does not exist|\(10024\)/.test(message)) throw error;
      }
    }
    if (isUlid(upload.upload_id)) await deletePrefixes(networks, upload.upload_id);
    sql.exec("DELETE FROM uploads WHERE upload_id = ?", upload.upload_id);
  }
  // Archives, built under their run's scratch prefix in the network they were built in.
  const archives = sql
    .exec<{ run_id: string; network_id: string }>("SELECT run_id, network_id FROM archives")
    .toArray();
  for (const archive of archives) {
    if (spent()) return "partial";
    if (isUlid(archive.run_id)) await deletePrefixes([archive.network_id], archive.run_id);
    sql.exec("DELETE FROM archive_zip_records WHERE run_id = ?", archive.run_id);
    sql.exec("DELETE FROM archive_segments WHERE run_id = ?", archive.run_id);
    sql.exec("DELETE FROM archives WHERE run_id = ?", archive.run_id);
  }
  const jobs = sql.exec<{ job_id: string; cursor: ArrayBuffer | null }>(
    "SELECT job_id, cursor FROM jobs WHERE cursor IS NOT NULL",
  );
  for (const job of jobs.toArray()) {
    if (spent()) return "partial";
    const runId = decodeJson<{ runId?: unknown }>(job.cursor && new Uint8Array(job.cursor))?.runId;
    if (typeof runId === "string" && isUlid(runId)) await deletePrefixes(networks, runId);
    sql.exec("DELETE FROM jobs WHERE job_id = ?", job.job_id);
  }

  // 2. Pack bytes.
  const packs = sql
    .exec<PackRow>(
      `SELECT pack_id, network_id, r2_key, kind, origin FROM packs
       WHERE state <> 'deleted' ORDER BY pack_id`,
    )
    .toArray();
  const shared = new Set<string>();
  for (const network of networks) {
    const ids = packs.filter((p) => p.network_id === network).map((p) => p.pack_id);
    if (ids.length === 0) continue;
    metrics.count("do.request", { class: "NetworkDO", method: "sharedPacks" });
    for (const id of await env.NETWORK.getByName(network).sharedPacks(ids)) shared.add(id);
  }
  const ours = packs.filter((p) => p.origin === "own" && !shared.has(p.pack_id));
  const notOurs = packs.filter((p) => !ours.includes(p));
  const condemned = storage.transactionSync(() => {
    // Checked again with the condemnation: a lease taken while we asked the network wins.
    if (leased()) return false;
    for (const pack of ours)
      sql.exec("UPDATE packs SET state = 'condemned' WHERE pack_id = ?", pack.pack_id);
    for (const pack of notOurs)
      sql.exec("UPDATE packs SET state = 'deleted' WHERE pack_id = ?", pack.pack_id);
    return true;
  });
  if (!condemned) return "busy";
  let batch: { ids: string[]; keys: string[] } = { ids: [], keys: [] };
  const flush = async () => {
    if (batch.keys.length > 0) {
      r2("delete_pack", "class_a");
      await git.bucket.delete(batch.keys);
    }
    for (const id of batch.ids)
      sql.exec("UPDATE packs SET state = 'deleted' WHERE pack_id = ?", id);
    batch = { ids: [], keys: [] };
  };
  for (const pack of ours) {
    // A row whose ids or key are not valid names no object of ours.
    const keys = packR2Keys(pack) ?? [];
    if (batch.keys.length + keys.length > DELETE_BATCH) {
      if (spent()) return "partial";
      await flush();
    }
    batch.ids.push(pack.pack_id);
    batch.keys.push(...keys);
  }
  if (spent()) return "partial";
  await flush();

  // 3. Membership, and the account's access records of it.
  for (const network of networks) {
    metrics.count("do.request", { class: "NetworkDO", method: "removeMember" });
    await env.NETWORK.getByName(network).removeMember({ networkId: network, repoId });
  }
  if (accountId) {
    metrics.count("do.request", { class: "OrgDO", method: "forgetRepo" });
    await env.ORG.getByName(accountId).forgetRepo(repoId);
  }
  return "erased";

  /** Deletes `net/<nid>/scratch/<id>/` in every network, whatever the budget left. */
  async function deletePrefixes(nets: readonly string[], id: string): Promise<void> {
    for (const network of nets) {
      const prefix = scratchPrefix(network, id);
      for (;;) {
        r2("list_scratch", "class_a");
        const page = await git.bucket.list({ prefix, limit: DELETE_BATCH });
        const keys = page.objects.map((o) => o.key);
        if (keys.length > 0) {
          r2("delete_scratch", "class_a");
          await git.bucket.delete(keys);
        }
        if (!page.truncated) break;
      }
    }
  }
}
