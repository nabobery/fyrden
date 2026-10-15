// The SDK against this API: a repository's life through typed calls.

import { env, exports } from "cloudflare:workers";
import {
  authorizationUrl,
  createDpopKey,
  createPkce,
  type DpopKey,
  exchangeCode,
  exchangeToken,
  FyrdenClient,
  FyrdenError,
  refreshToken,
} from "@fyrden/sdk";
import { uniqueId } from "@fyrden/testing";
import { describe, expect, inject, it } from "vitest";
import { user } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { REDIRECT, registered, signedIn } from "./helpers/oauth.js";
import { postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");

const client = (token: string) =>
  new FyrdenClient({
    baseUrl: `${ORIGIN}/api`,
    token,
    fetch: (url, init) => exports.default.fetch(new Request(url, init)),
  });

describe("the SDK", () => {
  it("creates, pushes with a git token, writes, browses, forks and deletes a repository", async () => {
    const me = await user();
    const api = client(me.token);
    const whoami = await api.call("meta.whoami", {});
    expect(whoami.id).toBe(me.principalId);
    const repo = await api.call("repos.create", { name: uniqueId("sdk") });
    // A git token, minted through the SDK, pushes the first commits.
    const admin = client((await user(true)).token);
    const git = await admin.call("admin.tokens.create", { user_id: me.principalId, type: "git" });
    const pushed = await postPush(
      {
        repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
        owner: { principalId: me.principalId, token: git.token },
        path: `/${repo.owner}/${repo.name}.git`,
      },
      pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 }),
    );
    expect(pushed.report).toContain("ok refs/heads/main\n");
    const commits: string[] = [];
    for await (const c of api.paginate("repos.commits.list", {
      owner: repo.owner,
      repo: repo.name,
      per_page: 1,
    }))
      commits.push(c.sha);
    expect(commits).toEqual([fx.c2, fx.c1]);
    const written = await api.call("repos.contents.put", {
      owner: repo.owner,
      repo: repo.name,
      path: "docs/hello world.md",
      message: "hello",
      content: btoa("hi"),
    });
    expect(written.commit.commit.verification.verified).toBe(true);
    const file = await api.call("repos.contents.get", {
      owner: repo.owner,
      repo: repo.name,
      path: "docs/hello world.md",
    });
    expect(file).toMatchObject({ type: "file", path: "docs/hello world.md" });
    const fork = await api.call("repos.fork", {
      owner: repo.owner,
      repo: repo.name,
      name: uniqueId("fork"),
    });
    const forks: string[] = [];
    for await (const f of api.paginate("repos.forks.list", {
      owner: repo.owner,
      repo: repo.name,
      per_page: 1,
    }))
      forks.push(f.name);
    expect(forks).toEqual([fork.name]);
    expect((await api.call("repos.delete", { owner: repo.owner, repo: repo.name })).state).toMatch(
      /deleting|deleted/,
    );
    const missing = await api
      .call("repos.get", { owner: repo.owner, repo: repo.name })
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(FyrdenError);
    expect(missing).toMatchObject({ status: 404, code: "repo_not_found" });
  });
});

describe("the SDK's OAuth and DPoP", () => {
  const fetcher: typeof fetch = (url, init) => exports.default.fetch(new Request(url, init));
  const resource = `${ORIGIN}/api`;

  /** The code flow as a client drives it with the SDK, up to its tokens, bound to `key`. */
  async function signIn(key: DpopKey, scope: string) {
    const clientId = await registered();
    const { cookie, userId } = await signedIn();
    const { verifier, challenge } = await createPkce();
    const url = authorizationUrl(ORIGIN, {
      clientId,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      resource,
      state: "s",
      scope,
      dpopJkt: key.jkt,
    });
    const consent = await fetcher(url, { headers: { Cookie: cookie }, redirect: "manual" });
    expect(consent.status).toBe(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1] ?? "";
    const answer = await fetcher(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Cookie: cookie,
        Origin: ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
    });
    const back = new URL(answer.headers.get("Location") ?? "");
    const tokens = await exchangeCode(
      ORIGIN,
      {
        clientId,
        code: back.searchParams.get("code") ?? "",
        codeVerifier: verifier,
        redirectUri: REDIRECT,
        resource,
      },
      { dpop: key, fetch: fetcher },
    );
    return { clientId, userId, tokens };
  }

  it("calls, pages and refreshes with DPoP-bound tokens, which are nothing without the key", async () => {
    const key = await createDpopKey();
    const { clientId, userId, tokens } = await signIn(key, "metadata:read repos:create");
    expect(tokens.token_type).toBe("DPoP");
    const bound = (token: string, dpop?: DpopKey) =>
      new FyrdenClient({ baseUrl: resource, token, fetch: fetcher, ...(dpop && { dpop }) });
    const api = bound(tokens.access_token, key);
    expect((await api.call("meta.whoami", {})).id).toBe(userId);
    for (let i = 0; i < 3; i++) await api.call("repos.create", { name: uniqueId("dpop") });
    let listed = 0;
    for await (const _ of api.paginate("repos.list", { per_page: 1 })) listed++;
    expect(listed).toBe(3);
    // As a Bearer token, or with another key's proofs, it is refused.
    await expect(bound(tokens.access_token).call("meta.whoami", {})).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      bound(tokens.access_token, await createDpopKey()).call("meta.whoami", {}),
    ).rejects.toMatchObject({ status: 401 });
    // A refresh keeps the binding.
    const next = await refreshToken(
      ORIGIN,
      { clientId, refreshToken: tokens.refresh_token ?? "" },
      { dpop: key, fetch: fetcher },
    );
    expect(next.token_type).toBe("DPoP");
    expect((await bound(next.access_token, key).call("meta.whoami", {})).id).toBe(userId);
  });

  it("exchanges an agent's token for one acting for a user, bound to its key", async () => {
    const owner = await user();
    const api = client(owner.token);
    const agent = await api.call("agents.create", { handle: uniqueId("sdk").slice(0, 39) });
    const own = await api.call("agents.tokens.create", { agent: agent.handle });
    const grant = await api.call("grants.create", {
      agent: agent.handle,
      scopes: ["metadata:read"],
      expires_in_days: 1,
    });
    const key = await createDpopKey();
    const exchanged = await exchangeToken(
      ORIGIN,
      { subjectToken: own.token, grantId: grant.id },
      { dpop: key, fetch: fetcher },
    );
    expect(exchanged.token_type).toBe("DPoP");
    const acting = new FyrdenClient({
      baseUrl: resource,
      token: exchanged.access_token,
      dpop: key,
      fetch: fetcher,
    });
    const me = await acting.call("meta.whoami", {});
    expect(me).toMatchObject({ id: owner.principalId, act: [{ id: agent.id }] });
    // An OAuth error is a typed error too.
    await expect(
      exchangeToken(ORIGIN, { subjectToken: own.token, grantId: "grt_nope" }, { fetch: fetcher }),
    ).rejects.toBeInstanceOf(FyrdenError);
  });
});
