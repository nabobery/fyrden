// The `github` context a run carries, per event: the common fields, the ref
// and SHA each event checks out, and the event payload.
import { describe, expect, it } from "vitest";
import { type GithubContextInput, githubContext } from "../../src/ci/github-context.js";

const TIP = "a".repeat(40);
const BEFORE = "b".repeat(40);
const HEAD = "c".repeat(40);
const DEFAULT_TIP = "d".repeat(40);

const repository = {
  id: "repo_01",
  name: "app",
  owner: { id: "usr_01", login: "alice" },
  defaultBranch: "main",
  private: true,
  htmlUrl: "https://forge.example/alice/app",
  cloneUrl: "https://forge.example/alice/app.git",
};

const eventRepository = {
  full_name: "alice/app",
  name: "app",
  owner: { login: "alice" },
  default_branch: "main",
  private: true,
  html_url: "https://forge.example/alice/app",
  clone_url: "https://forge.example/alice/app.git",
};

function input(event: GithubContextInput["event"], name?: string): GithubContextInput {
  return {
    serverUrl: "https://forge.example",
    apiUrl: "https://forge.example/api",
    repository,
    actor: { id: "usr_02", login: "bob" },
    workflow: { path: ".github/workflows/ci.yml", ...(name !== undefined && { name }) },
    runId: "01JRUN",
    runNumber: 7,
    event,
  };
}

const push = (ref: string): GithubContextInput["event"] => ({
  kind: "push",
  ref,
  before: BEFORE,
  after: TIP,
  created: false,
  headCommit: {
    id: TIP,
    treeId: "e".repeat(40),
    message: "Fix the build",
    timestamp: "2026-11-15T10:00:00Z",
    author: { name: "Bob", email: "bob@example.com" },
    committer: { name: "Bob", email: "bob@example.com" },
  },
  pusher: { name: "bob", email: "bob@example.com" },
});

const pullPayload = {
  number: 12,
  pull_request: { number: 12, draft: false, head: { sha: HEAD }, base: { ref: "main" } },
  label: { name: "ready" },
};

const pull = (kind: "pull_request" | "pull_request_target"): GithubContextInput["event"] =>
  kind === "pull_request"
    ? {
        kind,
        action: "labeled",
        number: 12,
        headSha: HEAD,
        headBranch: "feature",
        baseBranch: "main",
        payload: pullPayload,
      }
    : {
        kind,
        action: "labeled",
        number: 12,
        headBranch: "feature",
        baseBranch: "main",
        defaultBranchSha: DEFAULT_TIP,
        payload: pullPayload,
      };

describe("githubContext", () => {
  it("fills the common fields from the run, repository and actor", () => {
    const github = githubContext(input(push("refs/heads/main"), "CI"));
    expect(github).toMatchObject({
      repository: "alice/app",
      repository_id: "repo_01",
      repository_owner: "alice",
      repository_owner_id: "usr_01",
      actor: "bob",
      actor_id: "usr_02",
      workflow: "CI",
      workflow_ref: "alice/app/.github/workflows/ci.yml@refs/heads/main",
      workflow_sha: TIP,
      run_id: "01JRUN",
      run_number: "7",
      server_url: "https://forge.example",
      api_url: "https://forge.example/api",
      retention_days: "90",
    });
  });

  it("names the workflow by its path when it has no name", () => {
    expect(githubContext(input(push("refs/heads/main"))).workflow).toBe(".github/workflows/ci.yml");
  });

  it("leaves the attempt and the triggering actor to assignment", () => {
    const github = githubContext(input(push("refs/heads/main")));
    expect(github).not.toHaveProperty("run_attempt");
    expect(github).not.toHaveProperty("triggering_actor");
  });

  it("gives every scalar field as a string, as the runner reads them", () => {
    for (const event of [push("refs/heads/main"), pull("pull_request")]) {
      const { event: _payload, ...scalars } = githubContext(input(event));
      for (const [key, value] of Object.entries(scalars)) {
        expect(typeof value, key).toBe("string");
      }
    }
  });

  it("is deterministic", () => {
    for (const event of [
      push("refs/heads/main"),
      pull("pull_request"),
      pull("pull_request_target"),
      { kind: "schedule", cron: "*/5 * * * *", sha: DEFAULT_TIP } as const,
      {
        kind: "workflow_dispatch",
        ref: "refs/heads/main",
        sha: TIP,
        inputs: { level: "3" },
      } as const,
    ]) {
      expect(githubContext(input(event))).toStrictEqual(githubContext(input(event)));
    }
  });

  describe("push", () => {
    it("runs the pushed tip on the pushed ref, outside any pull request", () => {
      const github = githubContext(input(push("refs/heads/main")));
      expect(github).toMatchObject({
        event_name: "push",
        ref: "refs/heads/main",
        ref_name: "main",
        ref_type: "branch",
        sha: TIP,
        head_ref: "",
        base_ref: "",
      });
    });

    it("derives a tag's name and type", () => {
      const github = githubContext(input(push("refs/tags/v1.2")));
      expect(github).toMatchObject({ ref_name: "v1.2", ref_type: "tag" });
    });

    it("keeps slashes in a branch name", () => {
      expect(githubContext(input(push("refs/heads/feat/x"))).ref_name).toBe("feat/x");
    });

    it("carries the push payload built from the facts", () => {
      expect(githubContext(input(push("refs/heads/main"))).event).toStrictEqual({
        ref: "refs/heads/main",
        before: BEFORE,
        after: TIP,
        created: false,
        deleted: false,
        base_ref: null,
        head_commit: {
          id: TIP,
          tree_id: "e".repeat(40),
          message: "Fix the build",
          timestamp: "2026-11-15T10:00:00Z",
          author: { name: "Bob", email: "bob@example.com" },
          committer: { name: "Bob", email: "bob@example.com" },
        },
        pusher: { name: "bob", email: "bob@example.com" },
        repository: eventRepository,
        sender: { login: "bob", id: "usr_02" },
      });
    });
  });

  describe("pull_request", () => {
    it("runs the head commit on the pull request's head ref", () => {
      const github = githubContext(input(pull("pull_request")));
      expect(github).toMatchObject({
        event_name: "pull_request",
        ref: "refs/pull/12/head",
        ref_name: "12/head",
        ref_type: "branch",
        sha: HEAD,
        workflow_sha: HEAD,
        head_ref: "feature",
        base_ref: "main",
        workflow_ref: "alice/app/.github/workflows/ci.yml@refs/pull/12/head",
      });
    });

    it("merges the captured payload with the action, repository and sender", () => {
      expect(githubContext(input(pull("pull_request"))).event).toStrictEqual({
        ...pullPayload,
        action: "labeled",
        repository: eventRepository,
        sender: { login: "bob", id: "usr_02" },
      });
    });

    it("does not let the captured payload replace the action, repository or sender", () => {
      const event = pull("pull_request");
      const github = githubContext(
        input({
          ...event,
          payload: { ...pullPayload, action: "x", repository: "x", sender: "x" },
        } as GithubContextInput["event"]),
      );
      expect(github.event).toMatchObject({
        action: "labeled",
        repository: eventRepository,
        sender: { login: "bob", id: "usr_02" },
      });
    });
  });

  describe("pull_request_target", () => {
    it("runs the default branch tip on the default branch, with the pull request's branches", () => {
      const github = githubContext(input(pull("pull_request_target")));
      expect(github).toMatchObject({
        event_name: "pull_request_target",
        ref: "refs/heads/main",
        ref_name: "main",
        ref_type: "branch",
        sha: DEFAULT_TIP,
        workflow_sha: DEFAULT_TIP,
        head_ref: "feature",
        base_ref: "main",
        workflow_ref: "alice/app/.github/workflows/ci.yml@refs/heads/main",
      });
      expect(github.event).toMatchObject({ number: 12, action: "labeled" });
    });
  });

  describe("schedule", () => {
    it("runs the default branch tip and names the cron line", () => {
      const github = githubContext(
        input({ kind: "schedule", cron: "*/5 * * * *", sha: DEFAULT_TIP }),
      );
      expect(github).toMatchObject({
        event_name: "schedule",
        ref: "refs/heads/main",
        ref_name: "main",
        ref_type: "branch",
        sha: DEFAULT_TIP,
        head_ref: "",
        base_ref: "",
      });
      expect(github.event).toStrictEqual({
        schedule: "*/5 * * * *",
        repository: eventRepository,
        sender: { login: "bob", id: "usr_02" },
      });
    });
  });

  describe("workflow_dispatch", () => {
    it("runs the given ref and carries the inputs as strings", () => {
      const github = githubContext(
        input({
          kind: "workflow_dispatch",
          ref: "refs/tags/v2",
          sha: TIP,
          inputs: { debug: "true", level: "3" },
        }),
      );
      expect(github).toMatchObject({
        event_name: "workflow_dispatch",
        ref: "refs/tags/v2",
        ref_name: "v2",
        ref_type: "tag",
        sha: TIP,
        head_ref: "",
        base_ref: "",
      });
      expect(github.event).toStrictEqual({
        inputs: { debug: "true", level: "3" },
        ref: "refs/tags/v2",
        workflow: ".github/workflows/ci.yml",
        repository: eventRepository,
        sender: { login: "bob", id: "usr_02" },
      });
      expect(github).not.toHaveProperty("inputs");
    });
  });
});
