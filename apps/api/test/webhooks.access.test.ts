// Who may manage a repository's webhooks and read their deliveries: a hook
// exports issue and pull request contents, so every hook operation needs,
// besides its hook permission, the content reads (`issues:read`,
// `pull_requests:read`) in the caller's own scopes.
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attemptDelivery } from "../src/webhooks/deliver.js";
import { api, json } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

// What the API queues for an attempt is kept here, not sent: the real queue's consumer would
// make the attempt whenever it ran.
beforeEach(() => {
  vi.spyOn(env.WEBHOOKS, "send").mockResolvedValue({} as QueueSendResponse);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A token of the repository's owner limited to `scopes`. */
async function tokenWith(scopes: string[]): Promise<string> {
  const made = await json<{ token: string }>(
    api("POST", "/user/tokens", t.owner.token, { type: "pat", scopes }),
  );
  expect(made.status).toBe(201);
  return made.body.token;
}

const HOOKS = ["repository_hooks:read", "repository_hooks:write"];
const CONTENT = ["issues:read", "pull_requests:read"];

/** Every hook operation, as the token `token` asks it. */
async function everyOperation(token: string, hook: number, delivery: string) {
  const at = `${t.path}/hooks`;
  const calls: [string, string, string, unknown?][] = [
    ["list", "GET", at],
    ["get", "GET", `${at}/${hook}`],
    ["create", "POST", at, { config: { url: "https://93.184.216.34/other" }, events: ["push"] }],
    ["update", "PATCH", `${at}/${hook}`, { active: true }],
    ["ping", "POST", `${at}/${hook}/pings`],
    ["rotate", "POST", `${at}/${hook}/secret`],
    ["drop", "DELETE", `${at}/${hook}/secret/previous`],
    ["deliveries", "GET", `${at}/${hook}/deliveries`],
    ["delivery", "GET", `${at}/${hook}/deliveries/${delivery}`],
    ["redeliver", "POST", `${at}/${hook}/deliveries/${delivery}/attempts`],
    ["delete", "DELETE", `${at}/${hook}`],
  ];
  const statuses: Record<string, number> = {};
  for (const [name, method, path, body] of calls)
    statuses[name] = (await api(method, path, token, body)).status;
  return statuses;
}

/** A hook and its ping's delivery, made (and refused by the receiver), so it can be redelivered. */
async function hookWithDelivery() {
  const hook = (await t.createHook()).body;
  await t.materialize((await t.outbox()).filter((e) => e.webhooks));
  const [ping] = await t.deliveries();
  const delivery = (ping as { delivery_id: string }).delivery_id;
  t.answer = () => new Response("no", { status: 400 });
  await attemptDelivery(t.deps(), delivery);
  return { hook: hook.id, delivery };
}

describe("managing webhooks and reading their deliveries", () => {
  it("is refused to a token with the hook permissions but not the content reads", async () => {
    const { hook, delivery } = await hookWithDelivery();
    for (const scopes of [HOOKS, [...HOOKS, "issues:read"], [...HOOKS, "pull_requests:read"]]) {
      const statuses = await everyOperation(await tokenWith(scopes), hook, delivery);
      expect(Object.values(statuses).every((status) => status === 403)).toBe(true);
    }
    // The hook is still there, untouched.
    expect((await api("GET", `${t.path}/hooks/${hook}`, t.owner.token)).status).toBe(200);
  });

  it("is allowed with the hook permissions and both content reads", async () => {
    const { hook, delivery } = await hookWithDelivery();
    const statuses = await everyOperation(await tokenWith([...HOOKS, ...CONTENT]), hook, delivery);
    expect(statuses).toEqual({
      list: 200,
      get: 200,
      create: 201,
      update: 200,
      ping: 200,
      rotate: 200,
      drop: 200,
      deliveries: 200,
      delivery: 200,
      redeliver: 202,
      delete: 200,
    });
  });

  it("is refused over MCP too", async () => {
    const { hook } = await hookWithDelivery();
    const token = await tokenWith(HOOKS);
    const answer = await exports.default
      .fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_webhook",
            arguments: { owner: t.owner.handle, repo: t.repo.name, hook_id: hook },
          },
        }),
      })
      .then((r) => r.text());
    expect(answer).toContain("forbidden");
  });
});
