import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  parseRepairArgs,
  REPAIR_BATCH,
  REPAIR_HORIZON_MS,
  repairCountSql,
  repairEffects,
  repairSql,
} from "../src/commands/effects.ts";
import { fakeWrangler } from "./fake-wrangler.ts";

const realRoot = resolve(import.meta.dirname, "../../..");
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** The read model's database as the code expects it, empty. */
function orgDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(realRoot, "apps/api/migrations/org.expected.sql"), "utf8"));
  return db;
}

type Row = {
  id: string;
  sink?: string;
  state?: string;
  lastError?: string | null;
  createdAt?: number;
  occurredAt?: number;
  attempts?: number;
  maxAttempts?: number;
};

function insert(db: DatabaseSync, row: Row): void {
  db.prepare(
    `INSERT INTO effects (effect_id, sink, target, payload, state, attempts, next_attempt_at,
       last_error, created_at, recover_at, max_attempts) VALUES (?, ?, 't', ?, ?, ?, 0, ?, ?, 0, ?)`,
  ).run(
    row.id,
    row.sink ?? "feed",
    JSON.stringify(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
    row.state ?? "failed",
    row.attempts ?? 20,
    row.lastError === undefined ? "feed unavailable" : row.lastError,
    row.createdAt ?? NOW - DAY,
    row.maxAttempts ?? null,
  );
}

describe("effects repair", () => {
  it("reopens failed effects that may still matter, and none other", () => {
    const db = orgDatabase();
    insert(db, { id: "spent" });
    insert(db, { id: "no-error", lastError: null });
    insert(db, { id: "moved-on", lastError: "invalidated: its source was deleted" });
    insert(db, { id: "expired", lastError: "expired: past the feed's delivery deadline" });
    insert(db, { id: "page-gone", lastError: "page missing: absent" });
    insert(db, { id: "no-sink", lastError: "no sink named gone" });
    insert(db, { id: "pending", state: "pending" });
    insert(db, { id: "done", state: "done" });
    insert(db, { id: "webhook", sink: "webhooks" });
    // Watched activity: one attempt within a window long gone; never reopened.
    insert(db, { id: "watched", attempts: 1, maxAttempts: 1, lastError: "attempts spent" });
    insert(db, { id: "before-since", createdAt: NOW - 3 * DAY });
    // Past the horizon by when it happened, though journaled since.
    insert(db, { id: "too-old", occurredAt: NOW - REPAIR_HORIZON_MS - 1 });
    insert(db, { id: "recent", occurredAt: NOW - REPAIR_HORIZON_MS + DAY });
    const since = NOW - 2 * DAY;
    expect(db.prepare(repairCountSql("feed", since, NOW)).get()).toEqual({
      count: 3,
      oldest: NOW - DAY,
    });
    const reopened = db
      .prepare(repairSql("feed", since, NOW))
      .all()
      .map((r) => r.effect_id)
      .sort();
    expect(reopened).toEqual(["no-error", "recent", "spent"]);
    expect(
      db
        .prepare(
          `SELECT state, attempts, next_attempt_at, recover_at, last_error FROM effects
           WHERE effect_id = 'spent'`,
        )
        .get(),
    ).toEqual({
      state: "pending",
      // Claimed before, it still counts as claimed (a deletion waits for such an effect).
      attempts: 1,
      next_attempt_at: NOW,
      recover_at: NOW,
      last_error: "reopened: feed unavailable",
    });
    // Reopened, they are no longer failed: a second run finds none.
    expect(db.prepare(repairCountSql("feed", since, NOW)).get()).toMatchObject({ count: 0 });
  });

  it("reopens a bounded number a run, the oldest first", () => {
    const db = orgDatabase();
    for (let i = 0; i < REPAIR_BATCH + 2; i++)
      insert(db, { id: `e${String(i).padStart(5, "0")}`, createdAt: NOW - DAY + i });
    const first = db.prepare(repairSql("feed", 0, NOW)).all();
    expect(first).toHaveLength(REPAIR_BATCH);
    expect(db.prepare(repairCountSql("feed", 0, NOW)).get()).toMatchObject({
      count: 2,
      oldest: NOW - DAY + REPAIR_BATCH,
    });
  });

  it("takes a sink and a date not in the future, and --yes to change anything", () => {
    expect(parseRepairArgs(["--sink", "feed", "--since", "2027-01-14T00:00:00Z"], NOW)).toEqual({
      sink: "feed",
      since: Date.parse("2027-01-14T00:00:00Z"),
      confirmed: false,
    });
    expect(
      parseRepairArgs(["--since", "2027-01-14", "--sink", "webhooks", "--yes"], NOW),
    ).toMatchObject({ sink: "webhooks", confirmed: true });
    expect(parseRepairArgs(["--sink", "events", "--since", "2027-01-14"], NOW)).toHaveProperty(
      "error",
    );
    expect(parseRepairArgs(["--sink", "feed", "--since", "soon"], NOW)).toHaveProperty("error");
    expect(parseRepairArgs(["--sink", "feed"], NOW)).toHaveProperty("error");
    expect(parseRepairArgs(["--sink", "feed", "--since", "2099-01-01"], NOW)).toHaveProperty(
      "error",
    );
    expect(
      parseRepairArgs(["--sink", "feed", "--since", "2027-01-14", "--force"], NOW),
    ).toHaveProperty("error");
  });

  it("only counts without --yes, and reopens on the deployment's read model with it", async () => {
    const db = orgDatabase();
    insert(db, { id: "spent" });
    const fake = fakeWrangler();
    fake.state.d1.set("fyrden-org", "org-id");
    const ran: string[] = [];
    fake.state.d1Query = (name, sql) => {
      if (name !== "fyrden-org" || !sql.includes("effects")) return undefined;
      ran.push(sql.trimStart().split(/\s/)[0] as string);
      return db.prepare(sql).all();
    };
    const lines: string[] = [];
    const run = (confirmed: boolean) =>
      repairEffects({
        repoRoot: realRoot,
        runner: fake.runner,
        args: { sink: "feed", since: NOW - 2 * DAY, confirmed },
        now: () => NOW,
        log: (line) => lines.push(line),
      });
    expect(await run(false)).toBe(0);
    expect(ran).toEqual(["SELECT"]);
    expect(lines.at(-1)).toMatch(/dry run/);
    expect(await run(true)).toBe(1);
    expect(ran).toEqual(["SELECT", "SELECT", "UPDATE"]);
    expect(db.prepare("SELECT state FROM effects").get()).toEqual({ state: "pending" });
  });

  it("stops before touching any database when the config names another account", async () => {
    const root = await mkdtemp(join(tmpdir(), "fyrden-cli-repair-"));
    try {
      await mkdir(join(root, "apps", "api"), { recursive: true });
      const config = await readFile(join(realRoot, "apps/api/wrangler.jsonc"), "utf8");
      // Another account's id, as the config's first key.
      const open = config.indexOf("{") + 1;
      await writeFile(
        join(root, "apps/api/wrangler.jsonc"),
        `${config.slice(0, open)}\n  "account_id": "acct-other",${config.slice(open)}`,
      );
      await cp(join(realRoot, "apps/api/migrations"), join(root, "apps/api/migrations"), {
        recursive: true,
      });
      const fake = fakeWrangler();
      fake.state.d1.set("fyrden-org", "org-id");
      await expect(
        repairEffects({
          repoRoot: root,
          runner: fake.runner,
          args: { sink: "feed", since: NOW - DAY, confirmed: true },
          now: () => NOW,
          log: () => {},
        }),
      ).rejects.toThrow(/account_id acct-other/);
      expect(fake.calls.some((c) => c.args[0] === "d1")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
