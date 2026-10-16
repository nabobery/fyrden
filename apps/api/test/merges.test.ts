// Merging pull requests: merge and squash commits made and signed by the
// server through the push path, conflicts and a moved head refused, the
// rulesets judging a merge by the pull request's reviews and last push,
// and the pull request merged in the same transaction.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { MERGE_POLICY, type MergePolicy } from "../src/do/repo/merge.js";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Merged = { sha: string; merged: boolean; message: string; code?: string; detail?: string };
type Pull = {
  number: number;
  state: string;
  merged: boolean;
  merged_at: number | null;
  merge_commit_sha: string | null;
  merged_by: { id: string } | null;
  head: { sha: string };
};
type Commit = {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string };
    committer: { name: string; email: string };
    verification: { verified: boolean; reason: string };
  };
  parents: { sha: string }[];
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const commitOn = async (who: Who, branch: string, changes: Record<string, unknown>[]) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, who.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};

async function branchAt(name: string, sha: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

async function collaborator(permission: "pull" | "triage" | "push"): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission,
  });
  expect(set.status).toBe(200);
  return who;
}

const open = (who: Who, body: Record<string, unknown> = {}) =>
  json<Pull>(
    api("POST", `${path}/pulls`, who.token, {
      title: "Add feature",
      body: "Why it is needed.",
      head: "feature",
      base: "main",
      ...body,
    }),
  );
const merge = (who: Who, body: Record<string, unknown> = {}) =>
  json<Merged>(api("PUT", `${path}/pulls/1/merge`, who.token, body));
const pull = async () => (await json<Pull>(api("GET", `${path}/pulls/1`, owner.token))).body;
const commitAt = async (ref: string) =>
  (await json<Commit>(api("GET", `${path}/commits/${ref}`, owner.token))).body;
const file = async (name: string, ref = "main") => {
  const got = await json<{ content?: string }>(
    api("GET", `${path}/contents/${name}?ref=${ref}`, owner.token),
  );
  return got.body.content === undefined ? undefined : atob(got.body.content.replace(/\n/g, ""));
};
const ruleset = async (parameters: Record<string, unknown>) =>
  expect(
    (
      await api("POST", `${path}/rulesets`, owner.token, {
        name: uniqueId("reviews"),
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
        rules: [{ type: "pull_request", parameters }],
      })
    ).status,
  ).toBe(201);

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const base = await commitOn(owner, "main", [
    { path: "a.txt", content: "one\ntwo\nthree\nfour\nfive\n" },
    { path: "b.txt", content: "bee\n" },
  ]);
  await branchAt("feature", base);
  await commitOn(owner, "feature", [
    { path: "a.txt", content: "one\ntwo\nthree\nfour\nFIVE\n" },
    { path: "c.txt", content: "new\n" },
  ]);
});

describe("merging", () => {
  it("makes a merge commit of the base tip and the head, and marks it merged", async () => {
    const reader = await collaborator("pull");
    expect((await open(reader)).status).toBe(201);
    // The base moves on meanwhile, at a line the head leaves alone.
    const mainTip = await commitOn(owner, "main", [
      { path: "a.txt", content: "ONE\ntwo\nthree\nfour\nfive\n" },
    ]);
    const head = (await pull()).head.sha;

    const merged = await merge(owner);
    expect(merged).toMatchObject({
      status: 200,
      body: { merged: true, message: "Pull Request successfully merged" },
    });
    const made = await commitAt("main");
    expect(made.sha).toBe(merged.body.sha);
    expect(made.parents.map((p) => p.sha)).toEqual([mainTip, head]);
    expect(made.commit.message).toBe(
      `Merge pull request #1 from ${owner.handle}/feature\n\nAdd feature\n`,
    );
    expect(made.commit.committer.name).toBe("Fyrden");
    expect(made.commit.author.email).toContain(owner.principalId);
    expect(await file("a.txt")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(await file("c.txt")).toBe("new\n");

    expect(await pull()).toMatchObject({
      state: "closed",
      merged: true,
      merge_commit_sha: merged.body.sha,
      merged_by: { id: owner.principalId },
    });
    expect((await pull()).merged_at).toBeTypeOf("number");
    // Once merged, nothing more: neither a second merge nor a reopen.
    expect((await merge(owner)).body.code).toBe("not_mergeable");
    expect(
      (await json(api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" }))).body,
    ).toMatchObject({ code: "wrong_state" });

    const rows = await inRepo(env.REPO.getByName(repo.id), (r) => {
      const sql = r.git.context.storage.sql;
      return {
        events: sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map((row) => JSON.parse(row.event) as { type: string; entity: { row: unknown } | null }),
        audit: sql
          .exec<{ action: string; actor_id: string }>(
            "SELECT action, actor_id FROM audit_log ORDER BY at",
          )
          .toArray(),
        reflog: sql
          .exec<{ via: string }>(
            "SELECT via FROM reflog WHERE ref = 'refs/heads/main' ORDER BY seq DESC LIMIT 1",
          )
          .toArray(),
      };
    });
    const closed = rows.events.find((e) => e.type === "pull_request.closed");
    expect(closed?.entity?.row).toMatchObject({ state: "merged", mergeCommitSha: merged.body.sha });
    expect(rows.audit).toContainEqual({
      action: "pull_request.merge",
      actor_id: owner.principalId,
    });
    expect(rows.reflog).toEqual([{ via: "merge" }]);
  });

  it("squashes into one commit on the base tip, by the pull request's author", async () => {
    const writer = await collaborator("push");
    expect((await open(writer, { body: "Squashed body." })).status).toBe(201);
    const mainTip = (await commitAt("main")).sha;

    const merged = await merge(owner, { merge_method: "squash" });
    expect(merged.status).toBe(200);
    const made = await commitAt("main");
    expect(made.parents.map((p) => p.sha)).toEqual([mainTip]);
    expect(made.commit.message).toBe("Add feature (#1)\n\nSquashed body.\n");
    expect(made.commit.author.email).toContain(writer.principalId);
    expect(await file("c.txt")).toBe("new\n");
  });

  it("takes the caller's title and message, and the head it expects", async () => {
    await open(owner);
    const head = (await pull()).head.sha;
    expect((await merge(owner, { sha: "f".repeat(40) })).body).toMatchObject({
      code: "head_moved",
    });
    const merged = await merge(owner, {
      sha: head,
      commit_title: "Ship it",
      commit_message: "All of it.",
    });
    expect(merged.status).toBe(200);
    const made = await commitAt("main");
    expect(made.commit.message).toBe("Ship it\n\nAll of it.\n");
    // The base had not moved: the merged tree is the head's.
    expect(await file("a.txt")).toBe("one\ntwo\nthree\nfour\nFIVE\n");
  });

  it("is authored by the agent acting for a person, who is named as co-author", async () => {
    await open(owner);
    const agent = await agentFor(owner, ["contents:write", "pull_requests:read"]);
    const merged = await json<Merged>(api("PUT", `${path}/pulls/1/merge`, agent.delegated, {}));
    expect(merged.status).toBe(200);
    const made = await commitAt("main");
    expect(made.commit.author.email).toContain(agent.id);
    expect(made.commit.message).toMatch(
      new RegExp(`\\n\\nCo-authored-by: ${owner.handle} <${owner.principalId}@[^>]+>\\n$`),
    );
    expect((await pull()).merged_by).toEqual({ id: owner.principalId });
  });

  it("refuses conflicts, naming the paths, and leaves the pull request open", async () => {
    await open(owner);
    await commitOn(owner, "main", [{ path: "a.txt", content: "one\ntwo\nthree\nfour\nfive!\n" }]);
    const mainTip = (await commitAt("main")).sha;
    const refused = await merge(owner);
    expect(refused).toMatchObject({ status: 405, body: { code: "merge_conflict" } });
    expect(refused.body.detail).toContain("a.txt (content)");
    expect((await commitAt("main")).sha).toBe(mainTip);
    expect(await pull()).toMatchObject({ state: "open", merged: false, merge_commit_sha: null });
  });

  it("refuses a draft, a closed pull request, and callers without write access", async () => {
    const triager = await collaborator("triage");
    await open(owner, { draft: true });
    expect((await merge(owner)).body).toMatchObject({ code: "not_mergeable" });
    await api("PATCH", `${path}/pulls/1`, owner.token, { draft: false });
    // Merging takes contents:write: without it the repository is not found.
    expect((await merge(triager)).body).toMatchObject({ code: "repo_not_found" });
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    expect((await merge(owner)).body).toMatchObject({ code: "not_mergeable" });
  });
});

describe("rulesets judge the merge", () => {
  it("needs the approvals a pull_request rule asks for, from people with write access", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await open(owner);
    const head = (await pull()).head.sha;
    const refused = await merge(owner);
    expect(refused).toMatchObject({ status: 405, body: { code: "merge_refused" } });
    expect(refused.body.detail).toContain("approv");

    // A reader's approval does not count; a writer's does.
    const reader = await collaborator("pull");
    const writer = await collaborator("push");
    const approve = (who: Who) =>
      api("POST", `${path}/pulls/1/reviews`, who.token, { commit_id: head, event: "APPROVE" });
    expect((await approve(reader)).status).toBe(200);
    expect((await merge(owner)).body.code).toBe("merge_refused");
    expect((await approve(writer)).status).toBe(200);
    expect((await merge(owner)).status).toBe(200);
  });

  it("asks for an approval after the last push from someone other than its pusher", async () => {
    await ruleset({ require_last_push_approval: true });
    await open(owner);
    // A writer pushes to the head, then approves its own push: not enough.
    const writer = await collaborator("push");
    await commitOn(writer, "feature", [{ path: "d.txt", content: "more\n" }]);
    const head = (await pull()).head.sha;
    const approve = (who: Who) =>
      api("POST", `${path}/pulls/1/reviews`, who.token, { commit_id: head, event: "APPROVE" });
    expect((await approve(writer)).status).toBe(200);
    expect((await merge(owner)).body.code).toBe("merge_refused");
    const other = await collaborator("push");
    expect((await approve(other)).status).toBe(200);
    expect((await merge(owner)).status).toBe(200);
  });

  it("never takes an approval of an earlier head, submitted after the last push, as approving it", async () => {
    await ruleset({ require_last_push_approval: true });
    await open(owner);
    const earlier = (await pull()).head.sha;
    const writer = await collaborator("push");
    await commitOn(writer, "feature", [{ path: "d.txt", content: "more\n" }]);
    const head = (await pull()).head.sha;
    const other = await collaborator("push");
    const approve = (sha: string) =>
      api("POST", `${path}/pulls/1/reviews`, other.token, { commit_id: sha, event: "APPROVE" });
    // From a page that still showed the earlier head: it reviewed none of the push.
    expect((await approve(earlier)).status).toBe(200);
    const refused = await merge(owner);
    expect(refused.body.code).toBe("merge_refused");
    expect(refused.body.detail).toContain("last push");
    expect((await approve(head)).status).toBe(200);
    expect((await merge(owner)).status).toBe(200);
  });

  it("refuses a merge method the rule does not allow", async () => {
    await ruleset({ allowed_merge_methods: ["squash"] });
    await open(owner);
    const refused = await merge(owner);
    expect(refused.body.code).toBe("merge_refused");
    expect(refused.body.detail).toContain("cannot be merged by merge");
    expect((await merge(owner, { merge_method: "squash" })).status).toBe(200);
  });
});

describe("the last push", () => {
  it("is the opener's, then each pusher's; a reopening that takes a newer head is the reopener's", async () => {
    const writer = await collaborator("push");
    await open(owner);
    const lastPusher = () =>
      inRepo(env.REPO.getByName(repo.id), (r) => r.pulls.get(1)?.lastPusher ?? null);
    expect(await lastPusher()).toBe(owner.principalId);
    await commitOn(writer, "feature", [{ path: "d.txt", content: "more\n" }]);
    expect(await lastPusher()).toBe(writer.principalId);

    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" });
    // The head did not move while it was closed: still the writer's push.
    expect(await lastPusher()).toBe(writer.principalId);
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    await commitOn(writer, "feature", [{ path: "e.txt", content: "while closed\n" }]);
    expect(await lastPusher()).toBe(writer.principalId);
    const triager = await collaborator("triage");
    await api("PATCH", `${path}/pulls/1`, triager.token, { state: "open" });
    expect(await lastPusher()).toBe(triager.principalId);
  });
});

/** Runs `action` once, while the next merge has its commit stored but not yet made. */
const during = (action: () => Promise<unknown>) =>
  inRepo(env.REPO.getByName(repo.id), (r: RepoDO) => {
    r.mergeHooks = {
      beforeFinish: async () => {
        r.mergeHooks = {};
        await action();
      },
    };
  });

/** Moves `branch` from `from` to `to` (objects already stored), forcing it when it must. */
async function moveBranch(name: string, from: string, to: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: from, new: to, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

describe("a merge whose pull request changes before its commit", () => {
  const approveBy = async (who: Who) => {
    const head = (await pull()).head.sha;
    const approved = await json<{ id: number }>(
      api("POST", `${path}/pulls/1/reviews`, who.token, { commit_id: head, event: "APPROVE" }),
    );
    expect(approved.status).toBe(200);
    return approved.body.id;
  };
  const refusedLeavingItOpen = async (code: string) => {
    const mainTip = (await commitAt("main")).sha;
    expect((await merge(owner)).body.code).toBe(code);
    expect((await commitAt("main")).sha).toBe(mainTip);
    expect(await pull()).toMatchObject({ state: "open", merged: false });
  };

  it("is refused when an approval it counted is dismissed", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await open(owner);
    const writer = await collaborator("push");
    const id = await approveBy(writer);
    await during(() =>
      api("PUT", `${path}/pulls/1/reviews/${id}/dismissals`, owner.token, { message: "No" }),
    );
    await refusedLeavingItOpen("pull_changed");
  });

  it("is refused when an approver loses write access", async () => {
    await ruleset({ required_approving_review_count: 1 });
    await open(owner);
    const writer = await collaborator("push");
    await approveBy(writer);
    await during(() =>
      api("PUT", `${path}/collaborators/${writer.handle}`, owner.token, { permission: "pull" }),
    );
    await refusedLeavingItOpen("pull_changed");
  });

  it("is refused when the head is pushed away and back to the same commit", async () => {
    await open(owner);
    const head = (await pull()).head.sha;
    const away = (await commitAt("main")).sha;
    await during(async () => {
      await moveBranch("feature", head, away);
      await moveBranch("feature", away, head);
    });
    expect((await pull()).head.sha).toBe(head);
    await refusedLeavingItOpen("pull_changed");
  });

  it("is refused when it is closed, or the base branch moves", async () => {
    await open(owner);
    await during(() => api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" }));
    expect((await merge(owner)).body.code).toBe("pull_changed");
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" });

    await during(() => commitOn(owner, "main", [{ path: "z.txt", content: "z\n" }]));
    expect((await merge(owner)).body.code).toBe("base_moved");
    expect(await pull()).toMatchObject({ state: "open", merged: false });
    // Merged on a second try, from the new tip.
    expect((await merge(owner)).status).toBe(200);
  });
});

describe("merged pull requests", () => {
  it("are listed as closed", async () => {
    await open(owner);
    expect((await merge(owner)).status).toBe(200);
    const closed = await json<{ pull_requests: Pull[] }>(
      api("GET", `${path}/pulls?state=closed`, owner.token),
    );
    expect(closed.body.pull_requests.map((p) => [p.number, p.merged])).toEqual([[1, true]]);
    const opened = await json<{ pull_requests: Pull[] }>(
      api("GET", `${path}/pulls?state=open`, owner.token),
    );
    expect(opened.body.pull_requests).toEqual([]);
  });

  it("refuse a default message that would hold NUL", async () => {
    await open(owner, { body: "a\u0000b" });
    expect((await merge(owner, { merge_method: "squash" })).body.code).toBe("invalid_input");
    expect((await merge(owner, { merge_method: "squash", commit_message: "clean" })).status).toBe(
      200,
    );
  });
});

describe("a merge past its budget", () => {
  const withPolicy = (policy: Partial<MergePolicy>) =>
    inRepo(env.REPO.getByName(repo.id), (r: RepoDO) => {
      r.mergePolicy = { ...MERGE_POLICY, ...policy };
    });

  it("is refused as too expensive, not failed, whichever limit it meets", async () => {
    await open(owner);
    // The base moves, so the trees are merged rather than taken from the head.
    await commitOn(owner, "main", [{ path: "b.txt", content: "bee!\n" }]);
    for (const policy of [{ maxTreeBytes: 10 }, { maxTrees: 1 }, { maxReads: 0 }]) {
      await withPolicy(policy);
      expect(await merge(owner), JSON.stringify(policy)).toMatchObject({
        status: 422,
        body: { code: "too_expensive" },
      });
    }
    await withPolicy({});
    expect((await merge(owner)).status).toBe(200);
  });
});
