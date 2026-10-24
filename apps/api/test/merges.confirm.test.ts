// The organization's confirmation at a merge's commit: the reviewers whose
// approvals the rules count are confirmed by the organization's object,
// with no await between its answer and the commit, so an approval whose
// access was revoked after the repository's ACL snapshot was pulled (its
// invalidation not arrived) counts no more; the rules are judged again with
// the confirmed roles, a merge refused only when the approvals left do not
// suffice. Merge, squash and rebase (finished by a request or the alarm).
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

type Merged = { sha?: string; merged?: boolean; code?: string; detail?: string };

let admin: Who;
let owner: Who;
let alice: Who;
let bob: Who;
let carol: Who;
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

async function commitOn(branch: string, content: string): Promise<string> {
  return (
    await ok<{ commit: { sha: string } }>(
      api("POST", `${path}/file-commits`, owner.token, {
        branch,
        message: "change",
        changes: [{ path: "a.txt", content }],
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
    // The repository's owner, as its API path names it.
    path: `/${path.split("/")[2]}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

const ruleset = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ok(
    api("POST", `${path}/rulesets`, owner.token, {
      name: uniqueId("reviews"),
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [{ type: "pull_request", parameters }],
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

/**
 * Changes the organization's own records as `change` does and gives them a
 * new ACL version, without telling the repository (its invalidation is
 * still on its way): the repository's snapshot, pulled within the write
 * window, still says what it said.
 */
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

/** Records the principals of every confirmation the repository asks for, as it asks. */
async function recordConfirmations(): Promise<string[][]> {
  const calls: string[][] = [];
  await inRepo(stub(), (r: RepoDO) => {
    const real = r.confirmRoles;
    r.confirmRoles = (accountId, principals) => {
      calls.push([...principals].sort());
      return real(accountId, principals);
    };
  });
  return calls;
}

beforeAll(async () => {
  admin = await user(true);
});

beforeEach(async () => {
  owner = await user();
  [alice, bob, carol] = [await user(), await user(), await user()];
  const login = uniqueId("org").slice(0, 39);
  const made = await ok<{ id: string }>(
    api("POST", "/admin/organizations", admin.token, { login, admin: owner.handle }),
  );
  org = { login, id: made.id };
  for (const m of [alice, bob, carol])
    await ok(api("PUT", `/orgs/${login}/memberships/${m.handle}`, owner.token, {}));
  repo = await ok<{ id: string; name: string }>(
    api("POST", `/orgs/${login}/repos`, owner.token, { name: uniqueId("r") }),
  );
  path = `/repos/${login}/${repo.name}`;
  // Core (alice, carol) writes to the repository; bob writes as a collaborator.
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
  await branchAt("feature", await commitOn("main", "one\n"));
  await commitOn("feature", "one\ntwo\n");
  await ok(
    api("POST", `${path}/pulls`, owner.token, { title: "A change", head: "feature", base: "main" }),
  );
});

describe("a merge's confirmation by the organization", () => {
  for (const method of ["merge", "squash", "rebase"] as const)
    it(`counts no approval of a team member removed since the snapshot (${method})`, async () => {
      await ruleset({ required_approving_review_count: 1 });
      await approve(alice);
      const calls = await recordConfirmations();
      const before = await mainTip();
      await leavesCore(alice);
      const refused = await merge(method);
      expect(refused.status).toBe(405);
      expect(refused.body).toMatchObject({ code: "merge_refused" });
      expect(refused.body.detail).toContain("1 approving review is required (0 given)");
      expect(await mainTip()).toBe(before);
      expect(calls).toEqual([[alice.principalId]]);
      // Asked again: the repository decides from fresh roles now, and refuses before any commit.
      const again = await merge(method);
      expect(again.body.detail).toContain("1 approving review is required (0 given)");
      expect(await mainTip()).toBe(before);
    });

  it("counts no approval whose team's grant was lowered to read", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    await quietly((sql) =>
      sql.exec("UPDATE team_repos SET role = 'read' WHERE team_id = ?", core.id),
    );
    const refused = await merge("squash");
    expect(refused.body).toMatchObject({ code: "merge_refused" });
    expect(refused.body.detail).toContain("1 approving review is required (0 given)");
  });

  it("counts no approval of a collaborator removed since the snapshot", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(bob);
    await quietly((sql) =>
      sql.exec("DELETE FROM collaborators WHERE principal_id = ?", bob.principalId),
    );
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "merge_refused" });
  });

  it("merges on the approvals left when they suffice, and refuses when they do not", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    await approve(bob);
    const calls = await recordConfirmations();
    await leavesCore(alice);
    const merged = await merge();
    expect(merged.status).toBe(200);
    expect(calls).toEqual([[alice.principalId, bob.principalId].sort()]);
  });

  it("refuses two approvals required when one of them is revoked", async () => {
    await ruleset({ required_approving_review_count: 2 });
    await approve(alice);
    await approve(bob);
    await leavesCore(alice);
    const refused = await merge();
    expect(refused.body.detail).toContain("2 approving reviews are required (1 given)");
  });

  it("refuses when the only approval after the last push is revoked, none required", async () => {
    await ruleset({ required_approving_review_count: 0, require_last_push_approval: true });
    await approve(alice);
    await leavesCore(alice);
    const refused = await merge();
    expect(refused.body.detail).toContain("the last push must be approved");
  });

  it("confirms only the approvals that count: not a stale one, nor an agent's when agents' do not", async () => {
    await ruleset({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true });
    // Carol approves the head a push then replaces; alice's agent approves; bob approves.
    await approve(carol);
    await commitOn("feature", "one\ntwo\nthree\n");
    const agent = await agentFor(alice, ["pull_requests:write", "contents:read"]);
    await approve(alice, agent.delegated);
    await approve(bob);
    const calls = await recordConfirmations();
    await leavesCore(carol);
    await leavesCore(alice);
    expect((await merge()).status).toBe(200);
    expect(calls).toEqual([[bob.principalId]]);
  });

  it("asks nothing when the merger bypasses the rule, nor for an evaluated ruleset", async () => {
    await ruleset(
      { required_approving_review_count: 1 },
      { bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin" }] },
    );
    await ruleset({ required_approving_review_count: 1 }, { enforcement: "evaluate" });
    await approve(alice);
    const calls = await recordConfirmations();
    await leavesCore(alice);
    expect((await merge()).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("asks nothing when no approval is required, nor with no approval to count", async () => {
    await ruleset({ required_approving_review_count: 0 });
    await approve(alice);
    const calls = await recordConfirmations();
    expect((await merge()).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("asks nothing for a user's repository (a user's account has no teams)", async () => {
    repo = await ok<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    path = `/repos/${owner.handle}/${repo.name}`;
    await ok(
      api("PUT", `${path}/collaborators/${bob.handle}`, owner.token, { permission: "push" }),
    );
    await branchAt("feature", await commitOn("main", "one\n"));
    await commitOn("feature", "one\ntwo\n");
    await ok(
      api("POST", `${path}/pulls`, owner.token, { title: "Mine", head: "feature", base: "main" }),
    );
    await ruleset({ required_approving_review_count: 1 });
    await approve(bob);
    const calls = await recordConfirmations();
    expect((await merge()).status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("refuses a user's repository that changes hands between its judgement and its commit", async () => {
    repo = await ok<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    );
    path = `/repos/${owner.handle}/${repo.name}`;
    await ok(
      api("PUT", `${path}/collaborators/${bob.handle}`, owner.token, { permission: "push" }),
    );
    await branchAt("feature", await commitOn("main", "one\n"));
    await commitOn("feature", "one\ntwo\n");
    await ok(
      api("POST", `${path}/pulls`, owner.token, { title: "Mine", head: "feature", base: "main" }),
    );
    await ruleset({ required_approving_review_count: 1 });
    await approve(bob);
    const before = await mainTip();
    // Judged as a user's repository; by its commit, another ownership (as a transfer makes).
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeHooks = {
        beforeFinish: async () => {
          r.mergeHooks = {};
          r.git.context.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
        },
      };
    });
    const refused = await merge();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "authorization_unavailable" });
    expect(await mainTip()).toBe(before);
  });

  it("counts no approval of an agent's whose owner lost access, when agents' approvals count", async () => {
    await ruleset({ required_approving_review_count: 1, allow_agent_approvals: true });
    // An agent of alice's with write access of its own (in Core, put in the organization's
    // records directly, the repository told), reviewing with its own token: its approval is
    // alice's (a user's agents share her root), so alice leaving Core takes it, though the
    // agent stays in Core itself.
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
    const calls = await recordConfirmations();
    await leavesCore(alice);
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "merge_refused" });
    expect(refused.body.detail).toContain("1 approving review is required (0 given)");
    expect(calls).toEqual([[alice.principalId]]);
  });

  it("answers a rule's refusal as one, whatever its ruleset is named", async () => {
    await ruleset(
      { required_approving_review_count: 1 },
      { name: "the reviewers' access could not be confirmed; try the merge again" },
    );
    await approve(alice);
    await leavesCore(alice);
    const refused = await merge();
    expect(refused.status).toBe(405);
    expect(refused.body).toMatchObject({ code: "merge_refused" });
  });

  it("refuses as unavailable when the organization cannot answer, the base unchanged", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    const before = await mainTip();
    await inRepo(stub(), (r: RepoDO) => {
      r.confirmRoles = () => Promise.reject(new Error("unreachable"));
    });
    const refused = await merge();
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "authorization_unavailable" });
    expect(await mainTip()).toBe(before);
  });

  it("refuses as unavailable an answer older than one the repository has seen", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    await inRepo(stub(), (r: RepoDO) => {
      const real = r.confirmRoles;
      r.confirmRoles = async (accountId, principals) => {
        const answer = await real(accountId, principals);
        return { ...answer, version: answer.version - 1 };
      };
    });
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "authorization_unavailable" });
  });

  it("refuses as unavailable when the repository changes hands while it is asked", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    await inRepo(stub(), (r: RepoDO) => {
      const real = r.confirmRoles;
      r.confirmRoles = async (accountId, principals) => {
        const answer = await real(accountId, principals);
        r.git.context.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
        return answer;
      };
    });
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "authorization_unavailable" });
  });

  it("refuses more reviewers than it confirms before storing anything, asking nothing", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    await approve(bob);
    const calls = await recordConfirmations();
    await inRepo(stub(), (r: RepoDO) => {
      r.mergeConfirmPolicy = { ...r.mergeConfirmPolicy, maxReviewers: 1 };
    });
    const refused = await merge();
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "too_many_reviewers" });
    expect(calls).toEqual([]);
  });

  it("raises the ACL floor after the commit, never inside it: an unrelated change merges", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    // A newer ACL version that changes nothing for this merge.
    await quietly(() => {});
    expect((await merge()).status).toBe(200);
    // The snapshot is below the answer's version now: the next decision pulls a fresh one.
    expect(await inRepo(stub(), (r: RepoDO) => r.acl.basis())).toBe("unknown");
  });

  it("raises the ACL floor after a refused merge too", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    await leavesCore(alice);
    expect((await merge()).body.code).toBe("merge_refused");
    expect(await inRepo(stub(), (r: RepoDO) => r.acl.basis())).toBe("unknown");
  });
});

describe("a rebase merge the alarm finishes", () => {
  const saga = () =>
    inRepo(
      stub(),
      (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ state: string }>("SELECT state FROM merge_sagas WHERE pr_number = 1")
          .toArray()[0]?.state,
    );
  async function drive() {
    for (let i = 0; i < 40; i++) {
      if ((await saga()) !== "running") return;
      await inRepo(stub(), async (r: RepoDO) => {
        r.git.context.storage.sql.exec(
          "UPDATE jobs SET next_run_at = ? WHERE state = 'queued'",
          r.git.context.now(),
        );
        await r.alarm();
      });
    }
    throw new Error("the saga did not finish");
  }

  it("confirms afresh at the alarm's commit, and fails with the rule's reason", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    const calls = await recordConfirmations();
    // The request stops before its commit; access is revoked before the alarm commits.
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {};
          throw new Error("stopped before the commit");
        },
      };
    });
    const before = await mainTip();
    expect((await merge("rebase")).body).toMatchObject({ code: "merge_in_progress" });
    expect(calls).toEqual([]);
    await leavesCore(alice);
    await drive();
    expect(await saga()).toBe("failed");
    expect(calls).toEqual([[alice.principalId]]);
    expect(await mainTip()).toBe(before);
    // Its failure answered once, then a new attempt is judged afresh.
    const failed = await merge("rebase");
    expect(failed.body).toMatchObject({ code: "merge_refused" });
    expect(failed.body.detail).toContain("1 approving review is required (0 given)");
  });

  it("fails as unavailable when the repository changes hands after the alarm judged it", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    const calls = await recordConfirmations();
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {
            // At the alarm: judged under this ownership, then another before the commit.
            beforeFinalize: async () => {
              r.rebaseHooks = {};
              r.git.context.storage.sql.exec("UPDATE repo_meta SET owner_gen = owner_gen + 1");
            },
          };
          throw new Error("stopped before the commit");
        },
      };
    });
    const before = await mainTip();
    expect((await merge("rebase")).body).toMatchObject({ code: "merge_in_progress" });
    await drive();
    expect(await saga()).toBe("failed");
    expect(calls).toEqual([]);
    expect(await mainTip()).toBe(before);
    expect((await merge("rebase")).body).toMatchObject({ code: "authorization_unavailable" });
  });

  it("confirms again for a push it makes again", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await approve(alice);
    const calls = await recordConfirmations();
    await inRepo(stub(), (r: RepoDO) => {
      r.rebaseHooks = {
        beforeFinalize: async () => {
          r.rebaseHooks = {};
          // As a runner that lost the job does: the push discarded, made again later.
          const [row] = r.git.context.storage.sql
            .exec<{ upload_json: string }>("SELECT upload_json FROM merge_sagas")
            .toArray();
          r.git.uploads.abort(
            (JSON.parse(row?.upload_json ?? "{}") as { uploadId: string }).uploadId,
          );
          throw new Error("taken over");
        },
      };
    });
    expect((await merge("rebase")).body).toMatchObject({ code: "merge_in_progress" });
    await drive();
    expect(await saga()).toBe("done");
    // Only the attempt that commits asks: one confirmation.
    expect(calls).toEqual([[alice.principalId]]);
  });
});
