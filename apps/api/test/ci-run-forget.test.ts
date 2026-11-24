// A run's record in its repository: its first registration names a commit
// that garbage collection still roots (a ref's value, or a reflog entry
// within the retention), and forgetting a retired run releases what it
// holds and deletes what the repository keeps for it.
import { env } from "cloudflare:workers";
import { newUlid } from "@fyrden/adapters-cloudflare/git";
import { oidFromHex } from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import type { ConcurrencyDO } from "../src/do/ConcurrencyDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { APPROVAL_EVENT } from "../src/do/repo/run-approvals.js";
import { MAINTENANCE_DEFAULTS } from "../src/git/maintenance/policy.js";
import { GC_JOB_ID } from "../src/git/maintenance/schedule.js";
import { inConcurrency } from "./helpers/concurrency.js";
import { inRepo } from "./helpers/repo-git.js";
import { repoWithCommit } from "./helpers/runs.js";

const RETENTION = MAINTENANCE_DEFAULTS.reflogRetentionMs;
const ELSEWHERE = "e".repeat(40);

async function setup() {
  const f = await repoWithCommit();
  const repo = env.REPO.getByName(f.repo.id);
  const register = (runId: string, sha: string, reachableVia?: string) =>
    repo.registerRun({
      runId,
      sha,
      path: ".github/workflows/ci.yml",
      ...(reachableVia !== undefined && { reachableVia }),
    });
  const recorded = (runId: string) =>
    inRepo(
      repo,
      (r: RepoDO) =>
        r.git.context.storage.sql.exec("SELECT 1 FROM ci_runs WHERE run_id = ?", runId).toArray()
          .length > 0,
    );
  /** A reflog entry of a ref no longer present, moved from `hex` `ageMs` ago. */
  const reflogEntry = (hex: string, ageMs: number) =>
    inRepo(repo, (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        `INSERT INTO reflog (ref, version, old_oid, new_oid, at) VALUES ('refs/heads/gone', 1, ?, NULL, ?)`,
        oidFromHex(hex),
        r.git.context.now() - ageMs,
      );
    });
  return { f, repo, register, recorded, reflogEntry };
}

describe("a run's first registration", () => {
  it("records a run whose commit a ref names", async () => {
    const { f, register, recorded } = await setup();
    const runId = newUlid();
    expect(await register(runId, f.sha, f.sha)).toEqual({ ok: true });
    expect(await recorded(runId)).toBe(true);
  });

  it("refuses a commit no ref and no reflog entry within the retention reaches", async () => {
    const { register, recorded, reflogEntry } = await setup();
    await reflogEntry(ELSEWHERE, RETENTION + 1);
    const runId = newUlid();
    expect(await register(runId, ELSEWHERE, ELSEWHERE)).toEqual({
      ok: false,
      code: "commit_unreachable",
    });
    expect(await recorded(runId)).toBe(false);
  });

  it("records a commit a reflog entry within the retention names", async () => {
    const { register, recorded, reflogEntry } = await setup();
    await reflogEntry(ELSEWHERE, RETENTION - 60_000);
    const runId = newUlid();
    expect(await register(runId, ELSEWHERE, ELSEWHERE)).toEqual({ ok: true });
    expect(await recorded(runId)).toBe(true);
  });

  it("checks what reaches the commit (an annotated tag's object), not the commit itself", async () => {
    const { f, register } = await setup();
    expect(await register(newUlid(), ELSEWHERE, f.sha)).toEqual({ ok: true });
  });

  it("does not check a run already recorded, nor a registration that names no witness", async () => {
    const { f, register, recorded } = await setup();
    const runId = newUlid();
    expect(await register(runId, f.sha, f.sha)).toEqual({ ok: true });
    // The run's weekly check, and a run an earlier version allocated, name none.
    const weekly = newUlid();
    expect(await register(weekly, ELSEWHERE)).toEqual({ ok: true });
    expect(await recorded(weekly)).toBe(true);
    expect(await register(runId, f.sha, ELSEWHERE)).toEqual({ ok: true });
  });
});

describe("forgetting a run", () => {
  const request = (runId: string) => ({
    group: "Deploy",
    runId,
    ownerKey: "a1",
    cancelInProgress: false,
    holdMs: 6 * 60_000,
  });

  it("releases its scope to the pending run and deletes its receipts, record and spec", async () => {
    const { f, repo, register, recorded } = await setup();
    const [a, b] = [newUlid(), newUlid()];
    await register(a, f.sha, f.sha);
    await register(b, f.sha, f.sha);
    expect((await repo.acquireConcurrency([request(a)]))[0]?.outcome).toBe("owner");
    expect((await repo.acquireConcurrency([request(b)]))[0]?.outcome).toBe("pending");
    await inRepo(repo, (r: RepoDO) => {
      r.git.context.storage.sql.exec(
        "INSERT INTO ci_run_specs (run_id, spec, source) VALUES (?, '{}', '')",
        a,
      );
    });
    expect(await repo.forgetRun({ runId: a })).toEqual({ ok: true });
    const coordinator = await inConcurrency(f.repo.id, (c: ConcurrencyDO) => ({
      owner: c.context.storage.sql
        .exec<{ owner_run: string }>("SELECT owner_run FROM concurrency_groups")
        .one().owner_run,
      receipts: c.context.storage.sql
        .exec<{ run_id: string }>("SELECT run_id FROM concurrency_receipts")
        .toArray()
        .map((row) => row.run_id),
    }));
    expect(coordinator.owner).toBe(b);
    expect(coordinator.receipts).not.toContain(a);
    expect(coordinator.receipts).toContain(b);
    expect(await recorded(a)).toBe(false);
    expect(await recorded(b)).toBe(true);
    const left = await inRepo(repo, (r: RepoDO) => ({
      specs: r.git.context.storage.sql
        .exec("SELECT 1 FROM ci_run_specs WHERE run_id = ?", a)
        .toArray().length,
      gc: r.git.jobs.get(GC_JOB_ID)?.state,
    }));
    expect(left).toEqual({ specs: 0, gc: "queued" });
    // Again: nothing left to forget, still answered.
    expect(await repo.forgetRun({ runId: a })).toEqual({ ok: true });
  });

  it("settles a waiting approval as expired before deleting it, so its pull request waits on nothing", async () => {
    const { f, repo, register } = await setup();
    const runId = newUlid();
    await register(runId, f.sha, f.sha);
    await inRepo(repo, (r: RepoDO) => {
      const now = r.git.context.now();
      r.git.context.storage.sql.exec(
        `INSERT INTO ci_approvals (run_id, event_id, pull_number, trigger_kind, workflow_path,
           binding, state, created_at, updated_at)
         VALUES (?, 1, 7, 'pull_request', '.github/workflows/ci.yml', 'b', 'waiting', ?, ?)`,
        runId,
        now,
        now,
      );
    });
    expect(await inRepo(repo, (r: RepoDO) => r.ciApprovals.waiting(7))).toBe(true);
    expect(await repo.forgetRun({ runId })).toEqual({ ok: true });
    const after = await inRepo(repo, (r: RepoDO) => ({
      waiting: r.ciApprovals.waiting(7),
      rows: r.git.context.storage.sql
        .exec("SELECT 1 FROM ci_approvals WHERE run_id = ?", runId)
        .toArray().length,
      told: r.git.context.storage.sql
        .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
        .toArray()
        .map((row) => JSON.parse(row.event) as { type: string; data: Record<string, unknown> })
        .filter((e) => e.type === APPROVAL_EVENT)
        .map((e) => e.data),
    }));
    // The item is told the run no longer waits (settled), not merely left with a row gone.
    expect(after).toEqual({ waiting: false, rows: 0, told: [{ number: 7, run_id: runId }] });
  });
});
