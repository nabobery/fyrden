// Agents through public entry points: an agent of a user, its own token,
// and a token delegated to it under a grant (the RFC 8693 exchange).
import { exports } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { expect } from "vitest";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../../src/oauth/exchange.js";
import { api, json, type Who } from "./api.js";
import { ORIGIN } from "./git-http.js";

/** An agent of `owner`, its own token, and a delegated token under a grant of `scopes`. */
export async function agentFor(owner: Who, scopes: string[], repositories?: string[]) {
  const agent = await json<{ id: string; handle: string }>(
    api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39) }),
  );
  const own = await json<{ token: string }>(
    api("POST", `/agents/${agent.body.handle}/tokens`, owner.token, {}),
  );
  const granted = await json<{ id: string }>(
    api("POST", "/grants", owner.token, { agent: agent.body.handle, scopes, repositories }),
  );
  expect(granted.status).toBe(201);
  const res = await exports.default.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: TOKEN_EXCHANGE,
      subject_token: own.body.token,
      subject_token_type: ACCESS_TOKEN_TYPE,
      grant_id: granted.body.id,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return {
    id: agent.body.id,
    grantId: granted.body.id,
    own: own.body.token,
    delegated: (await res.json<{ access_token: string }>()).access_token,
  };
}
