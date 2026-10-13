import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  AUDIT_ARCHIVE_POLICY,
  type AuditArchivePolicy,
  type AuditRow,
  auditDigest,
  auditNdjson,
  auditObjectKey,
  segmentOf,
  UNCOVERED,
} from "../do/base/audit-archiver.js";

/**
 * Archives the directory's auth audit log (token mints and revokes, sign-ups,
 * repository creation) to R2 from a cron trigger, the way repository objects
 * archive theirs: a segment's rows are recorded before its object is
 * written, the object name is deterministic, and rows are deleted only once
 * archived and past the local retention. Objects go under
 * `audit/instance/<yyyy>/<mm>/<dd>/directory-<first row time>-<from>-<to>-<digest>.ndjson`.
 */

/** Segments one run writes at most; the rest waits for the next run. Proposed. */
export const DIRECTORY_SEGMENTS_PER_RUN = 20;

type Segment = { segment_id: number; from_seq: number; to_seq: number; r2_key: string };

export interface DirectoryArchiverDeps {
  readonly db: D1Database;
  readonly bucket: Pick<R2Bucket, "put">;
  readonly now: () => number;
  readonly metrics?: Metrics;
  readonly policy?: AuditArchivePolicy;
}

/** One run: finish pending segments, cut and write new ones, then prune. Returns the segments written. */
export async function archiveDirectoryAudit(deps: DirectoryArchiverDeps): Promise<number> {
  const policy = deps.policy ?? AUDIT_ARCHIVE_POLICY;
  let written = 0;
  for (; written < DIRECTORY_SEGMENTS_PER_RUN; written++) {
    const segment = (await pendingSegment(deps)) ?? (await cutSegment(deps, policy));
    if (!segment) break;
    await writeSegment(deps, segment);
  }
  if (written < DIRECTORY_SEGMENTS_PER_RUN) {
    const cutoff = deps.now() - policy.retentionMs;
    count(deps, "audit_prune", 2);
    await deps.db.batch([
      deps.db
        .prepare("DELETE FROM audit_log WHERE archived_at IS NOT NULL AND archived_at <= ?")
        .bind(cutoff),
      deps.db
        .prepare("DELETE FROM audit_segments WHERE state = 'archived' AND archived_at <= ?")
        .bind(cutoff),
    ]);
  }
  return written;
}

function count(deps: DirectoryArchiverDeps, op: string, statements = 1): void {
  deps.metrics?.count("d1.query", { db: "directory", op }, statements);
}

async function pendingSegment(deps: DirectoryArchiverDeps): Promise<Segment | null> {
  count(deps, "audit_segment_pending");
  return deps.db
    .prepare(
      `SELECT segment_id, from_seq, to_seq, r2_key FROM audit_segments
       WHERE state = 'pending' ORDER BY from_seq LIMIT 1`,
    )
    .first<Segment>();
}

async function segmentRows(
  deps: DirectoryArchiverDeps,
  fromSeq: number,
  toSeq: number,
): Promise<AuditRow[]> {
  count(deps, "audit_segment_read");
  const { results } = await deps.db
    .prepare(
      `SELECT seq, at, actor_id, act_chain, action, target_id, details, request_id
       FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq`,
    )
    .bind(fromSeq, toSeq)
    .all<AuditRow>();
  return results;
}

/**
 * Records the next segment: the oldest unarchived rows no reservation
 * covers, of one UTC day, up to the next reservation, named by the digest
 * of exactly the rows read. The record is refused if it overlaps any other
 * reservation, so overlapping runs never archive a row twice.
 */
async function cutSegment(
  deps: DirectoryArchiverDeps,
  policy: AuditArchivePolicy,
): Promise<Segment | null> {
  count(deps, "audit_segment_rows", 2);
  const [rows, next] = await deps.db.batch<AuditRow & { next_reserved?: number | null }>([
    deps.db
      .prepare(
        `SELECT seq, at, actor_id, act_chain, action, target_id, details, request_id
         FROM audit_log a
         WHERE archived_at IS NULL AND ${UNCOVERED}
         ORDER BY seq LIMIT ?`,
      )
      .bind(policy.maxRows),
    deps.db.prepare(
      `SELECT min(s.from_seq) AS next_reserved FROM audit_segments s
       WHERE s.from_seq > (SELECT min(seq) FROM audit_log a
                           WHERE archived_at IS NULL AND ${UNCOVERED})`,
    ),
  ]);
  const chosen = segmentOf(rows?.results ?? [], next?.results[0]?.next_reserved ?? null);
  const head = chosen[0];
  const last = chosen.at(-1);
  if (!head || !last) return null;
  const digest = await auditDigest(auditNdjson(chosen));
  const key = auditObjectKey("instance", head.at, "directory", head.at, head.seq, last.seq, digest);
  count(deps, "audit_segment_cut");
  const inserted = await deps.db
    .prepare(
      `INSERT INTO audit_segments (first_at, from_seq, to_seq, r2_key, state, created_at)
       SELECT ?1, ?2, ?3, ?4, 'pending', ?5
       WHERE NOT EXISTS (SELECT 1 FROM audit_segments WHERE from_seq <= ?3 AND to_seq >= ?2)
       ON CONFLICT (r2_key) DO NOTHING
       RETURNING segment_id, from_seq, to_seq, r2_key`,
    )
    .bind(head.at, head.seq, last.seq, key, deps.now())
    .first<Segment>();
  // Refused: another run reserved some of these rows; finish its segment if still pending.
  return inserted ?? pendingSegment(deps);
}

/**
 * Writes a segment's object and marks its rows archived. Rows that no
 * longer match the segment's digest (a restore replaced them) drop the
 * reservation instead, so they are cut again; the acknowledgement marks
 * rows only while the same reservation still exists, so rows a restore
 * brought back during the write are never marked.
 */
async function writeSegment(deps: DirectoryArchiverDeps, segment: Segment): Promise<void> {
  const body = auditNdjson(await segmentRows(deps, segment.from_seq, segment.to_seq));
  if (!segment.r2_key.endsWith(`-${await auditDigest(body)}.ndjson`)) {
    count(deps, "audit_segment_drop");
    await deps.db
      .prepare(
        "DELETE FROM audit_segments WHERE segment_id = ? AND r2_key = ? AND state = 'pending'",
      )
      .bind(segment.segment_id, segment.r2_key)
      .run();
    return;
  }
  await deps.bucket.put(segment.r2_key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  deps.metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "audit_put" });
  const now = deps.now();
  count(deps, "audit_segment_done", 2);
  await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE audit_log SET archived_at = ?
         WHERE seq BETWEEN ? AND ? AND archived_at IS NULL
           AND EXISTS (SELECT 1 FROM audit_segments
                       WHERE segment_id = ? AND r2_key = ? AND state = 'pending')`,
      )
      .bind(now, segment.from_seq, segment.to_seq, segment.segment_id, segment.r2_key),
    deps.db
      .prepare(
        "UPDATE audit_segments SET state = 'archived', archived_at = ? WHERE segment_id = ? AND r2_key = ?",
      )
      .bind(now, segment.segment_id, segment.r2_key),
  ]);
}
