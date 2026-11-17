// Required status checks, against fyrden-api under `wrangler dev`, through
// public entry points only (REST through the SDK, stock git): a ruleset on
// the default branch requires a check, git refuses a direct push of a
// commit nobody checked with the rule's own words, and the same commit,
// checked on a topic branch by an outside CI's status, then goes in.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, type Forge, Git, seededRepo, startForge } from "./forge.js";

const REPO = "required";

let forge: Forge;
let owner: Account;
let ownerGit: Git;
let work = "";
/** The ruleset on the default branch requiring `ci/build`, as created. */
let ruleset: { rules: unknown[] };

beforeAll(async () => {
  forge = await startForge("required-checks");
  owner = forge.admin;
  ownerGit = new Git(forge, owner);
  work = await seededRepo(forge, owner, ownerGit, REPO, { "README.md": "one\n" });
  ruleset = await owner.api.call("repos.rulesets.create", {
    owner: owner.handle,
    repo: REPO,
    name: "main needs CI",
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "required_status_checks",
        parameters: { required_status_checks: [{ context: "ci/build" }] },
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

const at = () => ({ owner: owner.handle, repo: REPO });

describe("a required status check", () => {
  it("refuses a direct push git reports, and lets the commit in once checked", async () => {
    expect(ruleset.rules).toEqual([
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: "ci/build" }],
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
        },
      },
    ]);

    const head = await ownerGit.commit(work, { "README.md": "one\ntwo\n" }, "two");
    const refused = await ownerGit.try(["push", "origin", "main"], work);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(
      '! [remote rejected] main -> main (required status check "ci/build" is expected (ruleset "main needs CI"))',
    );

    // Checked on a topic branch, the same commit is promoted.
    await ownerGit.ok(["push", "-q", "origin", "HEAD:refs/heads/topic"], work);
    await owner.api.call("statuses.create", {
      ...at(),
      sha: head,
      state: "pending",
      context: "ci/build",
    });
    const pending = await ownerGit.try(["push", "origin", "main"], work);
    expect(pending.stderr).toContain('required status check "ci/build" is pending');
    await owner.api.call("statuses.create", {
      ...at(),
      sha: head,
      state: "success",
      context: "ci/build",
      target_url: "https://ci.example/runs/1",
    });
    await ownerGit.ok(["push", "-q", "origin", "main"], work);
  });

  it("shows where a pull request's required checks stand", async () => {
    await ownerGit.ok(["checkout", "-q", "-b", "feature"], work);
    const head = await ownerGit.commit(work, { "README.md": "one\ntwo\nthree\n" }, "three");
    await ownerGit.ok(["push", "-q", "origin", "feature"], work);
    const pull = await owner.api.call("pulls.create", {
      ...at(),
      title: "Three",
      head: "feature",
      base: "main",
    });
    const before = await owner.api.call("pulls.required_checks.get", {
      ...at(),
      pull_number: pull.number,
    });
    expect(before).toMatchObject({
      head_sha: head,
      blocking: true,
      checks: [{ context: "ci/build", state: "expected", deciding: [] }],
    });
    await owner.api.call("statuses.create", {
      ...at(),
      sha: head,
      state: "success",
      context: "ci/build",
    });
    const after = await owner.api.call("pulls.required_checks.get", {
      ...at(),
      pull_number: pull.number,
    });
    expect(after).toMatchObject({ blocking: false, checks: [{ state: "passed" }] });
    const merged = await owner.api.call("pulls.merge", {
      ...at(),
      pull_number: pull.number,
      merge_method: "squash",
    });
    expect(merged.merged).toBe(true);
  });
});
