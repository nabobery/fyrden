// A push indexed against packs that a compaction then merged away still
// commits: the compacted pack holds the same objects, so the push's
// dependencies follow it. Only objects that are truly gone (a pack
// condemned or deleted) refuse the commit. The interleaving is driven
// step by step through the repository object's RPC methods: a push is
// indexed and left waiting for its commit, another push (or the background
// pack-cap compaction) merges the packs it depends on, then the first one
// commits.
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  PackIndexCache,
  packObjectKey,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import {
  createSha1Hasher,
  encodeCommit,
  encodeTree,
  hashObject,
  type Ident,
  type MemoryBudget,
  type Oid,
  oidToHex,
  PackBuilder,
  type PackId,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { PACK_CAP_JOB_ID } from "../src/git/maintenance/tail-merge-job.js";
import { PACK_CAP_DEFAULTS } from "../src/git/maintenance/tail-merge-plan.js";
import { followMergedAway } from "../src/git/push/merged-deps.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

type Stub = DurableObjectStub<RepoDO>;

const MAIN = "refs/heads/main";
/** Where an `.idx`'s oid table starts: after its 8-byte header and 1,024-byte fanout. */
const IDX_OIDS_START = 8 + 1024;
const GONE = "objects this push builds on were removed meanwhile; try the push again";
const encoder = new TextEncoder();
const zlib = createWorkersZlib();
const unbounded: MemoryBudget = {
  reserve: async (bytes) => ({ bytes, release() {} }),
  tryReserve: (bytes) => ({ bytes, release() {} }),
};
const sha1 = () => createSha1Hasher({ detectCollisions: false });
const ok = (ref: string) => ["unpack ok\n", `ok ${ref}\n`, "0000"];

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
async function commitPack(parent: Oid | null, n: number): Promise<{ oid: Oid; pack: Uint8Array }> {
  const blob = encoder.encode(`push number ${n}\n`);
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
  return { oid: commitOid, pack: concat(chunks) };
}

interface PackObject {
  type: "commit" | "tree" | "blob";
  data: Uint8Array;
  oid: Oid;
}

/** A pack of `objects`, in their order. */
async function packOf(objects: readonly PackObject[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const builder = await PackBuilder.start(objects.length, {
    sink: { write: async (chunk) => void chunks.push(chunk.slice()) },
    zlib,
    memory: unbounded,
  });
  for (const o of objects) await builder.addObject(o.type, o.data, o.oid);
  (await builder.finish()).release();
  return concat(chunks);
}

/** A root commit over a tree of `blobs` (named in their order), and its objects, commit first. */
async function rootCommit(
  blobs: readonly { data: Uint8Array; oid: Oid }[],
  message: string,
): Promise<{ oid: Oid; objects: PackObject[] }> {
  const tree = encodeTree(
    blobs.map((b, i) => ({
      mode: 0o100644,
      name: encoder.encode(`f${String(i).padStart(5, "0")}`),
      oid: b.oid,
    })),
  );
  const treeOid = await hashObject(sha1, "tree", tree);
  const commit = encodeCommit({
    tree: treeOid,
    parents: [],
    author: ident(1_700_000_000),
    committer: ident(1_700_000_000),
    headers: [],
    message: encoder.encode(message),
  });
  const oid = await hashObject(sha1, "commit", commit);
  return {
    oid,
    objects: [
      { type: "commit", data: commit, oid },
      { type: "tree", data: tree, oid: treeOid },
      ...blobs.map((b) => ({ type: "blob" as const, ...b })),
    ],
  };
}

/** A root commit of `files` files, its objects and its pack (`files` + 2 objects). */
async function widePack(
  files: number,
): Promise<{ oid: Oid; objects: PackObject[]; pack: Uint8Array }> {
  const blobs = await Promise.all(
    Array.from({ length: files }, async (_, i) => {
      const data = encoder.encode(`file ${i}\n`);
      return { data, oid: await hashObject(sha1, "blob", data) };
    }),
  );
  const root = await rootCommit(blobs, "wide\n");
  return { ...root, pack: await packOf(root.objects) };
}

/** A push of a new commit on `ref` (created from nothing) whose parent is `parent`. */
async function branchBody(ref: string, parent: Oid, n: number) {
  const c = await commitPack(parent, n);
  return {
    oid: c.oid,
    bytes: concat([pushBody([{ old: ZERO, new: oidToHex(c.oid), ref }]), c.pack]),
  };
}

/** Uploads and indexes a push, and leaves it waiting for its commit. */
async function stage(stub: Stub, bytes: Uint8Array): Promise<string> {
  const begun = await stub.beginPush({ principal: "usr_compact", tokenId: "tok_compact" });
  if (!begun.ok) throw new Error(begun.error);
  await env.GIT.put(begun.bodyKey, bytes);
  let progress = await stub.runPush(begun.uploadId, bytes.length, 10_000);
  for (let i = 0; progress.state === "indexing" && i < 100; i++)
    progress = await stub.pushStatus(begun.uploadId, 10_000);
  expect(progress.state).toBe("ready");
  return begun.uploadId;
}

/**
 * Uploads a push and runs its indexing up to its last phase: the
 * connectivity check has noted the packs it relied on, but the upload is
 * not marked indexed yet. A budget of 0 runs one phase per call (parse,
 * completion, connect; the last, graph, then records the dependencies).
 */
async function stageBeforeLastPhase(stub: Stub, bytes: Uint8Array): Promise<string> {
  const begun = await stub.beginPush({ principal: "usr_compact", tokenId: "tok_compact" });
  if (!begun.ok) throw new Error(begun.error);
  await env.GIT.put(begun.bodyKey, bytes);
  const states = [(await stub.runPush(begun.uploadId, bytes.length, 0)).state];
  for (let i = 0; i < 2; i++) states.push((await stub.pushStatus(begun.uploadId, 0)).state);
  expect(states).toEqual(["indexing", "indexing", "indexing"]);
  expect(await inRepo(stub, ({ git }) => git.uploads.get(begun.uploadId)?.state)).toBe("indexing");
  return begun.uploadId;
}

/** Runs the rest of a staged push's indexing. */
async function finishIndexing(stub: Stub, uploadId: string) {
  let progress = await stub.pushStatus(uploadId, 10_000);
  for (let i = 0; progress.state === "indexing" && i < 100; i++)
    progress = await stub.pushStatus(uploadId, 10_000);
  expect(progress.state).toBe("ready");
}

/** Commits a staged push, as the Worker does after re-authorizing the pusher. */
async function commit(stub: Stub, uploadId: string) {
  const response = await stub.finalizePush(uploadId, {
    tokenId: "tok_compact",
    decidedAt: Date.now(),
  });
  return reportLines(response).report;
}

/** Stages and commits a push. */
async function push(stub: Stub, bytes: Uint8Array) {
  return commit(stub, await stage(stub, bytes));
}

/** A repository whose main has `count` commits, one live pack each, under a pack-count cap of `cap`. */
async function repoWithPacks(count: number, cap: number) {
  const { stub } = await newRepo();
  await inRepo(stub, (repo) => {
    repo.packCap = { ...PACK_CAP_DEFAULTS, cap };
  });
  let tip: Oid | null = null;
  for (let n = 0; n < count; n++) {
    const c = await commitPack(tip, n);
    const bytes = concat([
      pushBody([{ old: tip ? oidToHex(tip) : ZERO, new: oidToHex(c.oid), ref: MAIN }]),
      c.pack,
    ]);
    expect(await push(stub, bytes)).toEqual(ok(MAIN));
    tip = c.oid;
  }
  return { stub, tip: tip as Oid };
}

/** An upload's dependencies and each one's registry state. */
const depsOf = (stub: Stub, uploadId: string) =>
  inRepo(stub, ({ git }) =>
    (git.uploads.get(uploadId)?.deps ?? []).map((id) => ({
      id: id as string,
      state: git.registry.get(id)?.state ?? null,
    })),
  );

/** Runs the compaction a refused push schedules (down to one pack below the cap) to its end. */
async function compactInBackground(stub: Stub) {
  await inRepo(stub, ({ git }) => git.jobs.ensure("compact", PACK_CAP_JOB_ID));
  const jobState = () => inRepo(stub, ({ git }) => git.jobs.get(PACK_CAP_JOB_ID)?.state ?? null);
  for (let i = 0; i < 20 && (await jobState()) !== "done"; i++) await runDurableObjectAlarm(stub);
  expect(await jobState()).toBe("done");
}

/** The repository's one live pack. */
async function onlyLivePack(stub: Stub): Promise<string> {
  const live = await inRepo(stub, ({ git }) => git.registry.liveOwn().map((p) => p.packId));
  expect(live).toHaveLength(1);
  return live[0] as string;
}

/** The staged upload's state and `packId`'s: still indexing, and the pack merged away. */
const mergedWhileIndexing = (stub: Stub, uploadId: string, packId: string) =>
  inRepo(stub, ({ git }) => [
    git.uploads.get(uploadId)?.state ?? null,
    git.registry.get(packId)?.state ?? null,
  ]);

const refOf = (stub: Stub, ref: string) =>
  inRepo(stub, ({ git }) => {
    const oid = git.refStore.readRefsSync().refs.get(ref);
    return oid ? oidToHex(oid) : null;
  });

/**
 * `git` with every `.idx` read of the bucket recorded per pack as [offset, length] (a whole
 * read as [0, -1]), and an index cache too small to hold any index whole: every index is
 * then read by ranges, as one larger than the cache's whole-index bound is.
 */
function rangedIdxReads(git: RepoGitStorage) {
  const reads = new Map<string, [number, number][]>();
  const bucket = new Proxy(git.bucket, {
    get(target, property) {
      if (property === "get") {
        return (key: string, options?: R2GetOptions) => {
          const range = options?.range as { offset: number; length: number } | undefined;
          const list = reads.get(key) ?? [];
          list.push(range ? [range.offset, range.length] : [0, -1]);
          reads.set(key, list);
          return target.get(key, options);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const packIndexes = new PackIndexCache(4 * 1024);
  const ranged = new Proxy(git, {
    get(inner, property) {
      if (property === "bucket") return bucket;
      if (property === "packIndexes") return packIndexes;
      return Reflect.get(inner, property);
    },
  });
  /** The reads of `packId`'s index: its header and fanout, then the rest. */
  const of = (packId: string) => {
    const [open, ...rest] = reads.get(packObjectKey(git.networkId(), packId, "idx")) ?? [];
    const count = git.registry.get(packId)?.objectCount ?? 0;
    // The oid table, between the fanout and the CRC32s; the offset tables follow those.
    const oidTableEnd = IDX_OIDS_START + 20 * count;
    return {
      open,
      oidTable: rest.filter(([at, length]) => at >= IDX_OIDS_START && at + length <= oidTableEnd),
      other: rest.filter(([at, length]) => !(at >= IDX_OIDS_START && at + length <= oidTableEnd)),
    };
  };
  return { git: ranged, reads, of };
}

/** Follows `packId` with every index read by ranges; its result and each readable pack's index reads. */
const followRanged = (stub: Stub, packId: string) =>
  inRepo(stub, async ({ git }) => {
    const { git: ranged, reads, of } = rangedIdxReads(git);
    let onRead = 0;
    const counter = { calls: 0 };
    const deps = await followMergedAway(
      ranged,
      [packId as PackId],
      { counter, onRead: () => onRead++ },
      () => true,
    );
    const live = git.registry.liveOwn().map((p) => p.packId as string);
    const rangeReads = [...reads.values()].flat().filter(([, length]) => length >= 0).length;
    return {
      deps: deps?.map(String),
      live,
      holders: live.map((id) => of(id)),
      sourceReads: counter.calls,
      onRead,
      rangeReads,
    };
  });

describe("push: dependencies merged away by compaction", () => {
  it("commits a push whose dependency another push's tail merge superseded", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 100);
    const staged = await stage(stub, a.bytes);
    const before = await depsOf(stub, staged);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((d) => d.state === "live")).toBe(true);

    // Another push commits first; at the cap, its commit merges the live packs.
    const b = await branchBody("refs/heads/b", tip, 101);
    expect(await push(stub, b.bytes)).toEqual(ok("refs/heads/b"));
    const merged = await inRepo(stub, ({ git }) =>
      before.map((d) => git.registry.get(d.id)?.state ?? null),
    );
    // The interleaving under test: a pack the staged push relied on is no longer live.
    expect(merged).toContain("superseded");

    expect(await commit(stub, staged)).toEqual(ok("refs/heads/a"));
    expect(await refOf(stub, "refs/heads/a")).toBe(oidToHex(a.oid));
    expect(await refOf(stub, "refs/heads/b")).toBe(oidToHex(b.oid));
  });

  it("follows a chain of merges: the pack that replaced a dependency merged away again", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 200);
    const staged = await stage(stub, a.bytes);
    const first = await depsOf(stub, staged);

    expect(await push(stub, (await branchBody("refs/heads/b", tip, 201)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    const second = await depsOf(stub, staged);
    // Another push adds a pack (no merge needed), then the background compaction merges
    // everything into one pack, the first merge's included.
    expect(await push(stub, (await branchBody("refs/heads/c", tip, 202)).bytes)).toEqual(
      ok("refs/heads/c"),
    );
    await compactInBackground(stub);
    // Each merge superseded a pack the staged push depended on at that point.
    const states = await inRepo(stub, ({ git }) => ({
      first: first.map((d) => git.registry.get(d.id)?.state ?? null),
      second: second.map((d) => git.registry.get(d.id)?.state ?? null),
    }));
    expect(states.first).toContain("superseded");
    expect(states.second).toContain("superseded");

    expect(await commit(stub, staged)).toEqual(ok("refs/heads/a"));
    expect(await refOf(stub, "refs/heads/a")).toBe(oidToHex(a.oid));
  });

  it("commits a push whose dependency the background pack-cap compaction superseded", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 300);
    const staged = await stage(stub, a.bytes);
    const before = await depsOf(stub, staged);

    await compactInBackground(stub);
    const merged = await inRepo(stub, ({ git }) =>
      before.map((d) => git.registry.get(d.id)?.state ?? null),
    );
    expect(merged).toContain("superseded");

    expect(await commit(stub, staged)).toEqual(ok("refs/heads/a"));
    expect(await refOf(stub, "refs/heads/a")).toBe(oidToHex(a.oid));
  });

  it("still refuses a push whose dependency was condemned after the merge", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 400);
    const staged = await stage(stub, a.bytes);
    expect(await push(stub, (await branchBody("refs/heads/b", tip, 401)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    // What the push depends on now is removed for good (as a collection condemns a pack).
    await inRepo(stub, ({ git }) => {
      for (const id of git.uploads.get(staged)?.deps ?? [])
        git.registry.transition(id, ["live", "superseded"], "condemned");
    });

    expect(await commit(stub, staged)).toEqual([
      "unpack ok\n",
      `ng refs/heads/a ${GONE}\n`,
      "0000",
    ]);
    expect(await refOf(stub, "refs/heads/a")).toBeNull();
  });

  it("still refuses a push whose dependency was condemned without any merge", async () => {
    const { stub, tip } = await repoWithPacks(2, 4);
    const a = await branchBody("refs/heads/a", tip, 500);
    const staged = await stage(stub, a.bytes);
    await inRepo(stub, ({ git }) => {
      for (const id of git.uploads.get(staged)?.deps ?? [])
        git.registry.transition(id, ["live"], "condemned");
    });

    expect(await commit(stub, staged)).toEqual([
      "unpack ok\n",
      `ng refs/heads/a ${GONE}\n`,
      "0000",
    ]);
    expect(await refOf(stub, "refs/heads/a")).toBeNull();
  });

  it("commits a push whose dependency was merged away while it was still being indexed", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 600);
    const staged = await stageBeforeLastPhase(stub, a.bytes);
    const live = await inRepo(stub, ({ git }) => git.registry.liveOwn().map((p) => p.packId));

    // Another push merges every live pack while the first one is between its phases.
    expect(await push(stub, (await branchBody("refs/heads/b", tip, 601)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    expect(
      await inRepo(stub, ({ git }) => live.map((id) => git.registry.get(id)?.state ?? null)),
    ).toEqual(live.map(() => "superseded"));

    await finishIndexing(stub, staged);
    // Recorded against the packs that hold the objects now.
    const deps = await depsOf(stub, staged);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.every((d) => d.state === "live")).toBe(true);
    expect(await commit(stub, staged)).toEqual(ok("refs/heads/a"));
    expect(await refOf(stub, "refs/heads/a")).toBe(oidToHex(a.oid));
  });

  it("commits a push whose merged-away dependency a retirement condemned while it was being indexed", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 650);
    const staged = await stageBeforeLastPhase(stub, a.bytes);
    const live = await inRepo(stub, ({ git }) => git.registry.liveOwn().map((p) => p.packId));
    expect(await push(stub, (await branchBody("refs/heads/b", tip, 651)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    // A retirement pass condemns every superseded pack at once; the compacted pack holding
    // their objects stays live.
    expect(
      await inRepo(stub, ({ git }) => {
        for (const id of live) git.registry.transition(id, ["superseded"], "condemned");
        return live.map((id) => git.registry.get(id)?.state ?? null);
      }),
    ).toEqual(live.map(() => "condemned"));

    await finishIndexing(stub, staged);
    const deps = await depsOf(stub, staged);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.every((d) => d.state === "live")).toBe(true);
    expect(await commit(stub, staged)).toEqual(ok("refs/heads/a"));
    expect(await refOf(stub, "refs/heads/a")).toBe(oidToHex(a.oid));
  });

  it("follows a merged-away dependency of more objects than one lookup slice holds", async () => {
    const { stub } = await newRepo();
    await inRepo(stub, (repo) => {
      repo.packCap = { ...PACK_CAP_DEFAULTS, cap: 1 };
    });
    // Main's one pack holds 4,102 objects (a tree of 4,100 files): two lookup slices.
    const wide = await widePack(4_100);
    expect(
      await push(
        stub,
        concat([pushBody([{ old: ZERO, new: oidToHex(wide.oid), ref: MAIN }]), wide.pack]),
      ),
    ).toEqual(ok(MAIN));
    const widePackId = await onlyLivePack(stub);
    // Its parent is in the wide pack only: that pack is the push's one dependency.
    const a = await branchBody("refs/heads/a", wide.oid, 660);
    const staged = await stageBeforeLastPhase(stub, a.bytes);
    // Another push's commit merges the wide pack with its own while the first is indexing.
    expect(await push(stub, (await branchBody("refs/heads/b", wide.oid, 661)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    expect(await mergedWhileIndexing(stub, staged, widePackId)).toEqual(["indexing", "superseded"]);

    await finishIndexing(stub, staged);
    const deps = await depsOf(stub, staged);
    expect(deps.map((d) => d.id)).not.toContain(widePackId);
    expect(deps.length).toBeGreaterThan(0);
    expect(deps.every((d) => d.state === "live")).toBe(true);
    expect(await commit(stub, staged)).toEqual(ok("refs/heads/a"));
    expect(await refOf(stub, "refs/heads/a")).toBe(oidToHex(a.oid));
  });

  it("still refuses a push when only the first lookup slice of its merged-away dependency is held", async () => {
    const { stub } = await newRepo();
    await inRepo(stub, (repo) => {
      repo.packCap = { ...PACK_CAP_DEFAULTS, cap: 1 };
    });
    // Main's pack: the wide commit's 4,102 objects, and 6 loose blobs whose oids sort after
    // all of them, so they fall in the second lookup slice (positions 4,102 to 4,107).
    const wide = await widePack(4_100);
    const highest = wide.objects
      .map((o) => oidToHex(o.oid))
      .sort()
      .at(-1) as string;
    const extras: PackObject[] = [];
    for (let i = 0; extras.length < 6; i++) {
      const data = encoder.encode(`extra ${i}\n`);
      const blobOid = await hashObject(sha1, "blob", data);
      if (oidToHex(blobOid) > highest) extras.push({ type: "blob", data, oid: blobOid });
    }
    expect(
      await push(
        stub,
        concat([
          pushBody([{ old: ZERO, new: oidToHex(wide.oid), ref: MAIN }]),
          await packOf([...wide.objects, ...extras]),
        ]),
      ),
    ).toEqual(ok(MAIN));
    const widePackId = await onlyLivePack(stub);
    const a = await branchBody("refs/heads/a", wide.oid, 670);
    const staged = await stageBeforeLastPhase(stub, a.bytes);
    expect(await push(stub, (await branchBody("refs/heads/b", wide.oid, 671)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    expect(await mergedWhileIndexing(stub, staged, widePackId)).toEqual(["indexing", "superseded"]);
    // The compacted pack is removed for good; a new pack holds the wide commit's objects
    // again, but not the loose blobs.
    await inRepo(stub, ({ git }) => {
      for (const pack of git.registry.liveOwn())
        git.registry.transition(pack.packId, ["live"], "condemned");
    });
    expect(
      await push(
        stub,
        concat([
          pushBody([{ old: ZERO, new: oidToHex(wide.oid), ref: "refs/heads/p" }]),
          wide.pack,
        ]),
      ),
    ).toEqual(ok("refs/heads/p"));
    expect(await mergedWhileIndexing(stub, staged, widePackId)).toEqual(["indexing", "superseded"]);

    await finishIndexing(stub, staged);
    // Every object of the first slice is readable, but the second slice's loose blobs are in
    // no readable pack: the dependency is kept, and the commit refuses.
    expect((await depsOf(stub, staged)).map((d) => d.id)).toEqual([widePackId]);
    expect(await commit(stub, staged)).toEqual([
      "unpack ok\n",
      `ng refs/heads/a ${GONE}\n`,
      "0000",
    ]);
    expect(await refOf(stub, "refs/heads/a")).toBeNull();
  });

  it("still refuses a push indexed against a merged pack whose objects are gone", async () => {
    const { stub, tip } = await repoWithPacks(2, 2);
    const a = await branchBody("refs/heads/a", tip, 700);
    const staged = await stageBeforeLastPhase(stub, a.bytes);
    expect(await push(stub, (await branchBody("refs/heads/b", tip, 701)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    // The compacted pack is removed for good before the first push finishes indexing.
    await inRepo(stub, ({ git }) => {
      for (const pack of git.registry.liveOwn().filter((p) => p.kind === "compact"))
        git.registry.transition(pack.packId, ["live"], "condemned");
    });

    await finishIndexing(stub, staged);
    expect(await commit(stub, staged)).toEqual([
      "unpack ok\n",
      `ng refs/heads/a ${GONE}\n`,
      "0000",
    ]);
    expect(await refOf(stub, "refs/heads/a")).toBeNull();
  });
  it("follows a dependency of two lookup slices through holders read by ranges, reading only their oid tables", async () => {
    const { stub } = await newRepo();
    await inRepo(stub, (repo) => {
      repo.packCap = { ...PACK_CAP_DEFAULTS, cap: 1 };
    });
    // 4,102 objects: two lookup slices.
    const wide = await widePack(4_100);
    expect(
      await push(
        stub,
        concat([pushBody([{ old: ZERO, new: oidToHex(wide.oid), ref: MAIN }]), wide.pack]),
      ),
    ).toEqual(ok(MAIN));
    const widePackId = await onlyLivePack(stub);
    expect(await push(stub, (await branchBody("refs/heads/b", wide.oid, 680)).bytes)).toEqual(
      ok("refs/heads/b"),
    );

    const followed = await followRanged(stub, widePackId);
    // The compacted pack holds every object, as its oid table shows: one read for each
    // slice, after its header, and no read of its offsets (32-bit or 64-bit).
    expect(followed.live).toHaveLength(1);
    expect(followed.deps).toEqual(followed.live);
    const [holder] = followed.holders;
    expect(holder?.open).toEqual([0, IDX_OIDS_START]);
    expect(holder?.oidTable).toHaveLength(2);
    expect(holder?.other).toEqual([]);
    // Read accounting: the source index once, whole; every range read reported.
    expect(followed.sourceReads).toBe(1);
    expect(followed.onRead).toBe(followed.rangeReads);
  });

  it("keeps a dependency whose later lookup slice no holder read by ranges has, after checking that slice", async () => {
    const { stub } = await newRepo();
    await inRepo(stub, (repo) => {
      repo.packCap = { ...PACK_CAP_DEFAULTS, cap: 1 };
    });
    // The wide commit's 4,102 objects, and 6 blobs sorting after all of them: the second slice.
    const wide = await widePack(4_100);
    const highest = wide.objects
      .map((o) => oidToHex(o.oid))
      .sort()
      .at(-1) as string;
    const extras: PackObject[] = [];
    for (let i = 0; extras.length < 6; i++) {
      const data = encoder.encode(`later slice ${i}\n`);
      const blobOid = await hashObject(sha1, "blob", data);
      if (oidToHex(blobOid) > highest) extras.push({ type: "blob", data, oid: blobOid });
    }
    expect(
      await push(
        stub,
        concat([
          pushBody([{ old: ZERO, new: oidToHex(wide.oid), ref: MAIN }]),
          await packOf([...wide.objects, ...extras]),
        ]),
      ),
    ).toEqual(ok(MAIN));
    const widePackId = await onlyLivePack(stub);
    expect(await push(stub, (await branchBody("refs/heads/b", wide.oid, 690)).bytes)).toEqual(
      ok("refs/heads/b"),
    );
    // The compacted pack is removed for good; a new pack holds the wide commit's objects
    // again, but not the 6 blobs.
    await inRepo(stub, ({ git }) => {
      for (const pack of git.registry.liveOwn())
        git.registry.transition(pack.packId, ["live"], "condemned");
    });
    expect(
      await push(
        stub,
        concat([
          pushBody([{ old: ZERO, new: oidToHex(wide.oid), ref: "refs/heads/p" }]),
          wide.pack,
        ]),
      ),
    ).toEqual(ok("refs/heads/p"));

    const followed = await followRanged(stub, widePackId);
    // Kept as it is, so the commit refuses.
    expect(followed.deps).toEqual([widePackId]);
    // The new pack answered the first slice and was asked for the second: an oid-table read
    // each, and no offsets read.
    expect(followed.live).toHaveLength(1);
    const [holder] = followed.holders;
    expect(holder?.oidTable).toHaveLength(2);
    expect(holder?.other).toEqual([]);
    expect(followed.onRead).toBe(followed.rangeReads);
  });
});
