// Replacing one account's CI data key: a new generation, every older one
// retired and its wrapped key erased, so the old secrets are listed unreadable
// and never delivered until set again; variables untouched; a retry answers
// the same.
import { env, exports } from "cloudflare:workers";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ciSecretKeys } from "../src/ci/envelope.js";
import { accountHooks, type OrgDO } from "../src/do/OrgDO.js";
import { readSecrets } from "../src/do/run/secrets.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  inAccount,
  newOrg,
  orgRepoOf,
  putSecret,
  repoOf,
  sealFor,
  secretValue,
} from "./helpers/ci-secrets.js";
import { ORIGIN } from "./helpers/git-http.js";

const K1 = (env as { CI_SECRETS_KEY?: string }).CI_SECRETS_KEY as string;
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const K3 = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
const metrics = { count() {} } as unknown as Metrics;

type KeyVars = { CI_SECRETS_KEY?: string; CI_SECRETS_KEYS_RETIRED?: string };

function setKeys(stub: DurableObjectStub<OrgDO>, vars: KeyVars) {
  return inAccount(stub, (_, instance) => {
    const e = (instance as unknown as { env: Record<string, unknown> }).env;
    for (const name of ["CI_SECRETS_KEY", "CI_SECRETS_KEYS_RETIRED"] as const) {
      if (vars[name] === undefined) delete e[name];
      else e[name] = vars[name];
    }
  });
}

const dataKeys = (stub: DurableObjectStub<OrgDO>) =>
  inAccount(stub, (sql) =>
    sql
      .exec<{
        generation: number;
        wrapped: string;
        nonce: string;
        replaced_at: number | null;
        replaced_by: number | null;
      }>(
        "SELECT generation, wrapped, nonce, replaced_at, replaced_by FROM ci_data_keys ORDER BY generation",
      )
      .toArray(),
  );

const replaceAudits = async (accountId: string) =>
  (
    await env.DIRECTORY.prepare(
      "SELECT actor_id, details FROM audit_log WHERE target_id = ? AND action = 'ci.data_key.replace' ORDER BY seq",
    )
      .bind(accountId)
      .all<{ actor_id: string; details: string }>()
  ).results.map((r) => [r.actor_id, JSON.parse(r.details)]);

type Status = {
  account_id: string;
  generation: number | null;
  created_at: string | null;
  secrets: number;
  unreadable_secrets: number;
  unreadable: { scope: string; name: string }[];
  unreadable_truncated: boolean;
};
type Replaced = {
  account_id: string;
  generation: number;
  replaced_generation: number;
  replaced_at: string;
};

const status = (who: Who, account: string) =>
  json<Status & { code?: string }>(api("GET", `/admin/accounts/${account}/ci/data-key`, who.token));
const replace = (who: Who, account: string, body: unknown, idempotencyKey?: string | null) =>
  json<Replaced & { code?: string; detail?: string }>(
    idempotencyKey === undefined
      ? api("POST", `/admin/accounts/${account}/ci/data-key/replace`, who.token, body)
      : fetchWithKey(
          `/admin/accounts/${account}/ci/data-key/replace`,
          who.token,
          body,
          idempotencyKey,
        ),
  );

function fetchWithKey(path: string, token: string, body: unknown, key: string | null) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(key !== null && { "Idempotency-Key": key }),
    },
    body: JSON.stringify(body),
  });
}

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

afterEach(() => {
  delete accountHooks.ciPrepared;
  delete accountHooks.ciRewrapPrepared;
  delete accountHooks.ciReplacePrepared;
  delete accountHooks.ciRewrapCounted;
});

/** A user with a repository holding secret `name`. */
async function userWithSecret(name = "OLD") {
  const owner = await user();
  const repo = await repoOf(owner.principalId);
  const path = `/repos/${owner.handle}/${repo.name}`;
  expect((await putSecret(owner, path, name, secretValue())).status).toBe(201);
  return { owner, repo, path, stub: env.ORG.getByName(owner.principalId) };
}

describe("replacing an account's CI data key", () => {
  it("retires the old generation: secrets unreadable and not delivered until set again, variables untouched", async () => {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login);
    const repoPath = `/repos/${org.login}/${repo.name}`;
    const orgPath = `/orgs/${org.login}`;
    expect(
      (await putSecret(owner, orgPath, "ORG_SECRET", secretValue(), { visibility: "all" })).status,
    ).toBe(201);
    expect((await putSecret(owner, repoPath, "REPO_SECRET", secretValue())).status).toBe(201);
    expect((await putSecret(owner, repoPath, "SET_AGAIN", secretValue())).status).toBe(201);
    expect(
      (
        await api("POST", `${orgPath}/actions/variables`, owner.token, {
          name: "PLAIN",
          value: "kept",
          visibility: "all",
        })
      ).status,
    ).toBe(201);
    const variablesBefore = await json(api("GET", `${orgPath}/actions/variables`, owner.token));
    const oldKey = await json<{ key_id: string; key: string }>(
      api("GET", `${repoPath}/actions/secrets/public-key`, owner.token),
    );

    const before = await status(admin, org.login);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      account_id: org.id,
      generation: 1,
      secrets: 3,
      unreadable_secrets: 0,
      unreadable: [],
      unreadable_truncated: false,
    });

    const done = await replace(admin, org.login, { account_id: org.id, generation: 1 });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ account_id: org.id, generation: 2, replaced_generation: 1 });

    const stub = env.ORG.getByName(org.id);
    const rows = await dataKeys(stub);
    expect(rows.map((r) => [r.generation, r.wrapped, r.nonce, r.replaced_by])).toEqual([
      [1, "", "", 2],
      [2, expect.any(String), expect.any(String), null],
    ]);
    expect(rows[1]?.wrapped).not.toBe("");

    // Listed unreadable everywhere; the status names them.
    const orgList = await json<{ secrets: Record<string, unknown>[] }>(
      api("GET", `${orgPath}/actions/secrets`, owner.token),
    );
    expect(orgList.body.secrets).toEqual([expect.objectContaining({ unreadable: true })]);
    const repoList = await json<{ secrets: Record<string, unknown>[] }>(
      api("GET", `${repoPath}/actions/secrets`, owner.token),
    );
    expect(repoList.body.secrets.every((s) => s.unreadable === true)).toBe(true);
    const after = await status(admin, org.login);
    expect(after.body).toMatchObject({
      generation: 2,
      secrets: 3,
      unreadable_secrets: 3,
      unreadable: [
        { scope: "org", name: "ORG_SECRET" },
        { scope: repo.id, name: "REPO_SECRET" },
        { scope: repo.id, name: "SET_AGAIN" },
      ],
      unreadable_truncated: false,
    });

    // The old public key is refused; the new one is generation 2.
    const stale = await json<{ code: string }>(
      api("PUT", `${repoPath}/actions/secrets/SET_AGAIN`, owner.token, {
        encrypted_value: await sealFor(oldKey.body.key, secretValue()),
        key_id: oldKey.body.key_id,
      }),
    );
    expect(stale).toMatchObject({ status: 422, body: { code: "bad_key_id" } });
    const newKey = await json<{ key_id: string }>(
      api("GET", `${repoPath}/actions/secrets/public-key`, owner.token),
    );
    expect(newKey.body.key_id).toMatch(/^2\./);
    const fresh = secretValue();
    expect((await putSecret(owner, repoPath, "SET_AGAIN", fresh)).status).toBe(204);

    // A job: the old secrets do not open; the one set again does.
    const keys = await ciSecretKeys(env);
    expect(
      await readSecrets(
        env,
        keys,
        org.id,
        repo.id,
        { kind: "names", names: ["REPO_SECRET"] },
        metrics,
      ),
    ).toEqual({ ok: false, code: "secrets_unavailable", names: ["REPO_SECRET"] });
    expect(
      await readSecrets(
        env,
        keys,
        org.id,
        repo.id,
        { kind: "names", names: ["SET_AGAIN"] },
        metrics,
      ),
    ).toMatchObject({ ok: true, secrets: [{ name: "SET_AGAIN", value: fresh }] });
    expect((await status(admin, org.login)).body).toMatchObject({ unreadable_secrets: 2 });

    // Variables: the same.
    expect(await json(api("GET", `${orgPath}/actions/variables`, owner.token))).toEqual(
      variablesBefore,
    );

    // Audited once, with no key material.
    const audits = await replaceAudits(org.id);
    expect(audits).toEqual([
      [admin.principalId, { generation: 2, replaces: 1, retired: [1], secrets: 3 }],
    ]);
  });

  it("answers a retry the same, with or without an idempotency key, even with the key gone", async () => {
    const { owner, stub } = await userWithSecret();
    const body = { account_id: owner.principalId, generation: 1 };
    const key = crypto.randomUUID();
    const first = await replace(admin, owner.handle, body, key);
    expect(first.status).toBe(200);
    expect(await replace(admin, owner.handle, body, key)).toEqual(first);
    expect(await replace(admin, owner.handle, body, null)).toEqual(first);
    try {
      await setKeys(stub, {});
      expect(await replace(admin, owner.handle, body)).toEqual(first);
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
    expect((await dataKeys(stub)).map((r) => r.generation)).toEqual([1, 2]);
    // Replacing 2 later: a retry naming 1 still answers 2, and retires nothing more.
    const second = await replace(admin, owner.handle, { ...body, generation: 2 });
    expect(second.body).toMatchObject({ generation: 3, replaced_generation: 2 });
    expect(await replace(admin, owner.handle, body)).toEqual(first);
    expect((await dataKeys(stub)).map((r) => r.generation)).toEqual([1, 2, 3]);
    expect(await replaceAudits(owner.principalId)).toHaveLength(2);
  });

  it("refuses what it must, writing nothing", async () => {
    const { owner, stub } = await userWithSecret();
    const other = await user();
    const before = await dataKeys(stub);
    const refused = async (who: Who, account: string, body: unknown) => {
      const res = await replace(who, account, body);
      return [res.status, res.body.code];
    };
    expect(
      await refused(admin, owner.handle, { account_id: other.principalId, generation: 1 }),
    ).toEqual([409, "account_changed"]);
    expect(
      await refused(admin, owner.handle, { account_id: owner.principalId, generation: 7 }),
    ).toEqual([409, "no_data_key"]);
    expect(
      await refused(admin, other.handle, { account_id: other.principalId, generation: 1 }),
    ).toEqual([409, "no_data_key"]);
    expect(
      await refused(admin, "nobody-here", { account_id: owner.principalId, generation: 1 }),
    ).toEqual([404, "account_not_found"]);
    expect(
      (await replace(owner, owner.handle, { account_id: owner.principalId, generation: 1 })).status,
    ).toBe(403);
    expect((await replace(admin, owner.handle, { account_id: owner.principalId })).status).toBe(
      422,
    );
    expect((await status(owner, owner.handle)).status).toBe(403);
    expect((await status(admin, "nobody-here")).body.code).toBe("account_not_found");
    try {
      await setKeys(stub, {});
      expect(
        await refused(admin, owner.handle, { account_id: owner.principalId, generation: 1 }),
      ).toEqual([503, "ci_key_unavailable"]);
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
    expect(await dataKeys(stub)).toEqual(before);
    expect(await replaceAudits(owner.principalId)).toEqual([]);
  });

  it("after a lost key: names the newest, retires every older generation, and none reopens", async () => {
    const { owner, path, stub } = await userWithSecret();
    try {
      // K1 lost: the next public key makes generation 2; generation 1 is lost, not retired.
      await setKeys(stub, { CI_SECRETS_KEY: K2 });
      expect((await putSecret(owner, path, "NEW", secretValue())).status).toBe(201);
      const changed = await replace(admin, owner.handle, {
        account_id: owner.principalId,
        generation: 1,
      });
      expect(changed.status).toBe(409);
      expect(changed.body).toMatchObject({ code: "generation_changed" });
      expect(changed.body.detail).toContain("2");
      const done = await replace(admin, owner.handle, {
        account_id: owner.principalId,
        generation: 2,
      });
      expect(done.body).toMatchObject({ generation: 3, replaced_generation: 2 });
      expect((await dataKeys(stub)).map((r) => [r.generation, r.replaced_by])).toEqual([
        [1, 3],
        [2, 3],
        [3, null],
      ]);
      // K1 turning up again does not reopen generation 1.
      await setKeys(stub, { CI_SECRETS_KEY: K2, CI_SECRETS_KEYS_RETIRED: K1 });
      expect((await status(admin, owner.handle)).body).toMatchObject({
        generation: 3,
        secrets: 2,
        unreadable_secrets: 2,
      });
      // Rewrap counts nothing retired.
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 0, unreadable: 0 });
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });

  it("refuses a secret prepared under the generation it retires", async () => {
    const { owner, path, stub } = await userWithSecret();
    accountHooks.ciPrepared = async (account) => {
      delete accountHooks.ciPrepared;
      expect(await account.ciReplaceDataKey({ principalId: admin.principalId }, 1)).toMatchObject({
        ok: true,
      });
    };
    expect(await json(putSecret(owner, path, "LATE", secretValue()))).toMatchObject({
      status: 422,
      body: { code: "bad_key_id" },
    });
    expect(
      await inAccount(stub, (sql) =>
        sql.exec("SELECT name FROM ci_secrets WHERE name = 'LATE'").toArray(),
      ),
    ).toEqual([]);
  });

  it("keeps a rewrap prepared before the replacement from writing the key back", async () => {
    const { stub } = await userWithSecret();
    try {
      await setKeys(stub, { CI_SECRETS_KEY: K2, CI_SECRETS_KEYS_RETIRED: K1 });
      accountHooks.ciRewrapPrepared = async (account) => {
        delete accountHooks.ciRewrapPrepared;
        await account.ciReplaceDataKey({ principalId: admin.principalId }, 1);
      };
      // Today's count went negative here: one listed, none left, one counted as remaining.
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 0, unreadable: 0 });
      expect((await dataKeys(stub))[0]).toMatchObject({ generation: 1, wrapped: "", nonce: "" });
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });

  it("counts each data key once when a replacement lands while a rewrap counts", async () => {
    const { owner, path, stub } = await userWithSecret();
    try {
      // Generation 1 under K1, which is then lost; generation 2 under K2, then retired for K3.
      await setKeys(stub, { CI_SECRETS_KEY: K2 });
      expect((await putSecret(owner, path, "NEW", secretValue())).status).toBe(201);
      await setKeys(stub, { CI_SECRETS_KEY: K3, CI_SECRETS_KEYS_RETIRED: K2 });
      accountHooks.ciRewrapCounted = async (account) => {
        delete accountHooks.ciRewrapCounted;
        await account.ciReplaceDataKey({ principalId: admin.principalId }, 2);
      };
      // The set counted is the one read before the replacement: generation 1, unreadable.
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 1, remaining: 0, unreadable: 1 });
      // The next sweep counts nothing retired.
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 0, unreadable: 0 });
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });

  it("makes one generation of two concurrent replacements, and both answer it", async () => {
    const { owner, stub } = await userWithSecret();
    let inner: unknown;
    accountHooks.ciReplacePrepared = async (account) => {
      delete accountHooks.ciReplacePrepared;
      inner = await account.ciReplaceDataKey({ principalId: admin.principalId }, 1);
    };
    const outer = await replace(admin, owner.handle, {
      account_id: owner.principalId,
      generation: 1,
    });
    expect(outer.status).toBe(200);
    expect(inner).toEqual({
      ok: true,
      value: {
        generation: 2,
        replacedGeneration: 1,
        replacedAt: Date.parse(outer.body.replaced_at),
      },
    });
    expect((await dataKeys(stub)).map((r) => r.generation)).toEqual([1, 2]);
    expect(await replaceAudits(owner.principalId)).toHaveLength(1);
  });

  it("finds a suspended account", async () => {
    const { owner } = await userWithSecret();
    await env.DIRECTORY.prepare(
      "UPDATE principals SET disabled_at = 1, lifecycle = 'suspended', lifecycle_gen = lifecycle_gen + 1 WHERE id = ?",
    )
      .bind(owner.principalId)
      .run();
    expect((await status(admin, owner.handle)).body).toMatchObject({ generation: 1, secrets: 1 });
    expect(
      (await replace(admin, owner.handle, { account_id: owner.principalId, generation: 1 })).status,
    ).toBe(200);
  });

  it("lists the first 100 unreadable secrets, from any number of retired generations", async () => {
    const { owner, repo, stub } = await userWithSecret("A_FIRST");
    // 101 more retired generations, one secret each (as 101 replacements would leave them).
    await inAccount(stub, (sql) => {
      for (let g = 2; g <= 102; g++) {
        sql.exec(
          `INSERT INTO ci_data_keys (generation, wrapped, nonce, master_key_id, created_at, replaced_at, replaced_by)
           VALUES (?, '', '', 'gone', 1, 1, 103)`,
          g,
        );
        sql.exec(
          `INSERT INTO ci_secrets (scope, name, generation, nonce, ciphertext, created_at, updated_at)
           VALUES (?, ?, ?, 'n', 'c', 1, 1)`,
          repo.id,
          `S_${String(g).padStart(3, "0")}`,
          g,
        );
      }
      // The generation that retired them, used by no secret.
      sql.exec(
        `INSERT INTO ci_data_keys (generation, wrapped, nonce, master_key_id, created_at)
         VALUES (103, 'w', 'n', 'gone', 1)`,
      );
    });
    const res = await status(admin, owner.handle);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      generation: 103,
      secrets: 102,
      unreadable_secrets: 101,
      unreadable_truncated: true,
    });
    expect(res.body.unreadable).toHaveLength(100);
    expect(res.body.unreadable[0]).toEqual({ scope: repo.id, name: "S_002" });
    expect(res.body.unreadable[99]).toEqual({ scope: repo.id, name: "S_101" });
  });

  it("counts no retired generation in a rewrap's mismatch count", async () => {
    const { owner, stub } = await userWithSecret();
    await replace(admin, owner.handle, { account_id: owner.principalId, generation: 1 });
    expect(await stub.ciRewrap("another-key-id")).toEqual({
      rewrapped: 0,
      remaining: 1,
      unreadable: 0,
    });
  });
});
