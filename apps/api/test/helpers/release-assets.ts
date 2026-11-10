import { env, exports } from "cloudflare:workers";
import type { RepoDO } from "../../src/do/RepoDO.js";
import { api, json } from "./api.js";
import { ORIGIN } from "./git-http.js";
import type { ReleaseRepo } from "./releases.js";
import { inRepo } from "./repo-git.js";

export type UploadOut = {
  id: string;
  release_id: number;
  name: string;
  content_type: string;
  size: number;
  part_size: number;
  part_count: number;
  state: "receiving" | "completing" | "completed" | "aborted";
  parts_url: string;
  expires_at: number;
  asset?: AssetOut;
  code?: string;
};

export type AssetOut = {
  id: number;
  name: string;
  content_type: string;
  size: number;
  uploader: { id: string };
  download_url: string;
  code?: string;
};

/** A draft release of the repository; its id. */
export async function draft(r: ReleaseRepo, tag = "v-draft"): Promise<number> {
  const made = await json<{ id: number }>(
    api("POST", `${r.path}/releases`, r.owner.token, { tag_name: tag, draft: true }),
  );
  if (made.status !== 201) throw new Error(`no draft: ${JSON.stringify(made)}`);
  return made.body.id;
}

export function begin(
  r: ReleaseRepo,
  releaseId: number,
  body: Record<string, unknown>,
  token = r.owner.token,
) {
  return json<UploadOut>(
    api("POST", `${r.path}/releases/${releaseId}/assets/uploads`, token, body),
  );
}

/** Sends one part's bytes to the parts URL; the etag or the refusal. */
export async function putPart(
  partsUrl: string,
  n: number,
  bytes: Uint8Array,
  token: string,
  headers: Record<string, string> = {},
) {
  const res = await exports.default.fetch(`${ORIGIN}${partsUrl}/${n}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body: bytes,
  });
  return {
    status: res.status,
    body: await res.json<{ part_number?: number; etag?: string; code?: string }>(),
  };
}

export function complete(
  r: ReleaseRepo,
  uploadId: string,
  parts: readonly { part_number: number; etag: string }[],
  token = r.owner.token,
) {
  return json<UploadOut>(
    api("POST", `${r.path}/releases/assets/uploads/${uploadId}/complete`, token, { parts }),
  );
}

export function abort(r: ReleaseRepo, uploadId: string, token = r.owner.token) {
  return json<UploadOut>(api("DELETE", `${r.path}/releases/assets/uploads/${uploadId}`, token));
}

/** Bytes of a given length, each a function of its position (so parts differ). */
export function bytesOf(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** Uploads `bytes` as asset `name` of release `releaseId`, one part at a time; the completion. */
export async function upload(
  r: ReleaseRepo,
  releaseId: number,
  name: string,
  bytes: Uint8Array,
  more: Record<string, unknown> = {},
) {
  const begun = await begin(r, releaseId, { name, size: bytes.length, ...more });
  if (begun.status !== 201) return begun;
  const parts: { part_number: number; etag: string }[] = [];
  for (let n = 1; n <= begun.body.part_count; n++) {
    const slice = bytes.subarray((n - 1) * begun.body.part_size, n * begun.body.part_size);
    const put = await putPart(begun.body.parts_url, n, slice, r.owner.token);
    if (put.status !== 200) throw new Error(`part ${n}: ${JSON.stringify(put)}`);
    parts.push({ part_number: n, etag: put.body.etag as string });
  }
  return complete(r, begun.body.id, parts);
}

export type Counters = {
  asset_bytes: number;
  usage_seq: number;
  told_seq: number;
  retain_until: number | null;
  early_purge_at: number | null;
};

/** The repository's asset counters and the sum its rows give, to compare. */
export function counted(stub: DurableObjectStub<RepoDO>) {
  return inRepo(stub, (repo) => {
    const sql = repo.git.context.storage.sql;
    const counters = sql.exec<Counters>("SELECT * FROM release_asset_counters").one();
    const rows = sql
      .exec<{ n: number }>(
        `SELECT (SELECT coalesce(sum(bytes), 0) FROM release_assets)
           + (SELECT coalesce(sum(bytes), 0) FROM release_asset_retained) AS n`,
      )
      .one().n;
    return { ...counters, rows, total: repo.releaseAssets.total() };
  });
}

/** Upload sessions' states, by id. */
export function sessions(stub: DurableObjectStub<RepoDO>) {
  return inRepo(stub, (repo) =>
    repo.git.context.storage.sql
      .exec<{ upload_id: string; state: string; settle_after: number | null }>(
        "SELECT upload_id, state, settle_after FROM release_asset_uploads ORDER BY created_at",
      )
      .toArray(),
  );
}

/** One slice of the release assets job, inside the object. */
export function assetSlice(stub: DurableObjectStub<RepoDO>) {
  return inRepo(stub, (repo) => repo.releaseAssets.slice());
}

/** The object of an upload's key in the bucket, or null. */
export async function objectOf(repoId: string, objectId: string) {
  return env.ASSETS.head(`release-assets/${repoId}/${objectId}`);
}

/** Object ids: of every asset, and of every retained object. */
export function objectIds(stub: DurableObjectStub<RepoDO>) {
  return inRepo(stub, (repo) => {
    const sql = repo.git.context.storage.sql;
    return {
      assets: sql
        .exec<{ object_id: string }>("SELECT object_id FROM release_assets ORDER BY id")
        .toArray()
        .map((row) => row.object_id),
      retained: sql
        .exec<{ object_id: string }>("SELECT object_id FROM release_asset_retained")
        .toArray()
        .map((row) => row.object_id),
    };
  });
}

/** The repository object's clock, which tests set apart from the wall clock. */
export function clockOf(stub: DurableObjectStub<RepoDO>): Promise<number> {
  return inRepo(stub, ({ git }) => git.context.now());
}
