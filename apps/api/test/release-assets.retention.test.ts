// Release assets over time: sessions that expire, objects replaced or
// deleted kept for 30 days and past any restore fence, an admin's early
// purge, sessions of an older restore generation, and a deletion settling
// every upload before it empties the repository's prefix. Times are set on
// the rows; the job runs a slice at a time.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { REPO_CLEANUPS } from "../src/repos/cleanups.js";
import { api, json } from "./helpers/api.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import {
  assetSlice,
  begin,
  bytesOf,
  clockOf,
  complete,
  counted,
  draft,
  objectIds,
  objectOf,
  putPart,
  sessions,
  upload,
} from "./helpers/release-assets.js";
import { type ReleaseRepo, releaseRepo } from "./helpers/releases.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const DAY = 24 * 60 * 60 * 1000;

let r: ReleaseRepo;
let release: number;

beforeEach(async () => {
  r = await releaseRepo(fx.repo);
  release = await draft(r);
});

const sql = (query: string, ...bindings: unknown[]) =>
  inRepo(r.stub, ({ git }) => {
    git.context.storage.sql.exec(query, ...bindings);
  });

const storage = async () =>
  (await json<{ storage_bytes: number }>(api("GET", "/user/quota", r.owner.token))).body
    .storage_bytes;

/**
 * Replaces asset "a" once, so one object is retained; its object id. Its sessions' completions
 * can no longer land unless `landing`, so only the protection a test is about holds it.
 */
async function retainOne(landing = false): Promise<string> {
  await upload(r, release, "a", bytesOf(10, 1));
  const [old] = (await objectIds(r.stub)).assets;
  await upload(r, release, "a", bytesOf(4, 2), { replace: true });
  if (!landing) await sql("UPDATE release_asset_uploads SET settle_after = 1");
  return old as string;
}

/** Its 30 days passed, a moment ago. */
const due = async () =>
  sql("UPDATE release_asset_retained SET purge_after = ?", (await clockOf(r.stub)) - 1000);

const purge = (token = r.owner.token) =>
  json<{ state: string; objects: number; bytes: number; code?: string }>(
    api("POST", `${r.path}/releases/retained/purge`, token, {}),
  );

describe("expiry", () => {
  it("ends a deleted release's open sessions and frees their holds", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const removed = await json(api("DELETE", `${r.path}/releases/${release}`, r.owner.token));
    expect(removed.status).toBe(200);
    await assetSlice(r.stub);
    expect((await sessions(r.stub)).filter((s) => s.state !== "aborted")).toEqual([]);
    const quota = await json<{ reserved_bytes: number }>(
      api("GET", "/user/quota", r.owner.token),
    );
    expect(quota.body.reserved_bytes).toBe(0);
    // Ended and cleared: a part finds no session.
    const late = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    expect(late.status).toBe(404);
  });

  it("keeps a completed session for retries until it expires, then clears it", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
    // Nothing it sent can land any more, but it hasn't expired.
    await sql("UPDATE release_asset_uploads SET settle_after = 1");
    await assetSlice(r.stub);
    expect((await sessions(r.stub)).map((s) => s.state)).toEqual(["completed"]);
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
    await sql("UPDATE release_asset_uploads SET expires_at = 1");
    await assetSlice(r.stub);
    expect(await sessions(r.stub)).toEqual([]);
  });

  it("ends a session before it touches R2, then clears it", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    await sql("UPDATE release_asset_uploads SET expires_at = 1");
    await assetSlice(r.stub);
    // Ended, and with nothing that could land, cleared on the next slice.
    const after = await sessions(r.stub);
    expect(after.length === 0 || after[0]?.state === "aborted").toBe(true);
    await assetSlice(r.stub);
    expect(await sessions(r.stub)).toEqual([]);
    const late = await complete(r, begun.body.id, [{ part_number: 1, etag: "x" }]);
    expect(late.status).toBe(404);
  });

  it("takes a crashed completion's bytes out of the total, and the account hears", async () => {
    const before = await storage();
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    // As if the object was evicted after stating its total and before deciding.
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {
        step: (step) => {
          if (step === "stated") throw new Error("evicted");
        },
      };
    });
    const stopped = await complete(r, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect(stopped.status).toBe(500);
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {};
    });
    expect(await storage()).toBe(before + 10);
    expect((await counted(r.stub)).total).toBe(10);
    await sql("UPDATE release_asset_uploads SET expires_at = 1");
    await assetSlice(r.stub);
    expect((await counted(r.stub)).total).toBe(0);
    expect(await storage()).toBe(before);
  });

  it("keeps a completed session's row until a stale completion could no longer land and it expired", async () => {
    await upload(r, release, "a", bytesOf(10));
    const [row] = await sessions(r.stub);
    expect(row?.state).toBe("completed");
    expect(row?.settle_after).toBeGreaterThan(await clockOf(r.stub));
    await assetSlice(r.stub);
    expect((await sessions(r.stub)).length).toBe(1);
    await sql("UPDATE release_asset_uploads SET settle_after = 1");
    await assetSlice(r.stub);
    expect((await sessions(r.stub)).length).toBe(1);
    await sql("UPDATE release_asset_uploads SET expires_at = 1");
    await assetSlice(r.stub);
    expect(await sessions(r.stub)).toEqual([]);
    // Its key is its asset's, and stays.
    const [object] = (await objectIds(r.stub)).assets;
    expect(await objectOf(r.id, object as string)).not.toBeNull();
  });
});

describe("retained objects", () => {
  it("go 30 days after they were retained: R2 first, then the total", async () => {
    const before = await storage();
    const old = await retainOne();
    expect(await storage()).toBe(before + 14);
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).not.toBeNull();
    await due();
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).toBeNull();
    expect((await objectIds(r.stub)).retained).toEqual([]);
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.rows]).toEqual([4, 4]);
    expect(await storage()).toBe(before + 4);
  });

  it("stay counted until R2 has deleted them", async () => {
    const old = await retainOne();
    await due();
    // When R2 is asked to delete them, their bytes are still in the total and in a statement.
    await inRepo(r.stub, (repo) => {
      const real = repo.assetBucket;
      repo.assetBucket = {
        head: (key: string) => real.head(key),
        resumeMultipartUpload: (key: string, id: string) => real.resumeMultipartUpload(key, id),
        delete: async (keys: string | string[]) => {
          const counted = repo.releaseAssets.total();
          const usage = repo.releaseAssets.usage();
          if (counted !== 14 || usage.bytes !== 14)
            throw new Error(`counted ${counted}, stated ${usage.bytes} before R2 deleted them`);
          return real.delete(keys);
        },
      } as unknown as R2Bucket;
    });
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).toBeNull();
    expect((await counted(r.stub)).total).toBe(4);
  });

  it("stay while a restore's fence may still bring back a state naming them", async () => {
    const old = await retainOne();
    await due();
    await inRepo(r.stub, (repo) => repo.releaseAssets.restored());
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).not.toBeNull();
    const c = await counted(r.stub);
    expect(c.retain_until).toBeGreaterThan((await clockOf(r.stub)) + 29 * DAY);
    await sql("UPDATE release_asset_counters SET retain_until = 1");
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).toBeNull();
  });

  it("stay while a session naming them may still have a completion landing", async () => {
    const old = await retainOne();
    await due();
    await sql(
      `INSERT INTO release_asset_uploads (upload_id, release_id, name, name_fold, content_type,
         replace_existing, bytes, part_bytes, object_id, multipart_id, principal, token_id,
         epoch_gen, state, settle_after, created_at, expires_at)
       VALUES ('01JTESTSESSION0000000000000', 1, 'x', 'x', 'a/b', 0, 1, 1, ?, 'm', 'p', 't',
         0, 'aborted', ?, 0, ?)`,
      old,
      (await clockOf(r.stub)) + 60_000,
      (await clockOf(r.stub)) + DAY,
    );
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).not.toBeNull();
  });
});

describe("an early purge", () => {
  it("removes what was retained before it, past the restore fence, and the total falls after R2", async () => {
    const before = await storage();
    const old = await retainOne();
    await inRepo(r.stub, (repo) => repo.releaseAssets.restored());
    const asked = await purge();
    expect(asked).toEqual({ status: 202, body: { state: "purging", objects: 1, bytes: 10 } });
    // Asked, not done: still counted until the job's slice.
    expect(await storage()).toBe(before + 14);
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).toBeNull();
    expect(await storage()).toBe(before + 4);
  });

  it("leaves what is retained after it its 30 days", async () => {
    await purge();
    const old = await retainOne();
    await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).not.toBeNull();
  });

  it("is for repository admins only: write access and agents are refused", async () => {
    const writer = await scopedToken(r.owner.principalId, ["contents:write"]);
    expect((await purge(writer)).status).toBe(403);
    const agent = await principalWithToken("agent", "pat");
    expect([403, 404]).toContain((await purge(agent.token)).status);
    expect((await purge()).status).toBe(202);
  });

  it("is refused while the repository moves", async () => {
    await sql(
      "UPDATE repo_meta SET transfer_id = 'trf_x', transfer_to = 'someone', write_frozen = 1",
    );
    const asked = await purge();
    expect([asked.status, asked.body.code]).toEqual([409, "repo_transferring"]);
  });
});

describe("a session of an older restore generation", () => {
  it("is ended by a retry without deleting its key", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    // Its object exists, as if a later state named it as an asset.
    const objectId = await inRepo(
      r.stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ object_id: string }>("SELECT object_id FROM release_asset_uploads")
          .one().object_id,
    );
    await env.ASSETS.put(`release-assets/${r.id}/${objectId}`, bytesOf(10));
    await sql("UPDATE release_asset_uploads SET epoch_gen = epoch_gen - 1");
    const done = await complete(r, begun.body.id, parts);
    expect([done.status, done.body.code]).toEqual([409, "upload_aborted"]);
    expect(await objectOf(r.id, objectId)).not.toBeNull();
  });

  it("is ended by the job without deleting its key", async () => {
    await begin(r, release, { name: "a", size: 10 });
    const objectId = await inRepo(
      r.stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ object_id: string }>("SELECT object_id FROM release_asset_uploads")
          .one().object_id,
    );
    await env.ASSETS.put(`release-assets/${r.id}/${objectId}`, bytesOf(10));
    await sql("UPDATE release_asset_uploads SET epoch_gen = epoch_gen - 1");
    await assetSlice(r.stub);
    await assetSlice(r.stub);
    expect(await objectOf(r.id, objectId)).not.toBeNull();
  });
});

describe("a deletion", () => {
  const settle = () => inRepo(r.stub, (repo) => repo.releaseAssets.settle());

  it("ends open sessions, waits while a completion may land, then is settled", async () => {
    await begin(r, release, { name: "a", size: 10 });
    await upload(r, release, "b", bytesOf(5));
    // The completed session's completion may still be landing.
    expect(await settle()).toBe("wait");
    expect((await sessions(r.stub)).map((s) => s.state).sort()).toEqual(["aborted", "completed"]);
    await sql("UPDATE release_asset_uploads SET settle_after = 1");
    expect(await settle()).toBe("settled");
  });

  it("waits a while after a restore, which can rewind a session to before it sent", async () => {
    await inRepo(r.stub, (repo) => repo.releaseAssets.restored());
    expect(await settle()).toBe("wait");
    await sql("UPDATE release_asset_counters SET retain_until = 1");
    expect(await settle()).toBe("settled");
  });

  it("empties the repository's prefix once settled, retained objects and orphans too", async () => {
    await upload(r, release, "a", bytesOf(10));
    await upload(r, release, "a", bytesOf(3), { replace: true });
    await env.ASSETS.put(`release-assets/${r.id}/orphan`, "x");
    await sql("UPDATE release_asset_uploads SET settle_after = 1");
    const cleanup = REPO_CLEANUPS.find((c) => c.name === "release_assets");
    expect(REPO_CLEANUPS.at(-1)).toBe(cleanup);
    expect(await cleanup?.page(env, { repoId: r.id, shard: "s", gen: 1 })).toBe("done");
    const listed = await env.ASSETS.list({ prefix: `release-assets/${r.id}/` });
    expect(listed.objects).toEqual([]);
  });
});

describe("the job", () => {
  it("never deletes the key of a session that committed while an earlier one was being ended", async () => {
    await begin(r, release, { name: "a", size: 10 });
    await begin(r, release, { name: "b", size: 10 });
    const rows = await inRepo(r.stub, ({ git }) => {
      const q = git.context.storage.sql;
      q.exec("UPDATE release_asset_uploads SET state = 'completing'");
      q.exec("UPDATE release_asset_uploads SET expires_at = 1 WHERE name = 'a'");
      q.exec("UPDATE release_asset_uploads SET expires_at = 2 WHERE name = 'b'");
      return q
        .exec<{ upload_id: string; object_id: string; name: string }>(
          "SELECT upload_id, object_id, name FROM release_asset_uploads ORDER BY name",
        )
        .toArray();
    });
    const [a, b] = rows as [(typeof rows)[0], (typeof rows)[0]];
    await env.ASSETS.put(`release-assets/${r.id}/${b.object_id}`, bytesOf(10));
    // While a's upload is being aborted, b's completion decides and commits.
    await inRepo(r.stub, (repo) => {
      const real = repo.assetBucket;
      repo.assetBucket = {
        head: (key: string) => real.head(key),
        delete: (keys: string | string[]) => real.delete(keys),
        resumeMultipartUpload: (key: string, id: string) => {
          const upload = real.resumeMultipartUpload(key, id);
          return {
            ...upload,
            complete: (parts: R2UploadedPart[]) => upload.complete(parts),
            abort: async () => {
              if (key.endsWith(a.object_id))
                repo.git.context.storage.sql.exec(
                  "UPDATE release_asset_uploads SET state = 'completed' WHERE upload_id = ?",
                  b.upload_id,
                );
              return upload.abort();
            },
          } as R2MultipartUpload;
        },
      } as unknown as R2Bucket;
    });
    await assetSlice(r.stub);
    expect(await objectOf(r.id, b.object_id)).not.toBeNull();
  });

  it("waits for a completion still landing rather than running again at once", async () => {
    const old = await retainOne(true);
    await purge();
    const result = await assetSlice(r.stub);
    expect(await objectOf(r.id, old)).not.toBeNull();
    expect(result).toMatchObject({ done: false });
    expect((result as { runAfterMs: number }).runAfterMs).toBeGreaterThan(60_000);
  });
});
