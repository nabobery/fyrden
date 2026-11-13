// Commit statuses from an outside CI, against fyrden-api under `wrangler
// dev`, through public entry points only (REST through the SDK, stock git):
// a token that may only post statuses reports a failure on a pull request's
// head, the combined status shows it, the author's feed gets a `ci_failed`
// item naming the failing check, and pushing a new head resolves it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  FeedFollower,
  type Forge,
  Git,
  refusal,
  seededRepo,
  startForge,
} from "./forge.js";

const REPO = "statuses";

let forge: Forge;
let owner: Account;
/** The outside CI: a collaborator whose token only posts statuses. */
let ci: Account;
let ownerGit: Git;
let work = "";

beforeAll(async () => {
  forge = await startForge("statuses");
  owner = forge.admin;
  const bot = await forge.user(`ci${Date.now().toString(36)}`);
  ownerGit = new Git(forge, owner);
  work = await seededRepo(forge, owner, ownerGit, REPO, { "README.md": "one\n" });
  await owner.api.call("repos.collaborators.set", {
    owner: owner.handle,
    repo: REPO,
    username: bot.handle,
    permission: "push",
  });
  const token = await owner.api.call("admin.tokens.create", {
    user_id: bot.id,
    type: "pat",
    scopes: ["statuses:write"],
    expires_in_days: 1,
  });
  ci = { ...bot, token: token.token, api: forge.client(token.token) };
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

const at = () => ({ owner: owner.handle, repo: REPO });

describe("an outside CI's statuses", () => {
  it("fail a pull request's head, tell its author, and are superseded by a new head", async () => {
    await ownerGit.ok(["checkout", "-q", "-b", "fix"], work);
    const head = await ownerGit.commit(work, { "README.md": "one\ntwo\n" }, "fix");
    await ownerGit.ok(["push", "-q", "origin", "fix"], work);
    const pull = await owner.api.call("pulls.create", {
      ...at(),
      title: "A fix",
      head: "fix",
      base: "main",
    });
    const feed = new FeedFollower(owner.api, (await owner.api.call("feed.sync", {})).head_cursor);

    // Its token posts statuses and nothing else.
    const refused = await refusal(
      ci.api.call("repos.commits.get", { ...at(), ref: head }) as Promise<unknown>,
    );
    expect(refused.status).toBe(403);
    const made = await ci.api.call("statuses.create", {
      ...at(),
      sha: head,
      state: "failure",
      context: "ci/build",
      target_url: "https://ci.example/runs/1",
      description: "2 tests failed",
    });
    expect(made).toMatchObject({ state: "failure", creator: { id: ci.id } });

    const combined = await owner.api.call("statuses.combined", { ...at(), ref: "fix" });
    expect(combined).toMatchObject({ state: "failure", sha: head, total_count: 1 });

    const failing = await feed.until(forge, pull.number, "ci_failed", "open");
    expect(failing.priority).toBe("P0");
    expect(failing.excerpt).toBe(`1 failing on ${head.slice(0, 7)}: ci/build`);

    // A new head, not yet built, supersedes the failure.
    await ownerGit.commit(work, { "README.md": "one\ntwo\nthree\n" }, "fix again");
    await ownerGit.ok(["push", "-q", "origin", "fix"], work);
    const resolved = await feed.until(forge, pull.number, "ci_failed", "resolved");
    expect(resolved.item_key).toBe(failing.item_key);
    expect(resolved.version).toBeGreaterThan(failing.version);
  });
});
