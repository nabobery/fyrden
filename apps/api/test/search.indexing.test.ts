// Turning search indexing on and off: the deployment setting that lets
// events project and repairs run, set by an instance administrator.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { searchIndexing } from "../src/search/repairs.js";
import { api, user } from "./helpers/api.js";

const put = (token: string, enabled: unknown) =>
  api("PUT", "/admin/search/indexing", token, { enabled });

describe("search indexing", () => {
  it("is turned on and off by an instance administrator, the same answer again changing nothing", async () => {
    const admin = await user(true);
    for (const enabled of [true, true, false, false, true]) {
      const res = await put(admin.token, enabled);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled });
      expect(await searchIndexing(env)).toBe(enabled);
    }
    // The state it is in, asked again, writes nothing (its time stays).
    await env.DIRECTORY.prepare(
      "UPDATE deployment_settings SET updated_at = 7 WHERE name = 'search_indexing'",
    ).run();
    expect((await put(admin.token, true)).status).toBe(200);
    const kept = await env.DIRECTORY.prepare(
      "SELECT updated_at FROM deployment_settings WHERE name = 'search_indexing'",
    ).first<{ updated_at: number }>();
    expect(kept?.updated_at).toBe(7);
    // On, a backfill is taken; off, refused.
    expect((await api("POST", "/admin/search/backfill", admin.token, {})).status).toBe(200);
    await put(admin.token, false);
    expect((await api("POST", "/admin/search/backfill", admin.token, {})).status).toBe(409);
  });

  it("is for instance administrators only, and takes a boolean", async () => {
    const admin = await user(true);
    await put(admin.token, false);
    const someone = await user();
    expect((await put(someone.token, true)).status).toBe(403);
    expect((await put(admin.token, "on")).status).toBe(422);
    expect(await searchIndexing(env)).toBe(false);
  });
});
