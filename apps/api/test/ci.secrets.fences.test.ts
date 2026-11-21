// What a secret write prepared outside its transaction meets at its commit: a
// repository that left (404), left and came back (409, never retried), or was
// deleted (404), each leaving no row; a new data key generation made once of
// concurrent requests; a guarded rewrap losing to another. And what leaving
// takes: a repository's secrets and variables, and its place on every list.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ciScopeHooks } from "../src/ci/secrets-ops.js";
import { accountHooks, type OrgDO } from "../src/do/OrgDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import {
  inAccount,
  newOrg,
  orgRepoOf,
  putSecret,
  repoOf,
  secretValue,
} from "./helpers/ci-secrets.js";

afterEach(() => {
  delete accountHooks.ciPrepared;
  delete accountHooks.ciListed;
  delete accountHooks.ciKeyPrepared;
  delete accountHooks.ciRewrapPrepared;
  delete ciScopeHooks.afterAuthorize;
});

let admin: Who;
beforeAll(async () => {
  admin = await user(true);
});

const NOTHING_HANDED = { collaborators: [], usageBytes: 0 };

/** `step` once, at the next secret write's pause between preparation and commit. */
function atCommit(step: (account: OrgDO) => Promise<unknown>) {
  accountHooks.ciPrepared = async (account) => {
    delete accountHooks.ciPrepared;
    await step(account);
  };
}

const rows = (stub: DurableObjectStub<OrgDO>, scope: string) =>
  inAccount(
    stub,
    (sql) =>
      sql.exec<{ n: number }>("SELECT count(*) AS n FROM ci_secrets WHERE scope = ?", scope).one()
        .n,
  );

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

describe("a secret write paused between preparation and commit", () => {
  it("lands nothing once the repository left the account", async () => {
    const { owner, repo, path, stub } = await userRepo();
    atCommit((account) => account.releaseRepo(uniqueId("trf"), repo.id));
    expect(await json(putSecret(owner, path, "LATE", secretValue()))).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    expect(await rows(stub, repo.id)).toBe(0);
  });

  it("lands nothing once the repository left and came back: 409, not retried", async () => {
    const { owner, repo, path, stub } = await userRepo();
    atCommit(async (account) => {
      await account.releaseRepo(uniqueId("trf"), repo.id);
      await account.adoptRepo(uniqueId("trf"), repo.id, NOTHING_HANDED);
    });
    expect(await json(putSecret(owner, path, "LATE", secretValue()))).toMatchObject({
      status: 409,
      body: { code: "repository_changed" },
    });
    expect(await rows(stub, repo.id)).toBe(0);
    // Sent again, it lands.
    expect((await putSecret(owner, path, "LATE", secretValue())).status).toBe(201);
  });

  it("lands nothing once the repository's arrival committed meanwhile: 409", async () => {
    const { owner, repo, path, stub } = await userRepo();
    atCommit((account) => account.adoptRepo(uniqueId("trf"), repo.id, NOTHING_HANDED));
    expect(await json(putSecret(owner, path, "LATE", secretValue()))).toMatchObject({
      status: 409,
      body: { code: "repository_changed" },
    });
    expect(await rows(stub, repo.id)).toBe(0);
  });

  it("lands nothing once the repository was deleted", async () => {
    const { owner, repo, path, stub } = await userRepo();
    atCommit(async (account) => account.forgetRepo(repo.id));
    expect(await json(putSecret(owner, path, "LATE", secretValue()))).toMatchObject({
      status: 404,
      body: { code: "repo_not_found" },
    });
    expect(await rows(stub, repo.id)).toBe(0);
  });

  it("lands nothing once a repository it lists left the organization: 409", async () => {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const kept = await orgRepoOf(owner, org.login);
    const listed = await orgRepoOf(owner, org.login);
    const stub = env.ORG.getByName(org.id);
    atCommit((account) => account.releaseRepo(uniqueId("trf"), listed.id));
    // The leaving one listed after one that stays: the whole write is refused.
    expect(
      await json(
        putSecret(owner, `/orgs/${org.login}`, "LATE", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [kept.id, listed.id],
        }),
      ),
    ).toMatchObject({ status: 409, body: { code: "repository_changed" } });
    expect(await rows(stub, "org")).toBe(0);
    expect(
      await inAccount(stub, (sql) =>
        sql.exec("SELECT repo_id FROM ci_secret_repos WHERE name = 'LATE'").toArray(),
      ),
    ).toEqual([]);
  });
});

describe("a repository a transfer is moving", () => {
  /** Organization `from`'s repository, with a transfer to `to` held at `step`. */
  async function moving(step: "directory" | "grants") {
    const owner = await user();
    const from = await newOrg(admin, owner);
    const to = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, from.login);
    const path = `/repos/${from.login}/${repo.name}`;
    expect((await putSecret(owner, path, "OWN", secretValue())).status).toBe(201);
    expect(
      (
        await api("POST", `/orgs/${to.login}/actions/variables`, owner.token, {
          name: "DESTINATION_ONLY",
          value: "v",
          visibility: "all",
        })
      ).status,
    ).toBe(201);
    await env.DIRECTORY.prepare(
      `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
         step, requested_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
    )
      .bind(repo.id, uniqueId("trf"), from.id, repo.name, to.id, repo.name, step, owner.principalId)
      .run();
    if (step === "grants")
      await env.DIRECTORY.prepare("UPDATE repos SET owner_id = ? WHERE id = ?")
        .bind(to.id, repo.id)
        .run();
    return {
      owner,
      repoId: repo.id,
      path: `/repos/${step === "grants" ? to.login : from.login}/${repo.name}`,
    };
  }

  for (const step of ["directory", "grants"] as const)
    it(`answers 409 repo_transferring to every repository-scoped call (held at ${step})`, async () => {
      const { owner, path } = await moving(step);
      for (const [method, sub, body] of [
        ["GET", "secrets", undefined],
        ["GET", "secrets/public-key", undefined],
        ["GET", "secrets/OWN", undefined],
        ["PUT", "secrets/OWN", { encrypted_value: "AAAA", key_id: "1.0000000000000000" }],
        ["DELETE", "secrets/OWN", undefined],
        ["GET", "organization-secrets", undefined],
        ["GET", "variables", undefined],
        ["POST", "variables", { name: "NEW", value: "v" }],
        ["GET", "variables/OWN", undefined],
        ["PATCH", "variables/OWN", { value: "v" }],
        ["DELETE", "variables/OWN", undefined],
        ["GET", "organization-variables", undefined],
      ] as const)
        expect(
          await json(api(method, `${path}/actions/${sub}`, owner.token, body)),
          `${method} ${sub}`,
        ).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
    });

  it("uses no access decision made while a transfer was under way, though it completes before the call", async () => {
    const { owner, path, repoId } = await moving("grants");
    // The directory settles on the destination between the decision and the account call.
    ciScopeHooks.afterAuthorize = async () => {
      delete ciScopeHooks.afterAuthorize;
      await env.DIRECTORY.prepare("UPDATE repo_transfers SET step = 'done' WHERE repo_id = ?")
        .bind(repoId)
        .run();
    };
    expect(
      await json(api("GET", `${path}/actions/organization-variables`, owner.token)),
    ).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
  });

  it("uses no access decision when a whole transfer away and back ran across it", async () => {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login);
    const path = `/repos/${org.login}/${repo.name}`;
    // Owner and transfer state the same before and after, but a transfer (another one) ran.
    ciScopeHooks.afterAuthorize = async () => {
      delete ciScopeHooks.afterAuthorize;
      await env.DIRECTORY.prepare(
        `INSERT INTO repo_transfers (repo_id, transfer_id, from_owner, from_name, to_owner, to_name,
           step, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'done', ?, 1, 1)`,
      )
        .bind(repo.id, uniqueId("trf"), org.id, repo.name, org.id, repo.name, owner.principalId)
        .run();
    };
    expect(
      await json(api("GET", `${path}/actions/organization-variables`, owner.token)),
    ).toMatchObject({ status: 409, body: { code: "repo_transferring" } });
    // Asked again, with nothing moving, it answers.
    expect((await api("GET", `${path}/actions/organization-variables`, owner.token)).status).toBe(
      200,
    );
  });
});

describe("a repository made public across the access decision", () => {
  it("is shown no private organization variable or secret", async () => {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login, "private");
    const path = `/repos/${org.login}/${repo.name}`;
    const orgPath = `/orgs/${org.login}`;
    for (const [name, visibility] of [
      ["PRIV", "private"],
      ["EVERY", "all"],
    ] as const) {
      expect(
        (
          await api("POST", `${orgPath}/actions/variables`, owner.token, {
            name,
            value: "v",
            visibility,
          })
        ).status,
      ).toBe(201);
      expect((await putSecret(owner, orgPath, name, secretValue(), { visibility })).status).toBe(
        201,
      );
    }
    const madePublic = () => {
      ciScopeHooks.afterAuthorize = async () => {
        delete ciScopeHooks.afterAuthorize;
        await env.DIRECTORY.prepare("UPDATE repos SET visibility = 'public' WHERE id = ?")
          .bind(repo.id)
          .run();
      };
    };
    madePublic();
    const variables = await json<{ variables: { name: string }[] }>(
      api("GET", `${path}/actions/organization-variables`, owner.token),
    );
    expect(variables.body.variables.map((v) => v.name)).toEqual(["EVERY"]);
    await env.DIRECTORY.prepare("UPDATE repos SET visibility = 'private' WHERE id = ?")
      .bind(repo.id)
      .run();
    madePublic();
    const secrets = await json<{ secrets: { name: string }[] }>(
      api("GET", `${path}/actions/organization-secrets`, owner.token),
    );
    expect(secrets.body.secrets.map((s) => s.name)).toEqual(["EVERY"]);
  });
});

describe("a write whose listed repository leaves during the directory lookup", () => {
  it("answers 409 repository_changed, not 422; an id unknown from the start stays 422", async () => {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const kept = await orgRepoOf(owner, org.login);
    const leaving = await orgRepoOf(owner, org.login);
    accountHooks.ciListed = async (account) => {
      delete accountHooks.ciListed;
      await account.releaseRepo(uniqueId("trf"), leaving.id);
    };
    expect(
      await json(
        putSecret(owner, `/orgs/${org.login}`, "LATE", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [kept.id, leaving.id],
        }),
      ),
    ).toMatchObject({ status: 409, body: { code: "repository_changed" } });
    expect(
      await json(
        putSecret(owner, `/orgs/${org.login}`, "LATE", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [kept.id, leaving.id],
        }),
      ),
    ).toMatchObject({ status: 422, body: { code: "unknown_repository" } });
    expect(await rows(env.ORG.getByName(org.id), "org")).toBe(0);
  });
});

describe("other writes paused before their commit", () => {
  it("adds no repository to a list once it left the organization", async () => {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const listed = await orgRepoOf(owner, org.login);
    const leaving = await orgRepoOf(owner, org.login);
    const path = `/orgs/${org.login}/actions/secrets/SEL`;
    expect(
      (
        await putSecret(owner, `/orgs/${org.login}`, "SEL", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [listed.id],
        })
      ).status,
    ).toBe(201);
    atCommit((account) => account.releaseRepo(uniqueId("trf"), leaving.id));
    expect(await json(api("PUT", `${path}/repositories/${leaving.id}`, owner.token))).toMatchObject(
      { status: 409, body: { code: "repository_changed" } },
    );
    atCommit((account) => account.releaseRepo(uniqueId("trf"), listed.id));
    expect(
      await json(
        api("PUT", `${path}/repositories`, owner.token, { selected_repository_ids: [listed.id] }),
      ),
    ).toMatchObject({ status: 409, body: { code: "repository_changed" } });
    // Asked again, a repository already gone is unknown.
    expect(await json(api("PUT", `${path}/repositories/${leaving.id}`, owner.token))).toMatchObject(
      { status: 422, body: { code: "unknown_repository" } },
    );
    expect(
      await inAccount(env.ORG.getByName(org.id), (sql) =>
        sql.exec("SELECT repo_id FROM ci_secret_repos WHERE name = 'SEL'").toArray(),
      ),
    ).toEqual([]);
  });

  it("creates no variable once its repository left and came back: 409", async () => {
    const { owner, repo, path, stub } = await userRepo();
    atCommit(async (account) => {
      await account.releaseRepo(uniqueId("trf"), repo.id);
      await account.adoptRepo(uniqueId("trf"), repo.id, NOTHING_HANDED);
    });
    expect(
      await json(
        api("POST", `${path}/actions/variables`, owner.token, { name: "LATE", value: "v" }),
      ),
    ).toMatchObject({ status: 409, body: { code: "repository_changed" } });
    expect(
      await inAccount(
        stub,
        (sql) =>
          sql
            .exec<{ n: number }>("SELECT count(*) AS n FROM ci_variables WHERE scope = ?", repo.id)
            .one().n,
      ),
    ).toBe(0);
  });
});

describe("leaving the account", () => {
  async function orgWithEverything() {
    const owner = await user();
    const org = await newOrg(admin, owner);
    const repo = await orgRepoOf(owner, org.login);
    const path = `/repos/${org.login}/${repo.name}`;
    expect((await putSecret(owner, path, "OWN", secretValue())).status).toBe(201);
    expect(
      (await api("POST", `${path}/actions/variables`, owner.token, { name: "OWN", value: "v" }))
        .status,
    ).toBe(201);
    expect(
      (
        await putSecret(owner, `/orgs/${org.login}`, "SHARED", secretValue(), {
          visibility: "selected",
          selected_repository_ids: [repo.id],
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api("POST", `/orgs/${org.login}/actions/variables`, owner.token, {
          name: "SHARED",
          value: "v",
          visibility: "selected",
          selected_repository_ids: [repo.id],
        })
      ).status,
    ).toBe(201);
    const stub = env.ORG.getByName(org.id);
    return { repo, stub };
  }

  const held = (stub: DurableObjectStub<OrgDO>, repoId: string) =>
    inAccount(stub, (sql) => ({
      secrets: sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM ci_secrets WHERE scope = ?", repoId)
        .one().n,
      variables: sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM ci_variables WHERE scope = ?", repoId)
        .one().n,
      lists:
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM ci_secret_repos WHERE repo_id = ?",
            repoId,
          )
          .one().n +
        sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM ci_variable_repos WHERE repo_id = ?",
            repoId,
          )
          .one().n,
      orgEntries:
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM ci_secrets WHERE scope = 'org'").one()
          .n +
        sql.exec<{ n: number }>("SELECT count(*) AS n FROM ci_variables WHERE scope = 'org'").one()
          .n,
    }));

  it("by transfer takes a repository's secrets, variables and places on lists", async () => {
    const { repo, stub } = await orgWithEverything();
    expect(await held(stub, repo.id)).toEqual({
      secrets: 1,
      variables: 1,
      lists: 2,
      orgEntries: 2,
    });
    await stub.releaseRepo(uniqueId("trf"), repo.id);
    expect(await held(stub, repo.id)).toEqual({
      secrets: 0,
      variables: 0,
      lists: 0,
      orgEntries: 2,
    });
    // A call that passed its checks before the release reads none of the organization's.
    for (const kind of ["secret", "variable"] as const)
      expect(await stub.ciRepoView(kind, repo.id, "private", 1, 30)).toMatchObject({
        ok: false,
        status: 404,
      });
  });

  it("by deletion takes the same", async () => {
    const { repo, stub } = await orgWithEverything();
    await stub.forgetRepo(repo.id);
    expect(await held(stub, repo.id)).toEqual({
      secrets: 0,
      variables: 0,
      lists: 0,
      orgEntries: 2,
    });
  });
});

describe("data key generations", () => {
  it("are made once of two concurrent public key requests after a lost key", async () => {
    const { owner, path, stub } = await userRepo();
    expect((await putSecret(owner, path, "OLD", secretValue())).status).toBe(201);
    const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await inAccount(stub, (_, instance) => {
      (instance as unknown as { env: Record<string, unknown> }).env.CI_SECRETS_KEY = K2;
    });
    try {
      // Both prepare a generation before either commits.
      let waiting: (() => void) | undefined;
      let prepared = 0;
      accountHooks.ciKeyPrepared = () => {
        prepared++;
        if (waiting) {
          waiting();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          waiting = resolve;
        });
      };
      const [a, b] = await Promise.all([
        json<{ key_id: string; key: string }>(
          api("GET", `${path}/actions/secrets/public-key`, owner.token),
        ),
        json<{ key_id: string; key: string }>(
          api("GET", `${path}/actions/secrets/public-key`, owner.token),
        ),
      ]);
      expect(prepared).toBe(2);
      expect(a.body.key_id).toMatch(/^2\./);
      expect(b.body).toEqual(a.body);
      expect(
        await inAccount(stub, (sql) =>
          sql
            .exec<{ generation: number }>("SELECT generation FROM ci_data_keys ORDER BY generation")
            .toArray(),
        ),
      ).toEqual([{ generation: 1 }, { generation: 2 }]);
      delete accountHooks.ciKeyPrepared;
      expect((await putSecret(owner, path, "NEW", secretValue())).status).toBe(201);
    } finally {
      await inAccount(stub, (_, instance) => {
        (instance as unknown as { env: Record<string, unknown> }).env.CI_SECRETS_KEY = (
          env as { CI_SECRETS_KEY?: string }
        ).CI_SECRETS_KEY;
      });
    }
  });

  it("are wrapped again only if unchanged: a rewrap that loses reads the row again", async () => {
    const { owner, path, stub } = await userRepo();
    expect((await putSecret(owner, path, "KEPT", secretValue())).status).toBe(201);
    const K1 = (env as { CI_SECRETS_KEY?: string }).CI_SECRETS_KEY as string;
    const K2 = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));
    const setNext = (next: string | undefined) =>
      inAccount(stub, (_, instance) => {
        const e = (instance as unknown as { env: Record<string, unknown> }).env;
        if (next === undefined) delete e.CI_SECRETS_KEY_NEXT;
        else e.CI_SECRETS_KEY_NEXT = next;
      });
    await setNext(K2);
    try {
      let inner: unknown;
      accountHooks.ciRewrapPrepared = async (account) => {
        delete accountHooks.ciRewrapPrepared;
        inner = await account.ciRewrap();
      };
      expect(await stub.ciRewrap()).toEqual({ rewrapped: 0, remaining: 0, unreadable: 0 });
      expect(inner).toEqual({ rewrapped: 1, remaining: 0, unreadable: 0 });
      await inAccount(stub, (_, instance) => {
        const e = (instance as unknown as { env: Record<string, unknown> }).env;
        e.CI_SECRETS_KEY = K2;
        delete e.CI_SECRETS_KEY_NEXT;
      });
      const listed = await json<{ secrets: Record<string, unknown>[] }>(
        api("GET", `${path}/actions/secrets`, owner.token),
      );
      expect(listed.body.secrets[0]).not.toHaveProperty("unreadable");
    } finally {
      await setNext(undefined);
      await inAccount(stub, (_, instance) => {
        (instance as unknown as { env: Record<string, unknown> }).env.CI_SECRETS_KEY = K1;
      });
    }
  });
});
