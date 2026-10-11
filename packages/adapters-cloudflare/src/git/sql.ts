import type { Metrics } from "../obs/metrics.js";

/** The parts of Durable Object storage the git adapters use. */
export type GitSqlStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** Shared by the git adapters of one Durable Object. */
export interface GitStorageContext {
  readonly storage: GitSqlStorage;
  readonly now: () => number;
  readonly metrics: Metrics;
  /** The Durable Object class, for cost counters. */
  readonly doClass: string;
}

export const noMetrics: Metrics = { count() {} };

/**
 * Runs a write and returns the rows it wrote (the billed unit for Durable
 * Object SQLite storage). The cursor is drained so the count is final.
 */
export function run(storage: GitSqlStorage, query: string, ...bindings: unknown[]): number {
  const cursor = storage.sql.exec(query, ...bindings);
  cursor.toArray();
  return cursor.rowsWritten;
}

export function rows<T extends Record<string, SqlStorageValue>>(
  storage: GitSqlStorage,
  query: string,
  ...bindings: unknown[]
): T[] {
  return storage.sql.exec<T>(query, ...bindings).toArray();
}

export function first<T extends Record<string, SqlStorageValue>>(
  storage: GitSqlStorage,
  query: string,
  ...bindings: unknown[]
): T | undefined {
  return storage.sql.exec<T>(query, ...bindings).toArray()[0];
}

/** Counts rows written by one storage operation. */
export function countRowsWritten(context: GitStorageContext, op: string, written: number): void {
  if (written > 0)
    context.metrics.count("do.rows_written", { class: context.doClass, op }, written);
}

/** A copy of `bytes` as the `ArrayBuffer` SQLite binds as a BLOB. */
export function blob(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

export function blobOrNull(bytes: Uint8Array | null | undefined): ArrayBuffer | null {
  return bytes ? blob(bytes) : null;
}

/** A BLOB column read back as bytes (a fresh copy, owned by the caller). */
export function bytesOf(value: SqlStorageValue): Uint8Array<ArrayBuffer> {
  if (!(value instanceof ArrayBuffer)) throw new TypeError("expected a BLOB column");
  return new Uint8Array(value.slice(0));
}

/**
 * Durable Object SQLite allows at most 100 bound parameters per query and
 * 2 MB per BLOB or row (verified 2026-10-11:
 * https://developers.cloudflare.com/durable-objects/platform/limits/#sql-storage-limits),
 * so IN lists are built in chunks of this size.
 */
export const IN_LIST_CHUNK = 90;

export function chunks<T>(items: readonly T[], size = IN_LIST_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
