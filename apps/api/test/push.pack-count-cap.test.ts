// The pack-count cap: a push's commit never leaves more than the cap of own
// live packs. When it would, the commit first merges the smallest packs
// (with the push's own unit) into one compacted pack, synchronously and
// within a budget; when no merge within budget makes room, the push is
// refused with a retryable error, nothing changes and compaction is
// scheduled. Pushes are driven through the repository object's RPC methods
// (what the Worker calls), not the HTTP layer.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import { packObjectKey, type RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  createSha1Hasher,
  encodeCommit,
  encodeTree,
  type FetchArgs,
  hashObject,
  type Ident,
  type MemoryBudget,
  type Oid,
  oidFromHex,
  oidToHex,
  PackBuilder,
  PackIdx,
  parsePack,
  writeIdx,
} from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { PACK_CAP_JOB_ID } from "../src/git/maintenance/tail-merge-job.js";
import { PACK_CAP_DEFAULTS, type PackCapPolicy } from "../src/git/maintenance/tail-merge-plan.js";
import { PACK_CAP_REFUSAL } from "../src/git/push/commit.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const OK = ["unpack ok\n", `ok ${MAIN}\n`, "0000"];
const encoder = new TextEncoder();
const zlib = createWorkersZlib();
const unbounded: MemoryBudget = {
  reserve: async (bytes) => ({ bytes, release() {} }),
  tryReserve: (bytes) => ({ bytes, release() {} }),
};
const sha1 = () => createSha1Hasher({ detectCollisions: false });

type Stub = DurableObjectStub<RepoDO>;

const ident = (at: number): Ident => ({
  name: encoder.encode("Fyrden Test"),
  email: encoder.encode("test@fyrden.invalid"),
  timestamp: at,
  timezone: "+0000",
});

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A commit (one file, child of `parent`) and the self-contained pack `git push` would send for it. */
async function commitPack(
  parent: Oid | null,
  n: number,
  /** Bytes of incompressible content to add to the file. */
  extra = 0,
): Promise<{ oid: Oid; pack: Uint8Array; objects: string[] }> {
  let seed = n + 1;
  const noise = Array.from({ length: extra }, () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
    return seed & 0xff;
  });
  const blob = concat([encoder.encode(`push number ${n}\n`), Uint8Array.from(noise)]);
  const blobOid = await hashObject(sha1, "blob", blob);
  const tree = encodeTree([{ mode: 0o100644, name: encoder.encode("file.txt"), oid: blobOid }]);
  const treeOid = await hashObject(sha1, "tree", tree);
  const commit = encodeCommit({
    tree: treeOid,
    parents: parent ? [parent] : [],
    author: ident(1_700_000_000 + n),
    committer: ident(1_700_000_000 + n),
    headers: [],
    message: encoder.encode(`push ${n}\n`),
  });
  const commitOid = await hashObject(sha1, "commit", commit);
  const chunks: Uint8Array[] = [];
  const builder = await PackBuilder.start(3, {
    sink: { write: async (chunk) => void chunks.push(chunk.slice()) },
    zlib,
    memory: unbounded,
  });
  await builder.addObject("commit", commit, commitOid);
  await builder.addObject("tree", tree, treeOid);
  await builder.addObject("blob", blob, blobOid);
  (await builder.finish()).release();
  return {
    oid: commitOid,
    pack: concat(chunks),
    objects: [commitOid, treeOid, blobOid].map(oidToHex),
  };
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** A receive-pack body updating main from `old` to `next`, with `pack`. */
function body(old: string, next: string, pack: Uint8Array): Uint8Array {
  return concat([pushBody([{ old, new: next, ref: MAIN }]), pack]);
}

/** One push through the object's RPC methods, as the Worker drives it. */
async function push(stub: Stub, bytes: Uint8Array) {
  const begun = await stub.beginPush({ principal: "usr_cap", tokenId: "tok_cap" });
  if (!begun.ok) throw new Error(begun.error);
  await env.GIT.put(begun.bodyKey, bytes);
  let progress = await stub.runPush(begun.uploadId, bytes.length, 10_000);
  for (let i = 0; progress.state === "indexing" && i < 100; i++)
    progress = await stub.pushStatus(begun.uploadId, 10_000);
  const response =
    progress.state === "done"
      ? progress.response
      : await stub.finalizePush(begun.uploadId, { tokenId: "tok_cap", decidedAt: Date.now() });
  return { uploadId: begun.uploadId, ...reportLines(response) };
}

/** Pushes `count` commits on main after `parent`; returns the new tip and every object pushed. */
async function pushChain(stub: Stub, count: number, from: { parent: Oid | null; n: number }) {
  let parent = from.parent;
  const objects: string[] = [];
  for (let i = 0; i < count; i++) {
    const c = await commitPack(parent, from.n + i);
    const reply = await push(stub, body(parent ? oidToHex(parent) : ZERO, oidToHex(c.oid), c.pack));
    expect(reply.report).toEqual(OK);
    parent = c.oid;
    objects.push(...c.objects);
  }
  return { tip: parent as Oid, objects, n: from.n + count };
}

const setPolicy = (stub: Stub, overrides: Partial<PackCapPolicy>) =>
  inRepo(stub, (repo) => {
    repo.packCap = { ...PACK_CAP_DEFAULTS, ...overrides };
  });

/** What a test compares before and after: refs, live packs, packs not yet committed. */
const snapshot = (stub: Stub) =>
  inRepo(stub, ({ git }) => ({
    main: oidToHex(git.refStore.readRefsSync().refs.get(MAIN) ?? (new Uint8Array(20) as Oid)),
    live: git.registry
      .liveOwn()
      .map((p) => p.packId)
      .sort(),
    unfinished: git.context.storage.sql
      .exec("SELECT count(*) AS n FROM packs WHERE state IN ('pending', 'indexing', 'indexed')")
      .one().n as number,
  }));

const jobState = (stub: Stub, jobId: string) =>
  inRepo(stub, ({ git }) => git.jobs.get(jobId)?.state ?? null);

/** Every object in a stored pack (parsed with no outside bases: the pack must be self-contained). */
async function objectsIn(git: RepoGitStorage, key: string, offset = 0, length?: number) {
  const object = await git.bucket.get(
    key,
    length === undefined ? undefined : { range: { offset, length } },
  );
  if (!object) throw new Error(`${key} is missing`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  const parsed = await parsePack(
    (async function* () {
      yield bytes;
    })(),
    {
      zlib,
      memory: unbounded,
      readRange: async (at, n) => bytes.subarray(at, at + n),
    },
  );
  const oids = Array.from({ length: parsed.entries.count }, (_, i) =>
    oidToHex(parsed.entries.oid(i)),
  ).sort();
  const idx = await writeIdx(parsed.entries, parsed.checksum, { createHasher: sha1 });
  parsed.release();
  return { oids, idx: idx.bytes };
}

/** The objects a stored `.idx` lists. */
async function idxObjects(git: RepoGitStorage, packId: string): Promise<string[]> {
  const object = await git.bucket.get(packObjectKey(git.networkId(), packId, "idx"));
  if (!object) throw new Error(`the index of ${packId} is missing`);
  const idx = PackIdx.parse(new Uint8Array(await object.arrayBuffer()));
  return Array.from({ length: idx.count }, (_, i) => oidToHex(idx.oidAt(i)));
}

const cloneArgs = (want: Oid): FetchArgs => ({
  wants: [want],
  haves: [],
  done: true,
  thinPack: false,
  noProgress: true,
  includeTag: false,
  ofsDelta: true,
  shallow: [],
  deepen: undefined,
  deepenRelative: false,
  deepenSince: undefined,
  deepenNot: [],
});

describe("push: pack-count cap", () => {
  it("2,000 small pushes without alarms keep live packs at or under the cap, and a clone opens at most cap indexes", async () => {
    const { stub } = await newRepo();
    const cap = PACK_CAP_DEFAULTS.cap;
    let parent: Oid | null = null;
    const pushed: string[] = [];
    let maxLive = 0;
    for (let n = 0; n < 2000; n++) {
      const c = await commitPack(parent, n);
      const reply = await push(
        stub,
        body(parent ? oidToHex(parent) : ZERO, oidToHex(c.oid), c.pack),
      );
      expect(reply.report).toEqual(OK);
      parent = c.oid;
      pushed.push(...c.objects);
      const live = await inRepo(stub, ({ git }) => git.registry.liveOwn().length);
      maxLive = Math.max(maxLive, live);
      expect(live).toBeLessThanOrEqual(cap);
    }
    expect(maxLive).toBe(cap);

    const after = await inRepo(stub, async (repo) => {
      const { git } = repo;
      // Nothing ran in the background: no compaction job was ever queued.
      const compactJobs = git.context.storage.sql
        .exec("SELECT count(*) AS n FROM jobs WHERE kind = 'compact'")
        .one().n as number;
      // Count the `.idx` objects a clone plan opens.
      const real = git.bucket;
      let idxReads = 0;
      const counting = new Proxy(real, {
        get(target, property) {
          if (property === "get") {
            return (key: string, options?: R2GetOptions) => {
              if (key.endsWith(".idx")) idxReads++;
              return target.get(key, options);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      (git as { bucket: R2Bucket }).bucket = counting;
      let reply: Awaited<ReturnType<RepoDO["planFetch"]>>;
      try {
        reply = await repo.planFetch({
          repoId: "repo-cap",
          args: cloneArgs(parent as Oid),
          plan: "paid",
          holder: "clone-after-2000",
        });
      } finally {
        (git as { bucket: R2Bucket }).bucket = real;
      }
      if (!reply.ok) throw new Error(reply.message);
      const stored = reply.parts.flatMap((p) => (p.kind === "stored" ? [p] : []));
      const cloned = await Promise.all(
        stored.map((p) => objectsIn(git, p.key, p.offset, p.length)),
      );
      if (reply.lease) git.leases.release(reply.lease.leaseId);
      return {
        compactJobs,
        idxReads,
        live: git.registry.liveOwn().length,
        cloned: cloned.flatMap((c) => c.oids).sort(),
        main: oidToHex(git.refStore.readRefsSync().refs.get(MAIN) as Oid),
      };
    });
    expect(after.compactJobs).toBe(0);
    expect(after.main).toBe(oidToHex(parent as Oid));
    expect(after.live).toBeLessThanOrEqual(cap);
    expect(after.idxReads).toBeLessThanOrEqual(cap);
    // The clone holds every object ever pushed, each once.
    expect(after.cloned).toEqual([...pushed].sort());
  }, 900_000);

  it("merges a thin push's unit (received pack and completion pack) as a whole into a self-contained pack", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { cap: 2 });
    expect(
      (await push(stub, pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 })))
        .report,
    ).toEqual(OK);
    const thin = await push(
      stub,
      pushBody([{ old: fx.c2, new: fx.c3, ref: MAIN }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(thin.report).toEqual(OK);
    const result = await inRepo(stub, async ({ git }) => {
      const unit = git.context.storage.sql
        .exec<{ pack_id: string; kind: string; state: string; r2_key: string }>(
          "SELECT pack_id, kind, state, r2_key FROM packs WHERE unit_id = ? ORDER BY kind",
          thin.uploadId,
        )
        .toArray();
      const live = git.registry.liveOwn();
      const merged = live.find((p) => p.kind === "compact");
      if (!merged) throw new Error("no compacted pack is live");
      // The received pack is thin (it does not parse alone): its objects come from its `.idx`.
      const inputs = await Promise.all(
        unit.map(async (p) => ({ oids: await idxObjects(git, p.pack_id) })),
      );
      const output = await objectsIn(git, merged.r2Key);
      const storedIdx = await git.bucket.get(packObjectKey(git.networkId(), merged.packId, "idx"));
      return {
        unit: unit.map((p) => [p.kind, p.state]),
        live: live.length,
        inputs: [...new Set(inputs.flatMap((i) => i.oids))].sort(),
        output: output.oids,
        sameIdx:
          storedIdx !== null &&
          equalBytes(new Uint8Array(await storedIdx.arrayBuffer()), output.idx),
        objectCount: merged.objectCount,
      };
    });
    expect(result.unit).toEqual([
      ["completion", "superseded"],
      ["receive", "superseded"],
    ]);
    expect(result.live).toBeLessThanOrEqual(2);
    // The compacted pack resolves alone and holds exactly the unit's objects
    // (the received pack's and the bases the completion pack added).
    expect(result.output).toEqual(result.inputs);
    expect(result.objectCount).toBe(result.output.length);
    // Its stored `.idx` is the one the engine writes for its bytes (which is git's).
    expect(result.sameIdx).toBe(true);

    // The repository still serves a full clone of c3.
    const reply = await stub.planFetch({
      repoId: "repo-thin",
      args: cloneArgs(oidFromHex(fx.c3)),
      plan: "paid",
      holder: "clone-thin",
    });
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.lease) await stub.releaseFetchLease(reply.lease.leaseId);
  });

  it("never supersedes a leased pack: it merges unleased ones, and refuses when all are leased", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { cap: 4 });
    const chain = await pushChain(stub, 4, { parent: null, n: 0 });
    const leasedIds = await inRepo(stub, ({ git }) => {
      const ids = git.registry.liveOwn().map((p) => p.packId);
      // A clone holds the three newest packs.
      const grant = git.leases.grant("read", ids.slice(1), "clone-in-flight", 60_000);
      if (!grant.ok) throw new Error("lease refused");
      return { leased: ids.slice(1), free: ids[0], leaseId: grant.leaseId };
    });

    const next = await pushChain(stub, 1, { parent: chain.tip, n: chain.n });
    const afterOne = await inRepo(stub, ({ git }) => ({
      live: git.registry.liveOwn().map((p) => [p.packId, p.kind]),
      freeState: git.registry.get(leasedIds.free as string)?.state,
    }));
    expect(afterOne.live.length).toBeLessThanOrEqual(4);
    for (const id of leasedIds.leased) expect(afterOne.live.map(([p]) => p)).toContain(id);
    expect(afterOne.freeState).toBe("superseded");

    // Now every live pack is leased: the push cannot make room.
    await inRepo(stub, ({ git }) => {
      const ids = git.registry.liveOwn().map((p) => p.packId);
      if (!git.leases.grant("read", ids, "second-clone", 60_000).ok) throw new Error("lease");
    });
    const before = await snapshot(stub);
    const c = await commitPack(next.tip, next.n);
    const refused = await push(stub, body(oidToHex(next.tip), oidToHex(c.oid), c.pack));
    expect(refused.report).toEqual(["unpack ok\n", `ng ${MAIN} ${PACK_CAP_REFUSAL}\n`, "0000"]);
    expect(refused.progress.join("")).toContain("try the push again later");
    expect(await snapshot(stub)).toEqual(before);
    expect(await jobState(stub, PACK_CAP_JOB_ID)).toBe("queued");
  });

  it("refuses an over-budget push with a retryable error, changes nothing, and schedules compaction that makes room", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { cap: 4 });
    const chain = await pushChain(stub, 4, { parent: null, n: 0 });
    // A budget smaller than any two packs: no merge can make room.
    await setPolicy(stub, { cap: 4, maxMergeBytes: 100 });
    const before = await snapshot(stub);
    const c = await commitPack(chain.tip, chain.n);
    const refused = await push(stub, body(oidToHex(chain.tip), oidToHex(c.oid), c.pack));
    expect(refused.report).toEqual(["unpack ok\n", `ng ${MAIN} ${PACK_CAP_REFUSAL}\n`, "0000"]);
    expect(await snapshot(stub)).toEqual(before);
    expect(
      await inRepo(stub, ({ git }) => ({
        upload: git.uploads.get(refused.uploadId)?.state,
        pending: git.context.storage.sql
          .exec("SELECT count(*) AS n FROM pending_commits WHERE upload_id = ?", refused.uploadId)
          .one().n,
      })),
    ).toEqual({ upload: "rejected", pending: 0 });
    // Compaction was scheduled (the local runtime may already have run its
    // alarm, which ended: the budget is the obstacle, not leases).
    expect(await jobState(stub, PACK_CAP_JOB_ID)).not.toBeNull();
    expect(await snapshot(stub)).toEqual(before);

    // The scheduled compaction, with a budget that fits, makes room below the cap...
    await setPolicy(stub, { cap: 4 });
    await inRepo(stub, ({ git }) => git.jobs.ensure("compact", PACK_CAP_JOB_ID));
    // Its slices, run one alarm at a time until it is done.
    for (let i = 0; i < 20 && (await jobState(stub, PACK_CAP_JOB_ID)) !== "done"; i++)
      await runDurableObjectAlarm(stub);
    expect(await jobState(stub, PACK_CAP_JOB_ID)).toBe("done");
    const compacted = await snapshot(stub);
    expect(compacted.live.length).toBeLessThanOrEqual(3);
    expect(compacted.main).toBe(before.main);

    // ...so the same push, tried again, goes through without merging.
    const again = await push(stub, body(oidToHex(chain.tip), oidToHex(c.oid), c.pack));
    expect(again.report).toEqual(OK);
    const final = await snapshot(stub);
    expect(final.live.length).toBe(compacted.live.length + 1);
    expect(final.main).toBe(oidToHex(c.oid));
  });

  it("a push too large to copy again stays its own pack while older packs merge", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { cap: 3 });
    const chain = await pushChain(stub, 3, { parent: null, n: 0 });
    const sizes = await inRepo(stub, ({ git }) => git.registry.liveOwn().map((p) => p.bytes ?? 0));
    // Budget: the two smallest packs fit; the push's pack alone does not.
    const c = await commitPack(chain.tip, chain.n, 4096);
    const smallest = [...sizes].sort((a, b) => a - b);
    await setPolicy(stub, {
      cap: 3,
      maxMergeBytes: (smallest[0] as number) + (smallest[1] as number) + 1,
    });
    const reply = await push(stub, body(oidToHex(chain.tip), oidToHex(c.oid), c.pack));
    expect(reply.report).toEqual(OK);
    const after = await inRepo(stub, ({ git }) =>
      git.registry.liveOwn().map((p) => ({ kind: p.kind, upload: p.uploadId })),
    );
    expect(after).toHaveLength(3);
    expect(after.filter((p) => p.kind === "compact")).toHaveLength(1);
    expect(after.find((p) => p.kind === "receive" && p.upload === reply.uploadId)).toBeDefined();
  });
});
