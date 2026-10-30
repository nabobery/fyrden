// The read model's and search's state, as instance administrators read it
// (`GET /admin/search/status`): what operators look at before a pause or
// an export.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { READ_MODEL_PROTOCOL, ReadModelWriter } from "../src/read-model/executor.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";

const status = (token: string) =>
  json<Record<string, Record<string, unknown>>>(api("GET", "/admin/search/status", token));

describe("the read model's status", () => {
  it("says it refuses writes outside the executor, consistent, with no export yet, and counts the live leases", async () => {
    const admin = await user(true);
    const writer = new ReadModelWriter(env, "default");
    await writer.acquire();
    try {
      const { status: code, body } = await status(admin.token);
      expect(code).toBe(200);
      expect(body.protocol).toEqual({
        serving_version: READ_MODEL_PROTOCOL,
        deployed_version: 0,
        required_version: 2,
        mode: "enforced",
        restore_floor: null,
      });
      expect(body.barrier).toMatchObject({
        directory_phase: "running",
        org_phase: "running",
        consistent: true,
      });
      expect(body.barrier?.org_generation).toBe(body.barrier?.directory_generation);
      expect(body.admission).toMatchObject({ open: false });
      expect(body.writers).toMatchObject({ live: 1, earliest_deadline: writer.lease?.until });
      expect(body.export).toEqual({ available: false, reason: "no_restore_floor" });
      expect(body.search).toMatchObject({ day: expect.any(Number), rows: expect.any(Number) });
    } finally {
      await writer.release();
    }
  });

  it("is read only by instance administrators", async () => {
    const someone = await user();
    expect((await status(someone.token)).status).toBe(403);
    const admin = await user(true);
    // A token narrowed to other permissions does not reach it either.
    const narrowed = await scopedToken(admin.principalId, ["members:read"]);
    expect((await status(narrowed)).status).toBe(403);
  });
});
