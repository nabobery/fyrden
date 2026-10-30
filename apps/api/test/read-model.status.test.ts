// The read model's and search's state, as instance administrators read it
// (`GET /admin/search/status`): what the rollout's operators look at before
// a pause, an export or turning refusals on.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { READ_MODEL_PROTOCOL, ReadModelWriter } from "../src/read-model/executor.js";
import { api, json, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";

const status = (token: string) =>
  json<Record<string, Record<string, unknown>>>(api("GET", "/admin/search/status", token));

describe("the read model's status", () => {
  it("says it runs in compatibility, consistent, with no export yet, and counts the live leases", async () => {
    const admin = await user(true);
    const writer = new ReadModelWriter(env, "default");
    await writer.acquire();
    try {
      const { status: code, body } = await status(admin.token);
      expect(code).toBe(200);
      expect(body.protocol).toEqual({
        serving_version: READ_MODEL_PROTOCOL,
        deployed_version: 0,
        required_version: 1,
        mode: "compatibility",
        restore_floor: null,
      });
      expect(body.barrier).toEqual({
        directory_phase: "running",
        directory_generation: 1,
        org_phase: "running",
        org_generation: 1,
        consistent: true,
      });
      expect(body.admission).toMatchObject({ open: false });
      expect(body.writers).toMatchObject({ live: 1, earliest_deadline: writer.lease?.until });
      expect(body.export).toEqual({ available: false, reason: "protocol_not_enforced" });
      expect(body.search).toMatchObject({ day: expect.any(Number), rows: expect.any(Number) });
    } finally {
      await writer.release();
    }
  });

  it("reads a missing barrier as null and not consistent, never as healthy", async () => {
    const admin = await user(true);
    await env.ORG_READ.prepare("DELETE FROM read_model_barrier").run();
    try {
      const { body } = await status(admin.token);
      expect(body.barrier).toMatchObject({
        org_phase: null,
        org_generation: null,
        consistent: false,
      });
      expect(body.protocol).toMatchObject({ required_version: null });
    } finally {
      await env.ORG_READ.prepare(
        "INSERT INTO read_model_barrier (id, phase, generation, protocol_version) VALUES (1, 'running', 1, 1)",
      ).run();
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
