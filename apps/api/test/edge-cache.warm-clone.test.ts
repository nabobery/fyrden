// Pack blocks survive eviction of the repository object: a clone that
// regenerates its pack after the object was evicted (its in-memory block
// tier is gone) finds the blocks in the network-scoped Cache API tier
// instead of reading them from R2 again.

import { evictDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, inject, it } from "vitest";
import {
  fetchBody,
  loadFixture,
  packObjects,
  parseFetchResponse,
  recordingMetrics,
  throughWorker,
} from "./helpers/fetch-repo.js";
import { basic, createRepo, ORIGIN, type TestRepo } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";

const fixtures = inject("fetchFixtures");
const single = fixtures.single;
const wants = [...new Set(single.refs.map((r) => r.oid))].map((oid) => `want ${oid}`);

let owner: { principalId: string; token: string };

beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

async function clone(repo: TestRepo, plan: "free" | "paid", extra: string[] = []) {
  const handle = owner.principalId.toLowerCase().replace("_", "-");
  const metrics = recordingMetrics();
  let bytes = new Uint8Array(0);
  await throughWorker(
    new Request(`${ORIGIN}/${handle}/${repo.name}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        Authorization: basic(owner.token),
      },
      body: fetchBody([...wants, "ofs-delta", "no-progress", ...extra, "done"]),
    }),
    { plan, metrics: metrics.dataset },
    async (response) => {
      expect(response.status).toBe(200);
      bytes = new Uint8Array(await response.arrayBuffer());
    },
  );
  const sum = (name: string, ...blobs: string[]) =>
    metrics.points
      .filter((p) => p.name === name && blobs.every((b, i) => p.blobs[i] === b))
      .reduce((n, p) => n + p.value, 0);
  const pack = parseFetchResponse(bytes).pack as Uint8Array;
  return {
    oids: (await packObjects(pack)).oids,
    regenerated: metrics.points.some(
      (p) => p.name === "git.fetch" && p.blobs[1] === "regenerated" && p.blobs[3] === "false",
    ),
    memoryHits: sum("git.fetch.blocks", "memory"),
    cacheApiHits: sum("git.fetch.blocks", "cache_api"),
    misses: sum("git.fetch.blocks", "miss"),
    doR2: sum("git.fetch.calls", "do", "r2"),
  };
}

describe.each(["free", "paid"] as const)("warm clone after eviction (plan %s)", (plan) => {
  it("reads pack blocks from the Cache API tier, not R2", async () => {
    const repo = await createRepo(owner.principalId);
    // Not all-reachable: every clone regenerates its pack, reading blocks.
    await loadFixture(repo.stub, single, { allReachable: false });

    const cold = await clone(repo, plan);
    expect(cold.oids).toEqual(single.objects);
    expect(cold.regenerated).toBe(true);
    expect(cold.misses).toBeGreaterThan(0);
    expect(cold.cacheApiHits).toBe(0);

    await evictDurableObject(repo.stub);

    // A request that differs in a capability is planned afresh (it never
    // shares the stored regenerated pack), so it reads the blocks again.
    const warm = await clone(repo, plan, ["include-tag"]);
    expect(warm.oids).toEqual(single.objects);
    expect(warm.regenerated).toBe(true);
    expect(warm.cacheApiHits).toBeGreaterThan(0);
    expect(warm.misses).toBe(0);
    expect(warm.doR2).toBeLessThan(cold.doR2);
  });
});
