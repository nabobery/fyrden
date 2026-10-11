// Fork creation in a fork network: the fork borrows the parent's packs (no
// pack byte is copied), copies the parent's commit graph for the closure of
// its branches and tags, and is published (directory row, cloneable) only
// once that copy is done. Clones of the fork are checked against what git
// says the refs reach.

import { env, exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { resolveRepo } from "../src/repos/directory.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { createRepo, ORIGIN } from "./helpers/git-http.js";
import { cloneObjects, fork, handleOf, inNetwork, type Owner } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fixtures = inject("fetchFixtures");
const single = fixtures.single;
const tips = (fixture: typeof single) => fixture.refs.map((r) => r.oid);

let owner: Owner;

beforeAll(async () => {
  owner = await principalWithToken("user", "git");
});

/** Every R2 object key under a network's prefix. */
async function keysUnder(networkId: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.GIT.list({ prefix: `net/${networkId}/`, ...(cursor ? { cursor } : {}) });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) return keys.sort();
    cursor = page.cursor;
  }
}

describe("fork creation", () => {
  it("copies no pack bytes, borrows the parent's packs and is cloneable as soon as it is published", async () => {
    const parent = await createRepo(owner.principalId);
    await loadFixture(parent.stub, fixtures.split);
    const networkId = await inRepo(parent.stub, ({ git }) => git.networkId());
    const before = await keysUnder(networkId);

    const forker = await principalWithToken("user", "git");
    const { repo, result } = await fork(owner, parent, forker);
    expect(result.packsCompacted).toBe(0);
    expect(result.commitsCopied).toBe(fixtures.split.commits.length);
    expect(result.publishMs).toBeGreaterThanOrEqual(0);
    // No object was written under the network's prefix.
    expect(await keysUnder(networkId)).toEqual(before);

    const view = await inRepo(repo.stub, ({ git }) => ({
      networkId: git.networkId(),
      packs: git.context.storage.sql
        .exec<{ origin: string; state: string }>("SELECT origin, state FROM packs")
        .toArray(),
      refs: [...git.refStore.readRefsSync().refs.keys()].sort(),
      head: git.refStore.readRefsSync().head,
    }));
    expect(view.networkId).toBe(networkId);
    expect(view.packs.length).toBe(fixtures.split.packs.length);
    expect(view.packs.every((p) => p.origin === "borrowed" && p.state === "live")).toBe(true);
    expect(view.refs).toEqual(fixtures.split.refs.map((r) => r.name).sort());
    expect(view.head).toBe(fixtures.split.head);

    // The network records both as members and the packs as claimed by both.
    const status = await inNetwork(networkId, (n) => n.status());
    expect(status.members.map((m) => [m.repoId, m.state]).sort()).toEqual(
      [
        [parent.id, "active"],
        [repo.id, "active"],
      ].sort(),
    );
    for (const pack of status.packs)
      expect(pack.claims.sort()).toEqual([parent.id, repo.id].sort());

    // Cloneable at once, with exactly what git says the refs reach.
    const clone = await cloneObjects(forker, repo, tips(fixtures.split), ["done"]);
    expect(clone.error).toBeUndefined();
    expect(clone.objects).toEqual([...fixtures.split.objects].sort());
  });

  it("negotiates and finds merge bases right after publication (the commit graph was copied)", async () => {
    const parent = await createRepo(owner.principalId);
    await loadFixture(parent.stub, single);
    const { repo } = await fork(owner, parent, owner);
    const main = single.refs.find((r) => r.name === "refs/heads/main")?.oid as string;
    const fetched = await cloneObjects(owner, repo, [main], [`have ${fixtures.have}`, "done"]);
    expect(fetched.objects).toEqual([...fixtures.sinceHave].sort());
    const ancestry = await inRepo(repo.stub, async ({ git }) => {
      const rows = await git.commitGraph.read(
        single.commits.map(
          (c) => Uint8Array.from(c.oid.match(/../g) ?? [], (h) => parseInt(h, 16)) as never,
        ),
        "verified",
      );
      return rows.filter((r) => r !== undefined).length;
    });
    expect(ancestry).toBe(single.commits.length);
  });

  it("is not visible before its commit-graph copy completes", async () => {
    const parent = await createRepo(owner.principalId);
    await loadFixture(parent.stub, single);
    const name = uniqueId("fork");
    const seen: (string | undefined)[] = [];
    const { repo } = await fork(owner, parent, owner, {
      name,
      pageSize: 1,
      copyCalls: 1,
      hooks: {
        async afterCopyStep() {
          const entry = await resolveRepo(env, handleOf(owner), name, { consistency: "primary" });
          seen.push(entry?.id);
        },
      },
    });
    expect(seen.length).toBeGreaterThanOrEqual(single.commits.length);
    expect(seen.every((id) => id === undefined)).toBe(true);
    const entry = await resolveRepo(env, handleOf(owner), name, { consistency: "primary" });
    expect(entry?.id).toBe(repo.id);
  });

  // Each call to the fork's object copies pages from the parent within a
  // budget of calls to other objects, and hands the frontier back: a long
  // history takes several calls, each inside one invocation's budget.
  it("copies the commit graph in bounded steps: at most the call budget of pages per step", async () => {
    const parent = await createRepo(owner.principalId);
    await loadFixture(parent.stub, fixtures.split);
    const name = uniqueId("fork");
    const steps: { pages: number; copied: number }[] = [];
    const seen: (string | undefined)[] = [];
    const { result } = await fork(owner, parent, owner, {
      name,
      pageSize: 1,
      copyCalls: 2,
      hooks: {
        async afterCopyStep(step) {
          steps.push({ pages: step.pages, copied: step.copied });
          seen.push(
            (await resolveRepo(env, handleOf(owner), name, { consistency: "primary" }))?.id,
          );
        },
      },
    });
    const commits = fixtures.split.commits.length;
    expect(result.commitsCopied).toBe(commits);
    expect(steps.every((s) => s.pages >= 1 && s.pages <= 2)).toBe(true);
    expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(commits / 2));
    expect(steps.reduce((n, s) => n + s.copied, 0)).toBe(commits);
    // Published only after the last step.
    expect(seen.every((id) => id === undefined)).toBe(true);
  });

  it("a fork of a 1 GB repository copies no pack bytes; time to publish is recorded", async ({
    annotate,
  }) => {
    // Simulated size: the registry says the packs hold 1 GiB (the bytes are
    // never read by fork creation), with 20,000 commits to copy.
    const parent = await createRepo(owner.principalId);
    await loadFixture(parent.stub, single);
    const GiB = 1024 ** 3;
    const commits = 20_000;
    await inRepo(parent.stub, ({ git }) => {
      const sql = git.context.storage.sql;
      sql.exec("UPDATE packs SET bytes = ? WHERE state = 'live'", GiB).toArray();
      // A linear history of synthetic commits under the fixture's main.
      let parentOid = new Uint8Array(20);
      const main = single.refs.find((r) => r.name === "refs/heads/main")?.oid as string;
      parentOid = Uint8Array.from(main.match(/../g) ?? [], (h) => parseInt(h, 16));
      const base = sql
        .exec<{ generation: number; level: number }>(
          "SELECT generation, level FROM commits WHERE oid = ?",
          parentOid.buffer,
        )
        .one();
      git.context.storage.transactionSync(() => {
        for (let i = 1; i <= commits; i++) {
          const oid = new Uint8Array(20);
          new DataView(oid.buffer).setUint32(0, 0xfe000000 + i);
          sql
            .exec(
              `INSERT INTO commits (oid, tree, parents, commit_time, generation, level, signature)
               VALUES (?, ?, ?, ?, ?, ?, NULL)`,
              oid.buffer,
              new Uint8Array(20).buffer,
              parentOid.slice().buffer,
              2_000_000_000 + i,
              base.generation + i,
              base.level + i,
            )
            .toArray();
          parentOid = oid;
        }
      });
      // Tags are left out: peeling one would read the (simulated) pack bytes.
      const tip = git.refStore.readRefsSync();
      const dropTags = [...tip.refs]
        .filter(([name]) => name.startsWith("refs/tags/"))
        .map(([name, oid]) => ({ name, oldOid: oid, newOid: null }));
      const result = git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [
          { name: "refs/heads/big", oldOid: null, newOid: parentOid as never },
          ...dropTags,
        ],
        expectedVersion: tip.version,
      });
      if (!result.ok) throw new Error("ref update failed");
    });
    const networkId = await inRepo(parent.stub, ({ git }) => git.networkId());
    const before = await keysUnder(networkId);
    const started = Date.now();
    const { repo, result } = await fork(owner, parent, owner);
    const wall = Date.now() - started;
    await annotate(
      `fork of a simulated 1 GiB repository with ${commits + single.commits.length} commits: published in ${result.publishMs} ms (wall ${wall} ms)`,
      "time to publish",
    );
    expect(await keysUnder(networkId)).toEqual(before);
    expect(result.commitsCopied).toBe(commits + single.commits.length);
    const borrowedBytes = await inRepo(
      repo.stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ n: number }>("SELECT sum(bytes) AS n FROM packs WHERE origin = 'borrowed'")
          .one().n,
    );
    expect(borrowedBytes).toBe(GiB);
  });
});

describe("repos.fork operation", () => {
  it("forks a repository the caller can read, owned by the caller (REST)", async () => {
    const user = await principalWithToken("user", "pat");
    const parent = await createRepo(user.principalId);
    await loadFixture(parent.stub, single);
    const name = uniqueId("forked");
    const res = await exports.default.fetch(
      `${ORIGIN}/api/repos/${handleOf(user)}/${parent.name}/forks`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ name }),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ owner: handleOf(user), name, visibility: "private" });
    const entry = await resolveRepo(env, handleOf(user), name, { consistency: "primary" });
    expect(entry?.networkId).toBe(await inRepo(parent.stub, ({ git }) => git.networkId()));
  });

  it("reports the default branch HEAD names (master here), in the lookup and the fork response", async () => {
    const user = await principalWithToken("user", "pat");
    const parent = await createRepo(user.principalId);
    // As an import of a repository whose HEAD is master (and has no main) leaves it.
    await loadFixture(parent.stub, {
      ...single,
      refs: single.refs.map((r) =>
        r.name === "refs/heads/main" ? { ...r, name: "refs/heads/master" } : r,
      ),
    });
    await inRepo(parent.stub, ({ git }) => git.refStore.setHead("refs/heads/master"));
    const headers = { Authorization: `Bearer ${user.token}` };
    const lookup = (name: string) =>
      exports.default.fetch(`${ORIGIN}/api/repos/${handleOf(user)}/${name}`, { headers });
    expect(await (await lookup(parent.name)).json()).toMatchObject({ default_branch: "master" });

    const name = uniqueId("forked");
    const res = await exports.default.fetch(
      `${ORIGIN}/api/repos/${handleOf(user)}/${parent.name}/forks`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ name }),
      },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name, default_branch: "master" });
    expect(await (await lookup(name)).json()).toMatchObject({ default_branch: "master" });
  });

  it("answers 404 for a repository the caller cannot read, and 409 for a name it already has", async () => {
    const a = await principalWithToken("user", "pat");
    const b = await principalWithToken("user", "pat");
    const parent = await createRepo(a.principalId);
    const post = (token: string, name?: string) =>
      exports.default.fetch(`${ORIGIN}/api/repos/${handleOf(a)}/${parent.name}/forks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify(name ? { name } : {}),
      });
    expect((await post(b.token)).status).toBe(404);
    // Forking without a name takes the parent's, which its owner already has.
    const taken = await post(a.token);
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: "name_taken" });
  });
});
