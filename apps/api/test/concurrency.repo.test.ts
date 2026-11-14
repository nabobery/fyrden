// Concurrency groups in the repository object: requests at the same moment
// leave one owner and one pending requester; a repeat is answered by its
// receipt; cancel-in-progress asks the owner to cancel, never evicting it
// before the lease it was granted; a release from anyone but the owner or
// the pending requester changes nothing; an owner whose lease expired is
// evicted only after its hold; and signals that cannot be delivered are
// retried without stopping the group's deadlines.
import { env } from "cloudflare:workers";
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { inRepo } from "./helpers/repo-git.js";
import { repoWithCommit } from "./helpers/runs.js";

const MIN = 60_000;
const HOLD = 6 * MIN;

async function setup() {
  const f = await repoWithCommit();
  const repo = env.REPO.getByName(f.repo.id);
  let clock = Date.UTC(2031, 0, 1);
  const tick = async (ms = 0) => {
    clock += ms;
    await inRepo(repo, (r: RepoDO) => {
      (r.git.context as { now: () => number }).now = () => clock;
    });
  };
  await tick();
  const request = (runId: string, cancelInProgress = false, holdMs = HOLD, ownerKey = "a1") => ({
    group: "Deploy",
    runId,
    ownerKey,
    cancelInProgress,
    holdMs,
  });
  const groupRow = () =>
    inRepo(
      repo,
      (r: RepoDO) =>
        r.git.context.storage.sql.exec("SELECT * FROM concurrency_groups").toArray()[0] as
          | Record<string, unknown>
          | undefined,
    );
  const signals = () =>
    inRepo(repo, (r: RepoDO) =>
      r.git.context.storage.sql
        .exec("SELECT run_id, kind, attempts FROM concurrency_signals ORDER BY created_at, kind")
        .toArray(),
    );
  const settle = () => inRepo(repo, (r: RepoDO) => r.concurrency.settleDue());
  return { f, repo, tick, request, groupRow, signals, settle, now: () => clock };
}

describe("concurrency groups in the repository", () => {
  it("leaves one owner and one pending requester when three ask at once", async () => {
    const { repo, request } = await setup();
    const [a, b, c] = [newUlid(), newUlid(), newUlid()];
    const answers = await Promise.all([
      repo.acquireConcurrency([request(a)]),
      repo.acquireConcurrency([request(b)]),
      repo.acquireConcurrency([request(c)]),
    ]);
    const outcomes = answers.map((x) => x[0]?.outcome).sort();
    expect(outcomes).toEqual(["owner", "pending", "pending"]);
    const statuses = await repo.concurrencyStatus(
      [a, b, c].map((runId) => ({ group: "deploy", runId, ownerKey: "a1" })),
    );
    expect(statuses.map((s) => s?.outcome).sort()).toEqual(["displaced", "owner", "pending"]);
  });

  it("answers a repeat with its receipt: a displaced requester cannot displace its displacer", async () => {
    const { repo, request, groupRow } = await setup();
    const [a, b, c] = [newUlid(), newUlid(), newUlid()];
    await repo.acquireConcurrency([request(a)]);
    await repo.acquireConcurrency([request(b)]);
    await repo.acquireConcurrency([request(c)]);
    const again = await repo.acquireConcurrency([request(b)]);
    expect(again[0]?.outcome).toBe("displaced");
    expect((await groupRow())?.pending_run).toBe(c);
    const owner = await repo.acquireConcurrency([request(a)]);
    expect(owner[0]).toMatchObject({ outcome: "owner", generation: 1 });
  });

  it("asks the owner to cancel on cancel-in-progress, its deadline no earlier than its lease", async () => {
    const { repo, request, groupRow, signals, now } = await setup();
    const [a, b] = [newUlid(), newUlid()];
    await repo.acquireConcurrency([request(a, false, MIN)]);
    await repo.acquireConcurrency([request(b, true)]);
    expect(await signals()).toEqual([{ run_id: a, kind: "cancel", attempts: 0 }]);
    // A one-minute hold would end at minute 1; the lease granted runs 10 minutes.
    expect((await groupRow())?.release_deadline).toBe(now() + 10 * MIN);
    const renewed = await repo.renewConcurrency(a, [
      { group: "Deploy", ownerKey: "a1", generation: 1 },
    ]);
    expect(renewed[0]).toMatchObject({
      ok: true,
      cancelRequested: true,
      leaseRemainingMs: 10 * MIN,
    });
  });

  it("ignores a release from an older owner, and releases by identity a just-promoted one", async () => {
    const { repo, request, groupRow } = await setup();
    const [a, b] = [newUlid(), newUlid()];
    await repo.acquireConcurrency([request(a)]);
    await repo.acquireConcurrency([request(b)]);
    // The run's earlier attempt, or a stale generation, frees nothing.
    const stranger = await repo.releaseConcurrency([{ group: "Deploy", runId: a, ownerKey: "a0" }]);
    expect(stranger[0]?.outcome).toBe("released");
    await repo.releaseConcurrency([{ group: "Deploy", runId: a, ownerKey: "a1", generation: 9 }]);
    expect((await groupRow())?.owner_run).toBe(a);
    await repo.releaseConcurrency([{ group: "Deploy", runId: a, ownerKey: "a1", generation: 1 }]);
    expect(await groupRow()).toMatchObject({ owner_run: b, generation: 2, pending_run: null });
    // b was cancelled while pending and releases without the generation it never learnt.
    const out = await repo.releaseConcurrency([{ group: "Deploy", runId: b, ownerKey: "a1" }]);
    expect(out[0]).toMatchObject({ outcome: "released", generation: 2 });
    expect(await groupRow()).toBeUndefined();
  });

  it("refuses a request that arrives after its own withdrawal", async () => {
    const { repo, request, groupRow } = await setup();
    const a = newUlid();
    // The release overtook the delayed request: it leaves a receipt, which answers the request.
    expect(await repo.releaseConcurrency([{ group: "Deploy", runId: a, ownerKey: "a1" }])).toEqual([
      { outcome: "released", generation: null, leaseRemainingMs: null, cancelRequested: false },
    ]);
    const late = await repo.acquireConcurrency([request(a)]);
    expect(late[0]?.outcome).toBe("released");
    expect(await groupRow()).toBeUndefined();
  });

  it("evicts an owner whose lease expired only after its hold, then promotes the pending one", async () => {
    const { repo, request, groupRow, tick, settle } = await setup();
    const [a, b] = [newUlid(), newUlid()];
    await repo.acquireConcurrency([request(a, false, HOLD)]);
    await repo.acquireConcurrency([request(b)]);
    await tick(10 * MIN);
    await settle();
    expect(await groupRow()).toMatchObject({ owner_run: a, pending_run: b });
    expect((await groupRow())?.cancel_requested_at).not.toBeNull();
    await tick(HOLD - 1);
    await settle();
    expect((await groupRow())?.owner_run).toBe(a);
    await tick(1);
    await settle();
    expect(await groupRow()).toMatchObject({ owner_run: b, generation: 2 });
    const lost = await repo.renewConcurrency(a, [
      { group: "Deploy", ownerKey: "a1", generation: 1 },
    ]);
    expect(lost[0]).toMatchObject({ ok: false, receipt: { outcome: "evicted" } });
  });

  it("keeps settling deadlines while a signal cannot be delivered, and retries the signal", async () => {
    const { repo, request, groupRow, signals, tick } = await setup();
    const [a, b] = [newUlid(), newUlid()];
    await repo.acquireConcurrency([request(a, false, MIN)]);
    await repo.acquireConcurrency([request(b, true)]);
    await inRepo(repo, (r: RepoDO) => {
      (r as unknown as { env: Env }).env = {
        ...(r as unknown as { env: Env }).env,
        RUN: {
          getByName: () => ({
            concurrencySignal: () => Promise.reject(new Error("unreachable")),
          }),
        } as unknown as Env["RUN"],
      };
    });
    // a's deadline is its 10-minute lease; the cancel to it fails at every try before that.
    for (let i = 0; i < 2; i++) {
      await tick(5 * MIN);
      await inRepo(repo, (r: RepoDO) => r.alarm());
    }
    // a was evicted at its deadline though its cancel never arrived; b owns the group.
    expect((await groupRow())?.owner_run).toBe(b);
    const owed = await signals();
    expect(owed.length).toBeGreaterThan(0);
    expect(owed.every((s) => (s.attempts as number) > 0)).toBe(true);
  });
});
