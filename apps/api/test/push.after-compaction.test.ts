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
  createSha1Hasher,
  encodeCommit,
  encodeTree,
  hashObject,
  type Ident,
  type MemoryBudget,
  type Oid,
  oidToHex,
  PackBuilder,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { PACK_CAP_JOB_ID } from "../src/git/maintenance/tail-merge-job.js";
import { PACK_CAP_DEFAULTS } from "../src/git/maintenance/tail-merge-plan.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

type Stub = DurableObjectStub<RepoDO>;

const MAIN = "refs/heads/main";
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

const refOf = (stub: Stub, ref: string) =>
  inRepo(stub, ({ git }) => {
    const oid = git.refStore.readRefsSync().refs.get(ref);
    return oid ? oidToHex(oid) : null;
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

});
