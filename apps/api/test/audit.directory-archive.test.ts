import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  archiveDirectoryAudit,
  type DirectoryArchiverDeps,
} from "../src/cron/directory-audit-archiver.js";
import { AUDIT_ARCHIVE_POLICY } from "../src/do/base/audit-archiver.js";
import worker from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;

/** An archive key with its content digest removed, for comparing names. */
const withoutDigest = (key: string) => key.replace(/-[0-9a-f]{16}\.ndjson$/, ".ndjson");
// 2026-10-13T10:00:00Z
const T0 = Date.UTC(2026, 9, 13, 10);

// This file owns the directory's audit log: each test starts from an empty one.
beforeEach(async () => {
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM audit_log"),
    env.DIRECTORY.prepare("DELETE FROM audit_segments"),
  ]);
});

async function insert(rows: { at: number; action?: string }[]) {
  await env.DIRECTORY.batch(
    rows.map((row) =>
      env.DIRECTORY.prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details)
         VALUES (?, 'usr_actor', ?, 'tok_target', '{"type":"pat"}')`,
      ).bind(row.at, row.action ?? "token.mint"),
    ),
  );
}

async function seqs() {
  const { results } = await env.DIRECTORY.prepare(
    "SELECT seq, archived_at IS NOT NULL AS archived FROM audit_log ORDER BY seq",
  ).all<{ seq: number; archived: number }>();
  return results;
}

/**
 * What a restore of the directory to just after its first audit row looks
 * like here: later rows and segments gone, the sequence back, and a new
 * row with the second row's number and time.
 */
async function restoreBeforeSecondRow(action: string, { keepSegments = false } = {}) {
  await env.DIRECTORY.batch([
    env.DIRECTORY.prepare("DELETE FROM audit_log WHERE seq > (SELECT min(seq) FROM audit_log)"),
    env.DIRECTORY.prepare("UPDATE audit_log SET archived_at = NULL"),
    ...(keepSegments ? [] : [env.DIRECTORY.prepare("DELETE FROM audit_segments")]),
    env.DIRECTORY.prepare(
      "UPDATE sqlite_sequence SET seq = (SELECT max(seq) FROM audit_log) WHERE name = 'audit_log'",
    ),
  ]);
  await insert([{ at: T0 + 1, action }]);
}

function archiver(now = T0) {
  const puts = new Map<string, string>();
  let failing = false;
  const deps: DirectoryArchiverDeps = {
    db: env.DIRECTORY,
    bucket: {
      put: async (key: string, value: unknown) => {
        if (failing) throw new Error("R2 unavailable");
        puts.set(key, String(value));
        return null as unknown as R2Object;
      },
    },
    now: () => now,
  };
  return {
    run: () => archiveDirectoryAudit(deps),
    puts,
    fail: (f: boolean) => {
      failing = f;
    },
    at: (t: number) => {
      now = t;
    },
  };
}

describe("directory audit archiver", () => {
  it("writes rows to one object per UTC day, named by the first row's time, and marks them archived", async () => {
    await insert([{ at: T0 }, { at: T0 + 1, action: "token.revoke" }, { at: T0 + DAY }]);
    const [first] = await seqs();
    const from = first?.seq ?? 0;
    const a = archiver();
    expect(await a.run()).toBe(2);
    expect([...a.puts.keys()].map(withoutDigest)).toEqual([
      `audit/instance/2026/10/13/directory-${T0}-${from}-${from + 1}.ndjson`,
      `audit/instance/2026/10/14/directory-${T0 + DAY}-${from + 2}-${from + 2}.ndjson`,
    ]);
    const lines = [...a.puts.values()][0]
      ?.trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines?.map((l) => [l.action, l.actor, l.target, l.details])).toEqual([
      ["token.mint", "usr_actor", "tok_target", { type: "pat" }],
      ["token.revoke", "usr_actor", "tok_target", { type: "pat" }],
    ]);
    expect((await seqs()).every((r) => r.archived === 1)).toBe(true);
    // Nothing left: the next run writes nothing.
    expect(await a.run()).toBe(0);
  });

  it("writes the same object after a failed write, and keeps the rows until then", async () => {
    await insert([{ at: T0 }, { at: T0 + 1 }]);
    const a = archiver();
    a.fail(true);
    await expect(a.run()).rejects.toThrow("R2 unavailable");
    expect((await seqs()).map((r) => r.archived)).toEqual([0, 0]);
    // A row written after the segment was cut goes into the next one.
    await insert([{ at: T0 + 2 }]);
    a.fail(false);
    expect(await a.run()).toBe(2);
    const keys = [...a.puts.keys()];
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/directory-\d+-\d+-\d+-[0-9a-f]{16}\.ndjson$/);
    const [, from, to] = /-(\d+)-(\d+)-[0-9a-f]{16}\.ndjson$/.exec(keys[0] ?? "") ?? [];
    expect(Number(to) - Number(from)).toBe(1);
  });

  it("lets two overlapping runs write each segment once", async () => {
    await insert([{ at: T0 }, { at: T0 + 1 }]);
    const a = archiver();
    const b = archiver();
    await Promise.all([a.run(), b.run()]);
    const { results } = await env.DIRECTORY.prepare(
      "SELECT r2_key, state FROM audit_segments",
    ).all();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ state: "archived" });
  });

  it("never replaces an archived object with other rows after a restore renumbers them", async () => {
    await insert([{ at: T0 }, { at: T0 + 1, action: "token.mint" }]);
    const a = archiver();
    await a.run();
    const [original] = [...a.puts.entries()];
    // A restore to before the second row: the same sequence numbers return,
    // the second one for a different action at the same time.
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM audit_log WHERE seq > (SELECT min(seq) FROM audit_log)"),
      env.DIRECTORY.prepare("UPDATE audit_log SET archived_at = NULL"),
      env.DIRECTORY.prepare("DELETE FROM audit_segments"),
      env.DIRECTORY.prepare(
        "UPDATE sqlite_sequence SET seq = (SELECT max(seq) FROM audit_log) WHERE name = 'audit_log'",
      ),
    ]);
    await insert([{ at: T0 + 1, action: "token.revoke" }]);
    await a.run();
    const keys = [...a.puts.keys()];
    expect(keys).toHaveLength(2);
    expect(withoutDigest(keys[0] ?? "")).toBe(withoutDigest(keys[1] ?? ""));
    expect(a.puts.get(original?.[0] ?? "")).toBe(original?.[1]);
  });

  it("refuses a stale segment when another run archived past its start in between", async () => {
    await insert([{ at: T0 }, { at: T0 + 1 }]);
    const b = archiver();
    let paused = false;
    // Run A pauses after reading its rows; meanwhile a row arrives and B archives all three.
    const gated: D1Database = new Proxy(env.DIRECTORY, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            // A's first batch is its read of the rows to cut.
            if (!paused) {
              paused = true;
              await insert([{ at: T0 + 2 }]);
              await b.run();
            }
            return results;
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const puts = new Map<string, string>();
    await archiveDirectoryAudit({
      db: gated,
      bucket: {
        put: async (key: string, value: unknown) => {
          puts.set(key, String(value));
          return null as unknown as R2Object;
        },
      },
      now: () => T0,
    });
    const { results } = await env.DIRECTORY.prepare(
      "SELECT from_seq, to_seq FROM audit_segments ORDER BY from_seq",
    ).all<{ from_seq: number; to_seq: number }>();
    // B's one segment covers all three rows; A wrote nothing.
    expect(results).toHaveLength(1);
    expect(puts.size).toBe(0);
    expect(b.puts.size).toBe(1);
    expect((await seqs()).every((r) => r.archived === 1)).toBe(true);
  });

  it("does not mark rows a restore brought back during the write as archived", async () => {
    await insert([{ at: T0 }, { at: T0 + 1, action: "token.mint" }]);
    let restored = false;
    const puts = new Map<string, string>();
    const deps: DirectoryArchiverDeps = {
      db: env.DIRECTORY,
      bucket: {
        put: async (key: string, value: unknown) => {
          puts.set(key, String(value));
          if (!restored) {
            restored = true;
            await restoreBeforeSecondRow("token.revoke");
          }
          return null as unknown as R2Object;
        },
      },
      now: () => T0,
    };
    await archiveDirectoryAudit(deps);
    // The replacement row went into its own object; nothing was marked without being written.
    const { results } = await env.DIRECTORY.prepare(
      "SELECT action, archived_at IS NOT NULL AS archived FROM audit_log ORDER BY seq",
    ).all<{ action: string; archived: number }>();
    expect(results).toEqual([
      { action: "token.mint", archived: 1 },
      { action: "token.revoke", archived: 1 },
    ]);
    const written = [...puts.values()].join("");
    expect(written).toContain("token.revoke");
    expect(puts.size).toBe(2);
  });

  it("drops a reservation whose rows a restore replaced, and archives the current rows", async () => {
    await insert([{ at: T0 }, { at: T0 + 1, action: "token.replaced" }]);
    const a = archiver();
    a.fail(true);
    await expect(a.run()).rejects.toThrow();
    await restoreBeforeSecondRow("token.revoke", { keepSegments: true });
    a.fail(false);
    await a.run();
    expect((await seqs()).every((r) => r.archived === 1)).toBe(true);
    const contents = [...a.puts.values()].join("");
    expect(contents).toContain("token.revoke");
    expect(contents).not.toContain("token.replaced");
  });

  it("archives rows below another run's reservation, which a global high-water mark would skip", async () => {
    await insert([{ at: T0 }, { at: T0 + 1 }, { at: T0 + 2 }]);
    const [, , third] = await seqs();
    // Another run reserved and archived only the third row (the first two
    // were in a reservation it dropped after a restore).
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `INSERT INTO audit_segments (first_at, from_seq, to_seq, r2_key, state, created_at, archived_at)
         VALUES (?, ?, ?, 'audit/instance/other', 'archived', ?, ?)`,
      ).bind(T0 + 2, third?.seq, third?.seq, T0, T0),
      env.DIRECTORY.prepare("UPDATE audit_log SET archived_at = ? WHERE seq = ?").bind(
        T0,
        third?.seq,
      ),
    ]);
    const a = archiver();
    expect(await a.run()).toBe(1);
    expect((await seqs()).every((r) => r.archived === 1)).toBe(true);
    expect([...a.puts.keys()].map(withoutDigest)).toEqual([
      `audit/instance/2026/10/13/directory-${T0}-${(third?.seq ?? 0) - 2}-${(third?.seq ?? 0) - 1}.ndjson`,
    ]);
  });

  it("deletes archived rows after the retention, never unarchived ones", async () => {
    await insert([{ at: T0 }]);
    const a = archiver();
    await a.run();
    await insert([{ at: T0 - 30 * DAY }]);
    a.at(T0 + AUDIT_ARCHIVE_POLICY.retentionMs + 1);
    a.fail(true);
    await expect(a.run()).rejects.toThrow();
    expect((await seqs()).map((r) => r.archived)).toEqual([1, 0]);
    a.fail(false);
    await a.run();
    // The old row was archived just now: only the first, past retention, is gone.
    expect(await seqs()).toEqual([{ seq: expect.any(Number), archived: 1 }]);
  });

  it("runs from the cron trigger into the assets bucket", async () => {
    await insert([{ at: Date.now() }]);
    await worker.scheduled?.(createScheduledController({ cron: "*/15 * * * *" }), env);
    const { results } = await env.DIRECTORY.prepare(
      "SELECT r2_key FROM audit_segments WHERE state = 'archived'",
    ).all<{ r2_key: string }>();
    expect(results).toHaveLength(1);
    const object = await env.ASSETS.get(results[0]?.r2_key ?? "");
    expect(JSON.parse((await object?.text()) ?? "{}")).toMatchObject({ action: "token.mint" });
  });
});
