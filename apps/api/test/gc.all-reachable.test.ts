// Packs flagged all-reachable (every object reachable from the current
// refs) are what lets a clone be served verbatim. Commits schedule a cheap
// mark of the unflagged packs; a non-fast-forward update clears every flag
// and the next mark sets them again where it can, never on a pack holding an
// object no ref reaches. Pushes go through the object's RPC methods with
// packs git wrote.
import { env } from "cloudflare:workers";
import type { FetchArgs } from "@fyrden/git-core";
import { oidFromHex, PackIdx } from "@fyrden/git-core";
import { describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { REACHABILITY_JOB_ID } from "../src/git/maintenance/schedule.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { moveRef } from "./helpers/gc.js";
import { now, packStates, runJob, setPolicy } from "./helpers/maintenance.js";
import { pushBody, reportLines, ZERO } from "./helpers/push-fixtures.js";
import { inRepo, newRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const fetchFx = inject("fetchFixtures");
const MAIN = "refs/heads/main";

async function push(stub: DurableObjectStub<RepoDO>, bytes: Uint8Array) {
  const begun = await stub.beginPush({ principal: "usr_reach", tokenId: "tok_reach" });
  if (!begun.ok) throw new Error(begun.error);
  await env.GIT.put(begun.bodyKey, bytes);
  let progress = await stub.runPush(begun.uploadId, bytes.length, 10_000);
  for (let i = 0; progress.state === "indexing" && i < 100; i++)
    progress = await stub.pushStatus(begun.uploadId, 10_000);
  const response =
    progress.state === "done"
      ? progress.response
      : await stub.finalizePush(begun.uploadId, {
          tokenId: "tok_reach",
          decidedAt: await now(stub),
        });
  return reportLines(response).report;
}

const cloneArgs = (wants: string[]): FetchArgs => ({
  wants: wants.map(oidFromHex),
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

const plan = (stub: DurableObjectStub<RepoDO>, wants: string[]) =>
  inRepo(stub, async (repo) => {
    const reply = await repo.planFetch({
      repoId: "r",
      args: cloneArgs(wants),
      plan: "paid",
      holder: "h",
    });
    if (!reply.ok) throw new Error(reply.message);
    if (reply.lease) repo.git.leases.release(reply.lease.leaseId);
    return reply.pack;
  });

describe("all-reachable flags", () => {
  it("a push schedules the mark; the pushed pack is flagged and clones are served from it verbatim", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { reachabilityDelayMs: 30_000 });
    expect(
      await push(stub, pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 })),
    ).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
    const scheduled = await inRepo(
      stub,
      ({ git }) =>
        git.context.storage.sql
          .exec<{ at: number }>(
            "SELECT next_run_at AS at FROM jobs WHERE job_id = ?",
            REACHABILITY_JOB_ID,
          )
          .one().at - git.context.now(),
    );
    expect(scheduled).toBeGreaterThan(25_000);
    expect(scheduled).toBeLessThanOrEqual(30_000);
    expect(await plan(stub, [fx.c2])).toBe("regenerated");

    expect((await runJob(stub, "reachability")).state).toBe("done");
    expect(
      (await packStates(stub)).filter((p) => p.state === "live").map((p) => p.all_reachable),
    ).toEqual([1]);
    expect(await plan(stub, [fx.c2])).toBe("as-is");
  });

  it("a non-fast-forward update clears the flags; the next mark flags only packs every object of which a ref reaches", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub);
    const packIds = await loadFixture(stub, fetchFx.split, { allReachable: false });
    await runJob(stub, "reachability");
    expect((await packStates(stub)).map((p) => p.all_reachable)).toEqual([1, 1]);

    // feature back one commit: its tip's objects are reachable from nothing but the reflog.
    const feature = fetchFx.split.refs.find((r) => r.name === "refs/heads/feature")?.oid as string;
    const parent = fetchFx.split.commits.find((c) => c.oid === feature)?.parents[0] as string;
    await moveRef(stub, "refs/heads/feature", feature, parent);
    expect((await packStates(stub)).map((p) => p.all_reachable)).toEqual([0, 0]);
    await runJob(stub, "reachability");
    const states = await packStates(stub);
    // The pack holding the old feature commit stays unflagged; the other is flagged again.
    const holder = await inRepo(stub, async ({ git }) => {
      for (const id of packIds) {
        const idx = await git.bucket.get(`net/${git.networkId()}/p/${id}.idx`);
        if (
          PackIdx.parse(new Uint8Array(await (idx as R2ObjectBody).arrayBuffer())).find(
            oidFromHex(feature),
          ) >= 0
        )
          return id;
      }
      return undefined;
    });
    for (const p of states) expect(p.all_reachable).toBe(p.pack_id === holder ? 0 : 1);
  });

  it("does not flag a pack when a non-fast-forward update happened during the mark", async () => {
    const { stub } = await newRepo();
    await setPolicy(stub, { sliceObjects: 2 });
    await loadFixture(stub, fetchFx.split, { allReachable: false });
    const feature = fetchFx.split.refs.find((r) => r.name === "refs/heads/feature")?.oid as string;
    const parent = fetchFx.split.commits.find((c) => c.oid === feature)?.parents[0] as string;
    let moved = false;
    await runJob(stub, "reachability", {
      max: 500,
      between: async (slice) => {
        if (slice === 2 && !moved) {
          moved = true;
          await moveRef(stub, "refs/heads/feature", feature, parent);
          await moveRef(stub, "refs/heads/feature", parent, feature);
        }
      },
    });
    expect(moved).toBe(true);
    // The run restarted from the new refs; both packs are reachable again.
    expect((await packStates(stub)).map((p) => p.all_reachable)).toEqual([1, 1]);
  });
});
