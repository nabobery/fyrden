// The orphan sweep of `net/<nid>/p/` follows the network's membership: a
// repository alone in its network sweeps the prefix itself; once it has a
// fork, its own sweep stops (an object without a row in its registry may be
// another member's) and the network collection sweeps instead, asking every
// member which pack ids their registries name.

import { env } from "cloudflare:workers";
import { newPackId } from "@fyrden/adapters-cloudflare/git";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { loadFixture } from "./helpers/fetch-repo.js";
import { DAY } from "./helpers/gc.js";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { setPolicy } from "./helpers/maintenance.js";
import { advanceNetwork, fork, inNetwork, type Owner, runNetworkJob } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");

let owner: Owner;
beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

/** An object under the pack prefix that no registry names. */
async function orphan(networkId: string): Promise<string> {
  const key = `net/${networkId}/p/${newPackId()}.pack`;
  await env.GIT.put(key, new Uint8Array([1, 2, 3]));
  return key;
}

/** Runs the repository's orphan reaper pass (its clock is far ahead, so every object is old). */
const reap = (repo: TestRepo) =>
  inRepo(repo.stub, async (r) => {
    r.git.jobs.ensure("reap_orphans", "reap-orphans");
    for (let i = 0; i < 20; i++) {
      await r.alarm();
      const job = r.git.jobs.get("reap-orphans");
      if (job?.state !== "queued" || job.cursor === null) break;
    }
  });

const exists = async (key: string) => (await env.GIT.head(key)) !== null;

describe("orphan sweep in a fork network", () => {
  it("a repository alone in its network sweeps the prefix itself", async () => {
    const p = await createRepo(owner.principalId);
    await loadFixture(p.stub, fx.repo);
    const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
    await setPolicy(p.stub);
    expect(await inNetwork(networkId, (n) => n.isSoleMember(p.id))).toBe(true);
    const key = await orphan(networkId);
    await reap(p);
    expect(await exists(key)).toBe(false);
  });

  it("with a fork, members stop sweeping and the network sweeps, keeping every member's packs", async () => {
    const p = await createRepo(owner.principalId);
    const packIds = await loadFixture(p.stub, fx.repo);
    const networkId = await inRepo(p.stub, ({ git }) => git.networkId());
    const { repo: f } = await fork(owner, p, owner);
    await setPolicy(p.stub);
    await setPolicy(f.stub);
    expect(await inNetwork(networkId, (n) => n.isSoleMember(p.id))).toBe(false);
    const key = await orphan(networkId);
    await reap(p);
    await reap(f);
    expect(await exists(key)).toBe(true);

    // The network's collection sweeps once the object is older than its TTL.
    await advanceNetwork(networkId, 2 * DAY);
    await inNetwork(networkId, (n) => n.startGc());
    await runNetworkJob(networkId, "gc");
    expect(await exists(key)).toBe(false);
    for (const id of packIds) {
      expect(await exists(`net/${networkId}/p/${id}.pack`)).toBe(true);
      expect(await exists(`net/${networkId}/p/${id}.idx`)).toBe(true);
    }
  });
});
