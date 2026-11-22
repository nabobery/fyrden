// Actions secrets over REST, for repositories and organizations: sealed by the
// client for the scope's public key, stored only as ciphertext, answered only
// as metadata, with GitHub's names, limits and organization access.
import { env, exports } from "cloudflare:workers";
import { MAX_CI_VALUE_BYTES } from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { ciSecretKeys, openSecretValue, unwrapDataKey } from "../src/ci/envelope.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  everyRow,
  inAccount,
  newOrg,
  orgRepoOf,
  putSecret,
  repoOf,
  sealFor,
  secretValue,
} from "./helpers/ci-secrets.js";
import { ORIGIN } from "./helpers/git-http.js";
import { logs } from "./setup/log-capture.js";

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

type Listed = { total_count: number; secrets: Record<string, unknown>[] };

/** A user's repository and its REST path. */
async function userRepo(visibility: "public" | "private" = "private") {
  const owner = await user();
  const repo = await repoOf(owner.principalId, visibility);
  return {
    owner,
    repo,
    path: `/repos/${owner.handle}/${repo.name}`,
    stub: env.ORG.getByName(owner.principalId),
  };
}

/** The value a stored secret opens to, read in its account object with the deployment's keys. */
async function storedValue(accountId: string, scope: string, name: string) {
  const stub = env.ORG.getByName(accountId);
  const row = await inAccount(stub, (sql) =>
    sql
      .exec<{
        generation: number;
        nonce: string;
        ciphertext: string;
        wrapped: string;
        key_nonce: string;
        master_key_id: string;
      }>(
        `SELECT s.generation, s.nonce, s.ciphertext, k.wrapped, k.nonce AS key_nonce, k.master_key_id
         FROM ci_secrets s JOIN ci_data_keys k USING (generation) WHERE s.scope = ? AND s.name = ?`,
        scope,
        name,
      )
      .one(),
  );
  const keys = await ciSecretKeys(env);
  const dataKey = await unwrapDataKey(
    keys,
    { accountId, generation: row.generation },
    { masterKeyId: row.master_key_id, nonce: row.key_nonce, wrapped: row.wrapped },
  );
  if (!dataKey) throw new Error("the data key does not open");
  return openSecretValue(dataKey, { accountId, scope, name, generation: row.generation }, row);
}

describe("repository secrets", () => {
  it("serve a public key, then take a sealed value: 201 created, 204 updated, stored only as ciphertext", async () => {
    const { owner, repo, path, stub } = await userRepo();
    const key = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    expect(key.status).toBe(200);
    expect(key.body.key_id).toMatch(/^1\.[0-9a-f]{16}$/);
    expect(atob(key.body.key)).toHaveLength(32);
    const first = secretValue();
    const created = await putSecret(owner, path, "deploy_key", first);
    expect(created.status).toBe(201);
    expect(await created.text()).toBe("");
    const second = secretValue();
    const updated = await putSecret(owner, path, "DEPLOY_KEY", second);
    expect(updated.status).toBe(204);
    expect(await storedValue(owner.principalId, repo.id, "DEPLOY_KEY")).toBe(second);
    const rows = await everyRow(stub);
    expect(rows).toContain("DEPLOY_KEY");
    expect(rows).not.toContain(first);
    expect(rows).not.toContain(second);
    expect(logs.lines.join("\n")).not.toContain(second);
  });

  it("answer a replayed PUT with its first status, and change nothing", async () => {
    const { owner, path } = await userRepo();
    const key = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    const body = JSON.stringify({
      encrypted_value: await sealFor(key.body.key, secretValue()),
      key_id: key.body.key_id,
    });
    const send = (idempotencyKey: string) =>
      exports.default.fetch(`${ORIGIN}/api${path}/actions/secrets/REPLAYED`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${owner.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body,
      });
    const k1 = crypto.randomUUID();
    expect((await send(k1)).status).toBe(201);
    expect((await send(k1)).status).toBe(201);
    const k2 = crypto.randomUUID();
    expect((await send(k2)).status).toBe(204);
    expect((await send(k2)).status).toBe(204);
  });

  it("take a PUT without an Idempotency-Key, as `gh secret set` sends it", async () => {
    const { owner, path } = await userRepo();
    const key = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    const put = async () =>
      exports.default.fetch(`${ORIGIN}/api${path}/actions/secrets/NO_KEY`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          encrypted_value: await sealFor(key.body.key, secretValue()),
          key_id: key.body.key_id,
        }),
      });
    expect((await put()).status).toBe(201);
    expect((await put()).status).toBe(204);
  });

  it("list and get names and times only, never a value", async () => {
    const { owner, path } = await userRepo();
    const value = secretValue();
    expect((await putSecret(owner, path, "B_TOKEN", value)).status).toBe(201);
    expect((await putSecret(owner, path, "A_TOKEN", secretValue())).status).toBe(201);
    const listed = await json<Listed>(api("GET", `${path}/actions/secrets`, owner.token));
    expect(listed.status).toBe(200);
    expect(listed.body.total_count).toBe(2);
    expect(listed.body.secrets.map((s) => s.name)).toEqual(["A_TOKEN", "B_TOKEN"]);
    for (const s of listed.body.secrets)
      expect(Object.keys(s).sort()).toEqual(["created_at", "name", "updated_at"]);
    const one = await json(api("GET", `${path}/actions/secrets/b_token`, owner.token));
    expect(one).toMatchObject({ status: 200, body: { name: "B_TOKEN" } });
    expect(JSON.stringify([listed.body, one.body])).not.toContain(value);
    const page = await json<Listed>(
      api("GET", `${path}/actions/secrets?per_page=1&page=2`, owner.token),
    );
    expect(page.body).toMatchObject({ total_count: 2, secrets: [{ name: "B_TOKEN" }] });
    // Past 100, a page is 100, as on GitHub.
    expect(
      await json(api("GET", `${path}/actions/secrets?per_page=101`, owner.token)),
    ).toMatchObject({ status: 200, body: { total_count: 2 } });
    expect((await api("GET", `${path}/actions/secrets?per_page=0`, owner.token)).status).toBe(422);
  });

  it("delete a secret: 204, then 404", async () => {
    const { owner, path } = await userRepo();
    expect((await putSecret(owner, path, "GONE", secretValue())).status).toBe(201);
    expect((await api("DELETE", `${path}/actions/secrets/GONE`, owner.token)).status).toBe(204);
    expect(await json(api("DELETE", `${path}/actions/secrets/GONE`, owner.token))).toMatchObject({
      status: 404,
      body: { code: "secret_not_found" },
    });
    expect(await json(api("GET", `${path}/actions/secrets/GONE`, owner.token))).toMatchObject({
      status: 404,
      body: { code: "secret_not_found" },
    });
  });

  it("keep a value's leading byte order mark, and take any UTF-8", async () => {
    const { owner, repo, path } = await userRepo();
    const value = `﻿${secretValue()} é 😀\n`;
    expect((await putSecret(owner, path, "BOM", value)).status).toBe(201);
    expect(await storedValue(owner.principalId, repo.id, "BOM")).toBe(value);
  });

  it("take a value of 48 KiB, and refuse one byte more", async () => {
    const { owner, path } = await userRepo();
    const at = "x".repeat(MAX_CI_VALUE_BYTES);
    expect(MAX_CI_VALUE_BYTES).toBe(49_152);
    expect((await putSecret(owner, path, "LARGEST", at)).status).toBe(201);
    expect(await json(putSecret(owner, path, "TOO_LARGE", `${at}x`))).toMatchObject({
      status: 422,
      body: { code: "secret_too_large" },
    });
    // Counted in bytes: two-byte characters make half as many.
    expect(
      await json(putSecret(owner, path, "TOO_LARGE", "é".repeat(MAX_CI_VALUE_BYTES / 2 + 1))),
    ).toMatchObject({ status: 422, body: { code: "secret_too_large" } });
  });

  it("refuse what does not open: another repository's key, garbage, altered boxes, invalid UTF-8", async () => {
    const { owner, path } = await userRepo();
    const other = await repoOf(owner.principalId);
    const otherPath = `/repos/${owner.handle}/${other.name}`;
    const otherKey = await json<{ key_id: string; key: string }>(
      api("GET", `${otherPath}/actions/secrets/public-key`, owner.token),
    );
    const ownKey = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    expect(otherKey.body.key_id).not.toBe(ownKey.body.key_id);
    const put = (body: Record<string, unknown>) =>
      json(api("PUT", `${path}/actions/secrets/REFUSED`, owner.token, body));
    // Sealed for the other repository, with its key id or with this one's.
    const forOther = await sealFor(otherKey.body.key, secretValue());
    expect(await put({ encrypted_value: forOther, key_id: otherKey.body.key_id })).toMatchObject({
      status: 422,
      body: { code: "bad_key_id" },
    });
    expect(await put({ encrypted_value: forOther, key_id: ownKey.body.key_id })).toMatchObject({
      status: 422,
      body: { code: "undecryptable_value" },
    });
    for (const keyId of ["", "1", "2.0000000000000000", "x.y", `9${ownKey.body.key_id}`])
      expect(await put({ encrypted_value: forOther, key_id: keyId }), keyId).toMatchObject({
        status: 422,
        body: { code: "bad_key_id" },
      });
    for (const encrypted of ["", "not base64!", btoa("short")])
      expect(await put({ encrypted_value: encrypted, key_id: ownKey.body.key_id })).toMatchObject({
        status: 422,
        body: { code: "undecryptable_value" },
      });
    const invalidUtf8 = await sealFor(ownKey.body.key, Uint8Array.of(0x61, 0xff, 0xfe));
    expect(await put({ encrypted_value: invalidUtf8, key_id: ownKey.body.key_id })).toMatchObject({
      status: 422,
      body: { code: "undecryptable_value" },
    });
    expect(await json(api("GET", `${path}/actions/secrets`, owner.token))).toMatchObject({
      body: { total_count: 0 },
    });
  });

  it("refuse names GitHub refuses, and GITEA_TOKEN", async () => {
    const { owner, path } = await userRepo();
    for (const name of ["GITHUB_TOKEN", "github_x", "1KEY", "a-b", "gitea_token"])
      expect(await json(putSecret(owner, path, name, secretValue())), name).toMatchObject({
        status: 422,
        body: { code: "invalid_secret_name" },
      });
  });

  it("refuse the 101st secret of a repository", async () => {
    const { owner, repo, path, stub } = await userRepo();
    expect((await putSecret(owner, path, "FIRST", secretValue())).status).toBe(201);
    await inAccount(stub, (sql) => {
      for (let i = 1; i < 100; i++)
        sql.exec(
          `INSERT INTO ci_secrets (scope, name, generation, nonce, ciphertext, created_at, updated_at)
           SELECT scope, ?, generation, nonce, ciphertext, created_at, updated_at FROM ci_secrets
           WHERE scope = ? AND name = 'FIRST'`,
          `S${i}`,
          repo.id,
        );
    });
    expect(await json(putSecret(owner, path, "EXTRA", secretValue()))).toMatchObject({
      status: 422,
      body: { code: "too_many_secrets" },
    });
    // Updating one of the hundred is not adding one.
    expect((await putSecret(owner, path, "FIRST", secretValue())).status).toBe(204);
  });

  it("serve the public key at its own path, not as a secret named public-key", async () => {
    const { owner, path } = await userRepo();
    expect(await json(api("GET", `${path}/actions/secrets/public-key`, owner.token))).toMatchObject(
      {
        status: 200,
        body: { key_id: expect.any(String) },
      },
    );
  });

  it("are for administrators: a writer gets nothing", async () => {
    const { owner, path } = await userRepo();
    const writer = await user();
    const added = await api("PUT", `${path}/collaborators/${writer.handle}`, owner.token, {
      permission: "push",
    });
    expect(added.status).toBeLessThan(300);
    expect(await json(api("GET", `${path}/actions/secrets`, writer.token))).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    expect(
      await json(
        api("PUT", `${path}/actions/secrets/X`, writer.token, {
          encrypted_value: "",
          key_id: "1.0",
        }),
      ),
    ).toMatchObject({ status: 404, body: { code: "repo_not_found" } });
  });

  it("record audit rows with the name and scope, never the value or the sealed value", async () => {
    const { owner, repo, path, stub } = await userRepo();
    const value = secretValue();
    const key = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    const sealed = await sealFor(key.body.key, value);
    const res = await api("PUT", `${path}/actions/secrets/AUDITED`, owner.token, {
      encrypted_value: sealed,
      key_id: key.body.key_id,
    });
    expect(res.status).toBe(201);
    expect((await api("DELETE", `${path}/actions/secrets/AUDITED`, owner.token)).status).toBe(204);
    await stub.deliverAudit();
    const { results } = await env.DIRECTORY.prepare(
      "SELECT action, details FROM audit_log WHERE target_id = ? AND action LIKE 'ci.%' ORDER BY seq",
    )
      .bind(owner.principalId)
      .all<{ action: string; details: string }>();
    expect(results.map((r) => r.action)).toEqual([
      "ci.data_key.create",
      "ci.secret.create",
      "ci.secret.delete",
    ]);
    expect(JSON.parse(results[1]?.details ?? "{}")).toMatchObject({
      scope: repo.id,
      name: "AUDITED",
    });
    const text = JSON.stringify(results) + (await everyRow(stub));
    expect(text).not.toContain(value);
    expect(text).not.toContain(sealed);
  });
});

describe("organization secrets", () => {
  async function orgWithRepos() {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const pub = await orgRepoOf(owner, org.login, "public");
    const priv = await orgRepoOf(owner, org.login, "private");
    const internal = await orgRepoOf(owner, org.login, "internal");
    return {
      owner,
      org,
      pub,
      priv,
      internal,
      path: `/orgs/${org.login}`,
      stub: env.ORG.getByName(org.id),
    };
  }

  const reaching = async (who: Who, login: string, repo: { name: string }) =>
    (
      await json<Listed>(
        api("GET", `/repos/${login}/${repo.name}/actions/organization-secrets`, who.token),
      )
    ).body.secrets.map((s) => s.name);

  it("reach every repository, private ones, or the selected ones", async () => {
    const { owner, org, pub, priv, internal, path } = await orgWithRepos();
    expect(
      (await putSecret(owner, path, "TO_ALL", secretValue(), { visibility: "all" })).status,
    ).toBe(201);
    expect(
      (await putSecret(owner, path, "TO_PRIVATE", secretValue(), { visibility: "private" })).status,
    ).toBe(201);
    expect(
      (
        await putSecret(owner, path, "TO_SELECTED", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [pub.id],
        })
      ).status,
    ).toBe(201);
    expect(await reaching(owner, org.login, pub)).toEqual(["TO_ALL", "TO_SELECTED"]);
    expect(await reaching(owner, org.login, priv)).toEqual(["TO_ALL", "TO_PRIVATE"]);
    expect(await reaching(owner, org.login, internal)).toEqual(["TO_ALL", "TO_PRIVATE"]);
    const listed = await json<Listed>(api("GET", `${path}/actions/secrets`, owner.token));
    expect(listed.body.secrets).toEqual([
      expect.objectContaining({ name: "TO_ALL", visibility: "all" }),
      expect.objectContaining({ name: "TO_PRIVATE", visibility: "private" }),
      expect.objectContaining({
        name: "TO_SELECTED",
        visibility: "selected",
        selected_repositories_url: `${ORIGIN}/api/orgs/${org.login}/actions/secrets/TO_SELECTED/repositories`,
      }),
    ]);
    expect(listed.body.secrets[0]).not.toHaveProperty("selected_repositories_url");
  });

  it("list, set, add and remove a selected secret's repositories", async () => {
    const { owner, org, pub, priv, path } = await orgWithRepos();
    expect(
      (
        await putSecret(owner, path, "SEL", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [],
        })
      ).status,
    ).toBe(201);
    const repos = async () =>
      (
        await json<{ total_count: number; repositories: { id: string; full_name: string }[] }>(
          api("GET", `${path}/actions/secrets/SEL/repositories`, owner.token),
        )
      ).body;
    expect(await repos()).toEqual({ total_count: 0, repositories: [] });
    expect(
      (
        await api("PUT", `${path}/actions/secrets/SEL/repositories`, owner.token, {
          selected_repository_ids: [pub.id],
        })
      ).status,
    ).toBe(204);
    expect(
      (await api("PUT", `${path}/actions/secrets/SEL/repositories/${priv.id}`, owner.token)).status,
    ).toBe(204);
    expect((await repos()).repositories.map((r) => r.id).sort()).toEqual([pub.id, priv.id].sort());
    expect((await repos()).repositories.find((r) => r.id === pub.id)?.full_name).toBe(
      `${org.login}/${pub.name}`,
    );
    expect(
      (await api("DELETE", `${path}/actions/secrets/SEL/repositories/${pub.id}`, owner.token))
        .status,
    ).toBe(204);
    expect((await repos()).repositories.map((r) => r.id)).toEqual([priv.id]);
    // A secret put again with selected and no list keeps its list.
    expect(
      (await putSecret(owner, path, "SEL", secretValue(), { visibility: "selected" })).status,
    ).toBe(204);
    expect((await repos()).repositories.map((r) => r.id)).toEqual([priv.id]);
  });

  it("page a selected secret's repositories", async () => {
    const { owner, pub, priv, internal, path } = await orgWithRepos();
    const ids = [pub.id, priv.id, internal.id].sort();
    expect(
      (
        await putSecret(owner, path, "SEL", secretValue(), {
          visibility: "selected",
          selected_repository_ids: ids,
        })
      ).status,
    ).toBe(201);
    const page = await json<{ total_count: number; repositories: { id: string }[] }>(
      api("GET", `${path}/actions/secrets/SEL/repositories?per_page=2&page=2`, owner.token),
    );
    expect(page.body).toEqual({
      total_count: 3,
      repositories: [expect.objectContaining({ id: ids[2] })],
    });
  });

  it("list no repository of a selection that the directory names as another owner's", async () => {
    const { owner, pub, priv, path } = await orgWithRepos();
    expect(
      (
        await putSecret(owner, path, "SEL", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [pub.id, priv.id],
        })
      ).status,
    ).toBe(201);
    // A transfer has moved it in the directory; the organization has not let it go yet.
    const elsewhere = await user();
    await env.DIRECTORY.prepare("UPDATE repos SET owner_id = ?, name = ? WHERE id = ?")
      .bind(elsewhere.principalId, "new-private-name", priv.id)
      .run();
    const listed = await json<{
      total_count: number;
      repositories: { id: string; full_name: string }[];
    }>(api("GET", `${path}/actions/secrets/SEL/repositories`, owner.token));
    expect(listed.body.total_count).toBe(1);
    expect(listed.body.repositories.map((r) => r.id)).toEqual([pub.id]);
    expect(JSON.stringify(listed.body)).not.toContain("new-private-name");
  });

  it("list 1,000 repositories at most: one more added alone is refused", async () => {
    const { owner, pub, priv, path, stub } = await orgWithRepos();
    expect(
      (
        await putSecret(owner, path, "SEL", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [pub.id],
        })
      ).status,
    ).toBe(201);
    await inAccount(stub, (sql) => {
      for (let i = 1; i < 1_000; i++)
        sql.exec("INSERT INTO ci_secret_repos (name, repo_id) VALUES ('SEL', ?)", `rep_fill${i}`);
    });
    expect(
      await json(api("PUT", `${path}/actions/secrets/SEL/repositories/${priv.id}`, owner.token)),
    ).toMatchObject({ status: 422, body: { code: "too_many_repositories" } });
    // One already listed is no addition.
    expect(
      (await api("PUT", `${path}/actions/secrets/SEL/repositories/${pub.id}`, owner.token)).status,
    ).toBe(204);
  });

  it("answer 409 for the repositories of a secret not of visibility selected", async () => {
    const { owner, pub, path } = await orgWithRepos();
    expect(
      (await putSecret(owner, path, "OPEN", secretValue(), { visibility: "all" })).status,
    ).toBe(201);
    for (const [method, sub, body] of [
      ["GET", "repositories", undefined],
      ["PUT", "repositories", { selected_repository_ids: [pub.id] }],
      ["PUT", `repositories/${pub.id}`, undefined],
      ["DELETE", `repositories/${pub.id}`, undefined],
    ] as const)
      expect(
        await json(api(method, `${path}/actions/secrets/OPEN/${sub}`, owner.token, body)),
        `${method} ${sub}`,
      ).toMatchObject({ status: 409, body: { code: "visibility_not_selected" } });
  });

  it("refuse a repository that is not the organization's", async () => {
    const { owner, path } = await orgWithRepos();
    const elsewhere = await repoOf(owner.principalId);
    expect(
      await json(
        putSecret(owner, path, "SEL", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [elsewhere.id],
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "unknown_repository" } });
    expect(
      (await putSecret(owner, path, "SEL", secretValue(), { visibility: "selected" })).status,
    ).toBe(201);
    for (const id of [elsewhere.id, "rep_missing"])
      expect(
        await json(api("PUT", `${path}/actions/secrets/SEL/repositories/${id}`, owner.token)),
      ).toMatchObject({ status: 422, body: { code: "unknown_repository" } });
  });

  it("keep a key per scope: the organization's opens only its own", async () => {
    const { owner, org, priv, path } = await orgWithRepos();
    const orgKey = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    const repoPath = `/repos/${org.login}/${priv.name}`;
    const res = await json(
      api("PUT", `${repoPath}/actions/secrets/X`, owner.token, {
        encrypted_value: await sealFor(orgKey.body.key, secretValue()),
        key_id: orgKey.body.key_id,
      }),
    );
    expect(res).toMatchObject({ status: 422, body: { code: "bad_key_id" } });
  });

  it("are for owners: a member gets 403", async () => {
    const { owner, path, org } = await orgWithRepos();
    const member = await user();
    expect(
      (
        await api("PUT", `/orgs/${org.login}/memberships/${member.handle}`, owner.token, {
          role: "member",
        })
      ).status,
    ).toBe(200);
    expect(await json(api("GET", `${path}/actions/secrets`, member.token))).toMatchObject({
      status: 403,
    });
    expect(
      await json(api("GET", `${path}/actions/secrets/public-key`, member.token)),
    ).toMatchObject({
      status: 403,
    });
  });

  it("are not a user's: its handle answers 404 not_an_org", async () => {
    const someone = await user();
    for (const [method, sub] of [
      ["GET", "secrets"],
      ["GET", "secrets/public-key"],
      ["GET", "secrets/X"],
      ["PUT", "secrets/X"],
      ["DELETE", "secrets/X"],
      ["GET", "secrets/X/repositories"],
      ["GET", "variables"],
      ["POST", "variables"],
    ] as const) {
      const body =
        method === "PUT"
          ? { encrypted_value: "", key_id: "1.0", visibility: "all" }
          : method === "POST"
            ? { name: "X", value: "v", visibility: "all" }
            : undefined;
      expect(
        await json(api(method, `/orgs/${someone.handle}/actions/${sub}`, someone.token, body)),
        `${method} ${sub}`,
      ).toMatchObject({ status: 404, body: { code: "not_an_org" } });
    }
  });

  it("leave a user's repositories none", async () => {
    const owner = await user();
    const repo = await repoOf(owner.principalId);
    expect(
      await json(
        api("GET", `/repos/${owner.handle}/${repo.name}/actions/organization-secrets`, owner.token),
      ),
    ).toMatchObject({ status: 200, body: { total_count: 0, secrets: [] } });
  });

  it("refuse the 1,001st secret of an organization", async () => {
    const { owner, path, stub } = await orgWithRepos();
    expect(
      (await putSecret(owner, path, "FIRST", secretValue(), { visibility: "all" })).status,
    ).toBe(201);
    await inAccount(stub, (sql) => {
      for (let i = 1; i < 1_000; i++)
        sql.exec(
          `INSERT INTO ci_secrets (scope, name, generation, nonce, ciphertext, visibility, created_at, updated_at)
           SELECT scope, ?, generation, nonce, ciphertext, visibility, created_at, updated_at FROM ci_secrets
           WHERE scope = 'org' AND name = 'FIRST'`,
          `S${i}`,
        );
    });
    expect(
      await json(putSecret(owner, path, "EXTRA", secretValue(), { visibility: "all" })),
    ).toMatchObject({
      status: 422,
      body: { code: "too_many_secrets" },
    });
  });
});
