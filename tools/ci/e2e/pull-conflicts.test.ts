// A pull request's text conflict resolved on the server, against
// fyrden-api under `wrangler dev`, through public entry points only: once
// through REST by its author, once through MCP by an agent acting for its
// author. Each resolution is a merge of the base's tip into the head,
// committed by the server on the head branch (checked with stock git: its
// parents, message, signature and content), after which the pull request
// merges. The agent follows its user's activity feed and sees the conflict
// reported and then resolved.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  delegatedAgent,
  eventually,
  FeedFollower,
  type Forge,
  Git,
  seededRepo,
  startForge,
} from "./forge.js";

const REPO = "conflicts";
const NOTES = "one\ntwo\nthree\n";

let forge: Forge;
let maintainer: Account;
let author: Account;
let maintainerGit: Git;
let authorGit: Git;
let baseWork = "";
let authorWork = "";
let agent: Awaited<ReturnType<typeof delegatedAgent>>;
let feed: FeedFollower;

beforeAll(async () => {
  forge = await startForge("conflict");
  maintainer = forge.admin;
  author = await forge.user(`author${Date.now().toString(36)}`);
  maintainerGit = new Git(forge, maintainer);
  authorGit = new Git(forge, author);
  baseWork = await seededRepo(forge, maintainer, maintainerGit, REPO, { "notes.txt": NOTES });
  await maintainer.api.call("repos.collaborators.set", {
    owner: maintainer.handle,
    repo: REPO,
    username: author.handle,
    permission: "push",
  });
  authorWork = await authorGit.clone(maintainer.handle, REPO, "author");
  agent = await delegatedAgent(forge, author, `${author.handle}-bot`, [
    "metadata:read",
    "contents:write",
    "pull_requests:write",
  ]);
  // The agent follows its user's feed from now on.
  feed = new FeedFollower(agent.api, (await agent.api.call("feed.sync", {})).head_cursor);
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

const at = () => ({ owner: maintainer.handle, repo: REPO });

/** The author's branch from main, changing the second line. */
async function pushHead(branch: string): Promise<string> {
  await authorGit.ok(["fetch", "-q", "origin", "main"], authorWork);
  await authorGit.ok(["checkout", "-q", "-B", branch, "FETCH_HEAD"], authorWork);
  const head = await authorGit.commit(
    authorWork,
    { "notes.txt": "one\ntwo (head)\nthree\n" },
    branch,
  );
  await authorGit.ok(["push", "-q", "origin", branch], authorWork);
  return head;
}

/** The maintainer changes the same line on main; the new tip. */
async function conflictingBase(text: string): Promise<string> {
  await maintainerGit.ok(["fetch", "-q", "origin", "main"], baseWork);
  await maintainerGit.ok(["checkout", "-q", "-B", "main", "FETCH_HEAD"], baseWork);
  const tip = await maintainerGit.commit(baseWork, { "notes.txt": `one\n${text}\nthree\n` }, text);
  await maintainerGit.ok(["push", "-q", "origin", "main"], baseWork);
  return tip;
}

/** Waits for the pull request's mergeability to be `state` (worked out in the background). */
const mergeability = (number: number, state: "clean" | "dirty") =>
  eventually(`#${number} ${state}`, async () => {
    const pull = await author.api.call("pulls.get", { ...at(), pull_number: number });
    return pull.mergeable_state === state ? pull : undefined;
  });

/** Checks with git that `branch` is at `sha`, a signed merge of `base` into `head`. */
async function expectBaseMerged(branch: string, sha: string, head: string, base: string) {
  expect((await authorGit.remoteRefs(maintainer.handle, REPO))[`refs/heads/${branch}`]).toBe(sha);
  await authorGit.ok(["fetch", "-q", "origin", branch], authorWork);
  expect(await authorGit.ok(["rev-parse", "FETCH_HEAD"], authorWork)).toBe(sha);
  expect(await authorGit.ok(["log", "-1", "--format=%P", sha], authorWork)).toBe(`${head} ${base}`);
  expect(await authorGit.ok(["log", "-1", "--format=%s", sha], authorWork)).toBe(
    `Merge branch 'main' into ${branch}`,
  );
  expect(await authorGit.ok(["cat-file", "commit", sha], authorWork)).toMatch(/^gpgsig /m);
  expect(await authorGit.ok(["show", `${sha}:notes.txt`], authorWork)).toBe(
    "one\ntwo (both)\nthree",
  );
}

const RESOLVED = "one\ntwo (both)\nthree\n";

describe("conflicts resolved on the server (wrangler dev)", () => {
  it("resolves through REST with a base-into-head merge commit on the head branch", {
    timeout: 180_000,
  }, async () => {
    const head = await pushHead("rest-fix");
    const opened = await author.api.call("pulls.create", {
      ...at(),
      title: "Resolved through REST",
      head: "rest-fix",
      base: "main",
    });
    const base = await conflictingBase("two (base, rest)");
    const dirty = await mergeability(opened.number, "dirty");
    expect(dirty.mergeable).toBe(false);

    const conflicts = await author.api.call("pulls.conflicts.get", {
      ...at(),
      pull_number: opened.number,
    });
    expect(conflicts).toMatchObject({ base_sha: base, head_sha: head });
    expect(conflicts.files).toEqual([
      expect.objectContaining({ path: "notes.txt", kind: "content", editable: true, conflicts: 1 }),
    ]);
    // git's markers, the head's side first, each named by its branch.
    expect(conflicts.files[0]?.content).toBe(
      "one\n<<<<<<< rest-fix\ntwo (head)\n=======\ntwo (base, rest)\n>>>>>>> main\nthree\n",
    );
    const resolved = await author.api.call("pulls.conflicts.resolve", {
      ...at(),
      pull_number: opened.number,
      conflict_snapshot: conflicts.conflict_snapshot,
      files: [{ path: "notes.txt", content: RESOLVED }],
    });
    expect(resolved.markers).toEqual([]);
    await expectBaseMerged("rest-fix", resolved.sha, head, base);

    // The pull request follows its head branch, now clean, and merges.
    const clean = await mergeability(opened.number, "clean");
    expect(clean.head.sha).toBe(resolved.sha);
    const merged = await maintainer.api.call("pulls.merge", {
      ...at(),
      pull_number: opened.number,
      sha: resolved.sha,
    });
    expect(merged.merged).toBe(true);
  });

  it("resolves through MCP as an agent, which sees the conflict come and go in its feed", {
    timeout: 180_000,
  }, async () => {
    const head = await pushHead("mcp-fix");
    const opened = await agent.mcp.tool<{ number: number }>("create_pull_request", {
      ...at(),
      title: "Resolved through MCP",
      head: "mcp-fix",
      base: "main",
    });
    const { number } = opened;
    const base = await conflictingBase("two (base, mcp)");
    // The agent hears of the conflict on its user's pull request.
    const reported = await feed.until(forge, number, "merge_conflict", "open");
    expect(reported).toMatchObject({ priority: "P0", action: "merge_conflict" });
    expect(reported.reasons).toContain("author");

    const conflicts = await agent.mcp.tool<{
      conflict_snapshot: string;
      head_sha: string;
      base_sha: string;
      files: { path: string; editable: boolean; content: string | null }[];
    }>("get_conflicts", { ...at(), pull_number: number });
    expect(conflicts).toMatchObject({ base_sha: base, head_sha: head });
    expect(conflicts.files.map((f) => [f.path, f.editable])).toEqual([["notes.txt", true]]);
    const resolved = await agent.mcp.tool<{ sha: string; markers: string[] }>("resolve_conflicts", {
      ...at(),
      pull_number: number,
      conflict_snapshot: conflicts.conflict_snapshot,
      files: [{ path: "notes.txt", content: RESOLVED }],
    });
    expect(resolved.markers).toEqual([]);
    await expectBaseMerged("mcp-fix", resolved.sha, head, base);
    // The agent made it for its user: the user is named as co-author.
    expect(await authorGit.ok(["log", "-1", "--format=%B", resolved.sha], authorWork)).toMatch(
      new RegExp(`^Co-authored-by: ${author.handle} <`, "m"),
    );

    // The conflict item resolves in place: one item, its latest state.
    const settled = await feed.until(forge, number, "merge_conflict", "resolved");
    expect(settled.item_key).toBe(reported.item_key);
    expect(settled.version).toBeGreaterThan(reported.version);
    expect(settled.action).toBe("merge_clean");
    await mergeability(number, "clean");
  });
});
