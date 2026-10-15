// The settings pages' revocations: what the page says is what the API did.
// A refused call (rate limited, gone) shows the API's problem, never success.

import { describe, expect, it } from "vitest";
import { action as agentsAction } from "../app/routes/settings.agents.js";
import { action as tokensAction } from "../app/routes/settings.tokens.js";
import { fakeApi, formPost, json } from "./helpers/context.js";

const refused = () => json({ status: 429, code: "rate_limited", detail: "Slow down." }, 429);

const run = async (
  act: typeof agentsAction | typeof tokensAction,
  path: string,
  fields: Record<string, string>,
  answer: () => Response,
) => {
  const { context, calls } = fakeApi(answer);
  const args = { request: formPost(path, fields), context, params: {} };
  const result = await act(args as never);
  return { result, call: calls[0] };
};

describe("revoking on the settings pages", () => {
  it.each([
    ["disable-agent", { agent: "bot" }, "DELETE /api/agents/bot", "Agent disabled."],
    ["revoke-grant", { grant: "grt_1" }, "DELETE /api/grants/grt_1", "Grant revoked."],
  ])("%s says so only when the API did it", async (intent, fields, call, done) => {
    const ok = await run(agentsAction, "/settings/agents", { intent, ...fields }, () => json({}));
    expect(`${ok.call?.method} ${new URL(ok.call?.url ?? "").pathname}`).toBe(call);
    expect(ok.result).toEqual({ done });
    const no = await run(agentsAction, "/settings/agents", { intent, ...fields }, refused);
    expect(no.result).toEqual({ error: "Slow down." });
  });

  it("revokes a token only when the API did", async () => {
    const fields = { intent: "revoke", id: "tok_1" };
    const ok = await run(tokensAction, "/settings/tokens", fields, () =>
      json({ id: "tok_1", revoked: true }),
    );
    expect(ok.result).toEqual({ revoked: true });
    const no = await run(tokensAction, "/settings/tokens", fields, refused);
    expect(no.result).toEqual({ error: "Slow down." });
    const gone = await run(tokensAction, "/settings/tokens", fields, () => json(null, 404));
    expect(gone.result).toEqual({ error: "The token was not revoked." });
  });
});

describe("the settings pages' listings", () => {
  it("page agents and grants each on its own", async () => {
    const { loader } = await import("../app/routes/settings.agents.js");
    const { context, calls } = fakeApi((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/auth/session") return json({ user: { id: "usr_1", handle: "ada" } });
      if (path === "/api/agents") return json({ agents: [], next_cursor: "A2" });
      return json({ grants: [], next_cursor: null });
    });
    const request = new Request("https://fyrden.test/settings/agents?agents=A1&grants=G1", {
      headers: { Cookie: "fyrden_session=s" },
    });
    const data = await loader({ request, context, params: {} } as never);
    const asked = calls.map((c) => `${new URL(c.url).pathname}${new URL(c.url).search}`);
    expect(asked).toContain("/api/agents?per_page=100&cursor=A1");
    expect(asked).toContain("/api/grants?per_page=100&cursor=G1");
    expect(data).toMatchObject({
      agentPages: {
        next: "/settings/agents?agents=A2&grants=G1",
        first: "/settings/agents?grants=G1",
      },
      grantPages: { next: null, first: "/settings/agents?agents=A1" },
    });
  });

  it("page tokens", async () => {
    const { loader } = await import("../app/routes/settings.tokens.js");
    const { context, calls } = fakeApi((request) =>
      new URL(request.url).pathname === "/auth/session"
        ? json({ user: { id: "usr_1", handle: "ada" } })
        : json({ tokens: [], next_cursor: "T2" }),
    );
    const request = new Request("https://fyrden.test/settings/tokens", {
      headers: { Cookie: "fyrden_session=s" },
    });
    const data = await loader({ request, context, params: {} } as never);
    expect(calls.map((c) => new URL(c.url).search)).toContain("?per_page=100");
    expect(data).toMatchObject({ pages: { next: "/settings/tokens?cursor=T2", first: null } });
  });
});
