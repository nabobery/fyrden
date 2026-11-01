// The read model's maintenance, as instance administrators run it through
// the API: pausing and resuming its writers (allowed while the deployment's
// maintenance holds other writes back), and a coherent export of it, once a
// restore floor is recorded, page by page under the pause's generation.

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ReadModelWriter } from "../src/read-model/executor.js";
import { EXPORT_TABLES, exportManifest, exportPage } from "../src/read-model/export.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { runningAgain } from "./helpers/read-model.js";

const floor = (bookmark: string | null) =>
  env.DIRECTORY.prepare(
    "UPDATE read_model_barriers SET read_model_protocol_since = ? WHERE shard = 'default'",
  )
    .bind(bookmark)
    .run();

afterEach(async () => {
  await floor(null);
  await runningAgain(env);
});

type Progress = { phase: string; generation: number; live: number; until: number | null };
type Page = { table: string; rows: Record<string, unknown>[]; next_cursor: string | null };

const pause = (who: Who) => json<Progress>(api("POST", "/admin/read-model/pause", who.token, {}));
const resume = (who: Who) =>
  json<{ phase: string; generation: number }>(
    api("POST", "/admin/read-model/resume", who.token, {}),
  );

/** Every page of the export at `generation`, through the API. */
async function exported(who: Who, generation: number): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null | undefined;
  do {
    const query = new URLSearchParams({ generation: String(generation) });
    if (cursor) query.set("cursor", cursor);
    const { status, body } = await json<Page>(
      api("GET", `/admin/read-model/export/pages?${query}`, who.token),
    );
    expect(status).toBe(200);
    pages.push(body);
    cursor = body.next_cursor;
  } while (cursor);
  return pages;
}

describe("the read model's maintenance, through the API", () => {
  it("pauses step by step, waiting for older leases, and resumes", async () => {
    const admin = await user(true);
    const held = new ReadModelWriter(env, "default");
    await held.acquire();
    const first = await pause(admin);
    expect(first).toMatchObject({ status: 200, body: { phase: "pausing", live: 1 } });
    await held.release();
    expect(await pause(admin)).toMatchObject({
      body: { phase: "paused", generation: first.body.generation, live: 0, until: null },
    });
    expect(await resume(admin)).toMatchObject({
      status: 200,
      body: { phase: "running", generation: first.body.generation },
    });
  });

  it("pauses and resumes while the deployment's maintenance holds other writes back", async () => {
    const admin = await user(true);
    const call = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await createApp().fetch(
        new Request(`${ORIGIN}/api${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
          body: "{}",
        }),
        { ...env, FYRDEN_READ_MODEL_MAINTENANCE: "on" },
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    expect(await (await call("/admin/read-model/pause")).json()).toMatchObject({
      phase: "paused",
    });
    expect(await (await call("/admin/read-model/resume")).json()).toMatchObject({
      phase: "running",
    });
    // Other writes still wait.
    expect((await call("/admin/search/backfill")).status).toBe(503);
  });

  it("resumes, given a generation, only the pause at it", async () => {
    const admin = await user(true);
    const { body } = await pause(admin);
    expect(body.phase).toBe("paused");
    const older = await json(
      api("POST", "/admin/read-model/resume", admin.token, { generation: body.generation - 1 }),
    );
    expect(older.body).toEqual({ phase: "paused", generation: body.generation });
    const own = await json(
      api("POST", "/admin/read-model/resume", admin.token, { generation: body.generation }),
    );
    expect(own.body).toEqual({ phase: "running", generation: body.generation });
  });

  it("refuses a pause while the barrier is recovering", async () => {
    const admin = await user(true);
    await env.DIRECTORY.prepare(
      "UPDATE read_model_barriers SET phase = 'recovering' WHERE shard = 'default'",
    ).run();
    expect(await pause(admin)).toMatchObject({
      status: 409,
      body: { code: "read_model_recovering" },
    });
  });

  it("exports nothing before a restore floor is recorded", async () => {
    const admin = await user(true);
    const { body } = await pause(admin);
    const query = `generation=${body.generation}`;
    for (const path of [
      `/admin/read-model/export?${query}`,
      `/admin/read-model/export/pages?${query}`,
    ])
      expect(await json(api("GET", path, admin.token))).toMatchObject({
        status: 409,
        body: { code: "no_restore_floor" },
      });
  });

  it("exports the read model paused at its generation, as the export module pages it, and refuses once it moved", async () => {
    const admin = await user(true);
    await floor("bookmark-after-enforcement");
    const { body } = await pause(admin);
    expect(body.phase).toBe("paused");
    const manifest = await json(
      api("GET", `/admin/read-model/export?generation=${body.generation}`, admin.token),
    );
    expect(manifest).toEqual({
      status: 200,
      body: JSON.parse(JSON.stringify(await exportManifest(env.ORG_READ, body.generation))),
    });
    const pages = await exported(admin, body.generation);
    // Every table, in order, each row once: what the export module returns from the start.
    expect(pages.map((p) => p.table).filter((t, i, all) => all.indexOf(t) === i)).toEqual(
      EXPORT_TABLES.map((t) => t.table),
    );
    const direct = await exportPage(env.ORG_READ, body.generation, { table: 0, after: null });
    expect(pages[0]).toMatchObject({ table: direct.table, rows: direct.rows });
    // Resumed: the export's generation is over.
    await resume(admin);
    const query = `generation=${body.generation}`;
    expect(
      await json(api("GET", `/admin/read-model/export/pages?${query}`, admin.token)),
    ).toMatchObject({ status: 409, body: { code: "export_fence_lost" } });
    // A cursor no page gave is refused.
    expect(
      (await json(api("GET", `/admin/read-model/export/pages?${query}&cursor=nope`, admin.token)))
        .status,
    ).toBe(422);
  });

  it("is run only by instance administrators", async () => {
    const someone = await user();
    expect((await pause(someone)).status).toBe(403);
    expect((await resume(someone)).status).toBe(403);
    expect(
      (await json(api("GET", "/admin/read-model/export?generation=1", someone.token))).status,
    ).toBe(403);
  });
});
