import { exports } from "cloudflare:workers";
import { AUTHENTICATED, type OperationDef, registry } from "@fyrden/api-contract";
import { permissionDef } from "@fyrden/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createRepo, type TestRepo } from "./helpers/git-http.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";

// The executor checks only the scopes of a repository permission; the
// handler must check the repository itself, with the permission the
// operation declares. Every repository operation in the registry is run
// here, so a new one that skips or weakens the check fails this test.

const ORIGIN = "https://fyrden.test";
const MISSING_KIND = { status: 403, code: "missing_permission" };
const UPLOAD_ID = "0".repeat(26);
const SHA = "a".repeat(40);
const RULESET = {
  name: "checked",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
  rules: [{ type: "deletion" }],
};

/**
 * For each repository operation: an input beyond the path, and what the
 * owner gets once authorization has passed (a fake upload id and a source
 * URL refused without a DNS lookup fail after the check, with their own
 * code). A new operation needs an entry.
 */
const CASES: Record<
  string,
  { input: Record<string, unknown>; expected: Outcome; ownRepo?: boolean }
> = {
  "repos.get": { input: {}, expected: { status: 200 } },
  "repos.update": { input: { description: "checked" }, expected: { status: 200 } },
  // {username} is the owner itself: a collaborator role it already exceeds.
  "repos.collaborators.set": { input: { permission: "pull" }, expected: { status: 200 } },
  "repos.collaborators.remove": { input: {}, expected: { status: 200 } },
  "repos.collaborators.list": { input: {}, expected: { status: 200 } },
  // Deletes a repository of its own, not the one the other cases use.
  "repos.delete": { input: {}, expected: { status: 200 }, ownRepo: true },
  // The repository is empty: listings answer, a named ref is not found.
  "repos.branches.list": { input: {}, expected: { status: 200 } },
  "repos.branches.get": { input: {}, expected: { status: 404, code: "branch_not_found" } },
  "repos.codeowners.errors": { input: {}, expected: { status: 404, code: "not_found" } },
  "repos.tags.list": { input: {}, expected: { status: 200 } },
  "repos.commits.list": { input: {}, expected: { status: 409, code: "repo_empty" } },
  "repos.commits.get": { input: {}, expected: { status: 404, code: "ref_not_found" } },
  "repos.compare": { input: {}, expected: { status: 404, code: "ref_not_found" } },
  "repos.contents.get": { input: {}, expected: { status: 409, code: "repo_empty" } },
  "repos.contents.root": { input: {}, expected: { status: 409, code: "repo_empty" } },
  "repos.readme.get": { input: {}, expected: { status: 409, code: "repo_empty" } },
  "repos.trees.get": { input: {}, expected: { status: 404, code: "ref_not_found" } },
  "repos.archives.get": { input: {}, expected: { status: 409, code: "repo_empty" } },
  "repos.forks.list": { input: {}, expected: { status: 200 } },
  // To its own owner: refused after authorization, with its own code.
  "repos.transfer": {
    input: {
      get new_owner() {
        return handle;
      },
    },
    expected: { status: 422, code: "same_owner" },
  },
  // No ruleset 1 exists: named ones are not found; a new one is made.
  "repos.rulesets.list": { input: {}, expected: { status: 200 } },
  "repos.rulesets.rule_suites.list": { input: {}, expected: { status: 200 } },
  "repos.rulesets.get": { input: {}, expected: { status: 404, code: "ruleset_not_found" } },
  "repos.rulesets.create": {
    input: RULESET,
    expected: { status: 201 },
    ownRepo: true,
  },
  "repos.rulesets.update": {
    input: RULESET,
    expected: { status: 404, code: "ruleset_not_found" },
  },
  "repos.rulesets.delete": { input: {}, expected: { status: 404, code: "ruleset_not_found" } },
  // No webhook exists; a new one with a private address is refused after the check.
  "repos.hooks.list": { input: {}, expected: { status: 200 } },
  "repos.hooks.get": { input: {}, expected: { status: 404, code: "hook_not_found" } },
  "repos.hooks.create": {
    input: { config: { url: "https://10.0.0.1/hook" } },
    expected: { status: 422, code: "invalid_url" },
  },
  "repos.hooks.update": {
    input: { active: false },
    expected: { status: 404, code: "hook_not_found" },
  },
  "repos.hooks.delete": { input: {}, expected: { status: 404, code: "hook_not_found" } },
  "repos.hooks.pings.create": { input: {}, expected: { status: 404, code: "hook_not_found" } },
  "repos.hooks.secret.rotate": { input: {}, expected: { status: 404, code: "hook_not_found" } },
  "repos.hooks.secret.drop": { input: {}, expected: { status: 404, code: "hook_not_found" } },
  "repos.hooks.deliveries.list": {
    input: {},
    expected: { status: 404, code: "hook_not_found" },
  },
  "repos.hooks.deliveries.get": {
    input: {},
    expected: { status: 404, code: "hook_not_found" },
  },
  "repos.hooks.deliveries.redeliver": {
    input: {},
    expected: { status: 404, code: "hook_not_found" },
  },
  // No pull request exists, and the repository has no branches to open one between.
  "pulls.list": { input: {}, expected: { status: 200 } },
  "pulls.get": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.create": {
    input: { title: "checked", head: "feature", base: "main" },
    expected: { status: 422, code: "base_not_found" },
  },
  "pulls.update": {
    input: { title: "checked" },
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.merge": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.conflicts.get": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.conflicts.resolve": {
    input: { conflict_snapshot: "0".repeat(80), files: [] },
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.branch.update": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.comments.list": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.comments.create": {
    input: { body: "checked", commit_id: SHA, path: "a.txt", line: 1 },
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.comments.get": { input: {}, expected: { status: 404, code: "comment_not_found" } },
  "pulls.comments.update": {
    input: { body: "checked" },
    expected: { status: 404, code: "comment_not_found" },
  },
  "pulls.comments.delete": { input: {}, expected: { status: 404, code: "comment_not_found" } },
  "pulls.threads.list": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.suggestions.apply": {
    input: { comment_ids: [1] },
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.threads.resolve": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.threads.unresolve": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.files.list": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.commits.list": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.reviews.list": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "pulls.reviews.get": { input: {}, expected: { status: 404, code: "review_not_found" } },
  "pulls.reviews.create": {
    input: { commit_id: SHA, event: "COMMENT", body: "checked" },
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.reviews.dismiss": {
    input: { message: "checked" },
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.requested_reviewers.list": {
    input: {},
    expected: { status: 404, code: "pull_not_found" },
  },
  "pulls.code_owners.get": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  // The owner itself, found by handle: the missing pull request is what answers.
  "pulls.requested_reviewers.add": {
    input: {
      get reviewers() {
        return [handle];
      },
    },
    expected: { status: 404, code: "pull_not_found" },
  },
  // Serving issues and pull requests alike, these declare metadata:read and take each kind's own
  // permission in the handler (see BOTH_KINDS below): metadata:read alone gets no further.
  "issues.list": { input: {}, expected: MISSING_KIND },
  "issues.get": { input: {}, expected: MISSING_KIND },
  "issues.lock": { input: {}, expected: MISSING_KIND },
  "issues.unlock": { input: {}, expected: MISSING_KIND },
  "issues.comments.list": { input: {}, expected: MISSING_KIND },
  "issues.comments.create": { input: { body: "checked" }, expected: MISSING_KIND },
  "issues.comments.get": { input: {}, expected: MISSING_KIND },
  "issues.comments.update": { input: { body: "checked" }, expected: MISSING_KIND },
  "issues.comments.delete": { input: {}, expected: MISSING_KIND },
  "issues.update": { input: { title: "checked" }, expected: MISSING_KIND },
  "issues.labels.list": { input: {}, expected: MISSING_KIND },
  "issues.references.list": { input: {}, expected: MISSING_KIND },
  "issues.labels.add": { input: { labels: ["checked"] }, expected: MISSING_KIND },
  "issues.labels.set": { input: { labels: [] }, expected: MISSING_KIND },
  "issues.labels.remove": { input: {}, expected: MISSING_KIND },
  "issues.labels.clear": { input: {}, expected: MISSING_KIND },
  "issues.assignees.add": {
    input: {
      get assignees() {
        return [handle];
      },
    },
    expected: MISSING_KIND,
  },
  "issues.assignees.remove": {
    input: {
      get assignees() {
        return [handle];
      },
    },
    expected: MISSING_KIND,
  },
  "reactions.issue.list": { input: {}, expected: MISSING_KIND },
  "reactions.issue.create": { input: { content: "+1" }, expected: MISSING_KIND },
  "reactions.issue.delete": { input: {}, expected: MISSING_KIND },
  "reactions.comment.list": { input: {}, expected: MISSING_KIND },
  "reactions.comment.create": { input: { content: "+1" }, expected: MISSING_KIND },
  "reactions.comment.delete": { input: {}, expected: MISSING_KIND },
  // Diff comments are pull requests' only: their reactions declare the pull requests permission.
  "reactions.review_comment.list": {
    input: {},
    expected: { status: 404, code: "comment_not_found" },
  },
  "reactions.review_comment.create": {
    input: { content: "+1" },
    expected: { status: 404, code: "comment_not_found" },
  },
  "reactions.review_comment.delete": {
    input: {},
    expected: { status: 404, code: "comment_not_found" },
  },
  // Labels and milestones serve both kinds: either kind's permission lets a caller through
  // (see EITHER_KIND below).
  "labels.list": { input: {}, expected: MISSING_KIND },
  "labels.get": { input: {}, expected: MISSING_KIND },
  "labels.create": { input: { name: "checked", color: "000000" }, expected: MISSING_KIND },
  "labels.update": { input: { color: "000000" }, expected: MISSING_KIND },
  "labels.delete": { input: {}, expected: MISSING_KIND },
  "labels.copy_defaults": { input: {}, expected: MISSING_KIND },
  "milestones.list": { input: {}, expected: MISSING_KIND },
  "milestones.get": { input: {}, expected: MISSING_KIND },
  "milestones.create": { input: { title: "checked" }, expected: MISSING_KIND },
  "milestones.update": { input: { title: "checked" }, expected: MISSING_KIND },
  "milestones.delete": { input: {}, expected: MISSING_KIND },
  // These test repositories predate identities (no events to record an issue with): refused
  // after authorization, with its own code.
  "issues.create": {
    input: { title: "checked" },
    expected: { status: 409, code: "repo_not_ready" },
  },
  "issues.delete": { input: {}, expected: { status: 404, code: "issue_not_found" } },
  "pulls.requested_reviewers.remove": {
    input: {
      get reviewers() {
        return [handle];
      },
    },
    expected: { status: 404, code: "pull_not_found" },
  },
  // Writes change their own repository: the first commit of an empty one.
  "repos.contents.put": {
    input: { message: "add", content: "aGk=" },
    expected: { status: 200 },
    ownRepo: true,
  },
  "repos.contents.delete": {
    input: { message: "remove", sha: SHA },
    expected: { status: 409, code: "sha_mismatch" },
    ownRepo: true,
  },
  "repos.file_commits.create": {
    input: { message: "add", changes: [{ path: "a.txt", content: "a" }] },
    expected: { status: 201 },
    ownRepo: true,
  },
  "uploads.create": {
    input: { size: 32, ref_updates: [{ ref: "refs/heads/main", old: null, new: SHA }] },
    expected: { status: 201 },
  },
  "uploads.get": { input: {}, expected: { status: 404, code: "upload_not_found" } },
  "uploads.complete": { input: {}, expected: { status: 404, code: "upload_not_found" } },
  "uploads.abort": { input: {}, expected: { status: 404, code: "upload_not_found" } },
  "imports.create": {
    input: { url: "https://127.0.0.1/r.git" },
    expected: { status: 422, code: "url_refused" },
  },
  "imports.get": { input: {}, expected: { status: 404, code: "import_not_found" } },
};

type Outcome = { status: number; code?: string };

// Operations on one repository (a list checks each repository it returns).
const repoOps = registry.filter(
  (op) =>
    op.permission !== AUTHENTICATED &&
    permissionDef(op.permission).resource === "repo" &&
    op.path.includes("{repo}"),
);

/**
 * Operations whose declared permission is not a repository's (creating
 * repositories, starring) but that also read a repository, with the
 * permission they need on it. A new one needs an entry.
 */
const SECONDARY: Record<string, { permission: string; input: Record<string, unknown> }> = {
  "repos.fork": { permission: "contents:read", input: { name: "forked" } },
  "repos.generate": { permission: "contents:read", input: { name: "generated" } },
  "stars.put": { permission: "metadata:read", input: {} },
  "stars.delete": { permission: "metadata:read", input: {} },
};
// Organization operations on a repository (a team's) check the organization
// first; their tests are with the organization's.
const secondaryOps = registry.filter(
  (op) =>
    !repoOps.includes(op) && !op.path.startsWith("/orgs/") && /\{(template_)?repo\}/.test(op.path),
);

let owner: { principalId: string; token: string };
let handle: string;
let repo: TestRepo;

beforeAll(async () => {
  owner = await principalWithToken("user", "pat");
  handle = owner.principalId.toLowerCase().replace("_", "-");
  repo = await createRepo(owner.principalId);
});

function call(op: OperationDef, token: string, name = repo.name) {
  const path = op.path
    .replace("{owner}", handle)
    .replace("{repo}", name)
    .replace("{template_owner}", handle)
    .replace("{template_repo}", name)
    .replace("{upload_id}", UPLOAD_ID)
    .replace("{pull_number}", "1")
    .replace("{review_id}", "1")
    .replace("{issue_number}", "1")
    .replace("{milestone_number}", "1")
    .replace("{reaction_id}", "1")
    .replace("{name}", "checked")
    .replace("{comment_id}", "1")
    .replace("{thread_id}", "1")
    .replace("{username}", handle)
    .replace("{branch+}", "main")
    .replace("{ref+}", "main")
    .replace("{basehead+}", "main...main")
    .replace("{path+}", "README.md")
    .replace("{tree_sha+}", "main")
    .replace("{format}", "zip")
    .replace("{ruleset_id}", "1")
    .replace("{hook_id}", "1")
    .replace("{delivery_id}", `msg_${"0".repeat(32)}`);
  const input = CASES[op.id]?.input ?? SECONDARY[op.id]?.input ?? {};
  const get = op.method === "GET";
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method: op.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(!get && { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }),
    },
    ...(!get && { body: JSON.stringify(input) }),
  });
}

async function outcome(res: Response): Promise<Outcome> {
  if (res.ok) return { status: res.status };
  return { status: res.status, code: (await res.json<{ code: string }>()).code };
}

/** An operation answering with the repository's file contents beside what it declares (owners from CODEOWNERS). */
const needsContents = (op: OperationDef) => op.id === "pulls.code_owners.get";

describe("repository operations", () => {
  it("have an input here for each of them", () => {
    expect(repoOps.map((op) => op.id).sort()).toEqual(Object.keys(CASES).sort());
  });

  it.each(repoOps.map((op) => [op.id, op] as const))(
    "%s answers a principal without access as if the repository did not exist",
    async (_, op) => {
      const stranger = await principalWithToken("user", "pat");
      expect(await outcome(await call(op, stranger.token))).toEqual({
        status: 404,
        code: "repo_not_found",
      });
    },
  );

  it.each(
    repoOps.filter((op) => !isHookOp(op) && !needsContents(op)).map((op) => [op.id, op] as const),
  )("%s needs no more than the permission it declares", async (_, op) => {
    const token = await scopedToken(owner.principalId, [op.permission]);
    const name = CASES[op.id]?.ownRepo ? (await createRepo(owner.principalId)).name : repo.name;
    expect(await outcome(await call(op, token, name))).toEqual(CASES[op.id]?.expected);
  });
});

describe("operations answering with file contents", () => {
  it.each(repoOps.filter(needsContents).map((op) => [op.id, op] as const))(
    "%s needs contents:read beside the permission it declares",
    async (_, op) => {
      const declared = await scopedToken(owner.principalId, [op.permission]);
      expect(await outcome(await call(op, declared))).toEqual({
        status: 403,
        code: "missing_permission",
      });
      const both = await scopedToken(owner.principalId, [op.permission, "contents:read"]);
      expect(await outcome(await call(op, both))).toEqual(CASES[op.id]?.expected);
    },
  );
});

/** A webhook operation: a hook carries issue and pull request contents out. */
const isHookOp = (op: OperationDef) => op.id.startsWith("repos.hooks.");
const HOOK_CONTENT = ["issues:read", "pull_requests:read"];

describe("webhook operations", () => {
  it.each(repoOps.filter(isHookOp).map((op) => [op.id, op] as const))(
    "%s needs both content reads beside the permission it declares",
    async (_, op) => {
      for (const extra of [[], ["issues:read"], ["pull_requests:read"]]) {
        const token = await scopedToken(owner.principalId, [op.permission, ...extra]);
        expect(await outcome(await call(op, token))).toEqual({ status: 403, code: "forbidden" });
      }
      const token = await scopedToken(owner.principalId, [op.permission, ...HOOK_CONTENT]);
      expect(await outcome(await call(op, token))).toEqual(CASES[op.id]?.expected);
    },
  );
});

/**
 * The operations serving issues and pull requests alike, and what each
 * answers once its kind's permission lets it through (the repository has
 * no issue or pull request #1, nor comment 1).
 */
const BOTH_KINDS: Record<string, Outcome> = {
  "issues.list": { status: 200 },
  "issues.get": { status: 404, code: "issue_not_found" },
  "issues.lock": { status: 404, code: "issue_not_found" },
  "issues.unlock": { status: 404, code: "issue_not_found" },
  "issues.comments.list": { status: 404, code: "issue_not_found" },
  "issues.comments.create": { status: 404, code: "issue_not_found" },
  "issues.comments.get": { status: 404, code: "comment_not_found" },
  "issues.comments.update": { status: 404, code: "comment_not_found" },
  "issues.comments.delete": { status: 404, code: "comment_not_found" },
  "issues.update": { status: 404, code: "issue_not_found" },
  "issues.labels.list": { status: 404, code: "issue_not_found" },
  "issues.references.list": { status: 404, code: "issue_not_found" },
  "issues.labels.add": { status: 404, code: "issue_not_found" },
  "issues.labels.set": { status: 404, code: "issue_not_found" },
  "issues.labels.remove": { status: 404, code: "issue_not_found" },
  "issues.labels.clear": { status: 404, code: "issue_not_found" },
  "issues.assignees.add": { status: 404, code: "issue_not_found" },
  "issues.assignees.remove": { status: 404, code: "issue_not_found" },
  "reactions.issue.list": { status: 404, code: "issue_not_found" },
  "reactions.issue.create": { status: 404, code: "issue_not_found" },
  "reactions.issue.delete": { status: 404, code: "issue_not_found" },
  "reactions.comment.list": { status: 404, code: "comment_not_found" },
  "reactions.comment.create": { status: 404, code: "comment_not_found" },
  "reactions.comment.delete": { status: 404, code: "comment_not_found" },
};

/**
 * Labels and milestones, serving both kinds: what each answers once either
 * kind's permission lets it through (the repository has no label or
 * milestone, and predates the identities writes need to record events).
 */
const EITHER_KIND: Record<string, Outcome> = {
  "labels.list": { status: 200 },
  "labels.get": { status: 404, code: "label_not_found" },
  "labels.create": { status: 409, code: "repo_not_ready" },
  "labels.update": { status: 409, code: "repo_not_ready" },
  "labels.delete": { status: 409, code: "repo_not_ready" },
  "labels.copy_defaults": { status: 409, code: "repo_not_ready" },
  "milestones.list": { status: 200 },
  "milestones.get": { status: 404, code: "milestone_not_found" },
  "milestones.create": { status: 409, code: "repo_not_ready" },
  "milestones.update": { status: 409, code: "repo_not_ready" },
  "milestones.delete": { status: 409, code: "repo_not_ready" },
};

describe("operations serving issues and pull requests", () => {
  it("are every repository operation that declares metadata:read and names an issue number or comment", () => {
    const serving = repoOps.filter(
      (op) =>
        op.permission === "metadata:read" &&
        (op.path.includes("/issues") || op.path.includes("{issue_number}")),
    );
    expect(serving.map((op) => op.id).sort()).toEqual(Object.keys(BOTH_KINDS).sort());
  });

  it.each(
    Object.keys(BOTH_KINDS).flatMap((id) =>
      (["issues", "pull_requests"] as const).map((kind) => [id, kind] as const),
    ),
  )("%s goes on with %s's own permission", async (id, kind) => {
    const op = registry.find((o) => o.id === id) as OperationDef;
    const token = await scopedToken(owner.principalId, [
      `${kind}:${op.method === "GET" ? "read" : "write"}`,
    ]);
    expect(await outcome(await call(op, token))).toEqual(BOTH_KINDS[id]);
  });

  it.each(Object.keys(BOTH_KINDS))(
    "%s writes nothing with a kind's read permission",
    async (id) => {
      const op = registry.find((o) => o.id === id) as OperationDef;
      if (op.method === "GET") return;
      const token = await scopedToken(owner.principalId, ["issues:read", "pull_requests:read"]);
      expect(await outcome(await call(op, token))).toEqual(MISSING_KIND);
    },
  );
});

describe("label and milestone operations", () => {
  it("are every repository operation that declares metadata:read on labels or milestones", () => {
    const serving = repoOps.filter(
      (op) =>
        op.permission === "metadata:read" &&
        (op.path.includes("/labels") || op.path.includes("/milestones")) &&
        !op.path.includes("/issues"),
    );
    expect(serving.map((op) => op.id).sort()).toEqual(Object.keys(EITHER_KIND).sort());
  });

  it.each(
    Object.keys(EITHER_KIND).flatMap((id) =>
      (["issues", "pull_requests"] as const).map((kind) => [id, kind] as const),
    ),
  )("%s goes on with %s's permission", async (id, kind) => {
    const op = registry.find((o) => o.id === id) as OperationDef;
    const token = await scopedToken(owner.principalId, [
      `${kind}:${op.method === "GET" ? "read" : "write"}`,
    ]);
    expect(await outcome(await call(op, token))).toEqual(EITHER_KIND[id]);
  });

  it.each(Object.keys(EITHER_KIND))("%s writes nothing with read permissions", async (id) => {
    const op = registry.find((o) => o.id === id) as OperationDef;
    if (op.method === "GET") return;
    const token = await scopedToken(owner.principalId, ["issues:read", "pull_requests:read"]);
    expect(await outcome(await call(op, token))).toEqual(MISSING_KIND);
  });
});

describe("operations that read a repository beyond their declared permission", () => {
  it("have an entry here for each of them", () => {
    expect(secondaryOps.map((op) => op.id).sort()).toEqual(Object.keys(SECONDARY).sort());
  });

  it.each(secondaryOps.map((op) => [op.id, op] as const))(
    "%s answers a principal without access as if the repository did not exist",
    async (_, op) => {
      const stranger = await principalWithToken("user", "pat");
      expect(await outcome(await call(op, stranger.token))).toEqual({
        status: 404,
        code: "repo_not_found",
      });
    },
  );

  it.each(secondaryOps.map((op) => [op.id, op] as const))(
    "%s needs its permission on the repository besides the one it declares",
    async (_, op) => {
      const token = await scopedToken(owner.principalId, [op.permission]);
      expect(await outcome(await call(op, token))).toEqual({
        status: 404,
        code: "repo_not_found",
      });
    },
  );
});
