// Garbage collection: objects no ref and no reflog entry (within the
// retention) reaches go to one garbage pack per run; a garbage pack is
// condemned only once nothing in it is reachable and a day has passed since
// it was last touched (not since it was written); it is deleted 30 days
// after. git's packs and git's `rev-list --objects` are the oracle; the
// object's clock is moved forward instead of waiting.
import { env } from "cloudflare:workers";
import { oidFromHex } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import {
  DAY,
  expectSorted,
  gcRepo,
  HOUR,
  inState,
  minus,
  moveRef,
  objectsIn,
  stored,
} from "./helpers/gc.js";
import { advance, packStates, runJob } from "./helpers/maintenance.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const SIDE = "refs/heads/side";
const FEATURE = "refs/heads/feature";

const hasCommitRow = (git: Parameters<Parameters<typeof inRepo>[1]>[0]["git"], hex: string) =>
  git.context.storage.sql
    .exec("SELECT 1 AS one FROM commits WHERE oid = ?", oidFromHex(hex).buffer)
    .toArray().length === 1;

describe("garbage collection: unreachable objects and their time to live", () => {
  it("keeps what the reflog reaches; after the retention, splits the pack into reachable and garbage", async () => {
    const { stub, packIds } = await gcRepo();
    await moveRef(stub, SIDE, fx.side, null);
    // Within the reflog retention the deleted branch's objects are reachable;
    // only the rewritten commit (no ref, no reflog entry) is garbage.
    await advance(stub, HOUR);
    expect(["done", "scheduled"]).toContain((await runJob(stub, "gc")).state);
    let states = await packStates(stub);
    expect(states.find((p) => p.pack_id === packIds[0])?.state).toBe("superseded");
    expectSorted(await objectsIn(stub, "live"), fx.repo.objects);
    expectSorted(await objectsIn(stub, "garbage"), minus(fx.all, fx.repo.objects));
    // Reachable from the reflog only: not flagged all-reachable.
    expect(states.find((p) => p.state === "live")?.all_reachable).toBe(0);

    await advance(stub, 91 * DAY);
    expect(["done", "scheduled"]).toContain((await runJob(stub, "gc")).state);
    states = await packStates(stub);
    expect(states.filter((p) => p.state === "live").map((p) => p.kind)).toEqual(["gc"]);
    // The first run's garbage is past its time to live: condemned in this run.
    expect(states.filter((p) => p.kind === "garbage").map((p) => p.state)).toEqual([
      "condemned",
      "garbage",
    ]);
    expectSorted(await objectsIn(stub, "live"), fx.withoutSide);
    expectSorted(await objectsIn(stub, "garbage"), minus(fx.repo.objects, fx.withoutSide));
    expectSorted(await objectsIn(stub, "condemned"), minus(fx.all, fx.repo.objects));
    // The gc pack holds only what the refs reach: flagged all-reachable.
    expect(states.find((p) => p.state === "live")?.all_reachable).toBe(1);
    // Garbage commits keep their rows until their pack is condemned.
    expect(await inRepo(stub, ({ git }) => hasCommitRow(git, fx.side))).toBe(true);
  });

  it("splits several git packs at once, each source superseded, one garbage pack", async () => {
    const { stub, packIds } = await gcRepo(fx.packs);
    await moveRef(stub, SIDE, fx.side, null);
    await moveRef(stub, FEATURE, fx.f2, fx.rewritten);
    await advance(stub, 91 * DAY);
    await runJob(stub, "gc");
    const states = await packStates(stub);
    expectSorted(await objectsIn(stub, "live"), fx.afterForce);
    expectSorted(await objectsIn(stub, "garbage"), minus(fx.all, fx.afterForce));
    expect(states.filter((p) => p.kind === "garbage")).toHaveLength(1);
    // A source with nothing unreachable stays as it is.
    for (const id of packIds)
      expect(["live", "superseded"]).toContain(states.find((p) => p.pack_id === id)?.state);
  });

  it("measures the time to live from the last touch, then condemns, then deletes 30 days later", async () => {
    const { stub } = await gcRepo();
    await moveRef(stub, SIDE, fx.side, null);
    await advance(stub, 91 * DAY);
    await runJob(stub, "gc");
    const garbage = await inRepo(stub, ({ git }) => inState(git, "garbage")[0] as string);

    // 20 hours later something reads the garbage pack under a lease: a touch.
    await advance(stub, 20 * HOUR);
    await inRepo(stub, ({ git }) => {
      const lease = git.leases.grant("read", [garbage as never], "reader", 60_000);
      if (!lease.ok) throw new Error("garbage packs are readable");
      git.leases.release(lease.leaseId);
    });
    // 25 hours after it was written, 5 after the touch: kept.
    await advance(stub, 5 * HOUR);
    await runJob(stub, "gc");
    expect((await packStates(stub)).find((p) => p.pack_id === garbage)?.state).toBe("garbage");
    // A day and an hour after the touch: condemned, and its commits' rows go with it.
    await advance(stub, 20 * HOUR);
    await runJob(stub, "gc");
    expect((await packStates(stub)).find((p) => p.pack_id === garbage)?.state).toBe("condemned");
    expect(await inRepo(stub, ({ git }) => hasCommitRow(git, fx.side))).toBe(false);
    expect(await inRepo(stub, ({ git }) => hasCommitRow(git, fx.f2))).toBe(true);

    // Not deleted before 30 days from its condemnation.
    await advance(stub, 29 * DAY);
    await runJob(stub, "retire-packs");
    expect(await inRepo(stub, ({ git }) => stored(git, garbage))).toBe(true);
    await advance(stub, 2 * DAY);
    await runJob(stub, "retire-packs");
    expect(await inRepo(stub, ({ git }) => stored(git, garbage))).toBe(false);
    expect((await packStates(stub)).find((p) => p.pack_id === garbage)).toBeUndefined();
  });

  it("copies garbage objects a ref reaches again into a live pack, and touches their garbage pack", async () => {
    const { stub } = await gcRepo();
    await moveRef(stub, SIDE, fx.side, null);
    await advance(stub, 91 * DAY);
    await runJob(stub, "gc");
    const garbage = await inRepo(stub, ({ git }) => inState(git, "garbage")[0] as string);
    // A ref moved straight to a commit only the garbage pack holds (an API
    // ref update, or a client that sent no objects).
    await moveRef(stub, "refs/heads/back", null, fx.side);
    await advance(stub, 2 * DAY);
    await runJob(stub, "gc");
    const states = await packStates(stub);
    expect(states.find((p) => p.pack_id === garbage)?.state).toBe("garbage");
    // Everything the refs reach is live again, the garbage pack included nothing more is lost.
    expectSorted(await objectsIn(stub, "live"), fx.repo.objects);
    const touched = await inRepo(
      stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ at: number }>(
            "SELECT last_touched_at AS at FROM packs WHERE pack_id = ?",
            garbage,
          )
          .one().at as number,
    );
    const now = await inRepo(stub, ({ git }) => git.context.now());
    expect(now - touched).toBeLessThan(HOUR);
  });

  it("converges after repeated force-pushes: only live packs of reachable objects remain after the TTL and the retention", async () => {
    const { stub } = await gcRepo(fx.packs);
    await moveRef(stub, FEATURE, fx.f2, fx.rewritten);
    await moveRef(stub, FEATURE, fx.rewritten, fx.f2);
    await moveRef(stub, FEATURE, fx.f2, fx.rewritten);
    await moveRef(stub, SIDE, fx.side, null);
    // Reflog retention, collection; time to live, collection; retention, retire.
    await advance(stub, 91 * DAY);
    await runJob(stub, "gc");
    await advance(stub, DAY + HOUR);
    await runJob(stub, "gc");
    await advance(stub, 31 * DAY);
    await runJob(stub, "retire-packs");
    const end = await inRepo(stub, async ({ git }) => {
      const net = git.networkId();
      const listed = await env.GIT.list({ prefix: `net/${net}/` });
      return {
        states: git.context.storage.sql
          .exec<{ state: string }>("SELECT state FROM packs")
          .toArray()
          .map((r) => r.state),
        keys: listed.objects.map((o) => o.key).sort(),
        live: inState(git, "live")
          .flatMap((id) => [`net/${net}/p/${id}.idx`, `net/${net}/p/${id}.pack`])
          .sort(),
      };
    });
    expect(new Set(end.states)).toEqual(new Set(["live"]));
    expectSorted(await objectsIn(stub, "live"), fx.afterForce);
    // Nothing else in R2: no superseded, garbage or scratch objects.
    expect(end.keys).toEqual(end.live);
  });
});
