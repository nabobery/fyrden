// Actions variables over REST, for repositories and organizations: GitHub's
// create (201, 409 when it exists), update (204) and delete, names and limits,
// and an organization's repository access; `gh variable set` relies on the 409.
import { env, exports } from "cloudflare:workers";
import { MAX_CI_VALUE_BYTES } from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { api, json, user, type Who } from "./helpers/api.js";
import { inAccount, newOrg, orgRepoOf, repoOf } from "./helpers/ci-secrets.js";
import { ORIGIN } from "./helpers/git-http.js";

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

type Listed = { total_count: number; variables: Record<string, unknown>[] };

async function userRepo() {
  const owner = await user();
  const repo = await repoOf(owner.principalId);
  return {
    owner,
    repo,
    path: `/repos/${owner.handle}/${repo.name}`,
    stub: env.ORG.getByName(owner.principalId),
  };
}

describe("repository variables", () => {
  it("are created (201, {}), read, updated (204) and deleted (204)", async () => {
    const { owner, path } = await userRepo();
    const created = await api("POST", `${path}/actions/variables`, owner.token, {
      name: "region",
      value: "eu-west-1",
    });
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("{}");
    expect(await json(api("GET", `${path}/actions/variables/REGION`, owner.token))).toMatchObject({
      status: 200,
      body: { name: "REGION", value: "eu-west-1", created_at: expect.any(String) },
    });
    expect(
      (
        await api("PATCH", `${path}/actions/variables/region`, owner.token, {
          name: "region",
          value: "us-east-2",
        })
      ).status,
    ).toBe(204);
    expect(await json(api("GET", `${path}/actions/variables/region`, owner.token))).toMatchObject({
      body: { value: "us-east-2" },
    });
    expect((await api("DELETE", `${path}/actions/variables/REGION`, owner.token)).status).toBe(204);
    expect(await json(api("GET", `${path}/actions/variables/REGION`, owner.token))).toMatchObject({
      status: 404,
      body: { code: "variable_not_found" },
    });
    expect(
      await json(api("PATCH", `${path}/actions/variables/REGION`, owner.token, { value: "x" })),
    ).toMatchObject({ status: 404, body: { code: "variable_not_found" } });
  });

  it("serve `gh variable set`: POST, 409 when it exists, then PATCH", async () => {
    const { owner, path } = await userRepo();
    const set = async (value: string) => {
      const posted = await api("POST", `${path}/actions/variables`, owner.token, {
        name: "MODE",
        value,
      });
      if (posted.status !== 409) return posted.status;
      expect(await posted.json()).toMatchObject({ code: "variable_exists" });
      return (
        await api("PATCH", `${path}/actions/variables/MODE`, owner.token, { name: "MODE", value })
      ).status;
    };
    expect(await set("one")).toBe(201);
    expect(await set("two")).toBe(204);
    expect(await json(api("GET", `${path}/actions/variables/MODE`, owner.token))).toMatchObject({
      body: { value: "two" },
    });
  });

  it("take POST and PATCH without an Idempotency-Key, as `gh variable set` sends them", async () => {
    const { owner, path } = await userRepo();
    const send = (method: string, sub: string, body: unknown) =>
      exports.default.fetch(`${ORIGIN}/api${path}/actions/variables${sub}`, {
        method,
        headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await send("POST", "", { name: "GH", value: "1" })).status).toBe(201);
    expect((await send("POST", "", { name: "GH", value: "2" })).status).toBe(409);
    expect((await send("PATCH", "/GH", { name: "GH", value: "2" })).status).toBe(204);
  });

  it("list by name, 30 a page at most", async () => {
    const { owner, path } = await userRepo();
    for (const name of ["B", "A", "C"])
      expect(
        (await api("POST", `${path}/actions/variables`, owner.token, { name, value: name })).status,
      ).toBe(201);
    const listed = await json<Listed>(api("GET", `${path}/actions/variables`, owner.token));
    expect(listed.body.total_count).toBe(3);
    expect(listed.body.variables.map((v) => v.name)).toEqual(["A", "B", "C"]);
    const page = await json<Listed>(
      api("GET", `${path}/actions/variables?per_page=2&page=2`, owner.token),
    );
    expect(page.body).toMatchObject({ total_count: 3, variables: [{ name: "C", value: "C" }] });
    // Past the most, a page is the most (GitHub's rule; `gh variable list` asks for 100).
    for (let i = 0; i < 30; i++)
      expect(
        (await api("POST", `${path}/actions/variables`, owner.token, { name: `X${i}`, value: "v" }))
          .status,
      ).toBe(201);
    const clamped = await json<Listed>(
      api("GET", `${path}/actions/variables?per_page=100`, owner.token),
    );
    expect(clamped.status).toBe(200);
    expect(clamped.body.variables).toHaveLength(30);
    expect((await api("GET", `${path}/actions/variables?per_page=0`, owner.token)).status).toBe(
      422,
    );
  });

  it("refuse a PATCH whose body names another variable than its path: no rename", async () => {
    const { owner, path } = await userRepo();
    expect(
      (await api("POST", `${path}/actions/variables`, owner.token, { name: "MODE", value: "a" }))
        .status,
    ).toBe(201);
    expect(
      await json(
        api("PATCH", `${path}/actions/variables/MODE`, owner.token, {
          name: "REGION",
          value: "b",
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "invalid_input" } });
    expect(await json(api("GET", `${path}/actions/variables/MODE`, owner.token))).toMatchObject({
      body: { value: "a" },
    });
    // Nor a name that is not a string.
    for (const name of [null, true, 1, ["MODE"], { name: "MODE" }])
      expect(
        await json(
          api("PATCH", `${path}/actions/variables/MODE`, owner.token, { name, value: "b" }),
        ),
        JSON.stringify(name),
      ).toMatchObject({ status: 422, body: { code: "invalid_input" } });
    expect(await json(api("GET", `${path}/actions/variables/MODE`, owner.token))).toMatchObject({
      body: { value: "a" },
    });
    // The same name in another case is the same variable.
    expect(
      (
        await api("PATCH", `${path}/actions/variables/MODE`, owner.token, {
          name: "mode",
          value: "c",
        })
      ).status,
    ).toBe(204);
  });

  it("refuse names GitHub refuses, a value past 48 KiB, and the 501st variable", async () => {
    const { owner, repo, path, stub } = await userRepo();
    for (const name of ["GITHUB_SHA", "1A", "a-b", ""])
      expect(
        await json(api("POST", `${path}/actions/variables`, owner.token, { name, value: "v" })),
        name,
      ).toMatchObject({ status: 422 });
    expect(
      await json(
        api("POST", `${path}/actions/variables`, owner.token, { name: "github_x", value: "v" }),
      ),
    ).toMatchObject({ body: { code: "invalid_variable_name" } });
    // GITEA_TOKEN is refused for secrets only.
    expect(
      (
        await api("POST", `${path}/actions/variables`, owner.token, {
          name: "GITEA_TOKEN",
          value: "v",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api("POST", `${path}/actions/variables`, owner.token, {
          name: "LARGEST",
          value: "x".repeat(MAX_CI_VALUE_BYTES),
        })
      ).status,
    ).toBe(201);
    expect(
      await json(
        api("POST", `${path}/actions/variables`, owner.token, {
          name: "TOO_LARGE",
          value: "é".repeat(MAX_CI_VALUE_BYTES / 2 + 1),
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "variable_too_large" } });
    expect(
      await json(
        api("PATCH", `${path}/actions/variables/LARGEST`, owner.token, {
          value: "x".repeat(MAX_CI_VALUE_BYTES + 1),
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "variable_too_large" } });
    await inAccount(stub, (sql) => {
      for (let i = 2; i < 500; i++)
        sql.exec(
          "INSERT INTO ci_variables (scope, name, value, created_at, updated_at) VALUES (?, ?, 'v', 0, 0)",
          repo.id,
          `V${i}`,
        );
    });
    expect(
      await json(
        api("POST", `${path}/actions/variables`, owner.token, { name: "EXTRA", value: "v" }),
      ),
    ).toMatchObject({ status: 422, body: { code: "too_many_variables" } });
  });

  it("are for administrators: a writer gets nothing", async () => {
    const { owner, path } = await userRepo();
    const writer = await user();
    expect(
      (
        await api("PUT", `${path}/collaborators/${writer.handle}`, owner.token, {
          permission: "push",
        })
      ).status,
    ).toBeLessThan(300);
    expect(await json(api("GET", `${path}/actions/variables`, writer.token))).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    expect(
      await json(api("POST", `${path}/actions/variables`, writer.token, { name: "X", value: "v" })),
    ).toMatchObject({ status: 404, body: { code: "repo_not_found" } });
  });

  it("record audit rows with the name and scope", async () => {
    const { owner, repo, path, stub } = await userRepo();
    expect(
      (await api("POST", `${path}/actions/variables`, owner.token, { name: "A", value: "1" }))
        .status,
    ).toBe(201);
    expect(
      (await api("PATCH", `${path}/actions/variables/A`, owner.token, { value: "2" })).status,
    ).toBe(204);
    expect((await api("DELETE", `${path}/actions/variables/A`, owner.token)).status).toBe(204);
    await stub.deliverAudit();
    const { results } = await env.DIRECTORY.prepare(
      "SELECT action, details FROM audit_log WHERE target_id = ? AND action LIKE 'ci.%' ORDER BY seq",
    )
      .bind(owner.principalId)
      .all<{ action: string; details: string }>();
    expect(results.map((r) => [r.action, JSON.parse(r.details)])).toEqual([
      ["ci.variable.create", { scope: repo.id, name: "A" }],
      ["ci.variable.update", { scope: repo.id, name: "A" }],
      ["ci.variable.delete", { scope: repo.id, name: "A" }],
    ]);
  });
});

describe("organization variables", () => {
  async function orgWithRepos() {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const pub = await orgRepoOf(owner, org.login, "public");
    const priv = await orgRepoOf(owner, org.login, "private");
    return { owner, org, pub, priv, path: `/orgs/${org.login}`, stub: env.ORG.getByName(org.id) };
  }

  const reaching = async (who: Who, login: string, repo: { name: string }) =>
    (
      await json<Listed>(
        api("GET", `/repos/${login}/${repo.name}/actions/organization-variables`, who.token),
      )
    ).body.variables.map((v) => [v.name, v.value]);

  it("reach every repository, private ones, or the selected ones, with their values", async () => {
    const { owner, org, pub, priv, path } = await orgWithRepos();
    const create = (name: string, visibility: string, ids?: string[]) =>
      api("POST", `${path}/actions/variables`, owner.token, {
        name,
        value: name.toLowerCase(),
        visibility,
        ...(ids && { selected_repository_ids: ids }),
      });
    expect((await create("TO_ALL", "all")).status).toBe(201);
    expect((await create("TO_PRIVATE", "private")).status).toBe(201);
    expect((await create("TO_SELECTED", "selected", [pub.id])).status).toBe(201);
    expect((await create("TO_ALL", "all")).status).toBe(409);
    expect(await reaching(owner, org.login, pub)).toEqual([
      ["TO_ALL", "to_all"],
      ["TO_SELECTED", "to_selected"],
    ]);
    expect(await reaching(owner, org.login, priv)).toEqual([
      ["TO_ALL", "to_all"],
      ["TO_PRIVATE", "to_private"],
    ]);
    const listed = await json<Listed>(api("GET", `${path}/actions/variables`, owner.token));
    expect(listed.body.variables.map((v) => [v.name, v.visibility])).toEqual([
      ["TO_ALL", "all"],
      ["TO_PRIVATE", "private"],
      ["TO_SELECTED", "selected"],
    ]);
    expect(
      await json(api("GET", `${path}/actions/variables/to_selected`, owner.token)),
    ).toMatchObject({
      body: {
        name: "TO_SELECTED",
        value: "to_selected",
        visibility: "selected",
        selected_repositories_url: expect.any(String),
      },
    });
  });

  it("change visibility by PATCH: to selected with a list, then to all (the list goes)", async () => {
    const { owner, org, pub, priv, path } = await orgWithRepos();
    expect(
      (
        await api("POST", `${path}/actions/variables`, owner.token, {
          name: "V",
          value: "v",
          visibility: "all",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api("PATCH", `${path}/actions/variables/V`, owner.token, {
          visibility: "selected",
          selected_repository_ids: [priv.id],
        })
      ).status,
    ).toBe(204);
    expect(await reaching(owner, org.login, pub)).toEqual([]);
    expect(
      (
        await json<{ repositories: { id: string }[] }>(
          api("GET", `${path}/actions/variables/V/repositories`, owner.token),
        )
      ).body.repositories.map((r) => r.id),
    ).toEqual([priv.id]);
    expect(
      (await api("PUT", `${path}/actions/variables/V/repositories/${pub.id}`, owner.token)).status,
    ).toBe(204);
    expect(await reaching(owner, org.login, pub)).toEqual([["V", "v"]]);
    expect(
      (await api("DELETE", `${path}/actions/variables/V/repositories/${pub.id}`, owner.token))
        .status,
    ).toBe(204);
    expect(
      (
        await api("PUT", `${path}/actions/variables/V/repositories`, owner.token, {
          selected_repository_ids: [pub.id],
        })
      ).status,
    ).toBe(204);
    expect(await reaching(owner, org.login, priv)).toEqual([]);
    expect(
      (await api("PATCH", `${path}/actions/variables/V`, owner.token, { visibility: "all" }))
        .status,
    ).toBe(204);
    expect(
      await json(api("GET", `${path}/actions/variables/V/repositories`, owner.token)),
    ).toMatchObject({
      status: 409,
      body: { code: "visibility_not_selected" },
    });
    expect(await reaching(owner, org.login, priv)).toEqual([["V", "v"]]);
  });

  it("replace a selected variable's list by a PATCH with the list alone; refuse one for another visibility", async () => {
    const { owner, org, pub, priv, path } = await orgWithRepos();
    const create = (name: string, visibility: string, ids?: string[]) =>
      api("POST", `${path}/actions/variables`, owner.token, {
        name,
        value: "v",
        visibility,
        ...(ids && { selected_repository_ids: ids }),
      });
    expect((await create("SEL", "selected", [priv.id])).status).toBe(201);
    expect(
      (
        await api("PATCH", `${path}/actions/variables/SEL`, owner.token, {
          selected_repository_ids: [pub.id],
        })
      ).status,
    ).toBe(204);
    expect(await reaching(owner, org.login, pub)).toEqual([["SEL", "v"]]);
    expect(await reaching(owner, org.login, priv)).toEqual([]);
    expect((await create("OPEN", "all")).status).toBe(201);
    expect(
      await json(
        api("PATCH", `${path}/actions/variables/OPEN`, owner.token, {
          value: "changed",
          selected_repository_ids: [pub.id],
        }),
      ),
    ).toMatchObject({ status: 409, body: { code: "visibility_not_selected" } });
    expect(await json(api("GET", `${path}/actions/variables/OPEN`, owner.token))).toMatchObject({
      body: { value: "v", visibility: "all" },
    });
  });

  it("refuse a repository that is not the organization's, and the 1,001st variable", async () => {
    const { owner, path, stub } = await orgWithRepos();
    const elsewhere = await repoOf(owner.principalId);
    expect(
      await json(
        api("POST", `${path}/actions/variables`, owner.token, {
          name: "V",
          value: "v",
          visibility: "selected",
          selected_repository_ids: [elsewhere.id],
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "unknown_repository" } });
    await inAccount(stub, (sql) => {
      for (let i = 0; i < 1_000; i++)
        sql.exec(
          "INSERT INTO ci_variables (scope, name, value, visibility, created_at, updated_at) VALUES ('org', ?, 'v', 'all', 0, 0)",
          `V${i}`,
        );
    });
    expect(
      await json(
        api("POST", `${path}/actions/variables`, owner.token, {
          name: "EXTRA",
          value: "v",
          visibility: "all",
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "too_many_variables" } });
  });

  it("are for owners: a member gets 403", async () => {
    const { owner, org, path } = await orgWithRepos();
    const member = await user();
    expect(
      (
        await api("PUT", `/orgs/${org.login}/memberships/${member.handle}`, owner.token, {
          role: "member",
        })
      ).status,
    ).toBe(200);
    expect(await json(api("GET", `${path}/actions/variables`, member.token))).toMatchObject({
      status: 403,
    });
    expect(
      await json(
        api("POST", `${path}/actions/variables`, member.token, {
          name: "X",
          value: "v",
          visibility: "all",
        }),
      ),
    ).toMatchObject({ status: 403 });
  });
});
