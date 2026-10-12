// Model-based check of garbage collection: random sequences of pushes,
// force pushes, branch deletions, clock moves, collections and retire
// passes. After every step, every object reachable from a ref or from a
// reflog entry within the retention is in a live pack whose bytes are in
// R2: collection never loses a reachable object. Commits and packs are
// built here (one commit, tree and blob per push), with the model knowing
// each commit's closure.
import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  packObjectKey,
  promotePendingCommits,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import {
  addPendingCommits,
  createSha1Hasher,
  encodeCommit,
  encodeTree,
  hashObject,
  type MemoryBudget,
  type Oid,
  oidFromHex,
  oidToHex,
  PackBuilder,
  PackIdx,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { DAY } from "./helpers/gc.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const encoder = new TextEncoder();
const zlib = createWorkersZlib();
const sha1 = () => createSha1Hasher({ detectCollisions: false });
const unbounded: MemoryBudget = {
  reserve: async (bytes) => ({ bytes, release() {} }),
  tryReserve: (bytes) => ({ bytes, release() {} }),
};

type Step =
  | { kind: "push"; branch: number; orphan: boolean }
  | { kind: "force"; branch: number; back: number }
  | { kind: "delete"; branch: number }
  | { kind: "advance"; days: number }
  | { kind: "gc" }
  | { kind: "retire" };

/** A seeded generator (mulberry32), so every sequence is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random sequence of steps (weights: pushes 4, force pushes 2, clock moves 2, collections 2, deletions 1, retire passes 1). */
function sequence(seed: number): Step[] {
  const rand = prng(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)] as T;
  const branch = () => Math.floor(rand() * 3);
  const kinds = [
    "push",
    "push",
    "push",
    "push",
    "force",
    "force",
    "advance",
    "advance",
    "gc",
    "gc",
    "delete",
    "retire",
  ] as const;
  return Array.from({ length: 4 + Math.floor(rand() * 11) }, (): Step => {
    switch (pick(kinds)) {
      case "push":
        return { kind: "push", branch: branch(), orphan: rand() < 0.2 };
      case "force":
        return { kind: "force", branch: branch(), back: Math.floor(rand() * 7) };
      case "delete":
        return { kind: "delete", branch: branch() };
      case "advance":
        return { kind: "advance", days: pick([0.5, 2, 31, 91]) };
      case "gc":
        return { kind: "gc" };
      default:
        return { kind: "retire" };
    }
  });
}

interface ModelCommit {
  readonly oid: string;
  readonly closure: readonly string[];
}

/** A commit (child of `parent`) with its own tree and blob, stored as a live pack; returns its closure. */
async function pushCommit(git: RepoGitStorage, n: number, parent: ModelCommit | undefined) {
  const blob = encoder.encode(`content ${n}\n`);
  const blobOid = await hashObject(sha1, "blob", blob);
  const tree = encodeTree([{ mode: 0o100644, name: encoder.encode(`f${n}.txt`), oid: blobOid }]);
  const treeOid = await hashObject(sha1, "tree", tree);
  const ident = {
    name: encoder.encode("T"),
    email: encoder.encode("t@fyrden.invalid"),
    timestamp: 1_700_000_000 + n,
    timezone: "+0000",
  };
  const commit = encodeCommit({
    tree: treeOid,
    parents: parent ? [oidFromHex(parent.oid)] : [],
    author: ident,
    committer: ident,
    headers: [],
    message: encoder.encode(`commit ${n}\n`),
  });
  const commitOid = await hashObject(sha1, "commit", commit);
  const writer = git.packStore.beginPack();
  const builder = await PackBuilder.start(3, { sink: writer, zlib, memory: unbounded });
  await builder.addObject("commit", commit, commitOid);
  await builder.addObject("tree", tree, treeOid);
  await builder.addObject("blob", blob, blobOid);
  const finished = await builder.finish();
  await writer.finish();
  await git.bucket.put(packObjectKey(git.networkId(), writer.packId, "idx"), finished.idx.bytes);
  finished.release();
  git.context.storage.sql
    .exec("UPDATE packs SET object_count = 3 WHERE pack_id = ?", writer.packId)
    .toArray();
  await addPendingCommits(git.commitGraph, `push-${n}`, [
    {
      oid: commitOid,
      tree: treeOid,
      parents: parent ? [oidFromHex(parent.oid)] : [],
      commitTime: 1_700_000_000 + n,
    },
  ]);
  promotePendingCommits(git.context, `push-${n}`);
  return {
    packId: writer.packId,
    commit: {
      oid: oidToHex(commitOid),
      closure: [
        oidToHex(commitOid),
        oidToHex(treeOid),
        oidToHex(blobOid),
        ...(parent?.closure ?? []),
      ],
    } satisfies ModelCommit,
  };
}

/** Every oid in a live pack whose bytes are in R2. */
async function liveObjects(git: RepoGitStorage): Promise<Set<string>> {
  const out = new Set<string>();
  for (const row of git.registry.liveOwn()) {
    const pack = await git.bucket.head(row.r2Key);
    const idx = await git.bucket.get(packObjectKey(row.networkId, row.packId, "idx"));
    if (!pack || !idx) continue;
    const parsed = PackIdx.parse(new Uint8Array(await idx.arrayBuffer()));
    for (let i = 0; i < parsed.count; i++) out.add(oidToHex(parsed.oidAt(i)));
  }
  return out;
}

describe("garbage collection never loses a reachable object (model-based)", () => {
  it("random pushes, force pushes, deletions, clock moves, collections and retire passes", async () => {
    for (let seed = 1; seed <= 10; seed++) {
      const steps = sequence(seed);
      {
        const { stub } = await newRepo();
        await setPolicy(stub, { geometricFactor: 2 });
        const commits = new Map<string, ModelCommit>();
        const history: ModelCommit[] = [];
        const tips: (ModelCommit | undefined)[] = [undefined, undefined, undefined];
        let n = 0;
        for (const s of [
          { kind: "push", branch: 0, orphan: true } as Step,
          ...steps,
          { kind: "gc" } as Step,
        ]) {
          switch (s.kind) {
            case "push":
            case "force": {
              const name = `refs/heads/b${s.branch}`;
              const old = tips[s.branch];
              let next: ModelCommit;
              if (s.kind === "force" && history.length > 0) {
                next = history[Math.max(0, history.length - 1 - s.back)] as ModelCommit;
              } else {
                const parent = s.kind === "push" && !s.orphan ? old : undefined;
                const made = await inRepo(stub, async ({ git }) => {
                  const pushed = await pushCommit(git, n, parent);
                  const result = git.refStore.commitSync({
                    addPacks: [pushed.packId],
                    removePacks: [],
                    refUpdates: [
                      {
                        name,
                        oldOid: old ? hexOid(old.oid) : null,
                        newOid: hexOid(pushed.commit.oid),
                      },
                    ],
                    expectedVersion: git.refStore.state().version,
                  });
                  if (!result.ok) throw new Error(JSON.stringify(result));
                  return pushed.commit;
                });
                n++;
                commits.set(made.oid, made);
                history.push(made);
                tips[s.branch] = made;
                break;
              }
              await inRepo(stub, ({ git }) => {
                const result = git.refStore.commitSync({
                  addPacks: [],
                  removePacks: [],
                  refUpdates: [
                    { name, oldOid: old ? hexOid(old.oid) : null, newOid: hexOid(next.oid) },
                  ],
                  expectedVersion: git.refStore.state().version,
                });
                if (!result.ok) throw new Error(JSON.stringify(result));
              });
              tips[s.branch] = next;
              break;
            }
            case "delete": {
              const old = tips[s.branch];
              if (!old) break;
              await inRepo(stub, ({ git }) => {
                git.refStore.commitSync({
                  addPacks: [],
                  removePacks: [],
                  refUpdates: [
                    { name: `refs/heads/b${s.branch}`, oldOid: hexOid(old.oid), newOid: null },
                  ],
                  expectedVersion: git.refStore.state().version,
                });
              });
              tips[s.branch] = undefined;
              break;
            }
            case "advance":
              await advance(stub, s.days * DAY);
              break;
            case "gc":
              await runJob(stub, "repack");
              await runJob(stub, "gc");
              break;
            case "retire":
              await runJob(stub, "retire-packs");
              break;
          }
          // Everything a ref or a reflog entry within the retention reaches is live and stored.
          const { roots, live } = await inRepo(stub, async ({ git }) => {
            const since = git.context.now() - 90 * DAY;
            const reflog = git.context.storage.sql
              .exec<{ old_oid: ArrayBuffer | null; new_oid: ArrayBuffer | null }>(
                "SELECT old_oid, new_oid FROM reflog WHERE at >= ?",
                since,
              )
              .toArray()
              .flatMap((r) => [r.old_oid, r.new_oid])
              .filter((o): o is ArrayBuffer => o !== null)
              .map((o) => oidToHex(new Uint8Array(o) as Oid));
            const refs = [...git.refStore.readRefsSync().refs.values()].map(oidToHex);
            return { roots: [...refs, ...reflog], live: await liveObjects(git) };
          });
          for (const root of roots) {
            for (const oid of (commits.get(root) as ModelCommit).closure) {
              if (!live.has(oid))
                throw new Error(
                  `seed ${seed}, after ${s.kind}: ${oid} (reachable from ${root}) is not in a live pack`,
                );
            }
          }
        }
      }
    }
    expect(true).toBe(true);
  }, 300_000);
});

function hexOid(hex: string): Oid {
  return oidFromHex(hex);
}
