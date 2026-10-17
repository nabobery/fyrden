// Pull requests merged by each strategy (merge, squash, rebase) against
// fyrden-api under `wrangler dev`, through public entry points only: between
// branches of one repository, and from a fork, opened by an agent acting for
// the fork's owner through MCP. Each merge's history is checked with stock
// git: the base branch on the server (`ls-remote`), its parents, authors,
// messages and changed files (`log`), and the pull request's own ref
// (`refs/pull/<n>/head`), which the merge took its changes from.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  delegatedAgent,
  eventually,
  type Forge,
  Git,
  mcpClient,
  seededRepo,
  startForge,
} from "./forge.js";

type Method = "merge" | "squash" | "rebase";
const METHODS: readonly Method[] = ["merge", "squash", "rebase"];
const REPO = "merges";

let forge: Forge;
let maintainer: Account;
let contributor: Account;
let maintainerGit: Git;
let contributorGit: Git;
/** The maintainer's working copy of the base repository. */
let baseWork = "";

beforeAll(async () => {
  forge = await startForge("merge");
  maintainer = forge.admin;
  contributor = await forge.user(`contrib${Date.now().toString(36)}`);
  maintainerGit = new Git(forge, maintainer);
  contributorGit = new Git(forge, contributor);
  baseWork = await seededRepo(forge, maintainer, maintainerGit, REPO, { "README.md": "base\n" });
  // The contributor reads the base (and so may fork it and open pull requests on it).
  await maintainer.api.call("repos.collaborators.set", {
    owner: maintainer.handle,
    repo: REPO,
    username: contributor.handle,
    permission: "pull",
  });
  await contributor.api.call("repos.fork", { owner: maintainer.handle, repo: REPO });
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

/** Pushes `branch` from main's tip with two commits, each adding one file; their ids. */
async function pushBranch(git: Git, work: string, branch: string): Promise<string[]> {
  await git.ok(["fetch", "-q", "origin"], work);
  await git.ok(["checkout", "-q", "-B", branch, "origin/main"], work);
  const one = await git.commit(work, { [`${branch}/one.txt`]: "one\n" }, `${branch}: one`);
  const two = await git.commit(work, { [`${branch}/two.txt`]: "two\n" }, `${branch}: two`);
  await git.ok(["push", "-q", "origin", branch], work);
  return [one, two];
}

/** Fetches the base's main into the maintainer's copy: its tip. */
async function baseTip(): Promise<string> {
  await maintainerGit.ok(["fetch", "-q", "origin", "main"], baseWork);
  return maintainerGit.ok(["rev-parse", "FETCH_HEAD"], baseWork);
}

/** Merges as the maintainer, sending a rebase that runs on in the background again until it ends. */
async function merge(number: number, method: Method, sha: string) {
  return eventually(`the ${method} merge of #${number}`, async () => {
    try {
      return await maintainer.api.call("pulls.merge", {
        owner: maintainer.handle,
        repo: REPO,
        pull_number: number,
        merge_method: method,
        sha,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "merge_in_progress") return undefined;
      throw error;
    }
  });
}

describe("pull requests merged by each strategy (wrangler dev)", () => {
  it("merges branches of one repository by merge, squash and rebase", {
    timeout: 300_000,
  }, async () => {
    for (const method of METHODS) {
      const branch = `same-${method}`;
      const commits = await pushBranch(maintainerGit, baseWork, branch);
      const head = commits[1] as string;
      const opened = await maintainer.api.call("pulls.create", {
        owner: maintainer.handle,
        repo: REPO,
        title: `Same repository, ${method}`,
        head: branch,
        base: "main",
      });
      expect(opened.head).toEqual({ ref: branch, sha: head });
      expect(opened.head_repo_id).toBeNull();
      const before = await baseTip();
      const result = await merge(opened.number, method, head);
      expect(result.merged).toBe(true);
      await expectHistory({
        method,
        number: opened.number,
        before,
        merged: result.sha,
        head,
        commits,
        author: maintainer.handle,
        title: opened.title,
        headLabel: `${maintainer.handle}/${branch}`,
      });
    }
  });

  it("merges an agent's pull requests from a fork by merge, squash and rebase", {
    timeout: 300_000,
  }, async () => {
    const forkWork = await contributorGit.clone(contributor.handle, REPO, "fork");
    // An agent acting for the contributor opens them, through MCP.
    const agent = await delegatedAgent(forge, contributor, `${contributor.handle}-bot`, [
      "metadata:read",
      "contents:read",
      "pull_requests:write",
    ]);
    const numbers: number[] = [];
    for (const method of METHODS) {
      const branch = `fork-${method}`;
      const commits = await pushBranch(contributorGit, forkWork, branch);
      const head = commits[1] as string;
      const opened = await agent.mcp.tool<{
        number: number;
        title: string;
        head: { ref: string; sha: string };
        head_repo_id: string | null;
        user: { id: string };
        performed_via_agents: string[];
      }>("create_pull_request", {
        owner: maintainer.handle,
        repo: REPO,
        title: `From a fork, ${method}`,
        head: `${contributor.handle}:${branch}`,
        base: "main",
      });
      expect(opened.head).toEqual({ ref: branch, sha: head });
      expect(opened.head_repo_id).not.toBeNull();
      expect(opened.user.id).toBe(contributor.id);
      expect(opened.performed_via_agents).toHaveLength(1);
      // The base serves the pull request's revision (and only through its ref).
      const pullRef = `refs/pull/${opened.number}/head`;
      await maintainerGit.ok(["fetch", "-q", "origin", pullRef], baseWork);
      expect(await maintainerGit.ok(["rev-parse", "FETCH_HEAD"], baseWork)).toBe(head);
      numbers.push(opened.number);
      const before = await baseTip();
      const result = await merge(opened.number, method, head);
      expect(result.merged).toBe(true);
      await expectHistory({
        method,
        number: opened.number,
        before,
        merged: result.sha,
        head,
        commits,
        // The agent opened it: the squash is its, the contributor its co-author.
        author: agent.handle,
        coAuthor: contributor.handle,
        title: opened.title,
        // The default title's head label is checked on its own below.
        headLabel: null,
      });
      const pull = await maintainer.api.call("pulls.get", {
        owner: maintainer.handle,
        repo: REPO,
        pull_number: opened.number,
      });
      expect(pull).toMatchObject({ state: "closed", merged: true, merge_commit_sha: result.sha });
    }
    // The fork's branches are the fork's: merging into the base moved none of them.
    const forkRefs = await contributorGit.remoteRefs(contributor.handle, REPO);
    for (const method of METHODS)
      expect(forkRefs[`refs/heads/fork-${method}`]).toBe(
        await contributorGit.ok(["rev-parse", `fork-${method}`], forkWork),
      );
    // An MCP client on the maintainer's own token sees them merged.
    const listed = await mcpClient(forge.origin, maintainer.token).tool<{
      pull_requests: { number: number; merged: boolean }[];
    }>("list_pull_requests", { owner: maintainer.handle, repo: REPO, state: "closed" });
    expect(
      listed.pull_requests
        .filter((p) => numbers.includes(p.number) && p.merged)
        .map((p) => p.number),
    ).toEqual([...numbers].reverse());
  });

  // As GitHub's: "from <fork owner>/<branch>", the branch where it is.
  it("names the fork's owner in a fork pull request's default merge title", {
    timeout: 120_000,
  }, async () => {
    const forkWork = await contributorGit.clone(contributor.handle, REPO, "fork-title");
    const branch = "fork-title";
    const commits = await pushBranch(contributorGit, forkWork, branch);
    const opened = await contributor.api.call("pulls.create", {
      owner: maintainer.handle,
      repo: REPO,
      title: "From a fork, its default merge title",
      head: `${contributor.handle}:${branch}`,
      base: "main",
    });
    const result = await merge(opened.number, "merge", commits[1] as string);
    await baseTip();
    expect(await maintainerGit.ok(["log", "-1", "--format=%s", result.sha], baseWork)).toBe(
      `Merge pull request #${opened.number} from ${contributor.handle}/${branch}`,
    );
  });
});

/**
 * Checks with git that main moved from `before` to the merge of the pull
 * request by `method`: what its new commits are, and that they bring the
 * pull request's changes and nothing else.
 */
async function expectHistory(options: {
  method: Method;
  number: number;
  before: string;
  merged: string;
  head: string;
  commits: readonly string[];
  author: string;
  /** Who the squash names in a `Co-authored-by` trailer, if anyone. */
  coAuthor?: string;
  title: string;
  /** `owner/branch` the default merge title names; null to check only its start. */
  headLabel: string | null;
}) {
  const { method, before, merged, head, commits, author, title, number } = options;
  const git = maintainerGit;
  const remote = await git.remoteRefs(maintainer.handle, REPO, "refs/heads/main");
  expect(remote["refs/heads/main"]).toBe(merged);
  expect(await baseTip()).toBe(merged);
  const show = (format: string, rev: string) =>
    git.ok(["log", "-1", `--format=${format}`, rev], baseWork);
  const range = async (format: string) =>
    (await git.ok(["log", "--reverse", `--format=${format}`, `${before}..${merged}`], baseWork))
      .split("\n")
      .filter(Boolean);
  // Exactly the pull request's changes, against where it branched from.
  const files = async (from: string, to: string) =>
    (await git.ok(["diff", "--name-only", from, to], baseWork)).split("\n").sort();
  expect(await files(before, merged)).toEqual(await files(`${head}~${commits.length}`, head));
  const made = (await range("%H")).filter((sha) => !commits.includes(sha));
  // Every commit the server made is signed with the platform's key.
  for (const sha of made)
    expect(await git.ok(["cat-file", "commit", sha], baseWork)).toMatch(/^gpgsig /m);
  switch (method) {
    case "merge":
      // A merge commit of the base's tip and the head; the head's own commits kept as they are.
      expect(await show("%P", merged)).toBe(`${before} ${head}`);
      if (options.headLabel === null)
        expect(await show("%s", merged)).toMatch(
          new RegExp(`^Merge pull request #${number} from `),
        );
      else
        expect(await show("%s", merged)).toBe(
          `Merge pull request #${number} from ${options.headLabel}`,
        );
      expect(await range("%H")).toEqual([...commits, merged]);
      break;
    case "squash":
      // One commit on the base's tip, by the pull request's author.
      expect(await show("%P", merged)).toBe(before);
      expect(await show("%s", merged)).toBe(`${title} (#${number})`);
      expect(await show("%an", merged)).toBe(author);
      if (options.coAuthor)
        expect(await show("%B", merged)).toMatch(
          new RegExp(`^Co-authored-by: ${options.coAuthor} <`, "m"),
        );
      expect(made).toEqual([merged]);
      break;
    case "rebase": {
      // The commits replayed one by one: authors, dates and messages kept, new ids.
      expect(made).toHaveLength(commits.length);
      expect(await show("%P", made[0] as string)).toBe(before);
      const original = async (format: string) =>
        (
          await git.ok(
            ["log", "--reverse", `--format=${format}`, `${head}~${commits.length}..${head}`],
            baseWork,
          )
        ).split("\n");
      for (const format of ["%an <%ae>", "%ad", "%s"])
        expect(await range(format)).toEqual(await original(format));
      expect(made.some((sha) => commits.includes(sha))).toBe(false);
      break;
    }
  }
}
