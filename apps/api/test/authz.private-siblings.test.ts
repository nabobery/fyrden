// Two private siblings in one fork network share a pack (design: object
// authorization): B holds the whole history; A, Alice's, was
// forked from B at main~1, borrows B's pack and holds only the commits up
// to main~1. Nothing only B reaches (a commit, tree, blob or diff) is ever
// served through A: not by SHA, not through a commit context, not by a
// fetch want, and not from any cache, although A's reader can read every
// block of the shared pack and the network-scoped block tier holds blocks
// B's requests put there.

import { env } from "cloudflare:workers";
import { promotePendingCommits } from "@fyrden/adapters-cloudflare/git";
import { addPendingCommits, oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { RepoAccessGrant } from "../src/git/cache/grant.js";
import type { ObjectAccessRequest } from "../src/git/cache/object-access.js";
import { ObjectGrant } from "../src/git/cache/object-grant.js";
import { authorizedCache } from "../src/git/cache/response-cache.js";
import {
  entryOf,
  handleOf,
  loggingAuthorities,
  spyCaches,
  tokenRecord,
} from "./helpers/edge-cache.js";
import type { FetchFixtureRepo } from "./helpers/fetch-fixtures.js";
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
import { inRepo } from "./helpers/repo-git.js";

const fixtures = inject("fetchFixtures");
const single = fixtures.single;
const tipOf = (name: string) => single.refs.find((r) => r.name === name)?.oid as string;
const main = tipOf("refs/heads/main");
const feature = tipOf("refs/heads/feature");
const forkPoint = fixtures.have;

let alice: { principalId: string; token: string };
let bob: { principalId: string; token: string };
let repoA: TestRepo;
let repoB: TestRepo;

/** The commits `tip` reaches in the fixture. */
function closure(fixture: FetchFixtureRepo, tip: string) {
  const byOid = new Map(fixture.commits.map((c) => [c.oid, c]));
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    stack.push(...(byOid.get(oid)?.parents ?? []));
  }
  return fixture.commits.filter((c) => seen.has(c.oid));
}

/**
 * A new repository in `parent`'s network, the way a fork leaves it: the
 * parent's live packs registered as borrowed, the parent's verified commit
 * rows for the closure of `tip`, and `refs/heads/main` at `tip`.
 */
async function forkOf(parent: TestRepo, ownerId: string, tip: string): Promise<TestRepo> {
  const repo = await createRepo(ownerId);
  const shared = await inRepo(parent.stub, ({ git }) => ({
    networkId: git.networkId(),
    packs: git.context.storage.sql
      .exec<{ pack_id: string; r2_key: string; kind: string; bytes: number; n: number }>(
        "SELECT pack_id, r2_key, kind, bytes, object_count AS n FROM packs WHERE state = 'live'",
      )
      .toArray(),
  }));
  await env.DIRECTORY.prepare("UPDATE repos SET network_id = ? WHERE id = ?")
    .bind(shared.networkId, repo.id)
    .run();
  const commits = closure(single, tip);
  await inRepo(repo.stub, async ({ git }) => {
    git.initialize(shared.networkId);
    const now = Date.now();
    for (const pack of shared.packs) {
      git.context.storage.sql.exec(
        `INSERT INTO packs (pack_id, network_id, r2_key, origin, kind, state, object_count, bytes,
           all_reachable, created_at, last_touched_at)
         VALUES (?, ?, ?, 'borrowed', ?, 'live', ?, ?, 0, ?, ?)`,
        pack.pack_id,
        shared.networkId,
        pack.r2_key,
        pack.kind,
        pack.n,
        pack.bytes,
        now,
        now,
      );
    }
    const uploadId = uniqueId("fork");
    await addPendingCommits(
      git.commitGraph,
      uploadId,
      commits.map((c) => ({
        oid: oidFromHex(c.oid),
        tree: oidFromHex(c.tree),
        parents: c.parents.map(oidFromHex),
        commitTime: c.time,
      })),
    );
    promotePendingCommits(git.context, uploadId);
    const result = git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oidFromHex(tip) }],
      expectedVersion: git.refStore.readRefsSync().version,
    });
    if (!result.ok) throw new Error(`fork commit failed: ${JSON.stringify(result)}`);
  });
  return repo;
}

beforeAll(async () => {
  alice = await principalWithToken("user", "git");
  bob = await principalWithToken("user", "git");
  repoB = await createRepo(bob.principalId);
  // Not all-reachable: every clone regenerates its pack and reads blocks.
  await loadFixture(repoB.stub, single, { allReachable: false });
  repoA = await forkOf(repoB, alice.principalId, forkPoint);
});

const ask = (repo: TestRepo, request: ObjectAccessRequest) => repo.stub.objectAccess(request);

/** B's answer for an object only B reaches, so the test names real objects. */
async function onlyInB(request: ObjectAccessRequest): Promise<string> {
  const answer = await ask(repoB, request);
  if (!answer.ok || answer.kind === "diff") throw new Error("B should show this object");
  return answer.oid;
}

describe("two private siblings sharing a pack", () => {
  it("never serves B's commits through A", async () => {
    for (const commit of [main, feature]) {
      expect(await ask(repoB, { kind: "commit", commit })).toEqual({
        ok: true,
        kind: "commit",
        oid: commit,
      });
      expect(await ask(repoA, { kind: "commit", commit })).toEqual({ ok: false });
    }
    expect((await ask(repoA, { kind: "commit", commit: forkPoint })).ok).toBe(true);
  });

  it("never serves B's trees or blobs through A, by commit context or by SHA", async () => {
    const newBlob = await onlyInB({ kind: "path", commit: main, path: "a.txt" });
    const newRoot = await onlyInB({ kind: "path", commit: main, path: "" });
    const featureBlob = await onlyInB({ kind: "path", commit: feature, path: "dir/b.txt" });
    const featureDir = await onlyInB({ kind: "path", commit: feature, path: "dir" });
    for (const oid of [newBlob, newRoot, featureBlob, featureDir]) {
      expect(fixtures.single.objects).toContain(oid);
    }

    // Through B's commits: A does not hold them.
    for (const [commit, path] of [
      [main, "a.txt"],
      [main, ""],
      [feature, "dir/b.txt"],
      [feature, "dir"],
    ] as const) {
      expect(await ask(repoA, { kind: "path", commit, path })).toEqual({ ok: false });
    }
    // By SHA, through one of A's own commits: the path leads to A's object, not B's.
    expect(
      await ask(repoA, { kind: "path", commit: forkPoint, path: "a.txt", expect: newBlob }),
    ).toEqual({ ok: false });
    expect(
      await ask(repoA, { kind: "path", commit: forkPoint, path: "dir/b.txt", expect: featureBlob }),
    ).toEqual({ ok: false });
    expect(
      await ask(repoA, { kind: "path", commit: forkPoint, path: "", expect: newRoot }),
    ).toEqual({ ok: false });
    // A's own version of the file is served.
    const own = await ask(repoA, { kind: "path", commit: forkPoint, path: "a.txt" });
    expect(own.ok && own.kind === "blob" && own.oid !== newBlob).toBe(true);
    // Paths that name nothing are refused, never resolved loosely.
    for (const path of ["/a.txt", "a.txt/", "dir//b.txt", "./a.txt", "dir/../a.txt", "a.txt/x"]) {
      expect(await ask(repoA, { kind: "path", commit: forkPoint, path })).toEqual({ ok: false });
    }
  });

  it("never serves a diff that involves B's commits through A", async () => {
    expect((await ask(repoB, { kind: "diff", base: forkPoint, head: main })).ok).toBe(true);
    for (const [base, head] of [
      [forkPoint, main],
      [main, forkPoint],
      [forkPoint, feature],
    ] as const) {
      expect(await ask(repoA, { kind: "diff", base, head })).toEqual({ ok: false });
    }
    const root = single.commits.find((c) => c.parents.length === 0)?.oid as string;
    expect((await ask(repoA, { kind: "diff", base: root, head: forkPoint })).ok).toBe(true);
  });

  it("refuses B's objects as fetch wants through A, and clones only A's closure, after B warmed the shared block tier", async () => {
    const request = (repo: TestRepo, ownerId: string, token: string, args: string[]) =>
      new Request(`${ORIGIN}/${handleOf(ownerId)}/${repo.name}.git/git-upload-pack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-git-upload-pack-request",
          "Git-Protocol": "version=2",
          Authorization: basic(token),
        },
        body: fetchBody([...args, "ofs-delta", "no-progress", "done"]),
      });
    const fetchThrough = async (repo: TestRepo, ownerId: string, token: string, args: string[]) => {
      const metrics = recordingMetrics();
      let bytes = new Uint8Array(0);
      await throughWorker(
        request(repo, ownerId, token, args),
        { plan: "free", metrics: metrics.dataset },
        async (response) => {
          expect(response.status).toBe(200);
          bytes = new Uint8Array(await response.arrayBuffer());
        },
      );
      const blocks = (tier: string) =>
        metrics.points
          .filter((p) => p.name === "git.fetch.blocks" && p.blobs[0] === tier)
          .reduce((n, p) => n + p.value, 0);
      return { parsed: parseFetchResponse(bytes), blocks };
    };

    // A pair of its own, so every block in the network's Cache API tier was
    // put there by B's clone: B clones everything first.
    const b = await createRepo(bob.principalId);
    await loadFixture(b.stub, single, { allReachable: false });
    const a = await forkOf(b, alice.principalId, forkPoint);
    const fromB = await fetchThrough(
      b,
      bob.principalId,
      bob.token,
      [...new Set(single.refs.map((r) => r.oid))].map((oid) => `want ${oid}`),
    );
    expect((await packObjects(fromB.parsed.pack as Uint8Array)).oids).toEqual(single.objects);
    expect(fromB.blocks("miss")).toBeGreaterThan(0);

    // B's tips and B's objects, wanted through A: refused.
    const newBlob = await onlyInB({ kind: "path", commit: main, path: "a.txt" });
    for (const want of [main, feature, newBlob]) {
      const refused = await fetchThrough(a, alice.principalId, alice.token, [`want ${want}`]);
      expect(refused.parsed.error).toBe(`upload-pack: not our ref ${want}`);
      expect(refused.parsed.pack).toBeUndefined();
    }

    // A's own clone reads blocks B put in the shared tier (A's memory tier
    // is its own and empty), yet carries only what A's commits reach.
    const fromA = await fetchThrough(a, alice.principalId, alice.token, [`want ${forkPoint}`]);
    expect(fromA.blocks("cache_api")).toBeGreaterThan(0);
    expect(fromA.blocks("miss")).toBe(0);
    const sent = (await packObjects(fromA.parsed.pack as Uint8Array)).oids;
    expect(sent).toContain(forkPoint);
    for (const oid of [...fixtures.sinceHave, feature]) expect(sent).not.toContain(oid);
    for (const oid of sent) expect(single.objects).toContain(oid);

    // The object check is not swayed by the warm cache either.
    expect(await ask(a, { kind: "commit", commit: main })).toEqual({ ok: false });
    expect(await ask(a, { kind: "path", commit: main, path: "a.txt" })).toEqual({ ok: false });
  });

  it("never answers through A from a response B cached for the same SHA", async () => {
    const log: string[] = [];
    const { open } = spyCaches(log);
    const authorities = loggingAuthorities(log);
    const bobGrant = (await RepoAccessGrant.check(
      env,
      tokenRecord(bob.principalId),
      await entryOf(bob.principalId, repoB),
      "read",
    )) as RepoAccessGrant;
    const aliceGrant = (await RepoAccessGrant.check(
      env,
      tokenRecord(alice.principalId),
      await entryOf(alice.principalId, repoA),
      "read",
    )) as RepoAccessGrant;
    // Alice has no access to B, Bob none to A.
    expect(
      await RepoAccessGrant.check(
        env,
        tokenRecord(alice.principalId),
        await entryOf(bob.principalId, repoB),
        "read",
      ),
    ).toBeUndefined();

    // B caches its new blob, its commit and a diff.
    const newBlob = await onlyInB({ kind: "path", commit: main, path: "a.txt" });
    const bRequests: ObjectAccessRequest[] = [
      { kind: "path", commit: main, path: "a.txt" },
      { kind: "commit", commit: main },
      { kind: "diff", base: forkPoint, head: main },
    ];
    const cacheB = authorizedCache(bobGrant, { open });
    for (const req of bRequests) {
      const object = (await ObjectGrant.authorize(bobGrant, authorities, req)) as ObjectGrant;
      await cacheB.put(object, "raw", new Response("from B"));
    }

    // Through A, by every route: no proof, so A's cache is never consulted.
    log.length = 0;
    const cacheA = authorizedCache(aliceGrant, { open });
    for (const req of [
      ...bRequests,
      { kind: "path", commit: forkPoint, path: "a.txt", expect: newBlob } as const,
    ]) {
      expect(await ObjectGrant.authorize(aliceGrant, authorities, req)).toBeUndefined();
    }
    expect(log.every((l) => l === `check ${repoA.id}`)).toBe(true);
    expect(cacheA.calls).toBe(0);

    // A's own blob at the same path lives under A's key only.
    const own = (await ObjectGrant.authorize(aliceGrant, authorities, {
      kind: "path",
      commit: forkPoint,
      path: "a.txt",
    })) as ObjectGrant;
    expect(await cacheA.match(own, "raw")).toBeUndefined();
    expect(
      log.filter((l) => l.startsWith("match")).every((l) => l.includes(`/v1/${repoA.id}/`)),
    ).toBe(true);
  });
});
