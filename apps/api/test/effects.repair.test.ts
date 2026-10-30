// An operator's repair of effects that failed for good while what they
// deliver can still matter: counted, and reopened through the read model's
// executor (never while it is under maintenance).
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPAIR_BATCH, REPAIR_HORIZON_MS } from "../src/effects/repair.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { pauseReadModel, resumeReadModel } from "../src/read-model/maintenance.js";
import { clock } from "../src/services.js";
import { api, json, user, type Who } from "./helpers/api.js";

const DAY = 24 * 60 * 60 * 1000;
// Written as production writes it: through the read model's executor.
const db = readModelFor(env, DEFAULT_ORG_SHARD);

let admin: Who;
let member: Who;
beforeAll(async () => {
  admin = await user(true);
  member = await user();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM effects").run();
});

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

function insert(now: number, row: Row): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO effects (effect_id, sink, target, payload, state, attempts, next_attempt_at,
         last_error, created_at, recover_at, max_attempts) VALUES (?, ?, 't', ?, ?, ?, 0, ?, ?, 0, ?)`,
    )
    .bind(
      row.id,
      row.sink ?? "feed",
      JSON.stringify(row.occurredAt === undefined ? {} : { occurredAt: row.occurredAt }),
      row.state ?? "failed",
      row.attempts ?? 20,
      row.lastError === undefined ? "feed unavailable" : row.lastError,
      row.createdAt ?? now - DAY,
      row.maxAttempts ?? null,
    );
}

type Repair = { eligible: number; oldest: number | null; reopened: number };

const repair = (body: Record<string, unknown>, who: Who = admin) =>
  json<Repair>(api("POST", "/admin/effects/repair", who.token, body));

describe("effects repair", () => {
  it("counts by default, and reopens failed effects that may still matter, and none other", async () => {
    const now = clock();
    await db.batch(
      [
        { id: "spent" },
        { id: "no-error", lastError: null },
        { id: "moved-on", lastError: "invalidated: its source was deleted" },
        { id: "expired", lastError: "expired: past the feed's delivery deadline" },
        { id: "page-gone", lastError: "page missing: absent" },
        { id: "no-sink", lastError: "no sink named gone" },
        { id: "pending", state: "pending" },
        { id: "done", state: "done" },
        { id: "webhook", sink: "webhooks" },
        // Watched activity: one attempt within a window long gone; never reopened.
        { id: "watched", attempts: 1, maxAttempts: 1, lastError: "attempts spent" },
        { id: "before-since", createdAt: now - 3 * DAY },
        // Past the horizon by when it happened, though journaled since.
        { id: "too-old", occurredAt: now - REPAIR_HORIZON_MS - DAY },
        { id: "recent", occurredAt: now - REPAIR_HORIZON_MS + DAY },
      ].map((row) => insert(now, row)),
    );
    const since = now - 2 * DAY;
    const dry = await repair({ sink: "feed", since });
    expect(dry).toMatchObject({ status: 200, body: { eligible: 3, reopened: 0 } });
    expect(dry.body.oldest).toBe(now - DAY);
    expect(
      await db.prepare("SELECT count(*) AS n FROM effects WHERE state = 'failed'").first(),
    ).toEqual({ n: 11 });

    expect(await repair({ sink: "feed", since, dry_run: false })).toMatchObject({
      status: 200,
      body: { eligible: 3, reopened: 3 },
    });
    const { results } = await db
      .prepare("SELECT effect_id FROM effects WHERE state = 'pending' ORDER BY effect_id")
      .all<{ effect_id: string }>();
    expect(results.map((r) => r.effect_id)).toEqual(["no-error", "pending", "recent", "spent"]);
    const spent = await db
      .prepare(
        `SELECT state, attempts, next_attempt_at, recover_at, lease_token, last_error FROM effects
         WHERE effect_id = 'spent'`,
      )
      .first<{ next_attempt_at: number; recover_at: number }>();
    expect(spent).toMatchObject({
      state: "pending",
      // Claimed before, it still counts as claimed (a deletion waits for such an effect).
      attempts: 1,
      lease_token: null,
      last_error: "reopened: feed unavailable",
    });
    // Due at once, and overdue for the cron.
    expect(spent?.next_attempt_at).toBe(spent?.recover_at);
    expect(spent?.next_attempt_at).toBeGreaterThanOrEqual(now);
    // Reopened, they are no longer failed: a second run finds none.
    expect(await repair({ sink: "feed", since, dry_run: false })).toMatchObject({
      body: { eligible: 0, oldest: null, reopened: 0 },
    });
  });

  it("reopens a bounded number a run, the oldest first", async () => {
    const now = clock();
    const rows = Array.from({ length: REPAIR_BATCH + 2 }, (_, i) =>
      insert(now, { id: `e${String(i).padStart(5, "0")}`, createdAt: now - DAY + i }),
    );
    for (let i = 0; i < rows.length; i += 100) await db.batch(rows.slice(i, i + 100));
    expect(await repair({ sink: "feed", since: 0, dry_run: false })).toMatchObject({
      body: { eligible: REPAIR_BATCH + 2, reopened: REPAIR_BATCH },
    });
    expect(await repair({ sink: "feed", since: 0 })).toMatchObject({
      body: { eligible: 2, oldest: now - DAY + REPAIR_BATCH, reopened: 0 },
    });
  });

  it("refuses a date in the future, an unknown sink, and anyone but an administrator", async () => {
    expect((await repair({ sink: "feed", since: clock() + DAY })).status).toBe(422);
    expect((await repair({ sink: "events", since: 0 })).status).toBe(422);
    expect((await repair({ sink: "feed", since: 0 }, member)).status).toBe(403);
  });

  it("reopens nothing while the read model is under maintenance", async () => {
    const now = clock();
    await db.batch([insert(now, { id: "spent" })]);
    await pauseReadModel(env, DEFAULT_ORG_SHARD);
    try {
      const refused = await repair({ sink: "feed", since: 0, dry_run: false });
      expect(refused).toMatchObject({ status: 503, body: { code: "read_model_maintenance" } });
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
    expect(await db.prepare("SELECT state FROM effects").first()).toEqual({ state: "failed" });
  });

  it("answers a request sent again with its key once maintenance is over, and replays it after", async () => {
    const now = clock();
    await db.batch([insert(now, { id: "spent" })]);
    const key = crypto.randomUUID();
    const keyed = () =>
      json<Repair>(
        exports.default.fetch("https://fyrden.test/api/admin/effects/repair", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${admin.token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          body: JSON.stringify({ sink: "feed", since: 0, dry_run: false }),
        }),
      );
    await pauseReadModel(env, DEFAULT_ORG_SHARD);
    try {
      expect(await keyed()).toMatchObject({ status: 503 });
    } finally {
      await resumeReadModel(env, DEFAULT_ORG_SHARD);
    }
    // Nothing was written: the same request, sent again, runs.
    expect(await keyed()).toMatchObject({ status: 200, body: { eligible: 1, reopened: 1 } });
    // Its answer replayed: a newer failure is left for another request.
    await db.batch([insert(now, { id: "later" })]);
    expect(await keyed()).toMatchObject({ status: 200, body: { eligible: 1, reopened: 1 } });
    expect(await db.prepare("SELECT state FROM effects WHERE effect_id = 'later'").first()).toEqual(
      { state: "failed" },
    );
  });
});
