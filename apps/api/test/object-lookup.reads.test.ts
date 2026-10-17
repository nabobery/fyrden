// What finding objects costs in R2 reads as a repository grows: the packs'
// `.idx` files are read once into the repository object's memory, so later
// lookups read none, however many packs or merged pull requests there are.
import { env } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { type Oid, oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { MERGE_POLICY, mergeOutcome } from "../src/do/repo/merge.js";
import { openLiveReader } from "../src/git/live-reader.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima".split(" ");
/** Forty lines of eight words, different for each seed. */
const lines = (seed: number) =>
  Array.from({ length: 40 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => WORDS[(seed * 7 + i * 3 + j) % WORDS.length]).join(" "),
  );
const fileOf = (n: number) =>
  `src/m${n % 5}/s${Math.floor(n / 5) % 4}/file${String(n).padStart(3, "0")}.txt`;

/**
 * The repository's storage with its R2 GETs counted: `.idx` reads (the
 * bucket) and pack reads (the pack store), the object's caches shared.
 */
function counting(git: RepoGitStorage) {
  const gets = { idx: 0, pack: 0 };
  const bind = <T extends object>(target: T, counted: PropertyKey, count: () => void): T =>
    new Proxy(target, {
      get(inner, property) {
        const value = Reflect.get(inner, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === counted) count();
          return value.apply(inner, args);
        };
      },
    });
  const bucket = bind(git.bucket, "get", () => gets.idx++);
  const packStore = bind(git.packStore, "openRange", () => gets.pack++);
  const counted = new Proxy(git, {
    get(inner, property) {
      if (property === "bucket") return bucket;
      if (property === "packStore") return packStore;
      return Reflect.get(inner, property);
    },
  });
  return { git: counted, gets };
}

interface Repo {
  readonly owner: Who;
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly stub: DurableObjectStub<RepoDO>;
}

async function newRepo(): Promise<Repo> {
  const owner = await user();
  const { id, name } = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("lookups") }),
    )
  ).body;
  return { owner, id, name, path: `/repos/${owner.handle}/${name}`, stub: env.REPO.getByName(id) };
}

async function commitOn(repo: Repo, branch: string, changes: Record<string, unknown>[]) {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${repo.path}/file-commits`, repo.owner.token, { branch, message: "c", changes }),
  );
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  return made.body.commit.sha;
}

async function branchAt(repo: Repo, name: string, sha: string) {
  const pushed = await postPush(
    {
      repo: { id: repo.id, name: repo.name, stub: repo.stub },
      owner: {
        principalId: repo.owner.principalId,
        token: await scopedToken(repo.owner.principalId, [], "git"),
      },
      path: `/${repo.owner.handle}/${repo.name}.git`,
    },
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

/** Every pack's index leaves the object's memory: as after the object is evicted. */
const coldIndexes = (repo: Repo) => inRepo(repo.stub, (r) => r.git.packIndexes.retain(new Set()));

/** R2 GETs of reading `oids` (header, then body) with a new reader and a cold block tier. */
const readCost = (repo: Repo, oids: readonly Oid[]) =>
  inRepo(repo.stub, async (r) => {
    const { git, gets } = counting(r.git);
    const reader = await openLiveReader(
      { git, memoryBlocks: createClockBlockCache() },
      { deltaBaseCacheBytes: 1 << 20, maxCacheCalls: 0 },
    );
    if (!reader) throw new Error("no packs");
    try {
      for (const oid of oids) {
        expect((await reader.readHeader(oid))?.type).toBe("blob");
        expect(await reader.readObject(oid)).toBeDefined();
      }
    } finally {
      reader.release();
    }
    return { ...gets, packs: r.git.registry.inState("live").length };
  });

const blobSha = async (repo: Repo, path: string) =>
  oidFromHex(
    (await json<{ sha: string }>(api("GET", `${repo.path}/contents/${path}`, repo.owner.token)))
      .body.sha,
  );

describe("object lookups", () => {
  it("read no index once warm, however many writes the repository has had", async () => {
    const repo = await newRepo();
    // The oldest pack holds these files; then 99 writes of their own pack each.
    await commitOn(
      repo,
      "main",
      Array.from({ length: 20 }, (_, n) => ({ path: fileOf(n), content: lines(n).join("\n") })),
    );
    // The packs whose indexes the writes left in memory, every ten writes.
    const wasHeld = new Set<string>();
    const held = () =>
      inRepo(repo.stub, (r) => {
        const live = r.git.registry.inState("live").map((p): string => p.packId);
        const inMemory = (id: string) => r.git.packIndexes.get(id) !== undefined;
        return {
          live,
          held: live.filter(inMemory),
          retiredHeld: [...wasHeld].filter((id) => !live.includes(id) && inMemory(id)),
          bytes: r.git.packIndexes.bytes,
          maxBytes: r.git.packIndexes.maxBytes,
        };
      });
    for (let h = 0; h < 99; h++) {
      await commitOn(repo, "main", [{ path: `hist/h${h}.txt`, content: `${h}\n` }]);
      if (h % 10 === 0) for (const id of (await held()).held) wasHeld.add(id);
    }
    const oids = await Promise.all(Array.from({ length: 20 }, (_, n) => blobSha(repo, fileOf(n))));

    // Merges at push time retired packs whose indexes were in memory: they left it.
    await readCost(repo, oids);
    const after = await held();
    expect([...wasHeld].filter((id) => !after.live.includes(id)).length).toBeGreaterThan(0);
    expect(after.retiredHeld).toEqual([]);
    expect(after.held).toEqual(after.live);
    expect(after.bytes).toBeLessThanOrEqual(after.maxBytes);

    // Cold: one whole read of each live pack's index at most.
    await coldIndexes(repo);
    const cold = await readCost(repo, oids);
    expect(cold.idx).toBeGreaterThan(0);
    expect(cold.idx).toBeLessThanOrEqual(cold.packs);
    // Warm (the next request): twenty objects in the oldest pack, no index read.
    const warm = await readCost(repo, oids);
    expect(warm.idx).toBe(0);
  });

  it("merging onto a base moved by 30 merged pull requests stays within budget", async () => {
    /**
     * A base of 300 files, two pull requests (10 files changed and 20
     * added each, on different files), and `merged` pull requests of the
     * same shape merged into the base before them.
     */
    async function diverged(merged: number) {
      const repo = await newRepo();
      const base = new Map<number, string[]>();
      for (let part = 0; part < 3; part++) {
        const changes = Array.from({ length: 100 }, (_, k) => {
          const n = part * 100 + k;
          base.set(n, lines(n));
          return { path: fileOf(n), content: lines(n).join("\n") };
        });
        await commitOn(repo, "main", changes);
      }
      const fork = await commitOn(repo, "main", [{ path: "fork.txt", content: "fork\n" }]);
      // A pull request edits one line of each of its files, from the fork point.
      const pull = (name: string, files: number[], line: number) =>
        files
          .map((n) => {
            const edited = [...(base.get(n) as string[])];
            edited[line] = `changed by ${name}`;
            return { path: fileOf(n), content: edited.join("\n") };
          })
          .concat(
            Array.from({ length: 20 }, (_, k) => ({
              path: `added/${name}/f${k}.txt`,
              content: `${name} ${k}\n`,
            })),
          );
      const tenFiles = (from: number) => Array.from({ length: 10 }, (_, k) => from + k * 13);
      const heads: string[] = [];
      for (const [name, from] of [
        ["a", 0],
        ["b", 150],
      ] as const) {
        await branchAt(repo, name, fork);
        heads.push(await commitOn(repo, name, pull(name, tenFiles(from), 2)));
      }
      // The merged pull requests change lines far from the two above, on the base as it moves.
      for (let i = 0; i < merged; i++) {
        const files = Array.from({ length: 10 }, (_, k) => (i * 37 + k * 29) % 300);
        const changes = files.map((n) => {
          const now = base.get(n) as string[];
          now[20 + (i % 15)] = `merged ${i}`;
          return { path: fileOf(n), content: now.join("\n") };
        });
        for (let k = 0; k < 20; k++)
          changes.push({ path: `added/merged${i}/f${k}.txt`, content: `${i} ${k}\n` });
        await commitOn(repo, "main", changes);
      }
      const baseTip = await commitOn(repo, "main", [{ path: "tip.txt", content: "tip\n" }]);
      for (const head of ["a", "b"]) {
        const opened = await json(
          api("POST", `${repo.path}/pulls`, repo.owner.token, { title: head, head, base: "main" }),
        );
        expect(opened.status).toBe(201);
      }
      // The merge work of the first pull request, from cold indexes and blocks.
      await coldIndexes(repo);
      const work = await inRepo(repo.stub, async (r) => {
        const { git, gets } = counting(r.git);
        const outcome = await mergeOutcome(
          { git, memoryBlocks: createClockBlockCache() },
          { baseTip: oidFromHex(baseTip), head: oidFromHex(heads[0] as string), upToDate: false },
          MERGE_POLICY,
        );
        expect(outcome.kind).toBe("clean");
        return gets.idx + gets.pack;
      });
      return { repo, work };
    }

    const one = await diverged(1);
    const { repo, work } = await diverged(30);
    expect(work).toBeLessThanOrEqual(one.work + 4);

    // Mergeability is worked out within its budget, from cold indexes.
    await coldIndexes(repo);
    await inRepo(repo.stub, (r) => r.alarm());
    for (const number of [1, 2]) {
      const state = await json<{ mergeable_state: string }>(
        api("GET", `${repo.path}/pulls/${number}`, repo.owner.token),
      );
      expect(state.body.mergeable_state).toBe("clean");
    }
    await coldIndexes(repo);
    const squashed = await json(
      api("PUT", `${repo.path}/pulls/1/merge`, repo.owner.token, { merge_method: "squash" }),
    );
    expect(squashed.status, JSON.stringify(squashed.body)).toBe(200);
    // The other pull request's 30-file commit replays onto the new base.
    await coldIndexes(repo);
    const rebased = await json(
      api("PUT", `${repo.path}/pulls/2/merge`, repo.owner.token, { merge_method: "rebase" }),
    );
    expect(rebased.status, JSON.stringify(rebased.body)).toBe(200);
  });
});
