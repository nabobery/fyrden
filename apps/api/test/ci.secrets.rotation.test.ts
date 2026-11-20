// Rotating the CI master key: data keys are wrapped again, secrets are not
// encrypted again; a retired key still opens; a lost key leaves its
// generation's secrets unreadable until they are set again under a new one.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  inAccount,
  newOrg,
  orgRepoOf,
  putSecret,
  repoOf,
  secretValue,
} from "./helpers/ci-secrets.js";

const K1 = (env as { CI_SECRETS_KEY?: string }).CI_SECRETS_KEY as string;
const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const keyId = async (key: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(atob(key), (c) => c.charCodeAt(0)),
      ),
    ),
  ]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

type KeyVars = {
  CI_SECRETS_KEY?: string;
  CI_SECRETS_KEY_NEXT?: string;
  CI_SECRETS_KEYS_RETIRED?: string;
};

/** The account object's CI key variables from now on (absent: unset). */
function setKeys(stub: DurableObjectStub<OrgDO>, vars: KeyVars) {
  return inAccount(stub, (_, instance) => {
    const e = (instance as unknown as { env: Record<string, unknown> }).env;
    for (const name of [
      "CI_SECRETS_KEY",
      "CI_SECRETS_KEY_NEXT",
      "CI_SECRETS_KEYS_RETIRED",
    ] as const) {
      if (vars[name] === undefined) delete e[name];
      else e[name] = vars[name];
    }
  });
}

const dataKeys = (stub: DurableObjectStub<OrgDO>) =>
  inAccount(stub, (sql) =>
    sql
      .exec<{ generation: number; master_key_id: string; wrapped: string; lost_at: number | null }>(
        "SELECT generation, master_key_id, wrapped, lost_at FROM ci_data_keys ORDER BY generation",
      )
      .toArray(),
  );
const ciphertexts = (stub: DurableObjectStub<OrgDO>) =>
  inAccount(stub, (sql) =>
    sql
      .exec("SELECT scope, name, generation, nonce, ciphertext FROM ci_secrets ORDER BY name")
      .toArray(),
  );

let owner: Who;
beforeAll(async () => {
  owner = await user();
});

async function repoWithSecret(name = "KEPT") {
  const repo = await repoOf(owner.principalId);
  const path = `/repos/${owner.handle}/${repo.name}`;
  expect((await putSecret(owner, path, name, secretValue())).status).toBe(201);
  return { repo, path };
}

describe("rotating the CI master key", () => {
  it("wraps each data key again under the next key, without encrypting any secret again", async () => {
    // Each test its own account, since keys are set per account object.
    owner = await user();
    const stub = env.ORG.getByName(owner.principalId);
    const { path } = await repoWithSecret();
    const before = await ciphertexts(stub);
    const [k1row] = await dataKeys(stub);
    expect(k1row?.master_key_id).toBe(await keyId(K1));
    try {
      await setKeys(stub, { CI_SECRETS_KEY: K1, CI_SECRETS_KEY_NEXT: K2 });
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 1, remaining: 0, unreadable: 0 });
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 0, unreadable: 0 });
      const [k2row] = await dataKeys(stub);
      expect(k2row?.master_key_id).toBe(await keyId(K2));
      expect(k2row?.wrapped).not.toBe(k1row?.wrapped);
      expect(await ciphertexts(stub)).toEqual(before);
      // The next key alone: the secret still opens, and is written again under its generation.
      await setKeys(stub, { CI_SECRETS_KEY: K2 });
      const listed = await json<{ secrets: Record<string, unknown>[] }>(
        api("GET", `${path}/actions/secrets`, owner.token),
      );
      expect(listed.body.secrets).toEqual([expect.not.objectContaining({ unreadable: true })]);
      expect((await putSecret(owner, path, "KEPT", secretValue())).status).toBe(204);
      expect(await dataKeys(stub)).toHaveLength(1);
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });

  it("opens a data key under a retired key, and wraps it under the current one at the next write", async () => {
    owner = await user();
    const stub = env.ORG.getByName(owner.principalId);
    const { path } = await repoWithSecret();
    try {
      await setKeys(stub, { CI_SECRETS_KEY: K2, CI_SECRETS_KEYS_RETIRED: `\n${K1}\n` });
      const listed = await json<{ secrets: Record<string, unknown>[] }>(
        api("GET", `${path}/actions/secrets`, owner.token),
      );
      expect(listed.body.secrets[0]).not.toHaveProperty("unreadable");
      const key = await json<{ key_id: string }>(
        api("GET", `${path}/actions/secrets/public-key`, owner.token),
      );
      expect(key.body.key_id).toMatch(/^1\./);
      expect((await dataKeys(stub))[0]?.master_key_id).toBe(await keyId(K1));
      expect((await putSecret(owner, path, "OTHER", secretValue())).status).toBe(201);
      expect((await dataKeys(stub)).map((k) => k.master_key_id)).toEqual([await keyId(K2)]);
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });

  it("writes nothing while a key is misconfigured, and still serves keys that open", async () => {
    owner = await user();
    const stub = env.ORG.getByName(owner.principalId);
    const { path } = await repoWithSecret();
    try {
      await setKeys(stub, { CI_SECRETS_KEY: K1, CI_SECRETS_KEY_NEXT: "" });
      expect((await api("GET", `${path}/actions/secrets/public-key`, owner.token)).status).toBe(
        200,
      );
      expect(await json(putSecret(owner, path, "NEW", secretValue()))).toMatchObject({
        status: 503,
        body: { code: "ci_key_unavailable" },
      });
      expect((await ciphertexts(stub)).map((s) => s.name)).toEqual(["KEPT"]);
      // No key to wrap with: its data key waits.
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 1, unreadable: 0 });
      // An account with no data key yet gets none made.
      const other = await user();
      const fresh = await repoOf(other.principalId);
      const otherStub = env.ORG.getByName(other.principalId);
      await setKeys(otherStub, { CI_SECRETS_KEY: K1, CI_SECRETS_KEY_NEXT: "" });
      expect(
        await json(
          api(
            "GET",
            `/repos/${other.handle}/${fresh.name}/actions/secrets/public-key`,
            other.token,
          ),
        ),
      ).toMatchObject({ status: 503, body: { code: "ci_key_unavailable" } });
      expect(await dataKeys(otherStub)).toEqual([]);
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });
});

describe("a lost master key", () => {
  it("leaves its generation's secrets unreadable; the public key starts a new generation, and a secret set again opens", async () => {
    owner = await user();
    const stub = env.ORG.getByName(owner.principalId);
    const { path } = await repoWithSecret("OLD");
    expect((await putSecret(owner, path, "OLD_TOO", secretValue())).status).toBe(201);
    const oldKey = await json<{ key_id: string; key: string }>(
      api("GET", `${path}/actions/secrets/public-key`, owner.token),
    );
    try {
      await setKeys(stub, { CI_SECRETS_KEY: K2 });
      const listed = async () =>
        (
          await json<{ secrets: { name: string; unreadable?: boolean }[] }>(
            api("GET", `${path}/actions/secrets`, owner.token),
          )
        ).body.secrets;
      expect(await listed()).toEqual([
        expect.objectContaining({ name: "OLD", unreadable: true }),
        expect.objectContaining({ name: "OLD_TOO", unreadable: true }),
      ]);
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 0, unreadable: 1 });
      // Sealed for the lost generation: refused, its key cannot be held.
      expect(
        await json(
          api("PUT", `${path}/actions/secrets/OLD`, owner.token, {
            encrypted_value: "AAAA",
            key_id: oldKey.body.key_id,
          }),
        ),
      ).toMatchObject({ status: 422, body: { code: "bad_key_id" } });
      const key = await json<{ key_id: string }>(
        api("GET", `${path}/actions/secrets/public-key`, owner.token),
      );
      expect(key.body.key_id).toMatch(/^2\./);
      const rows = await dataKeys(stub);
      expect(rows.map((r) => [r.generation, r.master_key_id, r.lost_at !== null])).toEqual([
        [1, await keyId(K1), true],
        [2, await keyId(K2), false],
      ]);
      expect((await putSecret(owner, path, "OLD", secretValue())).status).toBe(204);
      expect((await putSecret(owner, path, "NEW", secretValue())).status).toBe(201);
      expect(await listed()).toEqual([
        expect.not.objectContaining({ unreadable: true }),
        expect.not.objectContaining({ unreadable: true }),
        expect.objectContaining({ name: "OLD_TOO", unreadable: true }),
      ]);
      // The old key found again: what was not set again opens again.
      await setKeys(stub, { CI_SECRETS_KEY: K2, CI_SECRETS_KEYS_RETIRED: K1 });
      expect((await listed()).filter((s) => s.unreadable)).toEqual([]);
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 1, remaining: 0, unreadable: 0 });
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });
  it("marks the lost generation's organization secrets unreadable in a repository's view too", async () => {
    const admin = await user(true);
    const orgOwner = await user();
    const org = await newOrg(admin, orgOwner);
    const repo = await orgRepoOf(orgOwner, org.login);
    const stub = env.ORG.getByName(org.id);
    expect(
      (
        await putSecret(orgOwner, `/orgs/${org.login}`, "SHARED", secretValue(), {
          visibility: "all",
        })
      ).status,
    ).toBe(201);
    try {
      await setKeys(stub, { CI_SECRETS_KEY: K2 });
      const view = await json<{ secrets: Record<string, unknown>[] }>(
        api("GET", `/repos/${org.login}/${repo.name}/actions/organization-secrets`, orgOwner.token),
      );
      expect(view.body.secrets).toEqual([
        expect.objectContaining({ name: "SHARED", unreadable: true }),
      ]);
    } finally {
      await setKeys(stub, { CI_SECRETS_KEY: K1 });
    }
  });
});

describe("the rewrap operation", () => {
  it("wraps nothing in an object whose current key is not the one the caller expects, and counts it remaining", async () => {
    owner = await user();
    const stub = env.ORG.getByName(owner.principalId);
    await repoWithSecret("KEPT");
    const before = await dataKeys(stub);
    expect(await stub.ciRewrap("0000000000000000")).toEqual({
      rewrapped: 0,
      remaining: 1,
      unreadable: 0,
    });
    expect(await dataKeys(stub)).toEqual(before);
    expect(await stub.ciRewrap(await keyId(K1))).toEqual({
      rewrapped: 0,
      remaining: 0,
      unreadable: 0,
    });
  });
  it("is an instance administrator's", async () => {
    const someone = await user();
    expect((await api("POST", "/admin/ci/secrets/rewrap", someone.token, {})).status).toBe(403);
    const admin = await user(true);
    const res = await json<Record<string, unknown>>(
      api("POST", "/admin/ci/secrets/rewrap", admin.token, { cursor: "usr_~" }),
    );
    expect(res).toEqual({
      status: 200,
      body: { rewrapped: 0, remaining: 0, unreadable: 0, next_cursor: null },
    });
  });
});
