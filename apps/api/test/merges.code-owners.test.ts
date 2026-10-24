// Requiring code owners' review: a ruleset's pull_request rule with
// require_code_owner_review refuses a merge until every CODEOWNERS rule
// deciding a changed path has an approval from one of its owners (a user,
// a user's agent when agents' approvals count, or a member of an owner
// team), owners qualifying only with write access; worked out from the
// evaluation of the pull request's current base tip, head and file, fail
// closed when it is not, and confirmed with the organization at the commit
// (owner teams' grants and memberships included).
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import type { OrgDO } from "../src/do/OrgDO.js";
import type { RepoDO } from "../src/do/RepoDO.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Merged = { sha?: string; code?: string; detail?: string };

let admin: Who;
let owner: Who;
let alice: Who;
let bob: Who;
let carol: Who;
let dave: Who;
let org: { login: string; id: string };
let repo: { id: string; name: string };
let path: string;
let core: { id: string; slug: string };

const stub = () => env.REPO.getByName(repo.id);
const orgStub = () => env.ORG.getByName(org.id);

async function ok<T = Record<string, unknown>>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

/** Writes `files` (null deletes) on `branch` as one commit; its sha. */
async function commit(branch: string, files: Record<string, string | null>): Promise<string> {
  return (
    await ok<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch,
        message: "change",
        changes: Object.entries(files).map(([p, content]) =>
          content === null ? { path: p, delete: true } : { path: p, content },
        ),
      }),
    )
  ).commit.sha;
}

async function branchAt(name: string, sha: string): Promise<void> {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${path.split("/")[2]}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

/** Runs the repository's due jobs, a few rounds, everything due now. */
async function runJobs(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++)
    await inRepo(stub(), async (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const now = r.git.context.now();
      sql.exec("UPDATE jobs SET next_run_at = ? WHERE state = 'queued'", now);
      sql.exec("UPDATE code_owner_jobs SET requested_at = ?", now);
      await r.alarm();
    });
}

/** The default CODEOWNERS of these tests. */
const codeowners = () =>
  [
    `/src/ @${alice.handle}`,
    `/docs/ @${org.login}/${core.slug}`,
    `/lib/ @${dave.handle}`,
    "/free/",
  ].join("\n");

/**
 * `main` with CODEOWNERS (`file`, or none when null) and one file in each
 * place, a pull request from `feature` changing `changes`, its code owners
 * worked out (unless `settle` is false).
 */
async function pullChanging(
  changes: Record<string, string>,
  file: string | null = codeowners(),
  settle = true,
): Promise<void> {
  const base: Record<string, string | null> = {
    "src/a.ts": "a\n",
    "docs/a.md": "a\n",
    "lib/a.c": "a\n",
    "free/a.txt": "a\n",
    "other.txt": "a\n",
  };
  if (file !== null) base[".github/CODEOWNERS"] = `${file}\n`;
  await branchAt("feature", await commit("main", base));
  await commit("feature", changes);
  await ok(
    api("POST", `${path}/pulls`, owner.token, { title: "Change", head: "feature", base: "main" }),
  );
  if (settle) await runJobs();
}

const ruleset = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ok(
    api("POST", `${path}/rulesets`, owner.token, {
      name: uniqueId("owners"),
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [
        { type: "pull_request", parameters: { require_code_owner_review: true, ...parameters } },
      ],
      ...extra,
    }),
  );
const head = async () =>
  (await ok<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token))).head.sha;
const approve = async (who: Who, token = who.token) =>
  ok(api("POST", `${path}/pulls/1/reviews`, token, { commit_id: await head(), event: "APPROVE" }));
const merge = (method: "merge" | "squash" | "rebase" = "merge") =>
  json<Merged>(api("PUT", `${path}/pulls/1/merge`, owner.token, { merge_method: method }));
const mainTip = async () =>
  (await ok<{ sha: string }>(api("GET", `${path}/commits/main`, owner.token))).sha;

/** The organization's records changed as `change` does, a new ACL version, the repository not told. */
const quietly = (change: (sql: SqlStorage) => void) =>
  runInDurableObject(orgStub(), (_: OrgDO, state) => {
    change(state.storage.sql);
    state.storage.sql.exec("UPDATE org_meta SET acl_version = acl_version + 1");
  });
const leavesCore = (who: Who) =>
  quietly((sql) =>
    sql.exec(
      "DELETE FROM team_members WHERE team_id = ? AND principal_id = ?",
      core.id,
      who.principalId,
    ),
  );

/** Records what each confirmation the repository asks for reads, as it asks. */
async function recordConfirmations(): Promise<{ principals: string[]; teams: string[] }[]> {
  const calls: { principals: string[]; teams: string[] }[] = [];
  await inRepo(stub(), (r: RepoDO) => {
    const real = r.confirmRoles;
    r.confirmRoles = (accountId, principals, teams, pairs) => {
      calls.push({ principals: [...principals].sort(), teams: [...(teams ?? [])].sort() });
      return real(accountId, principals, teams, pairs);
    };
  });
  return calls;
}

beforeAll(async () => {
  admin = await user(true);
});

beforeEach(async () => {
  owner = await user();
  [alice, bob, carol, dave] = [await user(), await user(), await user(), await user()];
  const login = uniqueId("org").slice(0, 39);
  const made = await ok<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  org = { login, id: made.id };
  for (const m of [alice, bob, carol, dave])
    await ok(api("PUT", `/orgs/${login}/memberships/${m.handle}`, owner.token, {}));
  repo = await ok<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${login}/${repo.name}`;
  const team = await ok<{ slug: string }>(
    api("POST", `/orgs/${login}/teams`, owner.token, { name: "Core" }),
  );
  for (const m of [alice, carol])
    await ok(api("PUT", `/orgs/${login}/teams/${team.slug}/memberships/${m.handle}`, owner.token));
  await ok(
    api("PUT", `/orgs/${login}/teams/${team.slug}/repos/${login}/${repo.name}`, owner.token, {
      permission: "push",
    }),
  );
  const id = await runInDurableObject(
    orgStub(),
    (_: OrgDO, state) =>
      state.storage.sql
        .exec<{ team_id: string }>("SELECT team_id FROM teams WHERE slug = ?", team.slug)
        .one().team_id,
  );
  core = { id, slug: team.slug };
  await ok(api("PUT", `${path}/collaborators/${bob.handle}`, owner.token, { permission: "push" }));
});

describe("requiring code owners' review", () => {
  it("merges once a user owner approves, refusing a non-owner's approval with the rule's line", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ruleset({});
    await approve(bob);
    const refused = await merge();
    expect(refused).toMatchObject({ status: 405, body: { code: "merge_refused" } });
    expect(refused.body.detail).toContain(
      `code owners must approve: line 1 (src/a.ts: @${alice.handle})`,
    );
    await approve(alice);
    expect((await merge()).status).toBe(200);
  });

  for (const method of ["merge", "squash", "rebase"] as const)
    it(`merges once a member of an owner team approves (${method})`, async () => {
      await pullChanging({ "docs/a.md": "b\n" });
      await ruleset({});
      await approve(bob);
      expect((await merge(method)).body.detail).toContain(`@${org.login}/${core.slug}`);
      await approve(carol);
      expect((await merge(method)).status).toBe(200);
    });

  it("refuses at the commit a member removed from the owner team who keeps write elsewhere", async () => {
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging({ "docs/a.md": "b\n" });
    await ruleset({});
    await approve(carol);
    const calls = await recordConfirmations();
    const before = await mainTip();
    // Carol leaves after the merge was prepared (memberships read then), before its commit.
    await inRepo(stub(), (r: RepoDO) => {
      const recorded = r.confirmRoles;
      r.confirmRoles = async (...args) => {
        await leavesCore(carol);
        return recorded(...args);
      };
    });
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "merge_refused" });
    expect(refused.body.detail).toContain("code owners must approve: line 2");
    expect(await mainTip()).toBe(before);
    expect(calls).toEqual([{ principals: [carol.principalId], teams: [core.id] }]);
  });

  for (const when of ["before the merge", "between its preparation and its commit"])
    it(`refuses an owner team whose grant was lowered ${when}, its member keeping write`, async () => {
      await ok(
        api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
      );
      await pullChanging({ "docs/a.md": "b\n" });
      await ruleset({});
      await approve(carol);
      const lowered = () =>
        quietly((sql) =>
          sql.exec("UPDATE team_repos SET role = 'read' WHERE team_id = ?", core.id),
        );
      if (when === "before the merge") await lowered();
      else
        await inRepo(stub(), (r: RepoDO) => {
          const real = r.confirmRoles;
          r.confirmRoles = async (...args) => {
            await lowered();
            return real(...args);
          };
        });
      const refused = await merge();
      expect(refused.body).toMatchObject({ code: "merge_refused" });
      expect(refused.body.detail).toContain("line 2");
    });

  it("merges on another member's approval when one member leaves the team", async () => {
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging({ "docs/a.md": "b\n" });
    await ruleset({});
    await approve(carol);
    await approve(alice);
    await leavesCore(carol);
    expect((await merge()).status).toBe(200);
  });

  it("needs owners' approval with no approvals required, and none for ownerless or unmatched paths", async () => {
    await pullChanging({ "free/a.txt": "b\n", "other.txt": "b\n" });
    await ruleset({ required_approving_review_count: 0 });
    expect((await merge()).status).toBe(200);
  });

  it("refuses a rule whose only owner cannot write, naming why", async () => {
    await pullChanging({ "lib/a.c": "b\n" });
    await ruleset({});
    const refused = await merge();
    expect(refused.body.detail).toContain(
      `line 3 (lib/a.c): no qualifying owner (@${dave.handle}: no write access)`,
    );
  });

  it("refuses a rule naming no one who exists, or another organization's team", async () => {
    await pullChanging(
      { "src/a.ts": "b\n" },
      ["/src/ @no-such-person-here @someone-else/core"].join("\n"),
    );
    await ruleset({});
    const refused = await merge();
    expect(refused.body.detail).toContain(
      "no qualifying owner (@no-such-person-here: no such user;",
    );
    expect(refused.body.detail).toContain("@someone-else/core: not this repository's organization");
  });

  it("needs nothing without CODEOWNERS at the base, even one added by the pull request", async () => {
    await pullChanging({ ".github/CODEOWNERS": `* @${alice.handle}\n`, "src/a.ts": "b\n" }, null);
    await ruleset({});
    expect((await merge()).status).toBe(200);
  });

  it("refuses while code owners are being worked out, then merges once they are", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, codeowners(), false);
    await ruleset({});
    await approve(alice);
    const refused = await merge();
    expect(refused.body.detail).toContain("code owners are still being worked out");
    await runJobs();
    expect((await merge()).status).toBe(200);
  });

  it("refuses while CODEOWNERS has errors", async () => {
    await pullChanging({ "src/a.ts": "b\n" }, `/src/ @${alice.handle}\n/x/ not-an-owner`);
    await ruleset({});
    await approve(alice);
    expect((await merge()).body.detail).toContain("CODEOWNERS has 1 error");
  });

  it("counts no approval of an owner's agent disabled since, for ownership or count", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ruleset({ allow_agent_approvals: true });
    const agent = await agentFor(alice, ["pull_requests:write", "contents:read"]);
    await approve(alice, agent.delegated);
    await ok(api("DELETE", `/agents/${agent.handle}`, alice.token));
    const refused = await merge();
    expect(refused.body.detail).toContain(
      `code owners must approve: line 1 (src/a.ts: @${alice.handle})`,
    );
  });

  it("counts no approval of an owner's agent reviewing with its own token once it is disabled", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ruleset({ allow_agent_approvals: true });
    // An agent of alice's with write access of its own (in Core, put in the organization's
    // records directly, the repository told): its own token's approval stands for alice.
    const agent = await agentFor(alice, ["pull_requests:write", "contents:read"]);
    const { epoch, version } = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
        agent.id,
        agent.handle,
      );
      sql.exec(
        "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
        core.id,
        agent.id,
      );
      return sql
        .exec<{ epoch: number; version: number }>(
          `UPDATE org_meta SET acl_version = acl_version + 1
           RETURNING epoch_gen AS epoch, acl_version AS version`,
        )
        .one();
    });
    await stub().invalidateAcl(org.id, epoch, version);
    await approve(alice, agent.own);
    // Counted for alice while it is active.
    const before = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ id: string }>("SELECT reviewer_id AS id FROM reviews")
        .toArray()
        .map((x) => x.id),
    );
    expect(before).toEqual([agent.id]);
    await ok(api("DELETE", `/agents/${agent.handle}`, alice.token));
    const refused = await merge();
    expect(refused.body.detail).toContain(
      `code owners must approve: line 1 (src/a.ts: @${alice.handle})`,
    );
  });

  it("refuses when its code owners are worked out again between the decision and the commit", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ruleset({});
    await approve(alice);
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeHooks = {
        beforeFinish: async () => {
          r.mergeHooks = {};
          r.git.context.storage.sql.exec(
            "UPDATE code_owner_pointers SET eval_id = NULL, outcome = 'unreadable'",
          );
        },
      };
    });
    expect((await merge()).body).toMatchObject({ code: "pull_changed" });
  });

  it("prepares nothing for a merger who bypasses the rule, nor refuses for an evaluated ruleset", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ruleset({}, { bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin" }] });
    await ruleset({}, { enforcement: "evaluate" });
    const calls = await recordConfirmations();
    expect((await merge()).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("refuses more owners than a merge resolves, before storing anything", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await ruleset({});
    await approve(alice);
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerMergePolicy = { ...r.codeOwnerMergePolicy, maxHandles: 0 };
    });
    const refused = await merge();
    expect(refused).toMatchObject({ status: 422, body: { code: "code_owners_too_large" } });
  });

  it("fails an alarm-finished rebase whose owner team lost its member before the commit", async () => {
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging({ "docs/a.md": "b\n" });
    await ruleset({});
    await approve(carol);
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {};
          throw new Error("stopped before the commit");
        },
      };
    });
    expect((await merge("rebase")).body).toMatchObject({ code: "merge_in_progress" });
    await leavesCore(carol);
    await runJobs(10);
    const failed = await merge("rebase");
    expect(failed.body).toMatchObject({ code: "merge_refused" });
    expect(failed.body.detail).toContain("line 2");
  });
});

describe("code owners' review, its bounds and what it confirms", () => {
  it("refuses when an agent and its user, both in the owner team, leave it before the commit", async () => {
    await pullChanging({ "docs/a.md": "b\n" });
    await ruleset({ allow_agent_approvals: true });
    // Alice's agent, in Core besides her and with write of its own elsewhere; alice keeps write
    // as a collaborator: only their memberships are taken.
    const agent = await agentFor(alice, ["pull_requests:write", "contents:read"]);
    await ok(
      api("PUT", `${path}/collaborators/${alice.handle}`, owner.token, { permission: "push" }),
    );
    const { epoch, version } = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
      const sql = state.storage.sql;
      sql.exec(
        "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
        agent.id,
        agent.handle,
      );
      sql.exec(
        "INSERT INTO team_members (team_id, principal_id, added_at) VALUES (?, ?, 0)",
        core.id,
        agent.id,
      );
      sql.exec(
        "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, 'write', 0)",
        repo.id,
        agent.id,
        agent.handle,
      );
      return sql
        .exec<{ epoch: number; version: number }>(
          `UPDATE org_meta SET acl_version = acl_version + 1
           RETURNING epoch_gen AS epoch, acl_version AS version`,
        )
        .one();
    });
    await stub().invalidateAcl(org.id, epoch, version);
    await approve(alice, agent.own);
    await inRepo(stub(), (r: RepoDO) => {
      const real = r.confirmRoles;
      r.confirmRoles = async (...args) => {
        await leavesCore({ ...alice, principalId: agent.id });
        await leavesCore(alice);
        return real(...args);
      };
    });
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "merge_refused" });
    expect(refused.body.detail).toContain("line 2");
  });

  it("counts toward its membership bound only the approvals that can own: not a stale one", async () => {
    await ok(
      api("PUT", `${path}/collaborators/${carol.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging({ "docs/a.md": "b\n" });
    await ruleset({ dismiss_stale_reviews_on_push: true });
    await approve(bob);
    await commit("feature", { "docs/a.md": "c\n" });
    await runJobs();
    await approve(carol);
    // One team, one reviewer who can own: one membership; bob's stale approval is not asked about.
    await inRepo(stub(), (r: RepoDO) => {
      r.codeOwnerMergePolicy = { ...r.codeOwnerMergePolicy, maxPairs: 1 };
    });
    expect((await merge()).status).toBe(200);
  });

  it("judges an evaluated rule on memberships read for it too, beside an enforcing one", async () => {
    // Active: stale approvals count, agents' do not. Evaluated: stale ones dismissed, agents' count.
    await ok(
      api("PUT", `/orgs/${org.login}/teams/${core.slug}/memberships/${bob.handle}`, owner.token),
    );
    await pullChanging({ "docs/a.md": "b\n" });
    await ruleset({});
    await ruleset(
      { dismiss_stale_reviews_on_push: true, allow_agent_approvals: true },
      { enforcement: "evaluate" },
    );
    await approve(alice);
    await commit("feature", { "docs/a.md": "c\n" });
    await runJobs();
    // Only bob's agent can satisfy the evaluated rule: bob's membership must be read for it.
    const agent = await agentFor(bob, ["pull_requests:write", "contents:read"]);
    await approve(bob, agent.delegated);
    expect((await merge()).status).toBe(200);
    const evaluations = await inRepo(stub(), (r: RepoDO) =>
      r.git.context.storage.sql
        .exec<{ evaluations: string }>(
          "SELECT evaluations FROM rule_suites ORDER BY rowid DESC LIMIT 1",
        )
        .toArray()
        .map((row) => row.evaluations),
    );
    expect(evaluations.join("")).not.toContain("code owners");
  });

  for (const rules of [
    "no code owners required",
    "code owners only evaluated",
    "a bypassing merger",
  ])
    it(`keeps a merge going when an own-token agent loses its own grant before the commit (${rules})`, async () => {
      await pullChanging({ "src/a.ts": "b\n" });
      const counted = { required_approving_review_count: 1, allow_agent_approvals: true };
      if (rules === "no code owners required")
        await ruleset({ ...counted, require_code_owner_review: false });
      else if (rules === "code owners only evaluated")
        await ruleset({ ...counted }, { enforcement: "evaluate" });
      else
        await ruleset(counted, {
          bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin" }],
        });
      if (rules !== "no code owners required")
        await ruleset({ ...counted, require_code_owner_review: false });
      // An agent of alice's with write of its own (a collaborator grant put in directly).
      const agent = await agentFor(alice, ["pull_requests:write", "contents:read"]);
      await ok(
        api("PUT", `${path}/collaborators/${alice.handle}`, owner.token, { permission: "push" }),
      );
      const grant = async (role: string | null) => {
        const { epoch, version } = await runInDurableObject(orgStub(), (_: OrgDO, state) => {
          const sql = state.storage.sql;
          if (role === null) sql.exec("DELETE FROM collaborators WHERE principal_id = ?", agent.id);
          else {
            sql.exec(
              "INSERT INTO members (principal_id, handle, role, added_at) VALUES (?, ?, 'member', 0)",
              agent.id,
              agent.handle,
            );
            sql.exec(
              "INSERT INTO collaborators (repo_id, principal_id, handle, role, added_at) VALUES (?, ?, ?, ?, 0)",
              repo.id,
              agent.id,
              agent.handle,
              role,
            );
          }
          return sql
            .exec<{ epoch: number; version: number }>(
              `UPDATE org_meta SET acl_version = acl_version + 1
               RETURNING epoch_gen AS epoch, acl_version AS version`,
            )
            .one();
        });
        return { epoch, version };
      };
      const given = await grant("write");
      await stub().invalidateAcl(org.id, given.epoch, given.version);
      await approve(alice, agent.own);
      // Before the commit: the agent's own grant goes, the repository told and its roles pulled
      // again; alice still writes, so her root's approval still counts.
      await inRepo(stub(), (r: RepoDO) => {
        r.mergeHooks = {
          beforeFinish: async () => {
            r.mergeHooks = {};
            const taken = await grant(null);
            r.acl.invalidate(org.id, taken.epoch, taken.version);
            await r.acl.roleOf(alice.principalId, "write");
          },
        };
      });
      expect((await merge()).status).toBe(200);
    });

  for (const required of [false, true])
    it(`bounds the principals a confirmation reads only for enforced code owners (${required ? "enforced" : "none"})`, async () => {
      await pullChanging({ "src/a.ts": "b\n" });
      await ruleset({ required_approving_review_count: 1, require_code_owner_review: required });
      await approve(alice);
      await approve(bob);
      await inRepo(stub(), (r: RepoDO) => {
        r.mergeConfirmPolicy = { ...r.mergeConfirmPolicy, maxPrincipals: 1 };
      });
      const answer = await merge();
      if (required)
        expect(answer).toMatchObject({ status: 422, body: { code: "code_owners_too_large" } });
      else expect(answer.status).toBe(200);
    });

  it("discards the rebase's stored push when its own preparation at the finish refuses", async () => {
    await pullChanging({ "src/a.ts": "b\n" });
    await commit("main", { "other.txt": "moved\n" });
    await runJobs();
    await ruleset({});
    await approve(alice);
    // The request's preparation fits; the saga's own, after it stored its push, does not.
    await inRepo(stub(), (r: RepoDO) => {
      let asked = 0;
      const policy = r.codeOwnerMergePolicy;
      r.codeOwnerMergePolicy = {
        ...policy,
        get maxHandles() {
          return asked++ === 0 ? policy.maxHandles : 0;
        },
      };
    });
    const refused = await merge("rebase");
    expect(refused.body).toMatchObject({ code: "code_owners_too_large" });
    const live = await inRepo(
      stub(),
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM uploads WHERE state IN ('open', 'indexing', 'indexed')",
          )
          .one().n,
    );
    expect(live).toBe(0);
  });

  it("finds an owner team by its slug's index", async () => {
    const plan = await runInDurableObject(orgStub(), (_: OrgDO, state) =>
      state.storage.sql
        .exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT team_id FROM teams WHERE slug = ?",
          "core",
        )
        .toArray()
        .map((r) => r.detail)
        .join("\n"),
    );
    expect(plan).toMatch(/USING INDEX/);
    expect(plan).not.toMatch(/SCAN teams/);
  });
});

describe("code owners in a user's repository", () => {
  it("takes user owners, and no team as an owner", async () => {
    repo = await ok<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    path = `/repos/${owner.handle}/${repo.name}`;
    await ok(
      api("PUT", `${path}/collaborators/${alice.handle}`, owner.token, { permission: "push" }),
    );
    await pullChanging(
      { "src/a.ts": "b\n", "docs/a.md": "b\n" },
      [`/src/ @${alice.handle}`, `/docs/ @${org.login}/${core.slug}`].join("\n"),
    );
    await ruleset({});
    await approve(alice);
    const refused = await merge();
    expect(refused.body.detail).toContain(
      `line 2 (docs/a.md): no qualifying owner (@${org.login}/${core.slug}: not this repository's organization)`,
    );
    expect(refused.body.detail).not.toContain("line 1");
  });
});
