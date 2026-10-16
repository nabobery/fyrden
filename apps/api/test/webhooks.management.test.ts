// Repository webhooks managed over the API: made by administrators only,
// their secret made by the server, shown once and sealed at rest; events
// routed to the active hooks that take them; deliveries and their attempts
// shown to administrators.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { attemptDelivery } from "../src/webhooks/deliver.js";
import { openSecret, secretKeys } from "../src/webhooks/secrets.js";
import { api, json, user } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";
import { type HookOut, RECEIVER, webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

describe("webhooks", () => {
  it("are made by administrators with a secret shown once, and refuse unsafe URLs", async () => {
    const made = await t.createHook({ events: ["push", "pull_request"] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      active: true,
      events: ["pull_request", "push"],
      config: { url: RECEIVER },
      last_response: { code: null, status: "unused" },
      secrets: 1,
    });
    expect(made.body.secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    const listed = await json<HookOut[]>(api("GET", `${t.path}/hooks`, t.owner.token));
    expect(listed.body).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain("whsec_");
    // Sealed at rest, bound to its repository and hook.
    const stored = await inRepo(t.stub(), (r: RepoDO) =>
      r.git.context.storage.sql.exec<{ secrets: string }>("SELECT secrets FROM webhooks").one(),
    );
    expect(stored.secrets).not.toContain((made.body.secret as string).slice(6));
    const [sealed] = JSON.parse(stored.secrets);
    const keys = await secretKeys(env);
    expect(await openSecret(keys, { repoId: t.repo.id, hookId: made.body.id }, sealed)).toBe(
      made.body.secret,
    );
    expect(
      await openSecret(keys, { repoId: t.repo.id, hookId: made.body.id + 1 }, sealed),
    ).toBeUndefined();

    for (const url of ["https://10.0.0.1/x", "http://93.184.216.34/x", "https://localhost/x"])
      expect((await t.createHook({ config: { url } })).body).toMatchObject({ code: "invalid_url" });
    const writer = await user();
    await api("PUT", `${t.path}/collaborators/${writer.handle}`, t.owner.token, {
      permission: "push",
    });
    expect((await t.createHook({}, writer)).status).toBe(404);
    expect((await json(api("GET", `${t.path}/hooks`, writer.token))).status).toBe(404);
  });

  it("route events to the active hooks that take them, at their configuration versions", async () => {
    const pushes = (await t.createHook({ events: ["push"] })).body;
    const prs = (await t.createHook({ events: ["pull_request"] })).body;
    const off = (await t.createHook({ events: ["push"], active: false })).body;
    expect(
      (
        await json(
          api("POST", `${t.path}/file-commits`, t.owner.token, {
            message: "first",
            changes: [{ path: "a.txt", content: "a\n" }],
          }),
        )
      ).status,
    ).toBe(201);
    const events = await t.outbox();
    const pushed = events.find((e) => e.type === "refs.updated");
    expect(pushed?.webhooks).toEqual({
      hooks: [{ id: pushes.id, v: 1 }],
      repo: { name: t.repo.name, ownerId: t.owner.principalId, private: true },
    });
    // Each hook made got its ping (the inactive one none).
    const pings = events.filter((e) => e.type === "webhook.ping").map((e) => e.webhooks?.hooks);
    expect(pings).toEqual([[{ id: pushes.id, v: 1 }], [{ id: prs.id, v: 1 }]]);
    expect(off.active).toBe(false);
  });

  it("show deliveries and their attempts to administrators", async () => {
    const hook = (await t.createHook()).body;
    await t.materialize((await t.outbox()).filter((e) => e.webhooks));
    const [ping] = await t.deliveries();
    const id = (ping as { delivery_id: string }).delivery_id;
    await attemptDelivery(t.deps(), id);
    const listed = await json<{ deliveries: { id: string; state: string }[] }>(
      api("GET", `${t.path}/hooks/${hook.id}/deliveries`, t.owner.token),
    );
    expect(listed.body.deliveries).toEqual([expect.objectContaining({ id, state: "done" })]);
    const one = await json<{
      request: { payload: Record<string, unknown> };
      attempts_made: { n: number; status_code: number; response: string }[];
    }>(api("GET", `${t.path}/hooks/${hook.id}/deliveries/${id}`, t.owner.token));
    expect(one.body.request.payload).toMatchObject({ event: "ping", hook_id: hook.id });
    expect(one.body.attempts_made).toEqual([
      expect.objectContaining({ n: 1, status_code: 200, response: "ok" }),
    ]);
    expect(JSON.stringify(one.body)).not.toContain("whsec_");
  });
});
