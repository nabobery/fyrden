// Geometric repack: own live packs that break the geometric progression are
// compacted into one pack across alarm slices (resumable from the job
// cursor and scratch checkpoints) and swapped in with one transaction. The
// packs are those git wrote (the fetch fixtures).
import { env } from "cloudflare:workers";
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { packObjectKey, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { createSha1Hasher, type PackId, PackIdx, parsePack, writeIdx } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import { selectGeometricRepack } from "../src/git/maintenance/repack-plan.js";
import type { CapUnit } from "../src/git/maintenance/tail-merge-plan.js";
import { loadFixture, packObjects } from "./helpers/fetch-repo.js";
import { packStates, runJob, setPolicy } from "./helpers/maintenance.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const fixtures = inject("fetchFixtures");
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const unit = (id: string, objects: number): CapUnit => ({
  id,
  packIds: [id as PackId],
  bytes: objects * 100,
  objects,
  createdAt: 0,
  leased: false,
});

/** The live compacted pack's bytes, its stored `.idx`, and the `.idx` the parser writes for those bytes. */
async function livePack(git: RepoGitStorage) {
  const live = git.registry.liveOwn();
  if (live.length !== 1) throw new Error(`${live.length} live packs`);
  const pack = live[0] as (typeof live)[number];
  const bytes = new Uint8Array(
    await ((await git.bucket.get(pack.r2Key)) as R2ObjectBody).arrayBuffer(),
  );
  const stored = new Uint8Array(
    await (
      (await git.bucket.get(packObjectKey(git.networkId(), pack.packId, "idx"))) as R2ObjectBody
    ).arrayBuffer(),
  );
  const parsed = await parsePack(
    (async function* () {
      yield bytes;
    })(),
    {
      zlib: createWorkersZlib(),
      memory: git.memory,
      readRange: async (o, n) => bytes.subarray(o, o + n),
    },
  );
  const idx = await writeIdx(parsed.entries, parsed.checksum, {
    createHasher: () => createSha1Hasher({ detectCollisions: false }),
  });
  parsed.release();
  return { pack, bytes, stored, parsedIdx: idx.bytes };
}

/** A repository holding the split fixture (two packs git wrote), flagged all-reachable or not. */
async function splitRepo(allReachable: boolean) {
  const { stub } = await newRepo();
  await setPolicy(stub, { geometricFactor: 1000 });
  const packIds = await loadFixture(stub, fixtures.split, { allReachable });
  return { stub, packIds };
}

describe("geometric repack selection (git repack --geometric)", () => {
  it("rolls up the small tail and leaves a progression alone", () => {
    const ids = (units: CapUnit[]) => units.map((u) => u.id);
    expect(
      ids(
        selectGeometricRepack(
          [unit("a", 1), unit("b", 1), unit("c", 1), unit("d", 8), unit("e", 100)],
          2,
          1e6,
        ),
      ),
    ).toEqual(["a", "b", "c"]);
    expect(selectGeometricRepack([unit("a", 4), unit("b", 8), unit("c", 16)], 2, 1e6)).toEqual([]);
    expect(
      ids(selectGeometricRepack([unit("a", 10), unit("b", 11), unit("c", 12)], 2, 1e6)),
    ).toEqual(["a", "b", "c"]);
    // The new pack would be too large for the next pack: it joins too.
    expect(
      ids(
        selectGeometricRepack([unit("a", 3), unit("b", 3), unit("c", 10), unit("d", 100)], 2, 1e6),
      ),
    ).toEqual(["a", "b", "c"]);
    // Within the budget, the smallest first; one unit alone is no merge.
    expect(ids(selectGeometricRepack([unit("a", 5), unit("b", 5), unit("c", 5)], 2, 10))).toEqual([
      "a",
      "b",
    ]);
    expect(selectGeometricRepack([unit("a", 5), unit("b", 5)], 2, 5)).toEqual([]);
    expect(selectGeometricRepack([], 2, 10)).toEqual([]);
  });
});

describe("repack", () => {
  it("compacts git's packs into one pack holding every object once, swapped in; sources superseded", async () => {
    const { stub, packIds } = await splitRepo(true);
    const run = await runJob(stub, "repack");
    expect(run.state).toBe("done");
    const states = await packStates(stub);
    // Superseded, and condemned by the retire job it schedules; kept 30 days.
    expect(states.filter((p) => packIds.includes(p.pack_id as PackId)).map((p) => p.state)).toEqual(
      ["superseded", "superseded"],
    );
    expect((await runJob(stub, "retire-packs")).state).toBe("scheduled");
    expect(
      (await packStates(stub))
        .filter((p) => packIds.includes(p.pack_id as PackId))
        .map((p) => p.state),
    ).toEqual(["condemned", "condemned"]);
    const result = await inRepo(stub, async ({ git }) => {
      const { pack, bytes, stored, parsedIdx } = await livePack(git);
      return {
        kind: pack.kind,
        allReachable: git.registry.liveForFetch()[0]?.allReachable,
        objects: (await packObjects(bytes)).oids,
        idxMatches: hex(stored) === hex(parsedIdx),
        count: PackIdx.parse(stored).count,
        retire: git.jobs.get("retire-packs")?.state,
        sources: await Promise.all(
          packIds.map((id) => git.bucket.head(packObjectKey(git.networkId(), id, "pack"))),
        ),
      };
    });
    expect(result.kind).toBe("compact");
    expect(result.objects).toEqual(fixtures.split.objects);
    expect(result.idxMatches).toBe(true);
    expect(result.count).toBe(fixtures.split.objects.length);
    // Every source was flagged all-reachable, so the compacted pack is.
    expect(result.allReachable).toBe(true);
    expect(result.retire).toBe("queued");
    expect(result.sources.every((o) => o !== null)).toBe(true);
  });

  it("does not flag the new pack all-reachable when a source was not", async () => {
    const { stub } = await splitRepo(false);
    expect((await runJob(stub, "repack")).state).toBe("done");
    expect(await inRepo(stub, ({ git }) => git.registry.liveForFetch()[0]?.allReachable)).toBe(
      false,
    );
  });

  it("leaves packs in a geometric progression alone", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { geometricFactor: 1.0001 });
    await loadFixture(stub, fixtures.single);
    expect(await runJob(stub, "repack")).toEqual({ slices: 1, state: "done" });
    expect((await packStates(stub)).map((p) => p.state)).toEqual(["live"]);
  });

  it("resumes across slices and after lost cursors and failed slices, to the same bytes", async () => {
    const reference = await splitRepo(true);
    await runJob(reference.stub, "repack");
    const expected = await inRepo(reference.stub, async ({ git }) =>
      hex((await livePack(git)).bytes),
    );

    const { stub } = await splitRepo(true);
    await setPolicy(stub, { geometricFactor: 1000, sliceObjects: 3 });
    let saved: Uint8Array | null = null;
    let failures = 0;
    const run = await runJob(stub, "repack", {
      max: 400,
      between: async (slice) => {
        await inRepo(stub, ({ git }) => {
          const job = git.jobs.get("repack");
          // Every fifth slice: the reset lost the slice's cursor (its R2 writes stand).
          if (slice % 5 === 0 && saved !== null && job?.state === "queued") {
            git.context.storage.sql.exec(
              "UPDATE jobs SET cursor = ? WHERE job_id = 'repack'",
              saved,
            );
            return;
          }
          saved = job?.cursor ? (new Uint8Array(job.cursor).buffer as never) : null;
        });
        // Every seventh slice fails part-way: the next one continues from the saved cursor.
        if (slice % 7 === 0) {
          await inRepo(stub, ({ git }) => {
            const real = git.bucket;
            (git as { bucket: R2Bucket }).bucket = new Proxy(real, {
              get(target, property) {
                if (property === "put") {
                  return async () => {
                    (git as { bucket: R2Bucket }).bucket = real;
                    failures++;
                    throw new Error("evicted mid-slice");
                  };
                }
                const value = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          });
        }
      },
    });
    expect(run.state).toBe("done");
    expect(run.slices).toBeGreaterThan(10);
    expect(failures).toBeGreaterThan(0);
    const result = await inRepo(stub, async ({ git }) => ({
      bytes: hex((await livePack(git)).bytes),
      scratch: (await env.GIT.list({ prefix: `net/${git.networkId()}/scratch/` })).objects.length,
    }));
    expect(result.bytes).toBe(expected);
    // The run's scratch objects are gone.
    expect(result.scratch).toBe(0);
  }, 60_000);

  it("a swap whose cursor was lost is recognised as done; the live pack is never discarded", async () => {
    const { stub } = await splitRepo(true);
    let swapCursor: ArrayBuffer | null = null;
    await runJob(stub, "repack", {
      between: async () => {
        await inRepo(stub, ({ git }) => {
          const cursor = git.jobs.get("repack")?.cursor;
          if (cursor && new TextDecoder().decode(cursor).includes('"swap"'))
            swapCursor = new Uint8Array(cursor).buffer;
        });
      },
    });
    expect(swapCursor).not.toBeNull();
    const live = await inRepo(stub, ({ git }) => git.registry.liveOwn().map((p) => p.packId));
    // The object was evicted after the swap committed, before its cursor moved on.
    await inRepo(stub, ({ git }) => {
      git.context.storage.sql
        .exec("UPDATE jobs SET state = 'queued', cursor = ? WHERE job_id = 'repack'", swapCursor)
        .toArray();
    });
    expect((await runJob(stub, "repack")).state).toBe("done");
    const after = await inRepo(stub, async ({ git }) => ({
      live: git.registry.liveOwn().map((p) => p.packId),
      stored: (await git.bucket.head(git.registry.liveOwn()[0]?.r2Key as string)) !== null,
    }));
    expect(after.live).toEqual(live);
    expect(after.stored).toBe(true);
  });

  it("waits for the commit lock, then swaps", async () => {
    const { stub, packIds } = await splitRepo(true);
    await inRepo(stub, ({ git }) => {
      git.locks.tryAcquire("ref-commit", "a push", 60_000);
    });
    const first = await runJob(stub, "repack", { max: 3 });
    expect(first.state).toBe("queued");
    expect(
      (await packStates(stub))
        .filter((p) => packIds.includes(p.pack_id as PackId))
        .every((p) => p.state === "live"),
    ).toBe(true);
    await inRepo(stub, ({ git }) => {
      git.context.storage.sql.exec("DELETE FROM locks").toArray();
    });
    expect((await runJob(stub, "repack")).state).toBe("done");
  });

  it("starts over when a source is replaced under it (a push's tail merge)", async () => {
    const { stub, packIds } = await splitRepo(true);
    await setPolicy(stub, { geometricFactor: 1000, sliceObjects: 3 });
    await runJob(stub, "repack", { max: 2 });
    // Something else supersedes a source meanwhile.
    await inRepo(stub, ({ git }) => {
      git.registry.transition(packIds[0] as PackId, ["live"], "superseded");
    });
    const run = await runJob(stub, "repack", { max: 400 });
    expect(run.state).toBe("done");
    const states = await packStates(stub);
    // The abandoned output was discarded; nothing more to roll up with one live pack.
    expect(states.filter((p) => p.kind === "compact").map((p) => p.state)).toEqual(["discarded"]);
    expect(states.filter((p) => p.state === "live").map((p) => p.pack_id)).toEqual([packIds[1]]);
  });
});
