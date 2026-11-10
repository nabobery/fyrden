// Release assets across a transfer: the arrival holds the repository's
// total as the frozen repository states it, adoption counts it at the new
// account in the same step that ends the hold, and the old account counts
// it no more. A session still receiving must fit at the new account.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { transferHooks } from "../src/repos/transfer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  assetSlice,
  begin,
  bytesOf,
  complete,
  counted,
  draft,
  putPart,
  upload,
} from "./helpers/release-assets.js";
import { releaseRepo } from "./helpers/releases.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

async function newOrg(owner: Who): Promise<string> {
  const login = uniqueId("org").slice(0, 39);
  const res = await api("POST", "/admin/organizations", admin.token, {
    login,
    admin: owner.handle,
  });
  expect(res.status).toBe(201);
  return login;
}

const storage = async (path: string, token: string) =>
  (await json<{ storage_bytes: number; reserved_bytes: number }>(api("GET", path, token))).body;

describe("a transfer", () => {
  it("moves the assets' total, retained objects included, to the new account", async () => {
    const r = await releaseRepo(fx.repo);
    const release = await draft(r);
    const pushed = (await storage("/user/quota", r.owner.token)).storage_bytes;
    await upload(r, release, "a", bytesOf(10, 1));
    await upload(r, release, "a", bytesOf(4, 2), { replace: true });
    expect((await storage("/user/quota", r.owner.token)).storage_bytes).toBe(pushed + 14);
    const org = await newOrg(r.owner);
    const moved = await json<{ state: string }>(
      api("POST", `${r.path}/transfer`, r.owner.token, { new_owner: org }),
    );
    expect(moved.status).toBe(200);
    expect((await storage("/user/quota", r.owner.token)).storage_bytes).toBe(0);
    const there = await storage(`/orgs/${org}/quota`, r.owner.token);
    expect(there).toMatchObject({ storage_bytes: pushed + 14, reserved_bytes: 0 });
  });

  it("is refused at once when the new account has no room for the assets", async () => {
    const r = await releaseRepo(fx.repo);
    const release = await draft(r);
    const pushed = (await storage("/user/quota", r.owner.token)).storage_bytes;
    await upload(r, release, "a", bytesOf(10));
    const org = await newOrg(r.owner);
    await api("PUT", `/admin/accounts/${org}/quota`, admin.token, {
      max_storage_bytes: pushed + 9,
    });
    const refused = await json<{ code: string }>(
      api("POST", `${r.path}/transfer`, r.owner.token, { new_owner: org }),
    );
    expect([refused.status, refused.body.code]).toEqual([403, "quota_exceeded"]);
  });

  it("makes a session still receiving fit at the new account, which counts it", async () => {
    const r = await releaseRepo(fx.repo);
    const release = await draft(r);
    const begun = await begin(r, release, { name: "late", size: 10 });
    const org = await newOrg(r.owner);
    const pushed = (await storage("/user/quota", r.owner.token)).storage_bytes;
    expect(
      (await api("POST", `${r.path}/transfer`, r.owner.token, { new_owner: org })).status,
    ).toBe(200);
    const path = `/repos/${org}/${r.name}`;
    const moved = { ...r, path };
    const put = await putPart(
      begun.body.parts_url.replace(`/${r.owner.handle}/`, `/${org}/`),
      1,
      bytesOf(10),
      r.owner.token,
    );
    expect(put.status).toBe(200);
    const done = await complete(moved, begun.body.id, [
      { part_number: 1, etag: put.body.etag as string },
    ]);
    expect(done.body.state).toBe("completed");
    expect((await storage(`/orgs/${org}/quota`, r.owner.token)).storage_bytes).toBe(pushed + 10);
    const c = await counted(r.stub);
    expect(c.told_seq).toBe(c.usage_seq);
  });

  it("tells the new account the total afresh once it lands, whatever the arrival took", async () => {
    const r = await releaseRepo(fx.repo);
    await draft(r);
    const pushed = (await storage("/user/quota", r.owner.token)).storage_bytes;
    const org = await newOrg(r.owner);
    const orgId = (
      await env.DIRECTORY.prepare("SELECT id FROM principals WHERE handle = ?").bind(org).first<{
        id: string;
      }>()
    )?.id as string;
    // As if a session the arrival counted (10 bytes) ended, and the old account was told, before
    // the new account adopted the arrival's total: the adopted total is stale, and the repository
    // owes no statement. The hook runs in the transfer's request, so it takes its own stubs.
    let staged = false;
    transferHooks.afterGeneration = async () => {
      const stub = env.REPO.getByName(r.id);
      const seq = await inRepo(stub, ({ git }) => {
        const sql = git.context.storage.sql;
        sql.exec("UPDATE release_asset_counters SET told_seq = usage_seq");
        return sql.exec<{ usage_seq: number }>("SELECT usage_seq FROM release_asset_counters").one()
          .usage_seq;
      });
      const epoch = await inRepo(stub, (repo) => repo.events.epochGen());
      await runInDurableObject(env.ORG.getByName(orgId), (_: unknown, state) => {
        state.storage.sql.exec(
          `INSERT INTO quota_assets (repo_id, bytes, epoch_gen, seq) VALUES (?, 10, ?, ?)
           ON CONFLICT (repo_id) DO UPDATE SET bytes = 10, epoch_gen = excluded.epoch_gen,
             seq = excluded.seq`,
          r.id,
          epoch,
          seq,
        );
      });
      staged = true;
    };
    try {
      const moved = await json<{ state: string }>(
        api("POST", `${r.path}/transfer`, r.owner.token, { new_owner: org }),
      );
      expect([moved.status, moved.body.state, staged]).toEqual([200, "transferred", true]);
    } finally {
      delete transferHooks.afterGeneration;
    }
    await assetSlice(r.stub);
    expect((await storage(`/orgs/${org}/quota`, r.owner.token)).storage_bytes).toBe(pushed);
  });
});
