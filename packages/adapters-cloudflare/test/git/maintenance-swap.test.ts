import { env } from "cloudflare:workers";
import { oidFromBytes, type PackId } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { newPackId, packObjectKey } from "../../src/git/keys.js";
import { swapPacks } from "../../src/git/maintenance-swap.js";
import type { RepoGitStorage } from "../../src/git/repo-git-storage.js";
import { inProbe, newProbe } from "./harness.js";

/*
 * The one transaction a repack or collection ends with: outputs in, sources
 * superseded, garbage marked, flags set, dependencies of uploads not yet
 * committed moved to the outputs; or nothing at all.
 */

const oid = (n: number) => oidFromBytes(new Uint8Array(20).fill(n));

async function pack(git: RepoGitStorage, state: string, allReachable = 0): Promise<PackId> {
  const packId = newPackId(git.context.now());
  git.registry.createPending({ packId, networkId: git.networkId(), kind: "receive" });
  await env.GIT.put(packObjectKey(git.networkId(), packId, "pack"), new Uint8Array([1]));
  git.context.storage.sql
    .exec(
      "UPDATE packs SET state = ?, bytes = 1, all_reachable = ? WHERE pack_id = ?",
      state,
      allReachable,
      packId,
    )
    .toArray();
  return packId;
}

const states = (git: RepoGitStorage, ids: readonly string[]) =>
  ids.map((id) => git.registry.get(id)?.state);
const flag = (git: RepoGitStorage, id: string) =>
  git.context.storage.sql
    .exec<{ f: number }>("SELECT all_reachable AS f FROM packs WHERE pack_id = ?", id)
    .one().f;

describe("swapPacks", () => {
  it("swaps outputs for sources, marks garbage, condemns, inherits the flag", async () => {
    const { stub } = await newProbe();
    await inProbe(stub, async ({ git }) => {
      const a = await pack(git, "live", 1);
      const b = await pack(git, "live", 1);
      const out = await pack(git, "indexing");
      const junk = await pack(git, "indexing");
      const oldGarbage = await pack(git, "garbage");
      expect(
        swapPacks(git, {
          remove: [a, b],
          live: [out],
          garbage: [junk],
          condemn: [oldGarbage],
          inheritAllReachable: true,
          respectLeases: true,
          waitForIndexing: true,
        }),
      ).toEqual({ ok: true });
      expect(states(git, [a, b, out, junk, oldGarbage])).toEqual([
        "superseded",
        "superseded",
        "live",
        "garbage",
        "condemned",
      ]);
      expect(flag(git, out)).toBe(1);
    });
  });

  it("refuses, changing nothing, while a source is leased or an upload is being indexed (unless told not to wait)", async () => {
    const { stub } = await newProbe();
    await inProbe(stub, async ({ git }) => {
      const a = await pack(git, "live");
      const out = await pack(git, "indexing");
      const lease = git.leases.grant("read", [a], "clone", 60_000);
      if (!lease.ok) throw new Error("not leased");
      const request = { remove: [a], live: [out], respectLeases: true, waitForIndexing: true };
      expect(swapPacks(git, request)).toEqual({ ok: false, reason: "leased" });
      git.leases.release(lease.leaseId);
      const upload = git.uploads.begin({
        networkId: git.networkId(),
        principal: "usr_1",
        commands: [],
        atomic: true,
        withPack: true,
        ttlMs: 60_000,
        leaseTtlMs: 60_000,
      });
      git.uploads.markUploaded(upload.uploadId, { bytes: 1 });
      expect(swapPacks(git, request)).toEqual({ ok: false, reason: "indexing" });
      expect(states(git, [a, out])).toEqual(["live", "indexing"]);
      expect(swapPacks(git, { ...request, waitForIndexing: false })).toEqual({ ok: true });
    });
  });

  it("refuses when a source is no longer live or an output not finished", async () => {
    const { stub } = await newProbe();
    await inProbe(stub, async ({ git }) => {
      const a = await pack(git, "superseded");
      const out = await pack(git, "indexing");
      expect(
        swapPacks(git, { remove: [a], live: [out], respectLeases: true, waitForIndexing: true }),
      ).toEqual({
        ok: false,
        reason: "packs-changed",
      });
      const b = await pack(git, "live");
      const pending = await pack(git, "pending");
      expect(
        swapPacks(git, {
          remove: [b],
          live: [pending],
          respectLeases: true,
          waitForIndexing: true,
        }),
      ).toMatchObject({
        reason: "packs-changed",
      });
      expect(states(git, [b, pending])).toEqual(["live", "pending"]);
    });
  });

  it("moves the dependencies of uploads not yet committed from removed packs to the outputs", async () => {
    const { stub } = await newProbe();
    await inProbe(stub, async ({ git }) => {
      const a = await pack(git, "live");
      const keep = await pack(git, "live");
      const out = await pack(git, "indexing");
      const junk = await pack(git, "indexing");
      const upload = git.uploads.begin({
        networkId: git.networkId(),
        principal: "usr_1",
        commands: [],
        atomic: true,
        withPack: false,
        ttlMs: 60_000,
        leaseTtlMs: 60_000,
      });
      git.uploads.markBodyStored(upload.uploadId);
      git.uploads.markIndexed(upload.uploadId, { deps: [a, keep] });
      swapPacks(git, {
        remove: [a],
        live: [out],
        garbage: [junk],
        respectLeases: true,
        waitForIndexing: true,
      });
      expect(git.uploads.get(upload.uploadId)?.deps.sort()).toEqual([keep, out, junk].sort());
    });
  });

  it("flags packs all-reachable only if no non-fast-forward update happened since the mark", async () => {
    const { stub } = await newProbe();
    await inProbe(stub, async ({ git }) => {
      const a = await pack(git, "live");
      const nonff = git.refStore.state().nonffVersion;
      swapPacks(git, {
        remove: [],
        live: [],
        allReachable: { packIds: [a], nonffVersion: nonff + 1 },
        respectLeases: false,
        waitForIndexing: false,
      });
      expect(flag(git, a)).toBe(0);
      swapPacks(git, {
        remove: [],
        live: [],
        allReachable: { packIds: [a], nonffVersion: nonff },
        respectLeases: false,
        waitForIndexing: false,
      });
      expect(flag(git, a)).toBe(1);
    });
  });

  it("drops commit rows and touches garbage packs", async () => {
    const { stub } = await newProbe();
    await inProbe(stub, async ({ git }) => {
      const g = await pack(git, "garbage");
      git.context.storage.sql
        .exec("UPDATE packs SET last_touched_at = 1 WHERE pack_id = ?", g)
        .toArray();
      await git.commitGraph.insertPending("u", [
        { oid: oid(1), tree: oid(2), parents: [], commitTime: 1, generation: 1, level: 1 },
        { oid: oid(3), tree: oid(2), parents: [], commitTime: 1, generation: 1, level: 1 },
      ]);
      git.context.storage.sql
        .exec(
          "INSERT INTO commits SELECT oid, tree, parents, commit_time, generation, level, signature FROM pending_commits",
        )
        .toArray();
      // A fixed clock: the swap's "now" and the one read below must be the same instant.
      const at = git.context.now();
      (git.context as { now: () => number }).now = () => at;
      swapPacks(git, {
        remove: [],
        live: [],
        touch: [g],
        dropCommits: [oid(1)],
        respectLeases: false,
        waitForIndexing: false,
      });
      const rows = await git.commitGraph.read([oid(1), oid(3)], "verified");
      expect(rows.map((r) => r !== undefined)).toEqual([false, true]);
      expect(
        git.context.storage.sql
          .exec<{ t: number }>("SELECT last_touched_at AS t FROM packs WHERE pack_id = ?", g)
          .one().t,
      ).toBe(at);
    });
  });
});
