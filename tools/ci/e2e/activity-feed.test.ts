// The activity feed of a user, followed by an agent acting for it with a
// delegated token, against fyrden-api under `wrangler dev`, through public
// entry points only (REST `/feed`, `/feed/sync`, MCP `get_feed` and
// `sync_feed`, stock git). The agent sees a review asked of its user, the
// outcome of reviews of its user's pull request and a merge conflict on it,
// each once, in its latest state. A forged cursor, one naming no snapshot of
// the feed, or one of before streams ahead of the feed, is refused with 410
// and where to resync. Once its user is removed as a
// collaborator, that repository's items are gone, and stay gone when access
// is given back: only new items come.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  delegatedAgent,
  EFFECTS_CRON,
  eventually,
  FeedFollower,
  type FeedItem,
  type Forge,
  Git,
  readFeed,
  refusal,
  seededRepo,
  startForge,
} from "./forge.js";

const REPO = "activity";

let forge: Forge;
/** Owns the repository; asks for reviews and reviews. */
let owner: Account;
/** A collaborator: the user the agent acts for, whose feed it follows. */
let dev: Account;
let ownerGit: Git;
let devGit: Git;
let ownerWork = "";
let devWork = "";
let repoId = "";
let agent: Awaited<ReturnType<typeof delegatedAgent>>;
/** Where the agent started following, through REST and through MCP (a cursor is its token's own). */
let start = "";
let startMcp = "";

beforeAll(async () => {
  forge = await startForge("feed");
  owner = forge.admin;
  dev = await forge.user(`dev${Date.now().toString(36)}`);
  ownerGit = new Git(forge, owner);
  devGit = new Git(forge, dev);
  ownerWork = await seededRepo(forge, owner, ownerGit, REPO, { "README.md": "one\ntwo\n" });
  repoId = (await owner.api.call("repos.get", { owner: owner.handle, repo: REPO })).id;
  await setCollaborator();
  devWork = await devGit.clone(owner.handle, REPO, "dev");
  agent = await delegatedAgent(forge, dev, `${dev.handle}-bot`, [
    "metadata:read",
    "pull_requests:read",
  ]);
  start = (await agent.api.call("feed.sync", {})).head_cursor;
  startMcp = (await agent.mcp.tool<{ head_cursor: string }>("sync_feed", {})).head_cursor;
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

const at = () => ({ owner: owner.handle, repo: REPO });

const setCollaborator = () =>
  owner.api.call("repos.collaborators.set", {
    ...at(),
    username: dev.handle,
    permission: "push",
  });

/** Pushes `branch` from main with one change to README.md, as `git`. */
async function pushBranch(git: Git, work: string, branch: string, readme: string) {
  await git.ok(["fetch", "-q", "origin", "main"], work);
  await git.ok(["checkout", "-q", "-B", branch, "FETCH_HEAD"], work);
  const head = await git.commit(work, { "README.md": readme }, branch);
  await git.ok(["push", "-q", "origin", branch], work);
  return head;
}

/** The owner opens a pull request and asks the agent's user to review it. */
async function askForReview(branch: string): Promise<number> {
  await pushBranch(ownerGit, ownerWork, branch, `one\ntwo\n${branch}\n`);
  const pull = await owner.api.call("pulls.create", {
    ...at(),
    title: `Review ${branch}`,
    head: branch,
    base: "main",
  });
  await owner.api.call("pulls.requested_reviewers.add", {
    ...at(),
    pull_number: pull.number,
    reviewers: [dev.handle],
  });
  return pull.number;
}

/** This repository's items of a list of them. */
const ours = (items: readonly FeedItem[]) => items.filter((i) => i.repo.id === repoId);

describe("an agent following its user's activity feed (wrangler dev)", () => {
  it("sees a review request, a review outcome and a merge conflict once each, latest state", {
    timeout: 240_000,
  }, async () => {
    const feed = new FeedFollower(agent.api, start);
    // A review asked of the agent's user.
    const asked = await askForReview("asked");
    // Its user's own pull request: changes requested, then approved, then a conflict with main.
    const head = await pushBranch(devGit, devWork, "own", "one\ntwo (dev)\n");
    const own = (
      await dev.api.call("pulls.create", { ...at(), title: "Own", head: "own", base: "main" })
    ).number;
    const review = (event: "REQUEST_CHANGES" | "APPROVE", body?: string) =>
      owner.api.call("pulls.reviews.create", {
        ...at(),
        pull_number: own,
        commit_id: head,
        event,
        ...(body !== undefined && { body }),
      });
    await review("REQUEST_CHANGES", "Not yet.");
    const changes = await feed.until(forge, own, "changes_requested", "open");
    await review("APPROVE");
    await pushBranch(ownerGit, ownerWork, "main", "one\ntwo (owner)\n");

    const request = await feed.until(forge, asked, "review_requested", "open");
    expect(request).toMatchObject({ priority: "P0", reasons: ["requested_reviewer"] });
    expect(request.repo.full_name).toBe(`${owner.handle}/${REPO}`);
    const approved = await feed.until(forge, own, "approved", "open");
    expect(approved.priority).toBe("P0");
    // The request for changes was answered by the approval: the same item, resolved.
    const settled = await feed.until(forge, own, "changes_requested", "resolved");
    expect(settled.item_key).toBe(changes.item_key);
    expect(settled.version).toBeGreaterThan(changes.version);
    const conflict = await feed.until(forge, own, "merge_conflict", "open");
    expect(conflict.reasons).toContain("author");

    // Read again from where it started: each item once, as last changed.
    const again = ours((await readFeed(agent.api, start)).items);
    const keys = again.map((i) => i.item_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const item of [request, approved, settled, conflict])
      expect(again.find((i) => i.item_key === item.item_key)).toMatchObject({
        state: item.state,
        version: item.version,
      });
    // MCP reads the same feed the same way.
    const viaMcp = await agent.mcp.tool<{ items: FeedItem[] }>("get_feed", {
      since: startMcp,
      limit: 100,
    });
    expect(
      ours(viaMcp.items)
        .map((i) => `${i.item_key}@${i.version}`)
        .sort(),
    ).toEqual(again.map((i) => `${i.item_key}@${i.version}`).sort());

    // A sync lists what is open, with a cursor from which nothing has changed since.
    const synced = await agent.api.call("feed.sync", {});
    expect(synced.complete).toBe(true);
    const open = ours(synced.items).map((i) => `${i.thread_key} ${i.kind}`);
    for (const wanted of [
      `pull/${asked} review_requested`,
      `pull/${own} approved`,
      `pull/${own} merge_conflict`,
    ])
      expect(open).toContain(wanted);
    const caughtUp = await agent.api.call("feed.list", { since: synced.head_cursor });
    expect(caughtUp.items).toEqual([]);
    expect(caughtUp.poll_after_ms).toBeGreaterThan(0);
    const syncedViaMcp = await agent.mcp.tool<{ items: FeedItem[]; head_cursor: string }>(
      "sync_feed",
      {},
    );
    expect(ours(syncedViaMcp.items).map((i) => i.item_key)).toEqual(
      ours(synced.items).map((i) => i.item_key),
    );
  });

  it("refuses a forged cursor, an unknown one or one ahead of the feed with 410 and where to resync", async () => {
    const synced = await agent.api.call("feed.sync", {});
    const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const real = JSON.parse(Buffer.from(synced.head_cursor, "base64url").toString()) as {
      v: number;
      e: string;
      i: string;
    };
    const forged = cursor({ ...real, e: `${real.e}x` });
    const unknown = cursor({ ...real, i: "0".repeat(32) });
    // Of before streams: a sequence number of the whole feed, past its head.
    const ahead = cursor({ v: 1, e: real.e, s: 1_000_000 });
    for (const since of [forged, unknown, ahead])
      expect(await refusal(agent.api.call("feed.list", { since }))).toMatchObject({
        status: 410,
        code: "cursor_expired",
        resync: "/api/feed/sync",
      });
    await expect(agent.mcp.tool("get_feed", { since: forged })).rejects.toThrow(/cursor_expired/);
    // The REST token's cursor is not the MCP token's.
    await expect(agent.mcp.tool("get_feed", { since: start })).rejects.toThrow(/cursor_expired/);
  });

  it("drops a removed collaborator's items, and brings only new ones once access is back", {
    timeout: 240_000,
  }, async () => {
    // An item of the repository in the feed first.
    const removed = await askForReview("before-removal");
    await new FeedFollower(agent.api, start).until(forge, removed, "review_requested", "open");
    const before = ours((await agent.api.call("feed.sync", {})).items);
    expect(before.map((i) => i.thread_key)).toContain(`pull/${removed}`);
    await owner.api.call("repos.collaborators.remove", { ...at(), username: dev.handle });
    // Out of sight at once (the feed checks access when read)...
    expect(ours((await agent.api.call("feed.sync", {})).items)).toEqual([]);
    expect(ours((await readFeed(agent.api, start)).items)).toEqual([]);

    // ...and deleted: with access given back, the old items do not return.
    await setCollaborator();
    await eventually("the feed to forget the repository's old items", async () => {
      const items = ours((await readFeed(agent.api, start)).items);
      if (items.length === 0) return true;
      await forge.cron(EFFECTS_CRON);
      return undefined;
    });
    // New ones do.
    const feed = new FeedFollower(agent.api, start);
    const later = await askForReview("after");
    await feed.until(forge, later, "review_requested", "open");
    expect(
      ours([...feed.items.values()])
        .map((i) => i.thread_key)
        .filter((t) => t !== `pull/${later}`),
    ).toEqual([]);
  });
});
