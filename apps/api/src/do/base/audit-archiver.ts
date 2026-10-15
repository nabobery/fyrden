import type { JobHandler } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";

/**
 * Archives a Durable Object's append-only `audit_log` to R2, so audit
 * records outlive the object's storage and any queue. Rows go into segments
 * of one epoch and one UTC day; a segment's membership is recorded before
 * its object is written, under a deterministic name,
 * `audit/<org>/<yyyy>/<mm>/<dd>/<source>-<epoch>-<from>-<to>-<digest>.ndjson`:
 * a write retried after a crash writes the same object, and other rows
 * never take an archived object's name. Rows are deleted only once
 * archived and past the local retention.
 */

/** Proposed values. */
export interface AuditArchivePolicy {
  /** Rows in one segment at most. */
  readonly maxRows: number;
  /** How long archived rows stay in the object as well. */
  readonly retentionMs: number;
  /** Wait after a write before archiving, so one object holds more rows. */
  readonly delayMs: number;
}

export const AUDIT_ARCHIVE_POLICY: AuditArchivePolicy = {
  maxRows: 1_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  delayMs: 60_000,
};

/** The job id of a source's archiver: one per object. */
export const AUDIT_ARCHIVE_JOB = "audit-archive";

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** An `audit_log` row; the directory's table has fewer columns (absent: null). */
export type AuditRow = {
  seq: number;
  epoch_gen?: number | null;
  at: number;
  actor_id: string | null;
  on_behalf_of?: string | null;
  act_chain: string | null;
  token_id?: string | null;
  grant_id?: string | null;
  action: string;
  target_id: string | null;
  result?: string | null;
  details: string | null;
  request_id: string | null;
};

type Segment = {
  segment_id: number;
  epoch_gen: number;
  from_seq: number;
  to_seq: number;
  r2_key: string;
};

export interface AuditArchiverDeps {
  readonly storage: Storage;
  readonly bucket: Pick<R2Bucket, "put">;
  readonly now: () => number;
  /** The organization (or account) the source belongs to, for the object name. */
  readonly org: () => string;
  /** The source's id (the repository id), for the object name. */
  readonly source: () => string;
  readonly metrics?: Metrics;
  readonly policy?: AuditArchivePolicy;
}

/** Rows not archived yet: the backlog a deletion must wait for. */
export function unarchivedAuditRows(storage: Storage): number {
  return storage.sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM audit_log WHERE archived_at IS NULL")
    .one().n;
}

/** Whether any row waits to be archived (an index lookup, for every commit). */
export function hasUnarchivedAuditRows(storage: Storage): boolean {
  return (
    storage.sql
      .exec<{ waiting: number }>(
        "SELECT EXISTS (SELECT 1 FROM audit_log WHERE archived_at IS NULL) AS waiting",
      )
      .one().waiting === 1
  );
}

/**
 * One slice: finish a pending segment, or cut and write the next one; then
 * delete archived rows past retention. Not done while rows wait; when only
 * archived rows remain, it comes back when the oldest leaves retention.
 */
export function auditArchiveHandler(deps: AuditArchiverDeps): JobHandler {
  const policy = deps.policy ?? AUDIT_ARCHIVE_POLICY;
  const { storage } = deps;
  return {
    async runSlice() {
      const segment = pendingSegment(storage) ?? (await cutSegment(deps, policy));
      if (segment) {
        await writeSegment(deps, segment);
        return { done: false, cursor: null, runAfterMs: 0 };
      }
      const now = deps.now();
      storage.transactionSync(() => {
        const cutoff = now - policy.retentionMs;
        exec(
          deps,
          "audit.prune",
          "DELETE FROM audit_log WHERE archived_at IS NOT NULL AND archived_at <= ?",
          cutoff,
        );
        exec(
          deps,
          "audit.prune",
          "DELETE FROM audit_segments WHERE state = 'archived' AND archived_at <= ?",
          cutoff,
        );
      });
      const oldest = storage.sql
        .exec<{ at: number | null }>(
          "SELECT min(archived_at) AS at FROM audit_log WHERE archived_at IS NOT NULL",
        )
        .one().at;
      return oldest === null
        ? { done: true }
        : { done: false, cursor: null, runAfterMs: Math.max(0, oldest + policy.retentionMs - now) };
    },
  };
}

/** Runs a write and counts the rows it wrote. */
function exec(deps: AuditArchiverDeps, op: string, query: string, ...bindings: unknown[]): void {
  const cursor = deps.storage.sql.exec(query, ...bindings);
  cursor.toArray();
  if (cursor.rowsWritten > 0)
    deps.metrics?.count("do.rows_written", { class: "RepoDO", op }, cursor.rowsWritten);
}

function pendingSegment(storage: Storage): Segment | undefined {
  return storage.sql
    .exec<Segment>(
      `SELECT segment_id, epoch_gen, from_seq, to_seq, r2_key FROM audit_segments
       WHERE state = 'pending' ORDER BY from_seq LIMIT 1`,
    )
    .toArray()[0];
}

const ROW_COLUMNS = `seq, epoch_gen, at, actor_id, on_behalf_of, act_chain, token_id, grant_id,
  action, target_id, result, details, request_id`;

function segmentRows(storage: Storage, fromSeq: number, toSeq: number): AuditRow[] {
  return storage.sql
    .exec<AuditRow>(
      `SELECT ${ROW_COLUMNS} FROM audit_log WHERE seq BETWEEN ? AND ? ORDER BY seq`,
      fromSeq,
      toSeq,
    )
    .toArray();
}

/**
 * SQL condition: no reservation covers the audit row `a`. Reservations never
 * overlap, so only the nearest one starting at or below the row can cover
 * it (one index lookup per row).
 */
export const UNCOVERED = `coalesce((SELECT s.to_seq FROM audit_segments s WHERE s.from_seq <= a.seq
  ORDER BY s.from_seq DESC LIMIT 1), 0) < a.seq`;

/**
 * The rows of the next segment: from the first, those of its epoch and UTC
 * day, in sequence order, before the next reservation.
 */
export function segmentOf<R extends { seq: number; at: number; epoch_gen?: number | null }>(
  rows: readonly R[],
  nextReserved: number | null,
): R[] {
  const head = rows[0];
  if (!head) return [];
  const day = utcDay(head.at);
  const chosen: R[] = [];
  for (const row of rows) {
    if ((row.epoch_gen ?? null) !== (head.epoch_gen ?? null) || utcDay(row.at) !== day) break;
    if (nextReserved !== null && row.seq >= nextReserved) break;
    chosen.push(row);
  }
  return chosen;
}

/**
 * Records the next segment: the oldest unarchived rows no reservation
 * covers, of one epoch and UTC day, up to the next reservation, named by
 * the digest of exactly the rows read. The record is refused if it
 * overlaps another reservation.
 */
async function cutSegment(
  deps: AuditArchiverDeps,
  policy: AuditArchivePolicy,
): Promise<Segment | undefined> {
  const { storage } = deps;
  const rows = storage.sql
    .exec<AuditRow & { epoch_gen: number }>(
      `SELECT ${ROW_COLUMNS} FROM audit_log a
       WHERE archived_at IS NULL AND ${UNCOVERED}
       ORDER BY seq LIMIT ?`,
      policy.maxRows,
    )
    .toArray();
  const first = rows[0];
  const next = first
    ? storage.sql
        .exec<{ next: number | null }>(
          "SELECT min(from_seq) AS next FROM audit_segments WHERE from_seq > ?",
          first.seq,
        )
        .one().next
    : null;
  const chosen = segmentOf(rows, next);
  const head = chosen[0];
  const last = chosen.at(-1);
  if (!head || !last) return undefined;
  const digest = await auditDigest(auditNdjson(chosen));
  const key = auditObjectKey(
    deps.org(),
    head.at,
    deps.source(),
    head.epoch_gen,
    head.seq,
    last.seq,
    digest,
  );
  const cursor = storage.sql.exec<Segment>(
    `INSERT INTO audit_segments (epoch_gen, from_seq, to_seq, r2_key, state, created_at)
     SELECT ?1, ?2, ?3, ?4, 'pending', ?5
     WHERE NOT EXISTS (SELECT 1 FROM audit_segments WHERE from_seq <= ?3 AND to_seq >= ?2)
     RETURNING segment_id, epoch_gen, from_seq, to_seq, r2_key`,
    head.epoch_gen,
    head.seq,
    last.seq,
    key,
    deps.now(),
  );
  const segment = cursor.toArray()[0];
  deps.metrics?.count(
    "do.rows_written",
    { class: "RepoDO", op: "audit.segment" },
    cursor.rowsWritten,
  );
  return segment;
}

/**
 * Writes a segment's object and marks its rows archived. Rows that no
 * longer match the segment's digest (a restore replaced them) drop the
 * reservation instead, so they are cut again; the acknowledgement marks
 * rows only while the same reservation still exists.
 */
async function writeSegment(deps: AuditArchiverDeps, segment: Segment): Promise<void> {
  const { storage } = deps;
  const body = auditNdjson(segmentRows(storage, segment.from_seq, segment.to_seq));
  if (!segment.r2_key.endsWith(`-${await auditDigest(body)}.ndjson`)) {
    exec(
      deps,
      "audit.segment",
      "DELETE FROM audit_segments WHERE segment_id = ? AND r2_key = ? AND state = 'pending'",
      segment.segment_id,
      segment.r2_key,
    );
    return;
  }
  await deps.bucket.put(segment.r2_key, body, {
    httpMetadata: { contentType: "application/x-ndjson" },
  });
  deps.metrics?.count("r2.class_a", { bucket: "fyrden-assets", op: "audit_put" });
  const now = deps.now();
  storage.transactionSync(() => {
    exec(
      deps,
      "audit.archived",
      `UPDATE audit_log SET archived_at = ?
       WHERE seq BETWEEN ? AND ? AND archived_at IS NULL
         AND EXISTS (SELECT 1 FROM audit_segments
                     WHERE segment_id = ? AND r2_key = ? AND state = 'pending')`,
      now,
      segment.from_seq,
      segment.to_seq,
      segment.segment_id,
      segment.r2_key,
    );
    exec(
      deps,
      "audit.archived",
      "UPDATE audit_segments SET state = 'archived', archived_at = ? WHERE segment_id = ? AND r2_key = ?",
      now,
      segment.segment_id,
      segment.r2_key,
    );
  });
}

/** Audit rows as archived: one JSON record per line, the audit fields, JSON columns parsed. */
export function auditNdjson(rows: readonly AuditRow[]): string {
  return rows
    .map((row) => {
      const record = {
        seq: row.seq,
        epoch_gen: row.epoch_gen ?? null,
        at: new Date(row.at).toISOString(),
        actor: row.actor_id,
        on_behalf_of: row.on_behalf_of ?? null,
        act_chain: row.act_chain === null ? [] : JSON.parse(row.act_chain),
        token_id: row.token_id ?? null,
        grant_id: row.grant_id ?? null,
        action: row.action,
        target: row.target_id,
        result: row.result ?? null,
        details: row.details === null ? null : JSON.parse(row.details),
        request_id: row.request_id,
      };
      return `${JSON.stringify(record)}\n`;
    })
    .join("");
}

/**
 * The object a segment is archived to. The name ends with the digest of the
 * object's content: the same rows always name the same object, and
 * different rows (after a restore that reused sequence numbers) never do,
 * so an archived object is never replaced by other records.
 */
export function auditObjectKey(
  org: string,
  firstAt: number,
  source: string,
  epochGen: number,
  fromSeq: number,
  toSeq: number,
  digest: string,
): string {
  return `audit/${org}/${utcDay(firstAt)}/${source}-${epochGen}-${fromSeq}-${toSeq}-${digest}.ndjson`;
}

/** The first 16 hex digits (64 bits) of the SHA-256 of a segment's content. */
export async function auditDigest(body: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(hash).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `yyyy/mm/dd` of a time, in UTC. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10).replaceAll("-", "/");
}
