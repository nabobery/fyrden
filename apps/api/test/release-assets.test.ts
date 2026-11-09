// Release asset uploads on the real app and the real bucket: a session per
// asset, its parts straight to R2, a completion that states the repository's
// total to its account and commits only once the account took it, and
// replaced or deleted objects kept, still counted.
import { env } from "cloudflare:workers";
import { MAX_ASSET_UPLOADS } from "@fyrden/domain";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import {
  abort,
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
import { type ReleaseOut, type ReleaseRepo, releaseRepo } from "./helpers/releases.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");

let r: ReleaseRepo;
let release: number;

beforeEach(async () => {
  r = await releaseRepo(fx.repo);
  release = await draft(r);
});

const quota = async () =>
  (
    await json<{ storage_bytes: number; reserved_bytes: number }>(
      api("GET", "/user/quota", r.owner.token),
    )
  ).body;

const setLimit = async (bytes: number) => {
  await env.ORG.getByName(r.owner.principalId).quotaLimits();
  await inRepoOrg((sql) =>
    sql.exec(
      `INSERT INTO quota_limits (id, max_storage_bytes, updated_at) VALUES (1, ?, 0)
       ON CONFLICT (id) DO UPDATE SET max_storage_bytes = excluded.max_storage_bytes`,
      bytes,
    ),
  );
};

async function inRepoOrg(fn: (sql: SqlStorage) => unknown) {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(env.ORG.getByName(r.owner.principalId), (_: unknown, state) => {
    fn(state.storage.sql);
  });
}

/** Replaces the repository's bucket for its next requests (until the object restarts). */
function wrapBucket(stub: DurableObjectStub<RepoDO>, wrap: (bucket: R2Bucket) => R2Bucket) {
  return inRepo(stub, (repo) => {
    repo.assetBucket = wrap(env.ASSETS);
  });
}

const releaseOf = async () =>
  (await json<ReleaseOut>(api("GET", `${r.path}/releases/${release}`, r.owner.token))).body;

describe("an upload", () => {
  it("makes an asset of exactly its bytes, counted once it commits", async () => {
    const before = await quota();
    const bytes = bytesOf(1000);
    const begun = await begin(r, release, { name: "app.tar.gz", size: 1000 });
    expect(begun.status).toBe(201);
    expect(begun.body).toMatchObject({
      release_id: release,
      name: "app.tar.gz",
      content_type: "application/octet-stream",
      size: 1000,
      part_count: 1,
      state: "receiving",
      parts_url: `/api/repos/${r.owner.handle}/${r.name}/releases/assets/uploads/${begun.body.id}/parts`,
    });
    // Its size is held while it uploads.
    expect(await quota()).toMatchObject({ reserved_bytes: before.reserved_bytes + 1000 });
    const put = await putPart(begun.body.parts_url, 1, bytes, r.owner.token);
    expect(put.status).toBe(200);
    expect(put.body.part_number).toBe(1);
    const done = await complete(r, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect(done.status).toBe(200);
    expect(done.body.state).toBe("completed");
    expect(done.body.asset).toMatchObject({
      name: "app.tar.gz",
      size: 1000,
      uploader: { id: r.owner.principalId },
      download_url: `/api/repos/${r.owner.handle}/${r.name}/releases/download/v-draft/app.tar.gz`,
    });
    // Counted, and held no more.
    expect(await quota()).toMatchObject({
      storage_bytes: before.storage_bytes + 1000,
      reserved_bytes: before.reserved_bytes,
    });
    expect((await releaseOf()).assets).toMatchObject([{ name: "app.tar.gz", size: 1000 }]);
    const { assets } = await objectIds(r.stub);
    const object = await objectOf(r.id, assets[0] as string);
    expect(object?.size).toBe(1000);
    const c = await counted(r.stub);
    expect(c.asset_bytes).toBe(1000);
    expect(c.rows).toBe(1000);
    expect(c.told_seq).toBe(c.usage_seq);
  });

  it("takes many parts, each its own number, the last shorter", async () => {
    const begun = await begin(r, release, { name: "big.bin", size: 16 * 1024 * 1024 + 7 });
    expect(begun.body.part_count).toBe(2);
    const bytes = bytesOf(begun.body.size, 3);
    const done = await upload(r, release, "big2.bin", bytes);
    expect(done.body).toMatchObject({ state: "completed", asset: { size: bytes.length } });
    await abort(r, begun.body.id);
  });

  it("answers a completed session's asset again, and ignores the list a retry sends", async () => {
    const begun = await begin(r, release, { name: "a.zip", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
    const again = await complete(r, begun.body.id, [{ part_number: 1, etag: "other" }]);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ state: "completed", asset: { name: "a.zip" } });
  });

  it("takes the declared content type, lowercased, as metadata", async () => {
    const done = await upload(r, release, "x.deb", bytesOf(5), {
      content_type: "Application/VND.Debian.Binary-Package",
    });
    expect(done.body.asset?.content_type).toBe("application/vnd.debian.binary-package");
  });
});

describe("beginning an upload", () => {
  it("refuses a bad name, type or size before anything is made", async () => {
    for (const [body, code] of [
      [{ name: "a/b", size: 1 }, "invalid_asset_name"],
      [{ name: "..", size: 1 }, "invalid_asset_name"],
      [{ name: "a\u0000b", size: 1 }, "invalid_asset_name"],
      [{ name: "a", size: 1, content_type: "text/plain; x=1" }, "invalid_content_type"],
      [{ name: "a", size: 2 * 1024 * 1024 * 1024 + 1 }, "asset_too_large"],
    ] as const) {
      const begun = await begin(r, release, body);
      expect([begun.status, begun.body.code], JSON.stringify(body)).toEqual([422, code]);
    }
    expect(await sessions(r.stub)).toEqual([]);
  });

  it("refuses a release that isn't there", async () => {
    const begun = await begin(r, release + 1000, { name: "a", size: 1 });
    expect([begun.status, begun.body.code]).toEqual([404, "release_not_found"]);
  });

  it("refuses a name taken, compared folded, unless it replaces", async () => {
    await upload(r, release, "App.zip", bytesOf(3));
    const taken = await begin(r, release, { name: "app.ZIP", size: 1 });
    expect([taken.status, taken.body.code]).toEqual([422, "asset_name_taken"]);
    expect((await begin(r, release, { name: "app.ZIP", size: 1, replace: true })).status).toBe(201);
  });

  it("keeps the number of open sessions under the cap", async () => {
    for (let i = 0; i < MAX_ASSET_UPLOADS; i++)
      expect((await begin(r, release, { name: `f${i}`, size: 1 })).status).toBe(201);
    const over = await begin(r, release, { name: "one-more", size: 1 });
    expect([over.status, over.body.code]).toEqual([409, "too_many_uploads"]);
  });

  it("refuses what the account has no room for, and leaves no session open", async () => {
    await setLimit(500);
    const begun = await begin(r, release, { name: "a", size: 501 });
    expect([begun.status, begun.body.code]).toEqual([403, "quota_exceeded"]);
    expect((await sessions(r.stub)).map((s) => s.state)).toEqual(["aborted"]);
    expect((await quota()).reserved_bytes).toBe(0);
  });

  it("needs write access", async () => {
    const reader = await scopedToken(r.owner.principalId, ["contents:read"]);
    const begun = await begin(r, release, { name: "a", size: 1 }, reader);
    expect([begun.status, begun.body.code]).toEqual([403, "missing_permission"]);
  });
});

describe("a part", () => {
  it("must have its exact length, its number, and come from whoever began the session", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const url = begun.body.parts_url;
    expect((await putPart(url, 1, bytesOf(9), r.owner.token)).body.code).toBe(
      "invalid_part_length",
    );
    expect((await putPart(url, 2, bytesOf(10), r.owner.token)).body.code).toBe("invalid_part");
    expect((await putPart(url, 0, bytesOf(10), r.owner.token)).body.code).toBe("invalid_part");
    const other = (await (await import("./helpers/api.js")).user()).token;
    expect((await putPart(url, 1, bytesOf(10), other)).status).toBe(404);
    const gzip = await putPart(url, 1, bytesOf(10), r.owner.token, { "Content-Encoding": "gzip" });
    expect([gzip.status, gzip.body.code]).toEqual([415, "unsupported_encoding"]);
  });

  it("replaces a part sent again; the later etag completes it", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const first = await putPart(begun.body.parts_url, 1, bytesOf(10, 1), r.owner.token);
    const second = await putPart(begun.body.parts_url, 1, bytesOf(10, 2), r.owner.token);
    expect(second.body.etag).not.toBe(first.body.etag);
    const done = await complete(r, begun.body.id, [
      { part_number: 1, etag: second.body.etag as string },
    ]);
    expect(done.body.state).toBe("completed");
    const { assets } = await objectIds(r.stub);
    const stored = await env.ASSETS.get(`release-assets/${r.id}/${assets[0]}`);
    expect(new Uint8Array(await (stored as R2ObjectBody).arrayBuffer())).toEqual(bytesOf(10, 2));
  });

  it("isn't taken once the session is aborted or completed", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    await abort(r, begun.body.id);
    const late = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    expect([late.status, late.body.code]).toEqual([409, "upload_not_receiving"]);
  });

  it("isn't taken after the session expired", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    await inRepo(r.stub, ({ git }) =>
      git.context.storage.sql.exec("UPDATE release_asset_uploads SET expires_at = 1"),
    );
    const late = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    expect([late.status, late.body.code]).toEqual([410, "upload_expired"]);
  });
});

describe("completing", () => {
  it("checks the list before the session takes it", async () => {
    const begun = await begin(r, release, { name: "a", size: 16 * 1024 * 1024 + 1 });
    for (const parts of [
      [{ part_number: 1, etag: "x" }],
      [
        { part_number: 2, etag: "x" },
        { part_number: 1, etag: "y" },
      ],
      [
        { part_number: 1, etag: "x" },
        { part_number: 1, etag: "y" },
      ],
      [
        { part_number: 1, etag: "x" },
        { part_number: 2, etag: "y" },
        { part_number: 3, etag: "z" },
      ],
    ]) {
      const done = await complete(r, begun.body.id, parts);
      expect([done.status, done.body.code], JSON.stringify(parts)).toEqual([422, "invalid_parts"]);
    }
    expect((await sessions(r.stub)).map((s) => s.state)).toEqual(["receiving"]);
  });

  it("ends the session on an etag R2 doesn't know, deleting nothing else, and a new one works", async () => {
    await upload(r, release, "kept", bytesOf(4));
    const begun = await begin(r, release, { name: "a", size: 10 });
    await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const done = await complete(r, begun.body.id, [{ part_number: 1, etag: "0".repeat(32) }]);
    expect([done.status, done.body.code]).toEqual([422, "invalid_parts"]);
    expect((await sessions(r.stub)).find((s) => s.upload_id === begun.body.id)?.state).toBe(
      "aborted",
    );
    expect((await upload(r, release, "a", bytesOf(10))).body.state).toBe("completed");
    expect((await releaseOf()).assets.map((a) => (a as { name: string }).name)).toEqual([
      "a",
      "kept",
    ]);
  });

  it("is only for the token that began the session", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const other = await scopedToken(r.owner.principalId, ["contents:write"]);
    const done = await complete(
      r,
      begun.body.id,
      [{ part_number: 1, etag: put.body.etag as string }],
      other,
    );
    expect([done.status, done.body.code]).toEqual([409, "wrong_token"]);
  });

  it("refuses an asset the account has no room for, and lets its object go", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    // The limit lowered after the session reserved its bytes.
    await setLimit(5);
    const done = await complete(r, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect([done.status, done.body.code]).toEqual([403, "quota_exceeded"]);
    expect((await releaseOf()).assets).toEqual([]);
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.total]).toEqual([0, 0]);
  });

  it("fills the quota to the last byte, leaving no hold", async () => {
    const before = await quota();
    await setLimit(before.storage_bytes + 10);
    expect((await upload(r, release, "a", bytesOf(10))).body.state).toBe("completed");
    expect(await quota()).toMatchObject({
      storage_bytes: before.storage_bytes + 10,
      reserved_bytes: 0,
    });
  });

  it("refuses with nothing decided while the account won't take the total, and the retry commits", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    // The account answers not_here, as it does while it doesn't hold the repository.
    await inRepoOrg((sql) =>
      sql.exec(
        "INSERT INTO released_repos (repo_id, transfer_id, released_at) VALUES (?, 't', 0)",
        r.id,
      ),
    );
    const refused = await complete(r, begun.body.id, parts);
    expect([refused.status, refused.body.code]).toEqual([503, "quota_unavailable"]);
    expect((await sessions(r.stub))[0]?.state).toBe("completing");
    await inRepoOrg((sql) => sql.exec("DELETE FROM released_repos WHERE repo_id = ?", r.id));
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
  });

  it("counts another completing session's bytes once, not in its hold as well", async () => {
    const before = await quota();
    await setLimit(before.storage_bytes + 20);
    const first = await begin(r, release, { name: "a", size: 10 });
    const firstPut = await putPart(first.body.parts_url, 1, bytesOf(10), r.owner.token);
    const firstParts = [{ part_number: 1, etag: firstPut.body.etag as string }];
    // The first completion stops in completing: the account answers not_here.
    await inRepoOrg((sql) =>
      sql.exec(
        "INSERT INTO released_repos (repo_id, transfer_id, released_at) VALUES (?, 't', 0)",
        r.id,
      ),
    );
    expect((await complete(r, first.body.id, firstParts)).status).toBe(503);
    await inRepoOrg((sql) => sql.exec("DELETE FROM released_repos WHERE repo_id = ?", r.id));
    const second = await begin(r, release, { name: "b", size: 10 });
    const put = await putPart(second.body.parts_url, 1, bytesOf(10), r.owner.token);
    const done = await complete(r, second.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect([done.status, done.body.state]).toEqual([200, "completed"]);
    expect((await complete(r, first.body.id, firstParts)).body.state).toBe("completed");
    expect(await quota()).toMatchObject({
      storage_bytes: before.storage_bytes + 20,
      reserved_bytes: 0,
    });
  });

  it("commits on a retry after the object stopped before deciding", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {
        step: (step) => {
          if (step === "sent") throw new Error("stopped");
        },
      };
    });
    expect((await complete(r, begun.body.id, parts)).status).toBe(500);
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {};
    });
    expect((await sessions(r.stub))[0]?.state).toBe("completing");
    // R2 made the object; the retry finds the upload gone and the object there.
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
    expect((await counted(r.stub)).asset_bytes).toBe(10);
  });

  it("counts a size R2 assembled wrong as a refusal, and deletes the object", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    await wrapBucket(
      r.stub,
      (bucket) =>
        ({
          ...bucket,
          head: bucket.head.bind(bucket),
          delete: bucket.delete.bind(bucket),
          resumeMultipartUpload: (key: string, id: string) => {
            const upload = bucket.resumeMultipartUpload(key, id);
            return {
              ...upload,
              abort: upload.abort.bind(upload),
              complete: async (parts: R2UploadedPart[]) => {
                const object = await upload.complete(parts);
                return { ...object, size: 9 } as R2Object;
              },
            } as R2MultipartUpload;
          },
        }) as R2Bucket,
    );
    const done = await complete(r, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect([done.status, done.body.code]).toEqual([422, "size_mismatch"]);
    const { assets } = await objectIds(r.stub);
    expect(assets).toEqual([]);
  });

  it("takes an upload R2 no longer knows as done when its object is there at the right size", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    // Another holder's assembly landed first: R2 answers this one 10024.
    await wrapBucket(
      r.stub,
      (bucket) =>
        ({
          ...bucket,
          head: bucket.head.bind(bucket),
          delete: bucket.delete.bind(bucket),
          resumeMultipartUpload: (key: string, id: string) => {
            const upload = bucket.resumeMultipartUpload(key, id);
            return {
              ...upload,
              abort: upload.abort.bind(upload),
              complete: async (parts: R2UploadedPart[]) => {
                await upload.complete(parts);
                throw new Error(
                  "completeMultipartUpload: The specified multipart upload does not exist. (10024)",
                );
              },
            } as R2MultipartUpload;
          },
        }) as R2Bucket,
    );
    const done = await complete(r, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect(done.body.state).toBe("completed");
  });

  it("leaves the session as it was on an error it can't read, and the retry commits", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    let failing = true;
    await wrapBucket(
      r.stub,
      (bucket) =>
        ({
          ...bucket,
          head: bucket.head.bind(bucket),
          delete: bucket.delete.bind(bucket),
          resumeMultipartUpload: (key: string, id: string) => {
            const upload = bucket.resumeMultipartUpload(key, id);
            return {
              ...upload,
              abort: upload.abort.bind(upload),
              complete: async (list: R2UploadedPart[]) => {
                if (failing) {
                  failing = false;
                  throw new Error("internal error (10001)");
                }
                return upload.complete(list);
              },
            } as R2MultipartUpload;
          },
        }) as R2Bucket,
    );
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completing");
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
  });

  it("lets a later holder decide: one whose lock lapsed touches nothing", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    const uploadId = begun.body.id;
    const principal = r.owner.principalId;
    const etag = put.body.etag as string;
    const repoId = r.id;
    // The first holder's assembly lands; its lock lapses and a retry takes the token and
    // assembles too. The first then decides while the retry is still completing: it must touch
    // nothing. Then the retry decides and commits.
    await inRepo(r.stub, (repo) => {
      let sent = 0;
      let retry: Promise<unknown> | undefined;
      let retryAtSent: () => void = () => {};
      const retryReachedSent = new Promise<void>((resolve) => {
        retryAtSent = resolve;
      });
      let firstDecided: () => void = () => {};
      const firstHasDecided = new Promise<void>((resolve) => {
        firstDecided = resolve;
      });
      repo.assetHooks = {
        step: async (step) => {
          const sql = repo.git.context.storage.sql;
          if (step === "sent" && ++sent === 1) {
            sql.exec("UPDATE locks SET expires_at = 0 WHERE name LIKE 'release-asset-complete:%'");
            const tokenId = sql
              .exec<{ token_id: string }>("SELECT token_id FROM release_asset_uploads")
              .one().token_id;
            retry = repo.completeReleaseAsset({
              uploadId,
              actor: { principal, tokenId, via: "api" },
              parts: [{ partNumber: 1, etag }],
              decision: { tokenId, decidedAt: 0, actChain: [], requestId: null },
            });
            await retryReachedSent;
          } else if (step === "sent") {
            retryAtSent();
            await firstHasDecided;
          } else if (step === "decided" && retry) {
            const pending = retry;
            retry = undefined;
            // The first holder has decided: nothing changed, the retry still holds the session.
            const row = sql
              .exec<{ state: string }>("SELECT state FROM release_asset_uploads")
              .one();
            const assets = sql
              .exec<{ n: number }>("SELECT count(*) AS n FROM release_assets")
              .one();
            const object = sql
              .exec<{ object_id: string }>("SELECT object_id FROM release_asset_uploads")
              .one().object_id;
            const stored = await repo.assetBucket.head(`release-assets/${repoId}/${object}`);
            if (row.state !== "completing" || assets.n !== 0 || stored === null)
              throw new Error(`a fenced holder changed something: ${row.state}, ${assets.n}`);
            firstDecided();
            const second = (await pending) as { ok: boolean; view?: { state: string } };
            if (!second.ok || second.view?.state !== "completed")
              throw new Error(`the retry didn't commit: ${JSON.stringify(second)}`);
          }
        },
      };
    });
    const first = await complete(r, uploadId, parts);
    expect(first.status).toBe(200);
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.total]).toEqual([10, 10]);
    const { assets } = await objectIds(r.stub);
    expect(assets).toHaveLength(1);
    expect(await objectOf(r.id, assets[0] as string)).not.toBeNull();
  });

  it("sends nothing to R2 for a holder fenced before its assembly", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    // After this holder's total was taken, a retry took the token (its lock having lapsed) and
    // is still completing: this holder must neither assemble nor decide.
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {
        step: (step) => {
          if (step === "stated")
            repo.git.context.storage.sql.exec(
              "UPDATE release_asset_uploads SET completion_token = 'another holder'",
            );
          if (step === "sending") throw new Error("a fenced holder assembled");
        },
      };
    });
    const fenced = await complete(r, begun.body.id, parts);
    expect([fenced.status, fenced.body.state]).toEqual([200, "completing"]);
    const [row] = await sessions(r.stub);
    expect([row?.state, row?.settle_after]).toEqual(["completing", null]);
  });

  it("leaves a session completing while the repository moves, and commits it after", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    // A transfer freezes the repository while R2 assembles.
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {
        step: (step) => {
          if (step === "sent")
            repo.git.context.storage.sql.exec(
              "UPDATE repo_meta SET transfer_id = 'trf_x', transfer_to = 'someone', write_frozen = 1",
            );
        },
      };
    });
    const moving = await complete(r, begun.body.id, parts);
    expect([moving.status, moving.body.code]).toEqual([409, "release_asset_transferring"]);
    expect((await sessions(r.stub))[0]?.state).toBe("completing");
    // Called off (or landed): the retry commits.
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {};
      repo.git.context.storage.sql.exec(
        "UPDATE repo_meta SET transfer_id = NULL, transfer_to = NULL, write_frozen = 0",
      );
    });
    expect((await complete(r, begun.body.id, parts)).body.state).toBe("completed");
  });

  it("leaves a collaborator's session completing when the repository lands during assembly", async () => {
    const writer = await user();
    await api("PUT", `${r.path}/collaborators/${writer.handle}`, r.owner.token, {
      permission: "push",
    });
    const begun = await begin(r, release, { name: "a", size: 10 }, writer.token);
    expect(begun.status).toBe(201);
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), writer.token);
    const parts = [{ part_number: 1, etag: put.body.etag as string }];
    // A transfer lands while R2 assembles: a new owner generation, and the old account's ACL
    // snapshot dropped. The roles pulled before mean nothing now; the retry pulls them again.
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {
        step: (step) => {
          if (step !== "sent") return;
          const sql = repo.git.context.storage.sql;
          sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
          sql.exec("DELETE FROM acl_snapshot");
        },
      };
    });
    const landed = await complete(r, begun.body.id, parts, writer.token);
    expect(landed).toMatchObject({ status: 409, body: { code: "release_asset_transferring" } });
    expect((await sessions(r.stub))[0]?.state).toBe("completing");
    await inRepo(r.stub, (repo) => {
      repo.assetHooks = {};
    });
    expect((await complete(r, begun.body.id, parts, writer.token)).body.state).toBe("completed");
  });

  it("ends the session when the token's check refuses it, and deletes the object R2 made", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    const tokenId = await inRepo(
      r.stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ token_id: string }>("SELECT token_id FROM release_asset_uploads")
          .one().token_id,
    );
    const answer = await r.stub.completeReleaseAsset({
      uploadId: begun.body.id,
      actor: { principal: r.owner.principalId, tokenId, via: "api" },
      parts: [{ partNumber: 1, etag: put.body.etag as string }],
      decision: {
        refusal: "the token used for this push is no longer valid",
        tokenId,
        decidedAt: 0,
        actChain: [],
        requestId: null,
      },
    });
    expect(answer).toMatchObject({ ok: false, status: 403, code: "access_lost" });
    expect((await sessions(r.stub))[0]?.state).toBe("aborted");
    const object = await inRepo(
      r.stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ object_id: string }>("SELECT object_id FROM release_asset_uploads")
          .one().object_id,
    );
    expect(await objectOf(r.id, object)).toBeNull();
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.total]).toEqual([0, 0]);
  });

  it("refuses an asset whose release was deleted meanwhile", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(10), r.owner.token);
    await api("DELETE", `${r.path}/releases/${release}`, r.owner.token);
    const done = await complete(r, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect([done.status, done.body.code]).toEqual([404, "release_not_found"]);
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.total]).toEqual([0, 0]);
  });

  it("gives a name to the first of two sessions to finish; the other's object goes", async () => {
    const one = await begin(r, release, { name: "same", size: 10 });
    const two = await begin(r, release, { name: "same", size: 10 });
    const p1 = await putPart(one.body.parts_url, 1, bytesOf(10, 1), r.owner.token);
    const p2 = await putPart(two.body.parts_url, 1, bytesOf(10, 2), r.owner.token);
    expect(
      (await complete(r, one.body.id, [{ part_number: 1, etag: p1.body.etag as string }])).body
        .state,
    ).toBe("completed");
    const lost = await complete(r, two.body.id, [{ part_number: 1, etag: p2.body.etag as string }]);
    expect([lost.status, lost.body.code]).toEqual([422, "asset_name_taken"]);
    expect((await counted(r.stub)).asset_bytes).toBe(10);
  });
});

describe("replacing and deleting", () => {
  it("keeps a replaced object, counted until purged", async () => {
    await upload(r, release, "a", bytesOf(10, 1));
    const before = await objectIds(r.stub);
    const done = await upload(r, release, "a", bytesOf(20, 2), { replace: true });
    expect(done.body.asset).toMatchObject({ name: "a", size: 20 });
    const after = await objectIds(r.stub);
    expect(after.retained).toEqual(before.assets);
    expect(after.assets).not.toEqual(before.assets);
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.rows]).toEqual([30, 30]);
    expect(await objectOf(r.id, before.assets[0] as string)).not.toBeNull();
  });

  it("keeps a deleted asset's object, counted", async () => {
    const made = await upload(r, release, "a", bytesOf(10));
    const id = made.body.asset?.id as number;
    const deleted = await json(api("DELETE", `${r.path}/releases/assets/${id}`, r.owner.token));
    expect(deleted).toEqual({ status: 200, body: { id, state: "deleted" } });
    expect((await releaseOf()).assets).toEqual([]);
    const c = await counted(r.stub);
    expect([c.asset_bytes, c.rows]).toEqual([10, 10]);
    const gone = await json(api("GET", `${r.path}/releases/assets/${id}`, r.owner.token));
    expect([gone.status, gone.body.code]).toEqual([404, "asset_not_found"]);
  });

  it("keeps every asset's object of a deleted release, counted", async () => {
    await upload(r, release, "a", bytesOf(10));
    await upload(r, release, "b", bytesOf(5));
    await api("DELETE", `${r.path}/releases/${release}`, r.owner.token);
    const ids = await objectIds(r.stub);
    expect([ids.assets.length, ids.retained.length]).toEqual([0, 2]);
    expect((await counted(r.stub)).asset_bytes).toBe(15);
  });

  it("shows what is retained", async () => {
    await upload(r, release, "a", bytesOf(10));
    await upload(r, release, "a", bytesOf(4), { replace: true });
    const retained = await json<{ objects: number; bytes: number; next_purge_at: number | null }>(
      api("GET", `${r.path}/releases/retained`, r.owner.token),
    );
    expect(retained.status).toBe(200);
    expect(retained.body).toMatchObject({ objects: 1, bytes: 10 });
    expect(retained.body.next_purge_at).toBeGreaterThan(await clockOf(r.stub));
  });
});

describe("aborting", () => {
  it("ends the session and frees its hold", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const ended = await abort(r, begun.body.id);
    expect(ended.body.state).toBe("aborted");
    expect((await quota()).reserved_bytes).toBe(0);
    const done = await complete(r, begun.body.id, [{ part_number: 1, etag: "x" }]);
    expect([done.status, done.body.code]).toEqual([409, "upload_aborted"]);
  });

  it("answers the aborted session though the job cleared it while R2 was asked", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    await inRepo(r.stub, (repo) => {
      const bucket = env.ASSETS;
      repo.assetBucket = {
        ...bucket,
        head: bucket.head.bind(bucket),
        delete: bucket.delete.bind(bucket),
        resumeMultipartUpload: (key: string, id: string) => {
          const upload = bucket.resumeMultipartUpload(key, id);
          return {
            ...upload,
            // The job runs while the abort waits on R2, and clears the ended session.
            abort: async () => {
              await upload.abort();
              await repo.releaseAssets.slice();
            },
          } as R2MultipartUpload;
        },
      } as R2Bucket;
    });
    const ended = await abort(r, begun.body.id);
    expect([ended.status, ended.body.state]).toEqual([200, "aborted"]);
    expect(await sessions(r.stub)).toEqual([]);
  });

  it("is only for whoever began the session", async () => {
    const begun = await begin(r, release, { name: "a", size: 10 });
    const other = await (await import("./helpers/api.js")).user();
    const ended = await abort(r, begun.body.id, other.token);
    expect(ended.status).toBe(404);
  });
});
