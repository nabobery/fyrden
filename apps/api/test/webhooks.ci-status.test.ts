import { beforeEach, describe, expect, it } from "vitest";
import { entityBody, webhookEventOf } from "../src/webhooks/events.js";
import { api, json } from "./helpers/api.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();
let sha = "";

beforeEach(async () => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${t.path}/file-commits`, t.owner.token, {
      branch: "main",
      message: "one",
      changes: [{ path: "a.txt", content: "one\n" }],
    }),
  );
  sha = made.body.commit.sha;
});

async function post(body: Record<string, unknown>) {
  const made = await json<{ id: number; created_at: number }>(
    api("POST", `${t.path}/statuses/${sha}`, t.owner.token, body),
  );
  expect(made.status).toBe(201);
  return made.body;
}

describe("the status event", () => {
  it("has no action", () => {
    expect(webhookEventOf("status.created")).toEqual({ event: "status", action: null });
  });

  it("refuses a body not made from its capture", () => {
    expect(() => entityBody({ event: "status", action: null }, { data: {} } as never)).toThrow(
      /capture/,
    );
  });

  it("carries the status as the API shows it", async () => {
    await t.createHook({ events: ["status"] });
    const status = await post({
      state: "failure",
      context: "ext/build",
      description: "2 of 9 failed",
      target_url: "https://ci.example/1",
    });
    const events = await t.routed();
    expect(events.map((e) => e.type)).toEqual(["status.created"]);
    const user = { id: t.owner.principalId, login: t.owner.handle };
    const at = new Date(status.created_at).toISOString();
    expect(await t.bodies(events)).toEqual([
      {
        fyrden_payload: 1,
        event: "status",
        id: status.id,
        sha,
        state: "failure",
        context: "ext/build",
        description: "2 of 9 failed",
        target_url: "https://ci.example/1",
        creator: user,
        created_at: at,
        updated_at: at,
        repository: { id: t.repo.id, name: t.repo.name, owner: user, private: true },
        sender: { ...user, act_chain: [] },
        at,
        position: {
          epoch: events[0]?.id.epochGen,
          sequence: events[0]?.id.sourceSeq,
        },
      },
    ]);
  });

  it("is sent again for the same status posted again", async () => {
    await t.createHook({ events: ["status"] });
    const ids = [(await post({ state: "pending" })).id, (await post({ state: "pending" })).id];
    const bodies = await t.bodies(await t.routed());
    expect(bodies.map((b) => b.id)).toEqual(ids);
  });

  it("goes to a hook of every event", async () => {
    await t.createHook({ events: ["*"] });
    await post({ state: "success" });
    expect((await t.routed()).map((e) => e.type)).toEqual(["status.created"]);
  });

  it("writes no event when no hook takes it, or the one that did is off", async () => {
    const other = await t.createHook({ events: ["push"] });
    const off = await t.createHook({ events: ["status"], active: false });
    expect([other.status, off.status]).toEqual([201, 201]);
    const before = (await t.outbox()).length;
    await post({ state: "success" });
    expect(await t.outbox()).toHaveLength(before);
  });

  it("is not sent for a status refused", async () => {
    await t.createHook({ events: ["status"] });
    const refused = await api("POST", `${t.path}/statuses/${"0".repeat(40)}`, t.owner.token, {
      state: "success",
    });
    expect(refused.status).toBe(422);
    expect(await t.routed()).toEqual([]);
  });
});
