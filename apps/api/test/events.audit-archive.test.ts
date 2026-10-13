import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import {
  AUDIT_ARCHIVE_JOB,
  AUDIT_ARCHIVE_POLICY,
  auditArchiveHandler,
  unarchivedAuditRows,
} from "../src/do/base/audit-archiver.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { principalWithToken } from "./helpers/principals.js";
import { inRepo, newNetworkId, oid } from "./helpers/repo-git.js";

const newId = createIdFactory(Date.now, secureRandomBytes);

/** An archive key with its content digest removed, for comparing names. */
const withoutDigest = (key: string) => key.replace(/-[0-9a-f]{16}\.ndjson$/, ".ndjson");
const DAY = 24 * 60 * 60 * 1000;
// 2026-10-13T10:00:00Z
const T0 = Date.UTC(2026, 9, 13, 10);

/** A fresh repository object with no audit rows, and an archiver on a test clock and bucket. */
async function withArchiver<R>(
  fn: (a: {
    storage: DurableObjectStorage;
    run: () => Promise<unknown>;
    puts: Map<string, string>;
    failPuts: (fail: boolean) => void;
    setNow: (at: number) => void;
    insert: (rows: { at: number; epoch?: number }[]) => void;
  }) => Promise<R>,
): Promise<R> {
  const stub = env.REPO.getByName(newId("rep"));
  return runInDurableObject(stub, async (_: RepoDO, state) => {
    let now = T0;
    let failing = false;
    const puts = new Map<string, string>();
    const handler = auditArchiveHandler({
      storage: state.storage,
      bucket: {
        put: async (key: string, value: unknown) => {
          if (failing) throw new Error("R2 unavailable");
          puts.set(key, String(value));
          return null as unknown as R2Object;
        },
      },
      now: () => now,
      org: () => "usr_org",
      source: () => "rep_source",
    });
    return fn({
      storage: state.storage,
      run: () =>
        handler.runSlice({
          jobId: "j",
          kind: "audit_archive",
          cursor: null,
          attempts: 0,
          claim: 1,
        }),
      puts,
      failPuts: (fail) => {
        failing = fail;
      },
      setNow: (at) => {
        now = at;
      },
      insert: (rows) => {
        for (const row of rows)
          state.storage.sql.exec(
            `INSERT INTO audit_log (epoch_gen, at, actor_id, action, target_id, result, details)
             VALUES (?, ?, 'usr_actor', 'refs.update', 'rep_source', 'ok', '{"refs":1}')`,
            row.epoch ?? 1,
            row.at,
          );
      },
    });
  });
}

describe("audit archiver", () => {
  it("writes rows to a deterministic object per epoch and UTC day, then marks them archived", async () => {
    const result = await withArchiver(async ({ storage, run, puts, insert }) => {
      insert([
        { at: T0 },
        { at: T0 + 1 },
        // Same day, after a restore: a new epoch, a new object.
        { at: T0 + 2, epoch: 2 },
        // The next day.
        { at: T0 + DAY, epoch: 2 },
      ]);
      const slices = [];
      for (let i = 0; i < 6; i++) slices.push(await run());
      return {
        keys: [...puts.keys()].map(withoutDigest),
        first: puts.get([...puts.keys()][0] ?? ""),
        left: unarchivedAuditRows(storage),
        slices,
      };
    });
    expect(result.keys).toEqual([
      "audit/usr_org/2026/10/13/rep_source-1-1-2.ndjson",
      "audit/usr_org/2026/10/13/rep_source-2-3-3.ndjson",
      "audit/usr_org/2026/10/14/rep_source-2-4-4.ndjson",
    ]);
    expect(result.left).toBe(0);
    const lines = (result.first ?? "")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      expect.objectContaining({
        seq: 1,
        epoch_gen: 1,
        at: "2026-10-13T10:00:00.000Z",
        action: "refs.update",
        details: { refs: 1 },
        act_chain: [],
      }),
      expect.objectContaining({ seq: 2 }),
    ]);
    // Done writing; it comes back when the archived rows leave retention.
    expect(result.slices.at(-1)).toEqual({
      done: false,
      cursor: null,
      runAfterMs: AUDIT_ARCHIVE_POLICY.retentionMs,
    });
  });

  it("writes the same object again after a failed write, and keeps the rows until it succeeds", async () => {
    const result = await withArchiver(async ({ storage, run, puts, failPuts, insert }) => {
      insert([{ at: T0 }, { at: T0 + 1 }]);
      failPuts(true);
      const failed = await run().then(
        () => "ok",
        (e: Error) => e.message,
      );
      // A row written after the segment was cut is not in it.
      insert([{ at: T0 + 2 }]);
      const pending = storage.sql
        .exec<{ r2_key: string; state: string }>("SELECT r2_key, state FROM audit_segments")
        .toArray()
        .map((r) => ({ ...r, r2_key: withoutDigest(r.r2_key) }));
      failPuts(false);
      await run();
      await run();
      return {
        failed,
        pending,
        keys: [...puts.keys()].map(withoutDigest),
        left: unarchivedAuditRows(storage),
      };
    });
    expect(result.failed).toBe("R2 unavailable");
    expect(result.pending).toEqual([
      { r2_key: "audit/usr_org/2026/10/13/rep_source-1-1-2.ndjson", state: "pending" },
    ]);
    expect(result.keys).toEqual([
      "audit/usr_org/2026/10/13/rep_source-1-1-2.ndjson",
      "audit/usr_org/2026/10/13/rep_source-1-3-3.ndjson",
    ]);
    expect(result.left).toBe(0);
  });

  it("deletes archived rows only after the retention, and never unarchived ones", async () => {
    const result = await withArchiver(async ({ storage, run, failPuts, setNow, insert }) => {
      insert([{ at: T0 }]);
      await run();
      // An old row that could not be archived yet.
      insert([{ at: T0 - 30 * DAY }]);
      failPuts(true);
      setNow(T0 + AUDIT_ARCHIVE_POLICY.retentionMs + 1);
      await run().catch(() => {});
      const rows = storage.sql
        .exec<{ seq: number; archived: number }>(
          "SELECT seq, archived_at IS NOT NULL AS archived FROM audit_log ORDER BY seq",
        )
        .toArray();
      // Retention runs once nothing waits: still the old archived row is kept until then.
      failPuts(false);
      await run();
      await run();
      const after = storage.sql
        .exec<{ seq: number }>("SELECT seq FROM audit_log ORDER BY seq")
        .toArray();
      return { rows, after };
    });
    expect(result.rows).toEqual([
      { seq: 1, archived: 1 },
      { seq: 2, archived: 0 },
    ]);
    // Row 1 left retention; row 2 was archived just now and stays.
    expect(result.after).toEqual([{ seq: 2 }]);
  });
});

describe("repository audit archive", () => {
  it("archives a commit's audit row to the assets bucket through the alarm, even while the events queue is down", async () => {
    const owner = await principalWithToken("user", "pat");
    const repoId = newId("rep");
    const stub = env.REPO.getByName(repoId);
    await stub.initGitStorage(newNetworkId(), "refs/heads/main", {
      ownerId: owner.principalId,
      name: "audited",
      visibility: "private",
      epochGen: 1,
      actor: owner.principalId,
    });
    await inRepo(stub, (repo) => {
      repo.sendEvents = async () => {
        throw new Error("queue down");
      };
      repo.git.refStore.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: "refs/heads/main", oldOid: null, newOid: oid(1) }],
        expectedVersion: 0,
        actor: { principal: owner.principalId, tokenId: "tok_1", via: "push" },
      });
      const job = repo.git.jobs.get(AUDIT_ARCHIVE_JOB);
      expect(job?.state).toBe("queued");
      // Due now.
      repo.git.context.storage.sql.exec(
        "UPDATE jobs SET next_run_at = 0 WHERE job_id = ?",
        AUDIT_ARCHIVE_JOB,
      );
    });
    await runDurableObjectAlarm(stub);
    const keys = await inRepo(stub, (repo) =>
      repo.git.context.storage.sql
        .exec<{ r2_key: string; state: string }>("SELECT r2_key, state FROM audit_segments")
        .toArray(),
    );
    expect(keys).toEqual([
      {
        r2_key: expect.stringMatching(
          new RegExp(
            `^audit/${owner.principalId}/\\d{4}/\\d{2}/\\d{2}/${repoId}-1-1-1-[0-9a-f]{16}\\.ndjson$`,
          ),
        ),
        state: "archived",
      },
    ]);
    const object = await env.ASSETS.get(keys[0]?.r2_key ?? "");
    expect(JSON.parse((await object?.text()) ?? "{}")).toMatchObject({
      action: "refs.update",
      actor: owner.principalId,
      token_id: "tok_1",
      target: repoId,
    });
    expect(await inRepo(stub, (repo) => repo.outbox.pending())).toBeGreaterThan(0);
  });
});
