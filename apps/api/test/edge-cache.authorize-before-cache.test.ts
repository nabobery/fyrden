// Authorize before any cache (design: object authorization): a response
// cache can only be made from a grant the access check issued, it looks up only
// objects that passed that repository's object check, and its keys carry
// the repository id. The same blob in a private repository A and a public
// repository B: a user without access to A never reaches a cache entry
// keyed to A, and no cache is consulted before authorization. The git
// front door, for a caller without access, never touches a cache at all.

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { RepoAccessGrant } from "../src/git/cache/grant.js";
import { ObjectGrant } from "../src/git/cache/object-grant.js";
import { authorizedCache, PRIVATE_CACHE_CONTROL } from "../src/git/cache/response-cache.js";
import type { RepoEntry } from "../src/repos/directory.js";
import {
  entryOf,
  handleOf,
  loggingAuthorities,
  spyCaches,
  tokenRecord,
} from "./helpers/edge-cache.js";
import { fetchBody, loadFixture, throughWorker } from "./helpers/fetch-repo.js";
import { basic, createRepo, ORIGIN, type TestRepo } from "./helpers/git-http.js";
import { principalWithToken } from "./helpers/principals.js";

const fixtures = inject("fetchFixtures");
const main = fixtures.single.refs.find((r) => r.name === "refs/heads/main")?.oid as string;

let alice: { principalId: string; token: string };
let bob: { principalId: string; token: string };
let repoA: TestRepo;
let repoB: TestRepo;
let entryA: RepoEntry;
let entryB: RepoEntry;

beforeAll(async () => {
  alice = await principalWithToken("user", "git");
  bob = await principalWithToken("user", "git");
  // A: private, Alice's. B: public, Bob's. Both hold the same history, so
  // the same blobs.
  repoA = await createRepo(alice.principalId);
  repoB = await createRepo(bob.principalId);
  await env.DIRECTORY.prepare("UPDATE repos SET visibility = 'public' WHERE id = ?")
    .bind(repoB.id)
    .run();
  await loadFixture(repoA.stub, fixtures.single, { allReachable: false });
  await loadFixture(repoB.stub, fixtures.single, { allReachable: false });
  entryA = await entryOf(alice.principalId, repoA);
  entryB = await entryOf(bob.principalId, repoB);
});

const blobAt = { kind: "path", commit: main, path: "a.txt" } as const;

/** Whether every response-cache call in `log` comes after an object check of the key's repository. */
function cacheCallsFollowChecks(log: readonly string[]): boolean {
  const checked = new Set<string>();
  for (const entry of log) {
    const [what, arg] = entry.split(" ") as [string, string];
    if (what === "check") checked.add(arg);
    if (what === "match" || what === "put") {
      const repoId = new URL(arg).pathname.split("/")[2] as string;
      if (!checked.has(repoId)) return false;
    }
  }
  return true;
}

describe("response cache", () => {
  it("serves a user without access to A nothing keyed to A, and the same blob through B from B's own key", async () => {
    const log: string[] = [];
    const { open } = spyCaches(log);
    const authorities = loggingAuthorities(log);

    // Alice reads the blob through A: checked, then cached under A's key.
    const aliceGrant = await RepoAccessGrant.check(
      env,
      tokenRecord(alice.principalId),
      entryA,
      "read",
    );
    expect(aliceGrant).toBeDefined();
    const aliceBlob = await ObjectGrant.authorize(
      aliceGrant as RepoAccessGrant,
      authorities,
      blobAt,
    );
    expect(aliceBlob?.object.kind).toBe("blob");
    const cacheA = authorizedCache(aliceGrant as RepoAccessGrant, { open });
    expect(await cacheA.match(aliceBlob as ObjectGrant, "raw")).toBeUndefined();
    await cacheA.put(
      aliceBlob as ObjectGrant,
      "raw",
      new Response("A's copy", {
        headers: { "content-type": "text/plain", "set-cookie": "s=1", "cache-control": "public" },
      }),
    );
    const fromA = await cacheA.match(aliceBlob as ObjectGrant, "raw");
    expect(await fromA?.text()).toBe("A's copy");
    expect(fromA?.headers.get("cache-control")).toBe(PRIVATE_CACHE_CONTROL);
    expect(fromA?.headers.get("set-cookie")).toBeNull();
    const aKeys = log.filter((l) => l.startsWith("match ") || l.startsWith("put "));
    expect(aKeys.every((l) => l.includes(`/v1/${repoA.id}/blob/`))).toBe(true);

    // Bob may not read A: no grant, so no cache and no object check for A.
    log.length = 0;
    expect(
      await RepoAccessGrant.check(env, tokenRecord(bob.principalId), entryA, "read"),
    ).toBeUndefined();
    expect(
      await RepoAccessGrant.check(env, tokenRecord(alice.principalId, [repoB.id]), entryA, "read"),
    ).toBeUndefined();
    expect(log).toEqual([]);

    // Bob reads the same blob (same SHA) through B: a miss on B's own key, never A's entry.
    const bobGrant = await RepoAccessGrant.check(env, tokenRecord(bob.principalId), entryB, "read");
    expect(bobGrant).toBeDefined();
    const bobBlob = await ObjectGrant.authorize(bobGrant as RepoAccessGrant, authorities, blobAt);
    expect(bobBlob?.object).toEqual(aliceBlob?.object);
    const cacheB = authorizedCache(bobGrant as RepoAccessGrant, { open });
    expect(await cacheB.match(bobBlob as ObjectGrant, "raw")).toBeUndefined();
    await cacheB.put(bobBlob as ObjectGrant, "raw", new Response("B's copy"));
    expect(await (await cacheB.match(bobBlob as ObjectGrant, "raw"))?.text()).toBe("B's copy");
    const bKeys = log.filter((l) => l.startsWith("match ") || l.startsWith("put "));
    expect(bKeys.length).toBe(3);
    expect(bKeys.every((l) => l.includes(`/v1/${repoB.id}/blob/`))).toBe(true);
    expect(log.some((l) => l.includes(repoA.id))).toBe(false);

    // A's proof does not open B's cache, nor B's proof A's.
    log.length = 0;
    await expect(cacheB.match(aliceBlob as ObjectGrant, "raw")).rejects.toThrow(TypeError);
    await expect(cacheA.put(bobBlob as ObjectGrant, "raw", new Response("x"))).rejects.toThrow(
      TypeError,
    );
    expect(log).toEqual([]);
    // A's entry is still A's only.
    expect(await (await cacheA.match(aliceBlob as ObjectGrant, "raw"))?.text()).toBe("A's copy");
  });

  it("never looks up a cache before the access check and the object check", async () => {
    const log: string[] = [];
    const { open } = spyCaches(log);
    const authorities = loggingAuthorities(log);
    const grant = (await RepoAccessGrant.check(
      env,
      tokenRecord(alice.principalId),
      entryA,
      "read",
    )) as RepoAccessGrant;
    const cache = authorizedCache(grant, { open });
    // Making the cache touches nothing; the cache opens on first use.
    expect(log).toEqual([]);
    for (const request of [
      blobAt,
      { kind: "commit", commit: main } as const,
      { kind: "path", commit: main, path: "" } as const,
      { kind: "diff", base: fixtures.have, head: main } as const,
    ]) {
      const object = (await ObjectGrant.authorize(grant, authorities, request)) as ObjectGrant;
      expect(object).toBeDefined();
      await cache.match(object, "json");
      await cache.put(object, "json", new Response("{}"));
    }
    expect(log.filter((l) => l.startsWith("check")).length).toBe(4);
    expect(log.filter((l) => l.startsWith("match")).length).toBe(4);
    expect(cacheCallsFollowChecks(log)).toBe(true);
  });

  it("cannot be made or used without proofs the checks issued", async () => {
    const log: string[] = [];
    const { open } = spyCaches(log);
    const authorities = loggingAuthorities(log);
    const forged = Object.freeze({
      repoId: repoA.id,
      networkId: entryA.networkId,
      visibility: "private",
      principalId: bob.principalId,
      access: "read",
    }) as unknown as RepoAccessGrant;
    const viaPrototype = Object.assign(Object.create(RepoAccessGrant.prototype), {
      repoId: repoA.id,
    }) as RepoAccessGrant;
    for (const fake of [forged, viaPrototype, undefined as unknown as RepoAccessGrant]) {
      expect(() => authorizedCache(fake, { open })).toThrow(TypeError);
      await expect(ObjectGrant.authorize(fake, authorities, blobAt)).rejects.toThrow(TypeError);
    }

    // A real grant with a forged object proof: refused before any cache call.
    const grant = (await RepoAccessGrant.check(
      env,
      tokenRecord(alice.principalId),
      entryA,
      "read",
    )) as RepoAccessGrant;
    const cache = authorizedCache(grant, { open });
    const fakeObject = Object.freeze({
      grant,
      object: { kind: "blob", oid: "a".repeat(40) },
    }) as unknown as ObjectGrant;
    await expect(cache.match(fakeObject, "raw")).rejects.toThrow(TypeError);
    await expect(cache.put(fakeObject, "raw", new Response("x"))).rejects.toThrow(TypeError);
    expect(log).toEqual([]);

    // An object A does not hold gets no proof, so there is nothing to look up.
    const missing = await ObjectGrant.authorize(grant, authorities, {
      kind: "commit",
      commit: "0".repeat(40),
    });
    expect(missing).toBeUndefined();
    expect(log).toEqual([`check ${repoA.id}`]);
  });
});

describe("git front door", () => {
  const spied: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    spied.length = 0;
  });

  /** Spies on every Cache API cache opened (and the default cache) while a request runs. */
  function spyOnCacheApi() {
    const realOpen = caches.open.bind(caches);
    vi.spyOn(caches, "open").mockImplementation(async (name: string) => {
      spied.push(`open ${name}`);
      const cache = await realOpen(name);
      return {
        match: async (...args: Parameters<Cache["match"]>) => {
          spied.push("match");
          return cache.match(...args);
        },
        put: async (...args: Parameters<Cache["put"]>) => {
          spied.push("put");
          return cache.put(...args);
        },
        delete: (...args: Parameters<Cache["delete"]>) => cache.delete(...args),
      } as Cache;
    });
    vi.spyOn(caches.default, "match").mockImplementation(async () => {
      spied.push("default match");
      return undefined;
    });
  }

  const upload = (repo: TestRepo, ownerId: string, token: string, args: string[]) =>
    new Request(`${ORIGIN}/${handleOf(ownerId)}/${repo.name}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "Git-Protocol": "version=2",
        Authorization: basic(token),
      },
      body: fetchBody(args),
    });

  const clone = [`want ${main}`, "ofs-delta", "no-progress", "done"];

  it("refuses a caller without access to A before any cache is opened or read", async () => {
    spyOnCacheApi();
    for (const request of [
      upload(repoA, alice.principalId, bob.token, clone),
      new Request(
        `${ORIGIN}/${handleOf(alice.principalId)}/${repoA.name}.git/info/refs?service=git-upload-pack`,
        {
          headers: { "Git-Protocol": "version=2", Authorization: basic(bob.token) },
        },
      ),
    ]) {
      await throughWorker(request, { plan: "free" }, async (response) => {
        expect(response.status).toBe(404);
        await response.arrayBuffer();
      });
    }
    expect(spied).toEqual([]);
  });

  it("reads pack blocks through the cache only for an authorized caller", async () => {
    // A repository of its own: its object's memory tier starts empty.
    const repo = await createRepo(alice.principalId);
    await loadFixture(repo.stub, fixtures.single, { allReachable: false });
    spyOnCacheApi();
    await throughWorker(
      upload(repo, alice.principalId, alice.token, clone),
      { plan: "free" },
      async (response) => {
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      },
    );
    // A regenerated clone reads blocks: the block cache, never the default cache.
    expect(spied).toContain("open fyrden-pack-blocks");
    expect(spied.some((s) => s === "match")).toBe(true);
    expect(spied).not.toContain("default match");
  });
});
