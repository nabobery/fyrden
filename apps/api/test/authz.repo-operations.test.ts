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
  // The owner itself, found by handle: the missing pull request is what answers.
  "pulls.requested_reviewers.add": {
    input: {
      get reviewers() {
        return [handle];
      },
    },
    expected: { status: 404, code: "pull_not_found" },
  },
  "issues.comments.list": { input: {}, expected: { status: 404, code: "pull_not_found" } },
  "issues.comments.create": {
    input: { body: "checked" },
    expected: { status: 404, code: "pull_not_found" },
  },
  "issues.comments.get": { input: {}, expected: { status: 404, code: "comment_not_found" } },
  "issues.comments.update": {
    input: { body: "checked" },
    expected: { status: 404, code: "comment_not_found" },
  },
  "issues.comments.delete": { input: {}, expected: { status: 404, code: "comment_not_found" } },
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
    .replace("{comment_id}", "1")
    .replace("{thread_id}", "1")
    .replace("{username}", handle)
    .replace("{branch+}", "main")
    .replace("{ref+}", "main")
    .replace("{basehead+}", "main...main")
    .replace("{path+}", "README.md")
    .replace("{tree_sha+}", "main")
    .replace("{format}", "zip")
    .replace("{ruleset_id}", "1");
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

  it.each(repoOps.map((op) => [op.id, op] as const))(
    "%s needs no more than the permission it declares",
    async (_, op) => {
      const token = await scopedToken(owner.principalId, [op.permission]);
      const name = CASES[op.id]?.ownRepo ? (await createRepo(owner.principalId)).name : repo.name;
      expect(await outcome(await call(op, token, name))).toEqual(CASES[op.id]?.expected);
    },
  );
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
