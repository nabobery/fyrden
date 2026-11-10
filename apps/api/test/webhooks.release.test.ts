// Release webhooks: each action as the design lists it, in order, with the
// release as the API shows it as of the event; an edit's changes reach the
// body; a hook listening only for releases hears only them.
import { RELEASE_EVENTS } from "@fyrden/domain";
import { describe, expect, inject, it } from "vitest";
import { INLINE_MAX_BYTES } from "../src/webhooks/capture.js";
import { entityBody, webhookEventOf } from "../src/webhooks/events.js";
import { api, json } from "./helpers/api.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { moveRef } from "./helpers/gc.js";
import { setPolicy } from "./helpers/maintenance.js";
import { inRepo } from "./helpers/repo-git.js";
import { webhookTest } from "./helpers/webhooks.js";

const fx = inject("gcFixtures");
const t = webhookTest();

type Body = Record<string, unknown> & { action: string; release: Record<string, unknown> };
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

async function send<T = { id: number }>(method: string, tail: string, body?: unknown) {
  const answer = await json<T>(api(method, `${t.path}/releases${tail}`, t.owner.token, body));
  if (answer.status >= 300) throw new Error(`${answer.status}: ${JSON.stringify(answer.body)}`);
  return answer.body;
}

describe("release events", () => {
  it("are each a webhook action of the same name", () => {
    for (const type of RELEASE_EVENTS)
      expect(webhookEventOf(type)).toEqual({
        event: "release",
        action: type.slice("release.".length),
      });
  });

  it("refuse the comment-shaped default body: a capture is the only source", () => {
    expect(() =>
      entityBody({ event: "release", action: "created" }, { data: {} } as never),
    ).toThrow(/capture/);
  });
});

describe("release webhooks", () => {
  it("deliver each action, as of its event", async () => {
    await setPolicy(t.stub());
    await loadFixture(t.stub(), fx.repo, { allReachable: false });
    await t.createHook({ events: ["release"] });
    const made = await send("POST", "", { tag_name: "v1", draft: true, name: "One" });
    await send("PATCH", `/${made.id}`, { name: "Uno" });
    await send("PATCH", `/${made.id}`, { draft: false });
    await send("PATCH", `/${made.id}`, { prerelease: true });
    await send("PATCH", `/${made.id}`, { prerelease: false });
    await send("DELETE", `/${made.id}`);
    await moveRef(t.stub(), "refs/tags/pre", null, fx.side);
    await send("POST", "", { tag_name: "pre", prerelease: true });
    const bodies = (await t.bodies(await t.routed())) as Body[];
    expect(bodies.map((b) => b.action)).toEqual([
      "created",
      "edited",
      "published",
      "released",
      "edited",
      "edited",
      "released",
      "deleted",
      "created",
      "published",
      "prereleased",
    ]);
    expect(bodies[0]?.release).toMatchObject({ name: "One", draft: true, assets: [] });
    expect(bodies[1]).toMatchObject({ changes: { name: { from: "One" } } });
    expect(bodies[1]?.release).toMatchObject({ name: "Uno", draft: true });
    expect(bodies[2]?.release).toMatchObject({ draft: false, name: "Uno" });
    expect(bodies[2]?.release.published_at).toMatch(ISO);
    expect(bodies[2]?.release.author).toMatchObject({ login: t.owner.handle });
    expect(bodies[7]?.release).toMatchObject({ tag_name: "v1" });
  });

  it("carry a release's assets, all 100 at their longest names within the inline capture", async () => {
    await setPolicy(t.stub());
    await loadFixture(t.stub(), fx.repo, { allReachable: false });
    await t.createHook({ events: ["release"] });
    const made = await send("POST", "", { tag_name: "v-full", draft: true });
    await t.bodies(await t.routed());
    await inRepo(t.stub(), ({ git }) => {
      for (let i = 0; i < 100; i++) {
        const name = `${String(i).padStart(3, "0")}${"é".repeat(126)}`;
        git.context.storage.sql.exec(
          `INSERT INTO release_assets (release_id, name, name_fold, content_type, object_id, bytes,
             uploader, created_at, updated_at) VALUES (?, ?, ?, 'application/octet-stream', ?, 1, ?, 0, 0)`,
          made.id,
          name,
          name,
          `01J${String(i).padStart(23, "0")}`,
          t.owner.principalId,
        );
      }
    });
    await send("PATCH", `/${made.id}`, { name: "Full" });
    // The capture the event carries stays inline: the longer texts became blobs, read back for the body.
    const tree = await inRepo(
      t.stub(),
      ({ git }) =>
        git.context.storage.sql
          .exec<{ tree: string }>(
            `SELECT json_extract(event, '$.data.webhook.tree') AS tree FROM outbox
           WHERE json_extract(event, '$.type') = 'release.edited' ORDER BY source_seq DESC LIMIT 1`,
          )
          .one().tree,
    );
    expect(new TextEncoder().encode(tree).length).toBeLessThanOrEqual(INLINE_MAX_BYTES);
    const edited = ((await t.bodies(await t.routed())) as Body[]).find(
      (b) => b.action === "edited",
    );
    const assets = edited?.release.assets as { name: string; download_url: string }[];
    expect(assets).toHaveLength(100);
    // Relative to the repository: the owner's handle isn't where the body is made.
    expect(assets[0]?.download_url).toBe(
      `releases/download/v-full/${encodeURIComponent(assets[0]?.name as string)}`,
    );
  });
});
