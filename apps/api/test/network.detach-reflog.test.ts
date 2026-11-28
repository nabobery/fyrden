// A fork detached from its network keeps what its recent reflog entries
// reach, as garbage collection does: collection still runs afterwards, and
// a CI run registered for a commit only the reflog names can be checked
// out. What only a sibling reaches is never copied, and what only the
// reflog reaches is never served.
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { oidFromHex } from "@fyrden/git-core";
import { beforeAll, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import type { DetachCursor } from "../src/network/detach.js";
import { user } from "./helpers/api.js";
import { loadFixture, storeFixture } from "./helpers/fetch-repo.js";
import { DAY, HOUR, minus, moveRef, objectsOf } from "./helpers/gc.js";
import { createRepo } from "./helpers/git-http.js";
import { runJob, setPolicy } from "./helpers/maintenance.js";
import { cloneObjects, fork, inNetwork, type Owner, runDetach } from "./helpers/network.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const SIDE = "refs/heads/side";
/** Objects only `side` reaches. */
const sideOnly = minus(minus([...fx.all], fx.withoutSide), fx.afterForce);
/** Objects no branch or tag of the fixture but `rewritten` reaches. */
const rewrittenOnly = minus([...fx.afterForce], fx.withoutSide);

const RETENTION = 90 * DAY;

type Fork = Awaited<ReturnType<typeof fork>>["repo"];

const move = (repo: RepoDO, name: string, from: string | null, to: string | null) => {
  const result = repo.git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: [
      {
        name,
        oldOid: from === null ? null : oidFromHex(from),
        newOid: to === null ? null : oidFromHex(to),
      },
    ],
    expectedVersion: repo.git.refStore.state().version,
  });
  if (!result.ok) throw new Error(`ref update failed: ${JSON.stringify(result)}`);
};

/** A reflog row as its ref update wrote it, `age` ago. */
const logged = (
  repo: RepoDO,
  row: { ref?: string; old?: string | null; new?: string | null; age?: number },
) =>
  repo.git.context.storage.sql
    .exec(
      "INSERT INTO reflog (ref, version, old_oid, new_oid, at) VALUES (?, ?, ?, ?, ?)",
      row.ref ?? SIDE,
      repo.git.refStore.state().version,
      row.old ? oidFromHex(row.old) : null,
      row.new ? oidFromHex(row.new) : null,
      repo.git.context.now() - (row.age ?? 0),
    )
    .toArray();

const reflogOf = (f: Fork) =>
  inRepo(f.stub, ({ git }) =>
    git.context.storage.sql
      .exec<{ old_oid: ArrayBuffer | null; new_oid: ArrayBuffer | null }>(
        "SELECT old_oid, new_oid FROM reflog ORDER BY seq",
      )
      .toArray()
      .flatMap((row) => [row.old_oid, row.new_oid])
      .filter((oid) => oid !== null)
      .map((oid) => Buffer.from(oid).toString("hex")),
  );

const clearReflog = (f: Fork) =>
  inRepo(f.stub, ({ git }) => git.context.storage.sql.exec("DELETE FROM reflog").toArray());

const liveObjects = (f: Fork) =>
  inRepo(f.stub, async ({ git }) => {
    const rows = git.context.storage.sql
      .exec<{ pack_id: string }>("SELECT pack_id FROM packs WHERE state = 'live'")
      .toArray();
    const objects = new Set<string>();
    for (const row of rows) for (const o of await objectsOf(git, row.pack_id)) objects.add(o);
    return objects;
  });

const missingFrom = async (f: Fork, oids: readonly string[]) => {
  const live = await liveObjects(f);
  return oids.filter((o) => !live.has(o));
};

const register = (f: Fork, sha: string) =>
  inRepo(f.stub, (repo: RepoDO) =>
    repo.registerRun({
      runId: newUlid(),
      sha,
      path: ".github/workflows/ci.yml",
      reachableVia: sha,
    }),
  );

describe("a fork's detach and its reflog", () => {
  let parentOwner: Owner;
  let forkOwner: Owner;
  beforeAll(async () => {
    parentOwner = await principalWithToken("user", "git");
    forkOwner = await user();
  });

  /** A fork of the whole fixture, or (not `stored`) of one without `side` nor its last commit. */
  async function forked({ stored = true } = {}): Promise<Fork> {
    const p = await createRepo(parentOwner.principalId);
    await loadFixture(
      p.stub,
      stored
        ? fx.repo
        : {
            ...fx.repo,
            packs: [fx.withoutSideCommitPack],
            refs: fx.repo.refs.filter((ref) => ref.name !== SIDE),
          },
      { allReachable: false },
    );
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    return f;
  }

  async function detach(
    f: Fork,
    onSlice?: (repo: RepoDO, cursor: DetachCursor) => Promise<void> | void,
  ) {
    const phases: string[] = [];
    let round = 0;
    await inRepo(f.stub, (repo: RepoDO) => {
      repo.detachHooks = {
        onSlice: async (cursor) => {
          phases.push(cursor.phase);
          round = cursor.round;
          await onSlice?.(repo, cursor);
        },
      };
    });
    const networkId = await inRepo(f.stub, ({ git }) => git.networkId());
    const detached = await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id }));
    expect(detached).toMatchObject({ ok: true });
    expect(await runDetach(f.stub)).toBe("done");
    expect(await inRepo(f.stub, ({ git }) => git.networkId())).not.toBe(networkId);
    return { phases, round };
  }

  /** A collection that ran to its end: it schedules the next one, for what only the reflog keeps. */
  const collects = async (f: Fork) => expect((await runJob(f.stub, "gc")).state).toBe("scheduled");

  it("keeps a deleted branch's commits: collected normally, its commit registered and checked out", async () => {
    const f = await forked();
    await moveRef(f.stub, SIDE, fx.side, null);
    await detach(f);
    expect(sideOnly.length).toBeGreaterThan(0);
    expect(await missingFrom(f, sideOnly)).toEqual([]);
    expect(await register(f, fx.side)).toEqual({ ok: true, epoch: expect.any(Number) });
    await collects(f);
    expect(await missingFrom(f, sideOnly)).toEqual([]);
    // Kept is not served: a want must be reachable from a ref.
    const want = await cloneObjects(forkOwner, f, [fx.side], ["done"]);
    expect(want.error).toMatch(/not our ref/);
    const main = fx.repo.refs.find((r) => r.name === "refs/heads/main")?.oid as string;
    const clone = await cloneObjects(forkOwner, f, [main], ["done"]);
    expect(clone.objects?.length).toBeGreaterThan(0);
    for (const o of sideOnly) expect(clone.objects).not.toContain(o);
  }, 60_000);

  it("keeps what a force push replaced during the detach, after its mark", async () => {
    const f = await forked();
    await clearReflog(f);
    let moves = 0;
    const { round } = await detach(f, (repo, cursor) => {
      if (cursor.phase !== "verify" || moves > 0) return;
      moves++;
      // To an object the mark did not reach and back: only the reflog names it at the swap.
      move(repo, "refs/heads/feature", fx.f2, fx.rewritten);
      move(repo, "refs/heads/feature", fx.rewritten, fx.f2);
    });
    expect({ moves, round }).toEqual({ moves: 1, round: 2 });
    expect(rewrittenOnly.length).toBeGreaterThan(0);
    expect(await missingFrom(f, rewrittenOnly)).toEqual([]);
    await collects(f);
  }, 60_000);

  it("keeps the whole checkout of a commit pushed during the detach without its tree, then abandoned", async () => {
    const f = await forked({ stored: false });
    let pushed = false;
    const { round } = await detach(f, async (repo, cursor) => {
      if (cursor.phase !== "mark" || pushed) return;
      pushed = true;
      // As a push during the detach: the commit in a pack of the new network, over objects only
      // the old network's packs hold.
      expect(repo.git.networkId()).toBe(cursor.newNetworkId);
      await storeFixture(
        repo.git,
        { ...fx.repo, packs: [fx.sideCommitPack], commits: [], refs: [] },
        { allReachable: false },
      );
      move(repo, SIDE, null, fx.side);
      move(repo, SIDE, fx.side, null);
    });
    expect({ pushed, round }).toEqual({ pushed: true, round: 1 });
    expect(await missingFrom(f, sideOnly)).toEqual([]);
    expect(await register(f, fx.side)).toEqual({ ok: true, epoch: expect.any(Number) });
    await collects(f);
  }, 60_000);

  it("skips an entry whose object no pack holds, and keeps its row", async () => {
    const f = await forked();
    const gone = "e".repeat(40);
    await inRepo(f.stub, (repo: RepoDO) => logged(repo, { old: gone, new: null }));
    await detach(f);
    expect(await reflogOf(f)).toContain(gone);
  }, 60_000);

  it("copies entries within the retention only", async () => {
    const f = await forked();
    await moveRef(f.stub, SIDE, fx.side, null);
    await clearReflog(f);
    let added = false;
    await detach(f, (repo) => {
      if (added) return;
      added = true;
      // Right before the round's mark: an expired entry not pruned yet, and one about to expire.
      logged(repo, { old: fx.side, age: RETENTION + HOUR });
      logged(repo, { ref: "refs/heads/feature", old: fx.rewritten, age: RETENTION - HOUR });
    });
    expect(added).toBe(true);
    expect(await missingFrom(f, [fx.side, fx.rewritten])).toEqual([fx.side]);
  }, 60_000);

  it.each(["old", "new"] as const)(
    "keeps an entry's %s id",
    async (side) => {
      const f = await forked();
      await moveRef(f.stub, SIDE, fx.side, null);
      await clearReflog(f);
      await inRepo(f.stub, (repo: RepoDO) => logged(repo, { [side]: fx.side }));
      await detach(f);
      expect(await missingFrom(f, sideOnly)).toEqual([]);
    },
    60_000,
  );

  it("keeps a pull request head the fork moved on from, and nothing its parent's reflog names", async () => {
    const p = await createRepo(parentOwner.principalId);
    await loadFixture(p.stub, fx.repo, { allReachable: false });
    // The parent's own history: named by its reflog, in the packs the fork borrows.
    await moveRef(p.stub, SIDE, fx.side, null);
    await moveRef(p.stub, "refs/pull/1/head", null, fx.side);
    const { repo: f } = await fork(parentOwner, p, forkOwner);
    await setPolicy(f.stub);
    expect((await liveObjects(f)).has(fx.side)).toBe(true);
    await moveRef(f.stub, "refs/pull/1/head", null, fx.rewritten);
    await moveRef(f.stub, "refs/pull/1/head", fx.rewritten, null);
    await detach(f);
    expect(await missingFrom(f, rewrittenOnly)).toEqual([]);
    expect(await missingFrom(f, sideOnly)).toEqual(sideOnly);
    await collects(f);
  }, 60_000);

  it("keeps an entry across a second detach, and lets it go once expired", async () => {
    const f = await forked();
    await moveRef(f.stub, SIDE, fx.side, null);
    await detach(f);
    await detach(f);
    expect(await missingFrom(f, sideOnly)).toEqual([]);
    await collects(f);
    await inRepo(f.stub, ({ git }) =>
      git.context.storage.sql
        .exec("UPDATE reflog SET at = ?", git.context.now() - RETENTION - HOUR)
        .toArray(),
    );
    await detach(f);
    expect(await missingFrom(f, sideOnly)).toEqual(sideOnly);
  }, 120_000);

  it.each([
    // The runs' commits read, the reflog not.
    ["began", { rootsRound: undefined }],
    // That version, deployed again, began the round from this version's cursor, copying its fields.
    ["began again", { round: 2 }],
  ])(
    "begins again a round an earlier version %s without the reflog",
    async (_, fields) => {
      const f = await forked();
      await moveRef(f.stub, SIDE, fx.side, null);
      await clearReflog(f);
      let stopped = false;
      await inRepo(f.stub, (repo: RepoDO) => {
        repo.detachHooks = {
          onSlice: (cursor) => {
            if (cursor.phase !== "prune" || stopped) return;
            stopped = true;
            throw new Error("stopped at the prune");
          },
        };
      });
      const networkId = await inRepo(f.stub, ({ git }) => git.networkId());
      expect(
        await inNetwork(networkId, (n) => n.detach({ networkId, repoId: f.id })),
      ).toMatchObject({
        ok: true,
      });
      await inRepo(f.stub, (repo: RepoDO) => repo.alarm());
      const phase = await inRepo(f.stub, (repo: RepoDO) => {
        const sql = repo.git.context.storage.sql;
        const [row] = sql
          .exec<{ cursor: ArrayBuffer | null }>("SELECT cursor FROM jobs WHERE job_id = 'detach'")
          .toArray();
        if (!row?.cursor) return "none";
        const cursor = JSON.parse(new TextDecoder().decode(row.cursor)) as Record<string, unknown>;
        // The entry was there all along; the earlier version's round did not read it.
        Object.assign(cursor, { heldRoots: true, ...fields });
        logged(repo, { old: fx.side });
        sql.exec(
          "UPDATE jobs SET cursor = ?, next_run_at = ? WHERE job_id = 'detach'",
          new TextEncoder().encode(JSON.stringify(cursor)),
          repo.git.context.now(),
        );
        repo.detachHooks = {};
        return String(cursor.phase);
      });
      expect(phase).toBe("prune");
      expect(await runDetach(f.stub)).toBe("done");
      expect(await missingFrom(f, sideOnly)).toEqual([]);
    },
    60_000,
  );

  // A fault put in by hand: an entry always comes with a newer version of the refs.
  it("verifies the reflog's entries too: one its mark did not copy is marked again", async () => {
    const f = await forked();
    await moveRef(f.stub, SIDE, fx.side, null);
    await clearReflog(f);
    let added = false;
    const { round } = await detach(f, (repo, cursor) => {
      if (cursor.phase !== "verify" || added) return;
      added = true;
      logged(repo, { old: fx.side });
    });
    expect({ added, round }).toEqual({ added: true, round: 2 });
    expect(await missingFrom(f, sideOnly)).toEqual([]);
  }, 60_000);

  it("keeps an entry among very many", async () => {
    const f = await forked();
    await moveRef(f.stub, SIDE, fx.side, null);
    await clearReflog(f);
    await inRepo(f.stub, (repo: RepoDO) => {
      // More ids than a function call takes as arguments.
      repo.git.context.storage.sql
        .exec(
          `WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
           INSERT INTO reflog (ref, version, old_oid, new_oid, at)
           SELECT 'refs/heads/side', 1, randomblob(20), NULL, ? FROM n`,
          repo.git.context.now(),
        )
        .toArray();
      logged(repo, { old: fx.side });
    });
    await detach(f);
    expect(await missingFrom(f, sideOnly)).toEqual([]);
  }, 60_000);

  it("verifies a run registered late at a reflog commit only once", async () => {
    const f = await forked();
    await moveRef(f.stub, SIDE, fx.side, null);
    const answers: unknown[] = [];
    const { phases, round } = await detach(f, async (repo, cursor) => {
      if (cursor.phase !== "prune" || answers.length > 0) return;
      answers.push(
        await repo.registerRun({
          runId: newUlid(),
          sha: fx.side,
          path: ".github/workflows/ci.yml",
          reachableVia: fx.side,
        }),
      );
    });
    expect(answers).toEqual([{ ok: true, epoch: expect.any(Number) }]);
    expect({ verified: phases.filter((p) => p === "verify").length, round }).toEqual({
      verified: 1,
      round: 1,
    });
    expect((await liveObjects(f)).has(fx.side)).toBe(true);
  }, 60_000);
});
