import { env, exports } from "cloudflare:workers";
import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { createLogger, createMetrics } from "@fyrden/adapters-cloudflare/obs";
import { createFakeDataset } from "@fyrden/adapters-cloudflare/obs/testing";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listUserOrgsOperation, MEMBERSHIPS_SQL } from "../src/accounts/user-orgs.js";
import { ACCESS_TOKEN_TYPE, TOKEN_EXCHANGE } from "../src/oauth/exchange.js";
import type { OpContext } from "../src/ops/execute.js";
import { newId } from "../src/services.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { dpopKey } from "./helpers/dpop.js";
import { ORIGIN } from "./helpers/git-http.js";
import { callTool } from "./helpers/mcp.js";
import { call, code, form, REDIRECT, registered, testSession } from "./helpers/oauth.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";

type Listed = {
  login: string;
  id: string;
  repos_url: string;
  members_url: string;
  description: null;
  role: "admin" | "member";
};

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function newOrg(owner: Who) {
  const login = uniqueId("org").slice(0, 39);
  const made = await json<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  expect(made.status).toBe(201);
  return { login, id: made.body.id, stub: env.ORG.getByName(made.body.id) };
}
type Org = Awaited<ReturnType<typeof newOrg>>;

const join = async (org: Org, owner: Who, who: Who, role: "admin" | "member" = "member") =>
  expect(
    (await api("PUT", `/orgs/${org.login}/memberships/${who.handle}`, owner.token, { role }))
      .status,
  ).toBe(200);
const leave = async (org: Org, owner: Who, who: Who) =>
  expect(
    (await api("DELETE", `/orgs/${org.login}/memberships/${who.handle}`, owner.token)).status,
  ).toBe(200);

const list = (token: string, query = "") => api("GET", `/user/orgs${query}`, token);

async function roles(token: string, query = ""): Promise<[string, string][]> {
  const res = await list(token, query);
  expect(res.status).toBe(200);
  return (await res.json<Listed[]>()).map((o) => [o.login, o.role]);
}

const inOrder = (orgs: readonly Org[]) => [...orgs].sort((a, b) => (a.id < b.id ? -1 : 1));

const linksByRelation = (res: Response): Record<string, string> =>
  Object.fromEntries(
    (res.headers.get("Link") ?? "")
      .split(", ")
      .map((part) => /^<([^>]+)>; rel="([a-z]+)"$/.exec(part))
      .flatMap((m) => (m ? [[m[2], m[1]]] : [])),
  );

const recordOnly = (org: Pick<Org, "id">, who: Who) =>
  env.DIRECTORY.prepare("INSERT INTO memberships VALUES (?, ?, 'owner', 1)")
    .bind(org.id, who.principalId)
    .run();

describe("the caller's organizations", () => {
  it("are listed with the caller's role, in GitHub's shape", async () => {
    const owner = await user();
    const member = await user();
    const org = await newOrg(owner);
    await join(org, owner, member);
    const res = await list(owner.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Link")).toBeNull();
    expect(await res.json()).toEqual([
      {
        login: org.login,
        id: org.id,
        repos_url: `${ORIGIN}/api/orgs/${org.login}/repos`,
        members_url: `${ORIGIN}/api/orgs/${org.login}/members`,
        description: null,
        role: "admin",
      },
    ]);
    for (const url of ["repos", "members"])
      expect((await api("GET", `/orgs/${org.login}/${url}`, owner.token)).status).toBe(200);
    expect(await roles(member.token)).toEqual([[org.login, "member"]]);
  });

  it("are none for a user in none, an instance administrator too", async () => {
    await newOrg(await user());
    const nobody = await user();
    const other = await user(true);
    expect(await roles(nobody.token)).toEqual([]);
    expect(await roles(other.token)).toEqual([]);
  });

  it("follow the membership: joined, promoted, left", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    expect(await roles(bob.token)).toEqual([]);
    await join(org, owner, bob);
    expect(await roles(bob.token)).toEqual([[org.login, "member"]]);
    await join(org, owner, bob, "admin");
    expect(await roles(bob.token)).toEqual([[org.login, "admin"]]);
    await leave(org, owner, bob);
    expect(await roles(bob.token)).toEqual([]);
  });

  it("leave out a disabled organization", async () => {
    const owner = await user();
    const [kept, disabled] = [await newOrg(owner), await newOrg(owner)];
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(disabled.id)
      .run();
    expect(await roles(owner.token)).toEqual([[kept.login, "admin"]]);
  });

  it("name an organization as the directory does now", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const renamed = uniqueId("new").slice(0, 39);
    await env.DIRECTORY.prepare("UPDATE principals SET handle = ? WHERE id = ?")
      .bind(renamed, org.id)
      .run();
    expect(await roles(owner.token)).toEqual([[renamed, "admin"]]);
  });

  it("are refused to a suspended user", async () => {
    const owner = await user();
    await newOrg(owner);
    const unread = await scopedToken(owner.principalId, ["members:read"]);
    const suspended = await api("PUT", `/users/${owner.handle}/suspended`, admin.token, {});
    expect(suspended.status).toBeLessThan(300);
    expect((await list(unread)).status).toBe(401);
  });

  it("are the organization object's to confirm (items, links and role), whatever the record says", async () => {
    const owner = await user();
    const bob = await user();
    const mine = await newOrg(bob);
    const org = await newOrg(owner);
    await recordOnly(org, bob);
    const res = await list(bob.token, "?per_page=1");
    expect((await res.json<Listed[]>()).map((o) => o.login)).toEqual([mine.login]);
    expect(res.headers.get("Link")).toBeNull();
    await env.DIRECTORY.prepare("UPDATE memberships SET role = 'member' WHERE org_id = ?")
      .bind(mine.id)
      .run();
    expect(await roles(bob.token)).toEqual([[mine.login, "admin"]]);
  });
});

describe("a page of the caller's organizations", () => {
  let owner: Who;
  let orgs: Org[];

  beforeAll(async () => {
    owner = await user();
    const made: Org[] = [];
    for (let i = 0; i < 5; i++) made.push(await newOrg(owner));
    orgs = inOrder(made);
  });

  const logins = async (res: Response) => (await res.json<Listed[]>()).map((o) => o.login);

  it("is in the organizations' id order, with GitHub's links to the others", async () => {
    const url = (page: number) => `${ORIGIN}/api/user/orgs?per_page=2&page=${page}`;
    const first = await list(owner.token, "?per_page=2");
    expect(await logins(first)).toEqual([orgs[0]?.login, orgs[1]?.login]);
    expect(linksByRelation(first)).toEqual({ next: url(2), last: url(3) });
    const middle = await list(owner.token, "?per_page=2&page=2");
    expect(await logins(middle)).toEqual([orgs[2]?.login, orgs[3]?.login]);
    expect(linksByRelation(middle)).toEqual({
      prev: url(1),
      next: url(3),
      last: url(3),
      first: url(1),
    });
    const last = await list(owner.token, "?per_page=2&page=3");
    expect(await logins(last)).toEqual([orgs[4]?.login]);
    expect(linksByRelation(last)).toEqual({ prev: url(2), first: url(1) });
    const past = await list(owner.token, "?per_page=2&page=9");
    expect(await logins(past)).toEqual([]);
    expect(linksByRelation(past)).toEqual({ prev: url(3), first: url(1) });
  });

  it("is followed the same under /api/v3, as `gh` asks", async () => {
    const get = (url: string) =>
      exports.default.fetch(url, { headers: { Authorization: `token ${owner.token}` } });
    const seen: string[] = [];
    let next: string | undefined = `${ORIGIN}/api/v3/user/orgs?per_page=2`;
    for (let pages = 0; next !== undefined && pages < 5; pages++) {
      expect(next).toContain("/api/v3/user/orgs?");
      const res: Response = await get(next);
      seen.push(...(await logins(res)));
      next = linksByRelation(res).next;
    }
    expect(seen).toEqual(orgs.map((o) => o.login));
  });

  it("takes whole numbers from 1, and pages up to 1,000", async () => {
    for (const query of ["?per_page=0", "?page=0", "?page=1001", "?page=1.5", "?per_page=x"])
      expect((await list(owner.token, query)).status, query).toBe(422);
  });

  it("skips no organization that stays while one before it goes, but the one that moved up", async () => {
    const bob = await user();
    const joined: Org[] = [];
    for (const org of orgs.slice(0, 4)) {
      await join(org, owner, bob);
      joined.push(org);
    }
    expect(await logins(await list(bob.token, "?per_page=2"))).toEqual(
      joined.slice(0, 2).map((o) => o.login),
    );
    await leave(joined[0] as Org, owner, bob);
    expect(await logins(await list(bob.token, "?per_page=2&page=2"))).toEqual([joined[3]?.login]);
  });
});

describe("a listing of many organizations", () => {
  async function recorded(who: Who, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => newId("org")).sort();
    const rows = JSON.stringify(
      ids.map((id) => ({ id, handle: id.toLowerCase().replace("_", "-") })),
    );
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare(
        `INSERT INTO principals (id, type, handle, created_at)
         SELECT value ->> 'id', 'org', value ->> 'handle', 1 FROM json_each(?)`,
      ).bind(rows),
      env.DIRECTORY.prepare(
        `INSERT INTO memberships SELECT value ->> 'id', ?2, 'member', 1 FROM json_each(?1)`,
      ).bind(rows, who.principalId),
    ]);
    return ids;
  }

  function objects(held: ReadonlySet<string>) {
    const asked: string[] = [];
    vi.spyOn(env.ORG, "getByName").mockImplementation(
      (id: string) =>
        ({
          accountRole: async () => {
            asked.push(id);
            return held.has(id) ? "member" : null;
          },
        }) as unknown as ReturnType<typeof env.ORG.getByName>,
    );
    return asked;
  }

  const total = async (token: string) => {
    const res = await list(token, "?per_page=1");
    return Number(/[?&]page=(\d+)>; rel="last"/.exec(res.headers.get("Link") ?? "")?.[1]);
  };

  it("holds 30 unless asked", async () => {
    const who = await user();
    objects(new Set(await recorded(who, 31)));
    expect(await roles(who.token)).toHaveLength(30);
  });

  it("stops at the oldest 200, 100 a page at most", async () => {
    const who = await user();
    const ids = await recorded(who, 260);
    const asked = objects(new Set(ids));
    expect(await total(who.token)).toBe(200);
    expect(asked.length).toBe(250);
    const page = await list(who.token, "?per_page=1000&page=2");
    expect((await page.json<Listed[]>()).map((o) => o.id)).toEqual(ids.slice(100, 200));
    expect(linksByRelation(page).next).toBeUndefined();
  });

  it.each([51, 250])("gives no place to %i it does not confirm", async (wrong) => {
    const who = await user();
    const ids = await recorded(who, wrong + 200);
    objects(new Set(ids.slice(wrong)));
    expect(await total(who.token)).toBe(200);
    const page = await list(who.token, "?per_page=100&page=2");
    expect((await page.json<Listed[]>()).map((o) => o.id)).toEqual(ids.slice(wrong + 100));
  });

  it("asks 500 at most", async () => {
    const who = await user();
    const ids = await recorded(who, 510);
    const asked = objects(new Set());
    expect(await roles(who.token)).toEqual([]);
    expect(asked.sort()).toEqual(ids.slice(0, 500));
  });

  it("fails when one of them cannot be confirmed, rather than leave it out", async () => {
    const who = await user();
    const [first] = await recorded(who, 2);
    vi.spyOn(env.ORG, "getByName").mockImplementation(
      (id: string) =>
        ({
          accountRole: async () => {
            if (id === first) throw new Error("the object is away");
            return "member";
          },
        }) as unknown as ReturnType<typeof env.ORG.getByName>,
    );
    expect((await list(who.token)).status).toBe(500);
  });

  it("asks each once for the user's own agent", async () => {
    const who = await user();
    const ids = await recorded(who, 3);
    const agent = await agentFor(who, ["members:read"]);
    const asked = objects(new Set(ids));
    expect(await roles(agent.delegated)).toHaveLength(3);
    expect(asked.sort()).toEqual(ids);
  });
});

describe("a token that may not see every organization", () => {
  async function askedDuring(run: () => Promise<unknown>): Promise<string[]> {
    const asked: string[] = [];
    const real = env.ORG.getByName.bind(env.ORG);
    vi.spyOn(env.ORG, "getByName").mockImplementation((id: string) => {
      asked.push(id);
      return real(id);
    });
    await run();
    return asked;
  }

  it("needs members:read, by name or implied", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const refused = await list(await scopedToken(owner.principalId, ["metadata:read"]));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      code: "missing_permission",
      missing_permission: "members:read",
    });
    for (const scope of ["members:read", "members:write"])
      expect(await roles(await scopedToken(owner.principalId, [scope]))).toEqual([
        [org.login, "admin"],
      ]);
  });

  it("sees none when it is limited to repositories, an organization's own included", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const repo = await json<{ id: string }>(
      api("POST", `/orgs/${org.login}/repos`, owner.token, { name: uniqueId("r") }),
    );
    for (const ids of [[repo.body.id], []]) {
      const token = await scopedToken(owner.principalId, ["members:read"], "pat", ids);
      const asked = await askedDuring(async () => {
        const res = await list(token);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
        expect(res.headers.get("Link")).toBeNull();
      });
      expect(asked).toEqual([]);
    }
  });

  it("sees its user's, with their role, when it is delegated to the user's own agent", async () => {
    const owner = await user();
    const other = await user();
    const [mine, theirs] = [await newOrg(owner), await newOrg(other)];
    await join(theirs, other, owner);
    const agent = await agentFor(owner, ["members:read"]);
    expect(await roles(agent.delegated)).toEqual(
      inOrder([mine, theirs]).map((o) => [o.login, o === mine ? "admin" : "member"]),
    );
    const narrow = await agentFor(owner, ["metadata:read"]);
    expect((await list(narrow.delegated)).status).toBe(403);
    const limited = await agentFor(
      owner,
      ["members:read"],
      [
        `${mine.login}/${
          (
            await json<{ name: string }>(
              api("POST", `/orgs/${mine.login}/repos`, owner.token, { name: uniqueId("r") }),
            )
          ).body.name
        }`,
      ],
    );
    expect(await roles(limited.delegated)).toEqual([]);
  });

  async function delegatedTo(ownerId: string, grantor: Who): Promise<string> {
    const agent = await principalWithToken("agent", "pat", { owner: ownerId });
    const granted = await json<{ id: string }>(
      api("POST", "/grants", grantor.token, {
        agent: agent.principalId.toLowerCase().replace("_", "-"),
        scopes: ["members:read"],
      }),
    );
    expect(granted.status).toBe(201);
    return exchanged(agent.token, granted.body.id);
  }

  async function exchanged(agentToken: string, grantId: string): Promise<string> {
    const res = await form("/oauth/token", {
      grant_type: TOKEN_EXCHANGE,
      subject_token: agentToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      grant_id: grantId,
    });
    expect(res.status).toBe(200);
    return (await res.json<{ access_token: string }>()).access_token;
  }

  const contextFor = (who: Who, ceilingIds: string[]): OpContext => {
    const auth = {
      principalId: who.principalId,
      principalType: "agent",
      scopes: ["members:read"],
      repoIds: null,
      ceilingIds,
    } as unknown as TokenRecord;
    return {
      env,
      auth,
      authState: {} as OpContext["authState"],
      log: createLogger({}, () => {}),
      metrics: createMetrics(createFakeDataset().dataset),
      requestId: "req-orgs",
      requestHost: "fyrden.test",
      requestOrigin: ORIGIN,
      waitUntil: () => {},
    };
  };

  it("sees only the organization that owns its agent, when its user is a member of it", async () => {
    const owner = await user();
    const [bot, other] = [await newOrg(owner), await newOrg(owner)];
    const token = await delegatedTo(bot.id, owner);
    const asked = await askedDuring(async () =>
      expect(await roles(token)).toEqual([[bot.login, "admin"]]),
    );
    expect(asked).not.toContain(other.id);
    const stranger = await user();
    await newOrg(stranger);
    expect(await roles(await delegatedTo(bot.id, stranger))).toEqual([]);
    const member = await user();
    await join(bot, owner, member);
    expect(await roles(await delegatedTo(bot.id, member))).toEqual([[bot.login, "member"]]);
  });

  it("is held to every agent of its chain", async () => {
    const owner = await user();
    const [bots, other] = [await newOrg(owner), await newOrg(owner)];
    const chainOf = async (ownerId: string) => {
      const [first, second] = [
        await principalWithToken("agent", "pat", { owner: ownerId }),
        await principalWithToken("agent", "pat", { owner: ownerId }),
      ];
      const handle = (p: { principalId: string }) => p.principalId.toLowerCase().replace("_", "-");
      const scopes = ["members:read"];
      const parent = await json<{ id: string }>(
        api("POST", "/grants", owner.token, { agent: handle(first), scopes }),
      );
      const passed = await json<{ id: string }>(
        api("POST", "/grants", first.token, {
          agent: handle(second),
          scopes,
          parent: parent.body.id,
        }),
      );
      expect(passed.status).toBe(201);
      return exchanged(second.token, passed.body.id);
    };
    expect(await roles(await chainOf(owner.principalId))).toEqual(
      inOrder([bots, other]).map((o) => [o.login, "admin"]),
    );
    expect(await roles(await chainOf(bots.id))).toEqual([[bots.login, "admin"]]);
  });

  it("lists no organization its agent's owner is not, whatever other owners allow", async () => {
    const owner = await user();
    const [one, other] = [await newOrg(owner), await newOrg(owner)];
    const listed = async (ceilingIds: string[]) =>
      (await listUserOrgsOperation(contextFor(owner, ceilingIds), { page: 1, per_page: 30 })).items;
    expect(await listed([one.id, owner.principalId])).toMatchObject([{ login: one.login }]);
    expect(await listed([one.id, other.id])).toEqual([]);
  });

  it("does not list its agent's organization once that is disabled", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const read = () =>
      listUserOrgsOperation(contextFor(owner, [org.id]), { page: 1, per_page: 30 });
    expect((await read()).total).toBe(1);
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(org.id)
      .run();
    expect(await read()).toMatchObject({ items: [], total: 0 });
  });

  it("is refused when its agent is another user's, before anything is read", async () => {
    const owner = await user();
    const other = await user();
    const shared = await newOrg(owner);
    await join(shared, owner, other);
    const token = await delegatedTo(other.principalId, owner);
    const asked = await askedDuring(async () => {
      const res = await list(token);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "delegated_listing" });
    });
    expect(asked).toEqual([]);
  });

  it("sees none when it is an agent's own, its owner's organizations included", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    for (const ownerId of [owner.principalId, org.id]) {
      const agent = await principalWithToken("agent", "pat", { owner: ownerId });
      const asked = await askedDuring(async () => expect(await roles(agent.token)).toEqual([]));
      expect(asked).toEqual([]);
    }
  });

  it("is refused where it is git's, or a CI job's", async () => {
    const owner = await user();
    await newOrg(owner);
    const git = await json<{ token: string }>(api("POST", "/user/git-tokens", owner.token, {}));
    const refused = await list(git.body.token);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "missing_permission" });
    expect((await list(await scopedToken(owner.principalId, [], "job"))).status).toBe(401);
  });

  it("is judged by an OAuth client's scopes, and by its proof when bound to a key", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const session = await testSession(owner.principalId);
    const cookie = `__Host-fyrden_session=${session.cookie}`;
    const clientId = await registered();
    const exchange = async (scope: string, headers: Record<string, string> = {}) => {
      const { back, verifier } = await code(clientId, cookie, {
        resource: `${ORIGIN}/api`,
        scope,
      });
      const res = await form(
        "/oauth/token",
        {
          grant_type: "authorization_code",
          code: back.searchParams.get("code") ?? "",
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
        },
        headers,
      );
      expect(res.status).toBe(200);
      return (await res.json<{ access_token: string }>()).access_token;
    };
    expect(await roles(await exchange("members:read"))).toEqual([[org.login, "admin"]]);
    expect((await list(await exchange("metadata:read"))).status).toBe(403);

    const key = await dpopKey();
    const bound = await exchange("members:read", {
      DPoP: await key.proof("POST", `${ORIGIN}/oauth/token`),
    });
    expect((await list(bound)).status).toBe(401);
    const proven = await call("/api/user/orgs", {
      headers: {
        Authorization: `DPoP ${bound}`,
        DPoP: await key.proof("GET", `${ORIGIN}/api/user/orgs`, bound),
      },
    });
    expect(proven.status).toBe(200);
    expect((await proven.json<Listed[]>()).map((o) => o.login)).toEqual([org.login]);
  });

  it("is a web session's as its user's", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const session = await testSession(owner.principalId);
    const res = await call("/api/user/orgs", {
      headers: { Cookie: `__Host-fyrden_session=${session.cookie}`, "X-Fyrden-Session": "1" },
    });
    expect(res.status).toBe(200);
    expect((await res.json<Listed[]>()).map((o) => o.login)).toEqual([org.login]);
  });
});

describe("the MCP tool", () => {
  it("answers what REST does, a page at a time, and refuses what REST does", async () => {
    const owner = await user();
    const orgs = inOrder([await newOrg(owner), await newOrg(owner)]);
    const all = await callTool(owner.token, "list_orgs", {});
    expect(all.structured).toEqual(await (await list(owner.token)).json());
    const legacy = await exports.default.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_orgs", arguments: {} },
      }),
    });
    const answer = await legacy.text();
    expect(legacy.status, answer).toBe(200);
    expect(
      JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1)).result
        .structuredContent,
    ).toEqual({ result: all.structured });
    const second = await callTool(owner.token, "list_orgs", { per_page: 1, page: 2 });
    expect((second.structured as unknown as Listed[]).map((o) => o.login)).toEqual([
      orgs[1]?.login,
    ]);
    const agent = await agentFor(owner, ["members:read"], undefined, `${ORIGIN}/mcp`);
    const delegated = await callTool(agent.delegated, "list_orgs", {});
    expect(delegated.structured).toEqual(all.structured);
    const narrow = await callTool(
      await scopedToken(owner.principalId, ["metadata:read"]),
      "list_orgs",
      {},
    );
    expect(narrow.isError).toBe(true);
    expect(JSON.parse(narrow.text)).toMatchObject({ code: "missing_permission" });
  });
});

describe("the read of the directory's record", () => {
  it("goes through the principal's index, no other principal's rows", async () => {
    const { results } = await env.DIRECTORY.prepare(`EXPLAIN QUERY PLAN ${MEMBERSHIPS_SQL}`)
      .bind(newId("usr"), "", 250)
      .all<{ detail: string }>();
    const plan = results.map((r) => r.detail);
    expect(plan.some((d) => /SEARCH m USING INDEX memberships_principal/.test(d))).toBe(true);
    expect(plan.filter((d) => /^SCAN/.test(d))).toEqual([]);
  });

  it("reads as many rows however many organizations and members there are beside the user's", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    await join(org, owner, bob);
    const read = async () =>
      (await env.DIRECTORY.prepare(MEMBERSHIPS_SQL).bind(bob.principalId, "", 250).all()).meta
        .rows_read;
    const before = await read();
    for (let i = 0; i < 3; i++) await join(await newOrg(owner), owner, await user());
    const oneEntryPastTheRange = 1;
    expect((await read()) - before).toBeLessThanOrEqual(oneEntryPastTheRange);
  });
});
