// What a user being deleted can no longer be given, decided in the write
// itself (so a request checked before the deletion began adds nothing after
// it), and handles released by a deletion, held for 90 days.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { D1TokenStore } from "@fyrden/adapters-cloudflare/auth";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { grantHooks } from "../src/accounts/delegation.js";
import { handleFree } from "../src/accounts/handles.js";
import { orgHooks } from "../src/accounts/orgs.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { forkRepository } from "../src/network/fork.js";
import type { OpContext } from "../src/ops/execute.js";
import { advanceDeletions } from "../src/repos/deletion.js";
import { publishHooks } from "../src/repos/directory.js";
import { starRepoOperation } from "../src/repos/stars.js";
import { transferHooks } from "../src/repos/transfer.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { loadFixture } from "./helpers/fetch-repo.js";
import { cloneObjects, entryOf } from "./helpers/network.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("pushFixtures");
const fetched = inject("fetchFixtures").single;
const DAY_MS = 24 * 60 * 60 * 1000;

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

afterEach(() => {
  delete publishHooks.before;
  delete orgHooks.beforePublish;
  delete grantHooks.beforeInsert;
  delete transferHooks.beforeMove;
});

/** `principalId` being deleted, as the deletion's transition leaves it. */
const markDeleting = (principalId: string) =>
  env.DIRECTORY.prepare(
    `UPDATE principals SET lifecycle = 'deleting', disabled_at = ?2,
       lifecycle_gen = lifecycle_gen + 1 WHERE id = ?1`,
  )
    .bind(principalId, Date.now())
    .run()
    .then(() => {});

const count = async (sql: string, ...args: unknown[]) =>
  (
    await env.DIRECTORY.prepare(sql)
      .bind(...args)
      .first<{ n: number }>()
  )?.n;

/** A valid handle no one has. */
const newHandle = (prefix: string) =>
  `${prefix}${uniqueId("")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 24)}`;

const reserve = (handle: string, until: number) =>
  env.DIRECTORY.prepare(
    "INSERT INTO handle_reservations (handle, principal_id, until) VALUES (?, ?, ?)",
  )
    .bind(handle, `usr_${uniqueId("gone")}`, until)
    .run();

/** A repository of `owner`'s, created through the API, holding the fetch fixture. */
async function repoOf(owner: { principalId: string; token: string }) {
  const name = uniqueId("parent");
  const made = await json<{ id: string }>(api("POST", "/user/repos", owner.token, { name }));
  expect(made.status).toBe(201);
  const stub = env.REPO.getByName(made.body.id);
  await stub.checkEpoch();
  await loadFixture(stub, fetched);
  return { id: made.body.id, name, stub };
}

describe("a handle a deletion released", () => {
  it("is taken by no user, organization or agent until its reservation ends, whatever its case", async () => {
    const handle = newHandle("held");
    await reserve(handle, Date.now() + 90 * DAY_MS);
    const refused = { status: 409, body: { code: "handle_taken" } };
    expect(
      await json(api("POST", "/admin/users", admin.token, { handle: handle.toUpperCase() })),
    ).toMatchObject(refused);
    expect(
      await json(
        api("POST", "/admin/organizations", admin.token, { login: handle, admin: admin.handle }),
      ),
    ).toMatchObject(refused);
    expect(await json(api("POST", "/agents", admin.token, { handle }))).toMatchObject(refused);
    expect(
      await count("SELECT count(*) AS n FROM principals WHERE handle = ? COLLATE NOCASE", handle),
    ).toBe(0);
  });

  it("is free again once its reservation ended, to users, organizations and agents", async () => {
    const [u, o, g] = [newHandle("freed"), newHandle("freed"), newHandle("freed")];
    for (const handle of [u, o, g]) await reserve(handle.toUpperCase(), Date.now() - 1);
    expect((await api("POST", "/admin/users", admin.token, { handle: u })).status).toBe(201);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login: o, admin: admin.handle }))
        .status,
    ).toBe(201);
    expect((await api("POST", "/agents", admin.token, { handle: g })).status).toBe(201);
  });

  it("is held until the instant its reservation ends, and free from then on", async () => {
    const handle = newHandle("edge");
    const until = 1_000_000;
    await reserve(handle, until);
    const freeAt = async (now: number) =>
      (
        await env.DIRECTORY.prepare(`SELECT ${handleFree("?1", "?2")} AS free`)
          .bind(handle.toUpperCase(), now)
          .first<{ free: number }>()
      )?.free;
    expect([await freeAt(until - 1), await freeAt(until), await freeAt(until + 1)]).toEqual([
      0, 1, 1,
    ]);
  });
});

describe("a user whose deletion began while a request was under way", () => {
  it("is given no new repository", async () => {
    const owner = await user();
    publishHooks.before = () => markDeleting(owner.principalId);
    const created = await json(api("POST", "/user/repos", owner.token, { name: uniqueId("late") }));
    expect(created).toMatchObject({ status: 404, body: { code: "owner_not_found" } });
    expect(
      await count("SELECT count(*) AS n FROM repos WHERE owner_id = ?", owner.principalId),
    ).toBe(0);
  });

  it("is given no fork, the copy made for them deleted", async () => {
    const parentOwner = await principalWithToken("user", "git");
    const parent = await repoOf(parentOwner);
    const forker = await user();
    publishHooks.before = () => markDeleting(forker.principalId);
    const forked = await forkRepository(env, {
      parent: await entryOf(parentOwner, parent),
      ownerId: forker.principalId,
      ownerHandle: forker.handle,
      name: uniqueId("fork"),
      maxRepos: Number.MAX_SAFE_INTEGER,
    });
    expect(forked).toMatchObject({ ok: false, status: 404, code: "owner_not_found" });
    // Never published: handed to the deletion in the same batch, which finishes it.
    const { results: copies } = await env.DIRECTORY.prepare(
      "SELECT id, state FROM repos WHERE owner_id = ?",
    )
      .bind(forker.principalId)
      .all<{ id: string; state: string }>();
    expect(copies.length).toBe(1);
    expect(copies.every((c) => c.state !== "active")).toBe(true);
    await advanceDeletions(env, { limit: 100 });
    for (const copy of copies)
      expect(
        (
          await env.DIRECTORY.prepare("SELECT state FROM repos WHERE id = ?")
            .bind(copy.id)
            .first<{ state: string }>()
        )?.state,
      ).toBe("deleted");
    // The parent is untouched: still cloned whole.
    const clone = await cloneObjects(
      parentOwner,
      parent,
      fetched.refs.map((r) => r.oid),
      ["done"],
    );
    expect(clone.error).toBeUndefined();
    expect(clone.objects?.length).toBeGreaterThan(0);
  });

  it("is moved no repository by a transfer, which leaves it where it was", async () => {
    const owner = await user();
    const org = uniqueId("org").slice(0, 39);
    expect(
      (await api("POST", "/admin/organizations", admin.token, { login: org, admin: owner.handle }))
        .status,
    ).toBe(201);
    const repo = (
      await json<{ id: string; name: string }>(
        api("POST", `/orgs/${org}/repos`, owner.token, { name: uniqueId("t") }),
      )
    ).body;
    const pushed = await postPush(
      {
        repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
        owner: {
          principalId: owner.principalId,
          token: await scopedToken(owner.principalId, [], "git"),
        },
        path: `/${org}/${repo.name}.git`,
      },
      pushBody([{ old: ZERO, new: fx.c2, ref: "refs/heads/main" }], { pack: fx.packC2 }),
    );
    expect(pushed.report).toContain("ok refs/heads/main\n");
    // The owner moves it into their own account; their deletion begins before the move.
    transferHooks.beforeMove = () => markDeleting(owner.principalId);
    const moved = await json(
      api("POST", `/repos/${org}/${repo.name}/transfer`, owner.token, { new_owner: owner.handle }),
    );
    expect(moved).toMatchObject({ status: 404, body: { code: "owner_not_found" } });
    const row = await env.DIRECTORY.prepare(
      `SELECT p.handle AS owner, t.step, t.last_error FROM repos r
         JOIN principals p ON p.id = r.owner_id JOIN repo_transfers t ON t.repo_id = r.id
       WHERE r.id = ?`,
    )
      .bind(repo.id)
      .first<{ owner: string; step: string; last_error: string }>();
    expect(row).toMatchObject({ owner: org, step: "failed", last_error: "owner_deleted" });
    // It takes changes again, in the organization.
    expect(
      await runInDurableObject(env.REPO.getByName(repo.id), (_: RepoDO, state) =>
        state.storage.sql.exec("SELECT write_frozen FROM repo_meta").one(),
      ),
    ).toEqual({ write_frozen: 0 });
  });

  it("is made the first owner of no organization", async () => {
    const owner = await user();
    orgHooks.beforePublish = () => markDeleting(owner.principalId);
    const login = uniqueId("org").slice(0, 39);
    expect(
      await json(api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle })),
    ).toMatchObject({ status: 409, body: { code: "user_changed" } });
    expect(await count("SELECT count(*) AS n FROM principals WHERE handle = ?", login)).toBe(0);
  });

  it("has no grant made to their agent", async () => {
    const granter = await user();
    const owner = await user();
    const agent = await json<{ handle: string; id: string }>(
      api("POST", "/agents", owner.token, { handle: uniqueId("bot").slice(0, 39) }),
    );
    grantHooks.beforeInsert = () => markDeleting(owner.principalId);
    const granted = await json(
      api("POST", "/grants", granter.token, {
        agent: agent.body.handle,
        scopes: ["metadata:read"],
      }),
    );
    expect(granted).toMatchObject({ status: 404, body: { code: "agent_not_found" } });
    expect(await count("SELECT count(*) AS n FROM grants WHERE agent_id = ?", agent.body.id)).toBe(
      0,
    );
  });

  it("stars nothing", async () => {
    const owner = await user();
    const starrer = await user();
    const repo = (
      await json<{ name: string }>(api("POST", "/user/repos", owner.token, { name: uniqueId("s") }))
    ).body;
    const collaborator = `/repos/${owner.handle}/${repo.name}/collaborators/${starrer.handle}`;
    expect((await api("PUT", collaborator, owner.token, { permission: "pull" })).status).toBe(200);
    // The request was checked; then the deletion began.
    const checked = await new D1TokenStore(env.DIRECTORY, {
      clock: () => Date.now(),
      newId: createIdFactory(() => Date.now(), secureRandomBytes),
      randomBytes: secureRandomBytes,
    }).verify(starrer.token, "write");
    if (!checked.ok) throw new Error(`the token is refused: ${checked.reason}`);
    const ctx = { env, auth: checked.record, metrics: { count() {} } } as unknown as OpContext;
    await markDeleting(starrer.principalId);
    await starRepoOperation(ctx, { owner: owner.handle, repo: repo.name });
    expect(
      await count("SELECT count(*) AS n FROM stars WHERE user_id = ?", starrer.principalId),
    ).toBe(0);
  });
});
