import { scratchPrefix } from "@fyrden/adapters-cloudflare/git";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { StoredBody } from "@fyrden/git-core";

/*
 * A push's scratch objects in R2, under the upload's scratch prefix
 * (`net/<nid>/scratch/<upload_id>/`), which the orphan reaper deletes for an
 * upload that never commits:
 *
 *   body     the request body, written by the Worker with one PUT
 *   cursor-<version>  the indexing cursor, when it is too large for its
 *            row: one object per save (`cursor` before versions)
 *   head     a chunked upload's or import's command section, built by the
 *            server from the requested ref updates
 *   pack     a chunked upload's or import's pack, assembled by an R2
 *            multipart upload
 *
 * A chunked upload or import is read as one body: `head` then `pack`.
 */

export const BUCKET_NAME = "fyrden-git";

export function bodyKey(networkId: string, uploadId: string): string {
  return `${scratchPrefix(networkId, uploadId)}body`;
}

const CURSOR_VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The key of one saved indexing cursor. Each save writes a new `version`
 * (a UUID), so a write that lands late never replaces a newer cursor;
 * without one, the single key earlier cursors used.
 */
export function cursorKey(networkId: string, uploadId: string, version?: string): string {
  if (version === undefined) return `${scratchPrefix(networkId, uploadId)}cursor`;
  if (!CURSOR_VERSION.test(version)) throw new RangeError("not a cursor version");
  return `${scratchPrefix(networkId, uploadId)}cursor-${version}`;
}

export function headKey(networkId: string, uploadId: string): string {
  return `${scratchPrefix(networkId, uploadId)}head`;
}

export function packKey(networkId: string, uploadId: string): string {
  return `${scratchPrefix(networkId, uploadId)}pack`;
}

/** Two stored bodies read as one: `first`, then `second`. */
export function concatStoredBody(first: StoredBody, second: StoredBody): StoredBody {
  const length = first.length + second.length;
  return {
    length,
    async read(offset, size) {
      if (offset < 0 || size < 0 || offset + size > length) {
        throw new RangeError(`range ${offset}+${size} is outside the body (${length})`);
      }
      const end = offset + size;
      if (end <= first.length) return first.read(offset, size);
      if (offset >= first.length) return second.read(offset - first.length, size);
      const head = await first.read(offset, first.length - offset);
      const tail = await second.read(0, end - first.length);
      const out = new Uint8Array(size);
      out.set(head);
      out.set(tail, head.length);
      return out;
    },
  };
}

/** The stored request body, read by range (one class B operation per read). */
export function r2StoredBody(
  bucket: R2Bucket,
  key: string,
  length: number,
  metrics: Metrics,
): StoredBody {
  return {
    length,
    async read(offset, size) {
      if (offset < 0 || size < 0 || offset + size > length) {
        throw new RangeError(`range ${offset}+${size} is outside the body (${length})`);
      }
      if (size === 0) return new Uint8Array(0);
      metrics.count("r2.class_b", { bucket: BUCKET_NAME, op: "get_body" });
      const object = await bucket.get(key, { range: { offset, length: size } });
      if (!object) throw new Error("the stored push body is missing");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.length !== size) {
        throw new Error(
          `the stored push body gave ${bytes.length} bytes at ${offset}, not ${size}`,
        );
      }
      return bytes;
    },
  };
}

/**
 * Deletes an upload's scratch objects (body or head and pack, and spilled
 * cursor: the unversioned key, and the `cursors` given, the published
 * one's key). Not counted as a class A or B operation: R2 lists deletes as
 * free (https://developers.cloudflare.com/r2/pricing/, unverified here).
 */
export async function deleteScratch(
  bucket: R2Bucket,
  networkId: string,
  uploadId: string,
  cursors: readonly string[] = [],
): Promise<void> {
  await bucket.delete([
    bodyKey(networkId, uploadId),
    cursorKey(networkId, uploadId),
    ...cursors,
    headKey(networkId, uploadId),
    packKey(networkId, uploadId),
  ]);
}
