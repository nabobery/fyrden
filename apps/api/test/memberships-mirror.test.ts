import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { reconcileMemberships } from "../src/accounts/memberships.js";
import { MAINTENANCE_OBJECT } from "../src/cron/maintenance.js";
import { accountHooks, type OrgDO } from "../src/do/OrgDO.js";
import { allocateEpoch } from "../src/events/epochs.js";
import { newId } from "../src/services.js";
import { api, json, user, type Who } from "./helpers/api.js";

let admin: Who;

beforeAll(async () => {
  admin = await user(true);
});

afterEach(() => {
  delete accountHooks.beforeDelivery;
  delete accountHooks.beforeRemoval;
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

const set = async (org: Org, owner: Who, who: Who, role: "admin" | "member") =>
  expect(
    (await api("PUT", `/orgs/${org.login}/memberships/${who.handle}`, owner.token, { role }))
      .status,
  ).toBe(200);
const remove = async (org: Org, owner: Who, who: Who) =>
  expect(
    (await api("DELETE", `/orgs/${org.login}/memberships/${who.handle}`, owner.token)).status,
  ).toBe(200);

async function mirrored(orgId: string): Promise<Record<string, string>> {
  const { results } = await env.DIRECTORY.prepare(
    "SELECT principal_id, role FROM memberships WHERE org_id = ?",
  )
    .bind(orgId)
    .all<{ principal_id: string; role: string }>();
  return Object.fromEntries(results.map((r) => [r.principal_id, r.role]));
}

const audits = async (orgId: string) =>
  (
    await env.DIRECTORY.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY seq")
      .bind(orgId)
      .all<{ action: string }>()
  ).results.map((r) => r.action);

const actorOf = (who: Who) => ({ principalId: who.principalId });
const member = (who: Who) => ({ id: who.principalId, handle: who.handle });

describe("the directory's record of an organization's members", () => {
  it("has the first owner as soon as the organization is made", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
  });

  it("follows each change by the time its request answers", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    await set(org, owner, bob, "member");
    expect(await mirrored(org.id)).toEqual({
      [owner.principalId]: "owner",
      [bob.principalId]: "member",
    });
    await set(org, owner, bob, "admin");
    expect((await mirrored(org.id))[bob.principalId]).toBe("owner");
    await remove(org, owner, bob);
    expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
    const carol = await user();
    const handed = await api(
      "PUT",
      `/admin/organizations/${org.login}/owners/${carol.handle}`,
      admin.token,
    );
    expect(handed.status).toBe(204);
    expect((await mirrored(org.id))[carol.principalId]).toBe("owner");
  });

  it("drops every principal a deletion retires", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const gone = [await user(), await user(), await user()];
    for (const who of gone) await set(org, owner, who, "member");
    const others = Array.from({ length: 97 }, () => newId("usr"));
    await org.stub.retirePrincipals({
      ids: [...gone.map((w) => w.principalId), ...others],
      jobId: "job_test",
      actor: actorOf(admin),
      ownerCheck: true,
      budget: 500,
    });
    await org.stub.deliverAudit();
    expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
  });

  it("records the state when a delivery goes, whatever changed while the one before it did", async () => {
    const owner = await user();
    const bob = await user();
    const carol = await user();
    const org = await newOrg(owner);
    let removal: Promise<unknown> | undefined;
    accountHooks.beforeDelivery = async (account: OrgDO) => {
      if (removal) return;
      removal = account.removeMember(actorOf(owner), bob.principalId, []);
      await account.setMember(actorOf(owner), member(carol), "owner");
    };
    await runInDurableObject(org.stub, async (account: OrgDO) => {
      await account.setMember(actorOf(owner), member(bob), "member");
      await account.setMember(actorOf(owner), member(carol), "member");
      await account.deliverAudit();
      await removal;
      expect(account.accountRole(bob.principalId)).toBeNull();
    });
    const now = { [owner.principalId]: "owner", [carol.principalId]: "owner" };
    expect(await mirrored(org.id)).toEqual(now);
    await org.stub.deliverAudit();
    expect(await mirrored(org.id)).toEqual(now);
  });

  it("keeps a change made while a whole list is written", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    await set(org, owner, bob, "member");
    let changed = false;
    accountHooks.beforeDelivery = async (account: OrgDO) => {
      if (changed) return;
      changed = true;
      await account.setMember(actorOf(owner), member(bob), "owner");
    };
    await org.stub.mirrorMembers();
    expect(changed).toBe(true);
    await org.stub.deliverAudit();
    expect((await mirrored(org.id))[bob.principalId]).toBe("owner");
  });

  it("writes every whole list asked for, one during another's delivery too", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const clear = () =>
      env.DIRECTORY.prepare("DELETE FROM memberships WHERE org_id = ?").bind(org.id).run();
    let second: Promise<void> | undefined;
    accountHooks.beforeDelivery = async (account: OrgDO) => {
      second ??= account.mirrorMembers();
    };
    await runInDurableObject(org.stub, async (account: OrgDO) => {
      await account.mirrorMembers();
      await clear();
      await account.mirrorMembers();
      await second;
    });
    expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
  });

  it("loses a member before the membership ends, and no delivery puts them back", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    await org.stub.setMember(actorOf(owner), member(bob), "member");
    let during: { role: string | null; recorded: boolean } | undefined;
    let delivery: Promise<void> | undefined;
    accountHooks.beforeRemoval = async (account: OrgDO) => {
      delivery = account.deliverAudit();
      during = {
        role: account.accountRole(bob.principalId),
        recorded: bob.principalId in (await mirrored(org.id)),
      };
    };
    await runInDurableObject(org.stub, async (account: OrgDO) => {
      await account.deliverAudit();
      expect(bob.principalId in (await mirrored(org.id))).toBe(true);
      expect(await account.removeMember(actorOf(owner), bob.principalId, [])).toMatchObject({
        ok: true,
        changed: true,
      });
      expect(bob.principalId in (await mirrored(org.id))).toBe(false);
      await delivery;
    });
    expect(during).toEqual({ role: "member", recorded: false });
    expect(bob.principalId in (await mirrored(org.id))).toBe(false);
  });

  it("has a member again whose removal was refused once their record was gone", async () => {
    const owner = await user();
    const bob = await user();
    const carol = await user();
    const org = await newOrg(owner);
    await set(org, owner, bob, "member");
    await set(org, owner, carol, "admin");
    accountHooks.beforeRemoval = async (account: OrgDO) => {
      await account.setMember(actorOf(carol), member(owner), "member");
    };
    expect(await org.stub.removeMember(actorOf(owner), bob.principalId, [])).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect(await org.stub.accountRole(bob.principalId)).toBe("member");
    accountHooks.beforeDelivery = async () => {
      throw new Error("the directory is away");
    };
    expect(await runDurableObjectAlarm(org.stub)).toBe(true);
    expect((await mirrored(org.id))[bob.principalId]).toBeUndefined();
    delete accountHooks.beforeDelivery;
    expect(await runDurableObjectAlarm(org.stub)).toBe(true);
    expect(await mirrored(org.id)).toEqual({
      [owner.principalId]: "member",
      [bob.principalId]: "member",
      [carol.principalId]: "owner",
    });
  });

  it("is left as it is by a removal that will be refused", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    await set(org, owner, bob, "member");
    const before = await mirrored(org.id);
    const during: Record<string, string>[] = [];
    accountHooks.beforeRemoval = async () => {
      during.push(await mirrored(org.id));
    };
    for (const [by, who] of [
      [bob, bob],
      [owner, owner],
    ] as const)
      expect(await org.stub.removeMember(actorOf(by), who.principalId, [])).toMatchObject({
        ok: false,
      });
    expect(during).toEqual([before, before]);
  });

  it("repeats a delivery that failed with the state as it is then, its audit rows once", async () => {
    const owner = await user();
    const bob = await user();
    const org = await newOrg(owner);
    accountHooks.beforeDelivery = async () => {
      throw new Error("the directory is away");
    };
    await runInDurableObject(org.stub, async (account: OrgDO) => {
      await account.setMember(actorOf(owner), member(bob), "member");
      await expect(account.deliverAudit()).rejects.toThrow("the directory is away");
      await account.setMember(actorOf(owner), member(bob), "owner");
    });
    expect((await mirrored(org.id))[bob.principalId]).toBeUndefined();
    delete accountHooks.beforeDelivery;
    expect(await runDurableObjectAlarm(org.stub)).toBe(true);
    expect((await mirrored(org.id))[bob.principalId]).toBe("owner");
    expect(await audits(org.id)).toEqual(["org.create", "org.member.set", "org.member.set"]);
  });

  it("delivers the audit rows of an organization never published, recording none of its members", async () => {
    const owner = await user();
    const bob = await user();
    const id = newId("org");
    const stub = env.ORG.getByName(id);
    const init = await stub.init({
      accountId: id,
      kind: "org",
      owner: member(owner),
      epochGen: await allocateEpoch(env.DIRECTORY, id),
    });
    expect(init.ok).toBe(true);
    await stub.setMember(actorOf(owner), member(bob), "member");
    await stub.deliverAudit();
    await stub.mirrorMembers();
    expect(await audits(id)).toEqual(["org.member.set"]);
    expect(await mirrored(id)).toEqual({});
  });

  it("delivers the audit rows of a member the directory does not know, recording the others", async () => {
    const owner = await user();
    const org = await newOrg(owner);
    const unknown = newId("usr");
    await runInDurableObject(org.stub, (_account: OrgDO, state) => {
      state.storage.sql.exec(
        "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, 'x', 'member', 1)",
        unknown,
      );
      state.storage.sql.exec(
        `INSERT INTO pending_audit (at, actor_id, action, target_id, details, request_id)
         VALUES (1, NULL, 'org.member.set', ?, ?, NULL)`,
        org.id,
        JSON.stringify({ user: unknown }),
      );
    });
    await org.stub.deliverAudit();
    await org.stub.mirrorMembers();
    expect(await audits(org.id)).toEqual(["org.create", "org.member.set"]);
    expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
  });

  it("makes a whole list equal to the object's: missing, changed and left over", async () => {
    const owner = await user();
    const [missing, demoted, stale] = [await user(), await user(), await user()];
    const org = await newOrg(owner);
    const other = await newOrg(stale);
    await set(org, owner, missing, "member");
    await set(org, owner, demoted, "member");
    await env.DIRECTORY.batch([
      env.DIRECTORY.prepare("DELETE FROM memberships WHERE org_id = ? AND principal_id = ?").bind(
        org.id,
        missing.principalId,
      ),
      env.DIRECTORY.prepare(
        "UPDATE memberships SET role = 'owner' WHERE org_id = ? AND principal_id = ?",
      ).bind(org.id, demoted.principalId),
      env.DIRECTORY.prepare("INSERT INTO memberships VALUES (?, ?, 'member', 1)").bind(
        org.id,
        stale.principalId,
      ),
    ]);
    await org.stub.mirrorMembers();
    expect(await mirrored(org.id)).toEqual({
      [owner.principalId]: "owner",
      [missing.principalId]: "member",
      [demoted.principalId]: "member",
    });
    expect(await mirrored(other.id)).toEqual({ [stale.principalId]: "owner" });
  });

  describe("past what one delivery writes", () => {
    const backlog = (state: DurableObjectState, org: Org, rows: number) => {
      for (let i = 0; i < rows; i++)
        state.storage.sql.exec(
          `INSERT INTO pending_audit (at, actor_id, action, target_id, details, request_id)
           VALUES (1, NULL, 'org.team.create', ?, '{}', NULL)`,
          org.id,
        );
    };

    it("goes with the object's alarm, at once", async () => {
      const owner = await user();
      const bob = await user();
      const org = await newOrg(owner);
      await runInDurableObject(org.stub, async (account: OrgDO, state) => {
        backlog(state, org, 1_001);
        await account.setMember(actorOf(owner), member(bob), "member");
        const retry = await state.storage.getAlarm();
        await account.deliverAudit();
        const left = state.storage.sql.exec("SELECT 1 FROM pending_audit").toArray();
        expect(left).toHaveLength(2);
        expect(await state.storage.getAlarm()).toBeLessThan(retry ?? 0);
      });
      expect((await mirrored(org.id))[bob.principalId]).toBeUndefined();
      expect(await runDurableObjectAlarm(org.stub)).toBe(true);
      expect((await mirrored(org.id))[bob.principalId]).toBe("member");
    });

    it("still writes a whole list asked for during its last batch", async () => {
      const owner = await user();
      const org = await newOrg(owner);
      await env.DIRECTORY.prepare("DELETE FROM memberships WHERE org_id = ?").bind(org.id).run();
      await runInDurableObject(org.stub, async (account: OrgDO, state) => {
        backlog(state, org, 1_000);
        let batches = 0;
        let whole: Promise<void> | undefined;
        accountHooks.beforeDelivery = async () => {
          if (++batches === 20) whole = account.mirrorMembers();
        };
        await account.deliverAudit();
        expect(batches).toBe(20);
        await whole;
      });
      expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
    });
  });

  it("records nothing for a user's own account", async () => {
    const owner = await user();
    const bob = await user();
    const stub = env.ORG.getByName(owner.principalId);
    await stub.init({
      accountId: owner.principalId,
      kind: "user",
      owner: member(owner),
      epochGen: await allocateEpoch(env.DIRECTORY, owner.principalId),
    });
    await stub.retirePrincipals({
      ids: [bob.principalId],
      jobId: "job_test",
      actor: actorOf(admin),
      ownerCheck: false,
      budget: 500,
    });
    await stub.mirrorMembers();
    expect(await mirrored(owner.principalId)).toEqual({});
  });
});

describe("the daily pass over every organization's members", () => {
  const SETTING = "membership_reconcile";
  const DAY = 24 * 60 * 60 * 1000;

  type Pass = { lastAsked: string | null; started_at: number };
  const state = async (): Promise<Pass | null> => {
    const row = await env.DIRECTORY.prepare("SELECT value FROM deployment_settings WHERE name = ?")
      .bind(SETTING)
      .first<{ value: string }>();
    return row && (JSON.parse(row.value) as Pass);
  };
  const reset = () =>
    env.DIRECTORY.prepare("DELETE FROM deployment_settings WHERE name = ?").bind(SETTING).run();
  const clear = (org: Org) =>
    env.DIRECTORY.prepare("DELETE FROM memberships WHERE org_id = ?").bind(org.id).run();

  async function finish(run: () => Promise<unknown>): Promise<number> {
    for (let runs = 1; runs <= 100; runs++) {
      await run();
      if ((await state())?.lastAsked === null) return runs;
    }
    throw new Error("the pass does not end");
  }
  const runAt =
    (now: number, from: Env = env) =>
    () =>
      reconcileMemberships(from, { now });

  const asking = (mirror: (id: string) => Promise<void>): Env =>
    new Proxy(env, {
      get: (target, prop) =>
        prop === "ORG"
          ? { getByName: (id: string) => ({ mirrorMembers: () => mirror(id) }) }
          : Reflect.get(target, prop),
    });

  it("records the members of organizations that have none recorded, a bounded number a run", async () => {
    await reset();
    const owner = await user();
    const orgs: Org[] = [];
    for (let i = 0; i < 11; i++) orgs.push(await newOrg(owner));
    for (const org of orgs) await clear(org);
    expect(await finish(runAt(1))).toBeGreaterThan(1);
    for (const org of orgs)
      expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
  });

  it("asks each organization once, in order, and goes on where it got to", async () => {
    await reset();
    const owner = await user();
    for (let i = 0; i < 11; i++) await newOrg(owner);
    const asked: string[] = [];
    const counting = asking(async (id) => {
      asked.push(id);
    });
    const runs = await finish(runAt(1, counting));
    expect(asked).toEqual([...new Set(asked)].sort());
    const { n } = (await env.DIRECTORY.prepare(
      "SELECT count(*) AS n FROM principals WHERE type = 'org' AND disabled_at IS NULL",
    ).first<{ n: number }>()) ?? { n: 0 };
    expect(asked).toHaveLength(n);
    expect(runs).toBe(Math.floor(n / 10) + 1);
  });

  it("starts again a day after it started, not before", async () => {
    await reset();
    await newOrg(await user());
    const now = Date.now();
    await finish(runAt(now));
    const asked: string[] = [];
    const counting = asking(async (id) => {
      asked.push(id);
    });
    await reconcileMemberships(counting, { now: now + DAY - 1 });
    expect(asked).toEqual([]);
    await reconcileMemberships(counting, { now: now + DAY });
    expect(asked.length).toBeGreaterThan(0);
    expect((await state())?.started_at).toBe(now + DAY);
  });

  it("goes past an organization that fails, and fails once its others are done", async () => {
    await reset();
    const owner = await user();
    const orgs = [await newOrg(owner), await newOrg(owner)];
    const asked: string[] = [];
    const failing = asking(async (id) => {
      asked.push(id);
      if (id === orgs[0]?.id) throw new Error("away");
    });
    let failed = 0;
    await finish(() => runAt(1, failing)().catch(() => failed++));
    expect(failed).toBe(1);
    expect(asked).toEqual(expect.arrayContaining(orgs.map((o) => o.id)));
  });

  it("leaves out organizations that are disabled", async () => {
    await reset();
    const org = await newOrg(await user());
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(org.id)
      .run();
    const asked: string[] = [];
    const counting = asking(async (id) => {
      asked.push(id);
    });
    await finish(runAt(1, counting));
    expect(asked).not.toContain(org.id);
  });

  it("runs with the deployment's maintenance", async () => {
    await reset();
    const owner = await user();
    const org = await newOrg(owner);
    await clear(org);
    await finish(() => env.MAINTENANCE.getByName(MAINTENANCE_OBJECT).run());
    expect(await mirrored(org.id)).toEqual({ [owner.principalId]: "owner" });
  });
});
