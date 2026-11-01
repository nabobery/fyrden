// A recovery of the read model through the API, end to end: paused, begun,
// its operational rows preserved, the read model restored (here as a
// maintenance writer leaves it: rows lost, changed and only restored, an
// older restore token, its barrier running), the restore reported, the rows
// imported exactly, search fenced, the token replaced, its charges spent,
// and the writers running again.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORG_SHARD, readModelFor } from "../src/events/read-model.js";
import { admitted } from "../src/read-model/maintenance.js";
import { PRESERVED_TABLES } from "../src/read-model/preservation.js";
import { MOST_ENTRIES, recoveryStep } from "../src/read-model/recovery.js";
import { restoreTokenState } from "../src/read-model/restore-token.js";
import { SOURCE_VISIBLE } from "../src/search/visibility.js";
import { api, json, user } from "./helpers/api.js";

const db = readModelFor(env, DEFAULT_ORG_SHARD);

type Recovery = { recovery_id: string; generation: number; stage: string; code?: string };

async function paused(token: string): Promise<void> {
  for (let step = 0; step < 5; step++) {
    const { body } = await json<{ phase: string }>(
      api("POST", "/admin/read-model/pause", token, {}),
    );
    if (body.phase === "paused") return;
  }
  throw new Error("not paused");
}

const step = (token: string, body: Record<string, unknown>) =>
  json<Recovery>(api("POST", "/admin/read-model/recovery/step", token, body));

/** Steps the recovery on while its stage is `stage`: where it stands after. */
async function through(token: string, id: string, stage: string): Promise<Recovery> {
  for (let n = 0; n < 300; n++) {
    const { status, body } = await step(token, { recovery_id: id });
    expect(status, JSON.stringify(body)).toBe(200);
    if (body.stage !== stage) return body;
  }
  throw new Error(`still ${stage}`);
}

describe("a recovery of the read model", () => {
  it("brings back the operational rows exactly, hides search until reconciled, and resumes the writers", async () => {
    const admin = await user(true);
    expect((await api("POST", "/admin/read-model/handshake", admin.token, {})).status).toBe(200);
    const kept = uniqueId("src");
    const lost = uniqueId("src");
    const only = uniqueId("only");
    // A source search shows before: hidden by the recovery until it is reconciled again.
    const shown = uniqueId("rep");
    await db
      .prepare(
        "INSERT INTO search_sources (repo_id, cutoff_epoch, cutoff_seq, visible_gen) SELECT ?, 0, 0, recovery_gen FROM search_index_state WHERE id = 1",
      )
      .bind(shown)
      .run();
    await db.batch([
      db
        .prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 4), (?, 7)")
        .bind(kept, lost),
    ]);
    const tokenBefore = await db
      .prepare("SELECT token FROM read_model_restore_token WHERE id = 1")
      .first<{ token: string }>();
    // A handshake after it: the restore goes to before it.
    expect((await api("POST", "/admin/read-model/handshake", admin.token, {})).status).toBe(200);
    const genBefore =
      (
        await db.prepare("SELECT recovery_gen FROM search_index_state WHERE id = 1").first<{
          recovery_gen: number;
        }>()
      )?.recovery_gen ?? 0;

    await paused(admin.token);
    const id = uniqueId("rcv");
    const begun = await json<Recovery>(
      api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: id }),
    );
    expect(begun.status).toBe(200);
    expect(begun.body).toMatchObject({ recovery_id: id, stage: "preserving" });
    expect(await through(admin.token, id, "preserving")).toMatchObject({
      stage: "awaiting_restore",
    });
    // Waiting for its restore: nothing moves without one reported.
    expect((await step(admin.token, { recovery_id: id })).body.stage).toBe("awaiting_restore");

    // The restore (as it leaves the read model): a row lost, one changed, one only restored, the
    // token from before the last handshake, and the barrier as it was then (running).
    const { generation } = begun.body;
    expect(
      await admitted(env, DEFAULT_ORG_SHARD, generation, (org) => [
        org.prepare("DELETE FROM source_owner WHERE source_id = ?").bind(lost),
        org.prepare("UPDATE source_owner SET owner_gen = 1 WHERE source_id = ?").bind(kept),
        org.prepare("INSERT INTO source_owner (source_id, owner_gen) VALUES (?, 1)").bind(only),
        org
          .prepare("UPDATE read_model_restore_token SET token = ? WHERE id = 1")
          .bind(tokenBefore?.token ?? ""),
        org.prepare("UPDATE read_model_barrier SET phase = 'running' WHERE id = 1"),
      ]),
    ).toBe(true);
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("mismatch");

    const reported = await step(admin.token, {
      recovery_id: id,
      restore: { bookmark: "bookmark-restored", undo_bookmark: "bookmark-undo" },
    });
    expect(reported.body.stage).toBe("importing");
    expect(await through(admin.token, id, "importing")).toMatchObject({ stage: "fencing" });
    expect(
      await db
        .prepare(
          "SELECT source_id, owner_gen FROM source_owner WHERE source_id IN (?, ?) ORDER BY owner_gen",
        )
        .bind(kept, lost)
        .all(),
    ).toMatchObject({
      results: [
        { source_id: kept, owner_gen: 4 },
        { source_id: lost, owner_gen: 7 },
      ],
    });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM source_owner WHERE source_id = ?")
        .bind(only)
        .first(),
    ).toEqual({ n: 0 });
    expect(await through(admin.token, id, "fencing")).toMatchObject({ stage: "resuming" });
    expect(
      await db
        .prepare(`SELECT ${SOURCE_VISIBLE("?1")} AS v`)
        .bind(shown)
        .first(),
    ).toEqual({ v: 0 });
    const spentBefore = await db
      .prepare("SELECT coalesce(sum(recovery_rows), 0) AS rows FROM search_budget")
      .first<{ rows: number }>();
    expect(await through(admin.token, id, "resuming")).toMatchObject({ stage: "complete" });

    // The writers running again; the token the read model's own; search hidden until reconciled.
    expect(
      await env.DIRECTORY.prepare(
        "SELECT phase, generation FROM read_model_barriers WHERE shard = ?",
      )
        .bind(DEFAULT_ORG_SHARD)
        .first(),
    ).toEqual({ phase: "running", generation });
    expect(
      await db.prepare("SELECT phase, generation FROM read_model_barrier WHERE id = 1").first(),
    ).toEqual({
      phase: "running",
      generation,
    });
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("matched");
    expect(
      (
        await db.prepare("SELECT recovery_gen FROM search_index_state WHERE id = 1").first<{
          recovery_gen: number;
        }>()
      )?.recovery_gen,
    ).toBe(genBefore + 1);
    const spent = await db
      .prepare("SELECT coalesce(sum(recovery_rows), 0) AS rows FROM search_budget")
      .first<{ rows: number }>();
    expect(spent?.rows).toBeGreaterThan(spentBefore?.rows ?? 0);
    expect(
      await env.DIRECTORY.prepare(
        "SELECT restore_bookmark, undo_bookmark FROM read_model_recoveries WHERE recovery_id = ?",
      )
        .bind(id)
        .first(),
    ).toEqual({ restore_bookmark: "bookmark-restored", undo_bookmark: "bookmark-undo" });
    // Its status, and a step after it is complete changes nothing.
    const status = await json<{ recovery: Recovery | null; search: { recovery_gen: number } }>(
      api("GET", "/admin/search/status", admin.token),
    );
    expect(status.body.recovery).toEqual({ recovery_id: id, generation, stage: "complete" });
    expect(status.body.search.recovery_gen).toBe(genBefore + 1);
    expect((await step(admin.token, { recovery_id: id })).body.stage).toBe("complete");
    expect(
      (await json<Recovery>(api("GET", "/admin/read-model/recovery", admin.token))).body,
    ).toEqual({
      recovery_id: id,
      generation,
      stage: "complete",
    });
  });

  it("replaces the restore token after taking it over, a step each, even one the directory knew", async () => {
    const admin = await user(true);
    expect((await api("POST", "/admin/read-model/handshake", admin.token, {})).status).toBe(200);
    const token = async () =>
      (
        await db
          .prepare("SELECT token FROM read_model_restore_token WHERE id = 1")
          .first<{ token: string }>()
      )?.token;
    const held = await token();
    await paused(admin.token);
    const id = uniqueId("rcv");
    await api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: id });
    await through(admin.token, id, "preserving");
    await step(admin.token, { recovery_id: id, restore: { bookmark: "b", undo_bookmark: "u" } });
    await through(admin.token, id, "importing");
    await through(admin.token, id, "fencing");
    const cursor = () =>
      env.DIRECTORY.prepare("SELECT cursor FROM read_model_recoveries WHERE recovery_id = ?")
        .bind(id)
        .first<{ cursor: string | null }>()
        .then((r) => JSON.parse(r?.cursor ?? "null"));
    // Taken over (the token the restore left, matched as it is), then replaced: a step each.
    expect((await step(admin.token, { recovery_id: id })).body.stage).toBe("resuming");
    expect(await cursor()).toEqual({ adopted: held });
    expect((await step(admin.token, { recovery_id: id })).body.stage).toBe("resuming");
    expect(await cursor()).toEqual({ adopted: held, rotated: true });
    expect(await token()).not.toBe(held);
    expect(await through(admin.token, id, "resuming")).toMatchObject({ stage: "complete" });
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("matched");
  });

  it("starts a second recovery with nothing of the first's charges or restore, and repeats no start once resuming", async () => {
    const admin = await user(true);
    const recover = async () => {
      await paused(admin.token);
      const id = uniqueId("rcv");
      await api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: id });
      return id;
    };
    const usage = (id: string) =>
      env.DIRECTORY.prepare(
        "SELECT usage_rows, usage_reads, restore_bookmark FROM read_model_recoveries WHERE recovery_id = ?",
      )
        .bind(id)
        .first<{ usage_rows: number; usage_reads: number; restore_bookmark: string | null }>();
    const first = await recover();
    await through(admin.token, first, "preserving");
    await step(admin.token, {
      recovery_id: first,
      restore: { bookmark: "b1", undo_bookmark: "u1" },
    });
    await through(admin.token, first, "importing");
    await through(admin.token, first, "fencing");
    // Its start asked again while resuming, with the read model's barrier already running (as the
    // resume leaves it before the directory's): not paused again.
    const generation = (await json<Recovery>(api("GET", "/admin/read-model/recovery", admin.token)))
      .body.generation;
    await step(admin.token, { recovery_id: first });
    await step(admin.token, { recovery_id: first });
    expect(
      await admitted(env, DEFAULT_ORG_SHARD, generation, (org) =>
        org.prepare("UPDATE read_model_barrier SET phase = 'running' WHERE id = 1"),
      ),
    ).toBe(true);
    await api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: first });
    expect(await db.prepare("SELECT phase FROM read_model_barrier WHERE id = 1").first()).toEqual({
      phase: "running",
    });
    expect(await through(admin.token, first, "resuming")).toMatchObject({ stage: "complete" });
    expect((await usage(first))?.usage_rows).toBeGreaterThan(0);
    const second = await recover();
    expect(await usage(second)).toEqual({ usage_rows: 0, usage_reads: 0, restore_bookmark: null });
    // Finished, so the file's other tests find the writers running.
    await through(admin.token, second, "preserving");
    await step(admin.token, {
      recovery_id: second,
      restore: { bookmark: "b2", undo_bookmark: "u2" },
    });
    await through(admin.token, second, "importing");
    await through(admin.token, second, "fencing");
    await through(admin.token, second, "resuming");
  });

  it("takes nothing over again from a step stalled while another took over and replaced the token", async () => {
    const admin = await user(true);
    expect((await api("POST", "/admin/read-model/handshake", admin.token, {})).status).toBe(200);
    await paused(admin.token);
    const id = uniqueId("rcv");
    await api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: id });
    await through(admin.token, id, "preserving");
    await step(admin.token, { recovery_id: id, restore: { bookmark: "b", undo_bookmark: "u" } });
    await through(admin.token, id, "importing");
    await through(admin.token, id, "fencing");
    // A step that read the cursor, then stalled before its takeover; meanwhile another took the
    // token over and replaced it.
    let stalled = false;
    const directory = new Proxy(env.DIRECTORY, {
      get(target, prop) {
        if (prop === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const sql = statements.map((s) => (s as unknown as { statement: string }).statement);
            if (!stalled && sql.some((q) => q.includes("token_completed = ?2"))) {
              stalled = true;
              expect((await step(admin.token, { recovery_id: id })).status).toBe(200);
              expect((await step(admin.token, { recovery_id: id })).status).toBe(200);
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const slow = new Proxy(env, {
      get: (target, prop) => (prop === "DIRECTORY" ? directory : Reflect.get(target, prop)),
    });
    await recoveryStep(slow, DEFAULT_ORG_SHARD, id);
    expect(stalled).toBe(true);
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("matched");
    expect(await through(admin.token, id, "resuming")).toMatchObject({ stage: "complete" });
    expect(await restoreTokenState(env, DEFAULT_ORG_SHARD)).toBe("matched");
  });

  it("never pauses again a barrier its recovery's resume opened at its generation", async () => {
    const admin = await user(true);
    await paused(admin.token);
    const id = uniqueId("rcv");
    const { body } = await json<Recovery>(
      api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: id }),
    );
    // As a resume of it leaves the read model's barrier, met by a start asked meanwhile.
    expect(
      await admitted(env, DEFAULT_ORG_SHARD, body.generation, (org) =>
        org.prepare("UPDATE read_model_barrier SET phase = 'running' WHERE id = 1"),
      ),
    ).toBe(true);
    await api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: id });
    expect(await db.prepare("SELECT phase FROM read_model_barrier WHERE id = 1").first()).toEqual({
      phase: "running",
    });
    // Put back as it was, and finished, for the file's other tests.
    expect(
      await admitted(env, DEFAULT_ORG_SHARD, body.generation, (org) =>
        org.prepare("UPDATE read_model_barrier SET phase = 'paused' WHERE id = 1"),
      ),
    ).toBe(true);
    await through(admin.token, id, "preserving");
    await step(admin.token, { recovery_id: id, restore: { bookmark: "b", undo_bookmark: "u" } });
    await through(admin.token, id, "importing");
    await through(admin.token, id, "fencing");
    await through(admin.token, id, "resuming");
  });

  it("charges a row written or removed no fewer entries than its table's indexes make", async () => {
    for (const table of PRESERVED_TABLES) {
      const indexes = await db
        .prepare("SELECT count(*) AS n FROM pragma_index_list(?)")
        .bind(table)
        .first<{ n: number }>();
      expect(1 + (indexes?.n ?? 0), table).toBeLessThanOrEqual(MOST_ENTRIES);
    }
  });

  it("is refused while the writers run, for another recovery's id, and to anyone but an instance administrator", async () => {
    const admin = await user(true);
    const refused = await json<Recovery>(
      api("POST", "/admin/read-model/recovery", admin.token, { recovery_id: uniqueId("rcv") }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("recovery_refused");
    const wrong = await step(admin.token, { recovery_id: uniqueId("rcv") });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe("recovery_refused");
    const someone = await user();
    expect((await step(someone.token, { recovery_id: uniqueId("rcv") })).status).toBe(403);
    expect(
      (
        await api("POST", "/admin/read-model/recovery", someone.token, {
          recovery_id: uniqueId("rcv"),
        })
      ).status,
    ).toBe(403);
  });
});
