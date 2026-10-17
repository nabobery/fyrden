// Pull requests from a fork, reviewed under a ruleset, against fyrden-api
// under `wrangler dev`, through public entry points only (REST and stock
// git). The base's default branch takes changes through pull requests only,
// each needing an approval of its exact head (earlier approvals go stale on
// a push) and the base's latest commit. Covered: the base's maintainers
// updating the fork's branch when its author allows it, refused when it does
// not or withdraws that consent; an approval going stale after a push to the
// base (the branch brought up to date makes a new head) and after a push to
// the fork's branch, the merge refused until that exact head is approved
// again; and the base merging only the revision `refs/pull/<n>/head` names.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Account,
  eventually,
  type Forge,
  Git,
  refusal,
  seededRepo,
  startForge,
} from "./forge.js";

const REPO = "reviewed";

let forge: Forge;
/** Owns the base; bypasses its ruleset (pushes to main directly). */
let maintainer: Account;
/** Writes the base: reviews, updates branches and merges, held to the ruleset. */
let reviewer: Account;
/** Reads the base; owns the fork the pull requests come from. */
let contributor: Account;
let maintainerGit: Git;
let contributorGit: Git;
let baseWork = "";
let forkWork = "";

beforeAll(async () => {
  forge = await startForge("review");
  maintainer = forge.admin;
  const suffix = Date.now().toString(36);
  reviewer = await forge.user(`reviewer${suffix}`);
  contributor = await forge.user(`contrib${suffix}`);
  maintainerGit = new Git(forge, maintainer);
  contributorGit = new Git(forge, contributor);
  baseWork = await seededRepo(forge, maintainer, maintainerGit, REPO, { "README.md": "base\n" });
  const at = { owner: maintainer.handle, repo: REPO };
  await maintainer.api.call("repos.collaborators.set", {
    ...at,
    username: reviewer.handle,
    permission: "push",
  });
  await maintainer.api.call("repos.collaborators.set", {
    ...at,
    username: contributor.handle,
    permission: "pull",
  });
  await maintainer.api.call("repos.rulesets.create", {
    ...at,
    name: "reviewed changes",
    enforcement: "active",
    target: "branch",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          require_code_owner_review: false,
          allowed_merge_methods: ["merge", "squash", "rebase"],
          allow_agent_approvals: false,
        },
      },
      { type: "require_up_to_date" },
    ],
    bypass_actors: [{ actor_type: "RepositoryRole", actor_id: "admin", bypass_mode: "always" }],
  });
  await contributor.api.call("repos.fork", at);
  forkWork = await contributorGit.clone(contributor.handle, REPO, "fork");
  await contributorGit.ok(
    ["remote", "add", "upstream", contributorGit.url(maintainer.handle, REPO)],
    forkWork,
  );
}, 180_000);

afterAll(async () => {
  await forge?.stop();
});

const at = () => ({ owner: maintainer.handle, repo: REPO });

/** A branch of the fork from the base's tip with one commit, and a pull request of it. */
async function openFromFork(branch: string, maintainerCanModify: boolean) {
  await contributorGit.ok(["fetch", "-q", "upstream", "main"], forkWork);
  await contributorGit.ok(["checkout", "-q", "-B", branch, "FETCH_HEAD"], forkWork);
  const head = await contributorGit.commit(forkWork, { [`${branch}.txt`]: "fork\n" }, branch);
  await contributorGit.ok(["push", "-q", "origin", branch], forkWork);
  const pull = await contributor.api.call("pulls.create", {
    ...at(),
    title: branch,
    head: `${contributor.handle}:${branch}`,
    base: "main",
    maintainer_can_modify: maintainerCanModify,
  });
  expect(pull.head.sha).toBe(head);
  expect(pull.maintainer_can_modify).toBe(maintainerCanModify);
  return { number: pull.number, head };
}

/** The maintainer moves the base's main on with a commit of its own (it bypasses the ruleset). */
async function moveBase(file: string): Promise<string> {
  await maintainerGit.ok(["fetch", "-q", "origin", "main"], baseWork);
  await maintainerGit.ok(["checkout", "-q", "-B", "main", "FETCH_HEAD"], baseWork);
  const tip = await maintainerGit.commit(baseWork, { [file]: "base moved\n" }, `base: ${file}`);
  await maintainerGit.ok(["push", "-q", "origin", "main"], baseWork);
  return tip;
}

/** Waits until the base has imported the fork's branch at `sha` as the pull request's head. */
async function headReaches(number: number, sha: string) {
  await eventually(`pull request #${number} at ${sha}`, async () => {
    const pull = await reviewer.api.call("pulls.get", { ...at(), pull_number: number });
    return pull.head.sha === sha ? pull : undefined;
  });
}

/** The fork's branch on the server. */
async function forkBranch(branch: string): Promise<string | undefined> {
  return (await contributorGit.remoteRefs(contributor.handle, REPO))[`refs/heads/${branch}`];
}

/** A merge refused because no approval of the head being merged stands. */
const STALE = {
  status: 405,
  code: "merge_refused",
  detail: expect.stringMatching(/1 approving review is required \(0 given\)/),
};

const approve = (number: number, sha: string) =>
  reviewer.api.call("pulls.reviews.create", {
    ...at(),
    pull_number: number,
    commit_id: sha,
    event: "APPROVE",
  });

const mergeAt = (number: number, sha: string) =>
  reviewer.api.call("pulls.merge", { ...at(), pull_number: number, merge_method: "merge", sha });

const updateBranch = (number: number) =>
  reviewer.api.call("pulls.branch.update", { ...at(), pull_number: number });

/**
 * Updates the branch once the fork has been told of its author's consent
 * (it is told in the background): refused as `maintainer_edits_off` until then.
 */
const updateOnceAllowed = (number: number) =>
  eventually(`the fork to take #${number}'s update`, async () => {
    try {
      return await updateBranch(number);
    } catch (error) {
      if ((error as { code?: string }).code === "maintainer_edits_off") return undefined;
      throw error;
    }
  });

describe("fork pull requests under a ruleset (wrangler dev)", () => {
  it("lets the base's maintainers update the fork's branch only while its author allows it", {
    timeout: 240_000,
  }, async () => {
    const { number, head } = await openFromFork("edits", false);
    await moveBase("edits-base-1.txt");
    // Off: refused, and the fork's branch is left alone.
    expect(await refusal(updateBranch(number))).toMatchObject({
      status: 403,
      code: "maintainer_edits_off",
    });
    expect(await forkBranch("edits")).toBe(head);

    // On: the update is a merge commit written to the fork's branch, which the base then follows.
    const allowed = await contributor.api.call("pulls.update", {
      ...at(),
      pull_number: number,
      maintainer_can_modify: true,
    });
    expect(allowed.maintainer_can_modify).toBe(true);
    const updated = await updateOnceAllowed(number);
    expect(await forkBranch("edits")).toBe(updated.sha);
    await contributorGit.ok(["fetch", "-q", "origin", "edits"], forkWork);
    const baseTip = (await maintainerGit.remoteRefs(maintainer.handle, REPO))["refs/heads/main"];
    expect(await contributorGit.ok(["log", "-1", "--format=%P", "FETCH_HEAD"], forkWork)).toBe(
      `${head} ${baseTip}`,
    );
    await headReaches(number, updated.sha);

    // Consent withdrawn: refused again, though it was allowed before.
    const withdrawn = await contributor.api.call("pulls.update", {
      ...at(),
      pull_number: number,
      maintainer_can_modify: false,
    });
    expect(withdrawn.maintainer_can_modify).toBe(false);
    await moveBase("edits-base-2.txt");
    expect(await refusal(updateBranch(number))).toMatchObject({
      status: 403,
      code: "maintainer_edits_off",
    });
    expect(await forkBranch("edits")).toBe(updated.sha);
    // Only the author decides: the maintainer cannot turn it back on.
    expect(
      await refusal(
        maintainer.api.call("pulls.update", {
          ...at(),
          pull_number: number,
          maintainer_can_modify: true,
        }),
      ),
    ).toMatchObject({ status: 403 });
    await contributor.api.call("pulls.update", { ...at(), pull_number: number, state: "closed" });
  });

  it("refuses a merge after a push to the base until the updated head is approved", {
    timeout: 240_000,
  }, async () => {
    const { number, head } = await openFromFork("base-push", true);
    await approve(number, head);
    const moved = await moveBase("base-push-base.txt");
    // The ruleset wants the base's latest commit in the pull request.
    expect(await refusal(mergeAt(number, head))).toMatchObject({
      status: 405,
      code: "merge_refused",
      detail: expect.stringMatching(/must include the latest commit of the branch/),
    });

    // Brought up to date, a new head: the approval of the old one no longer counts.
    const updated = await updateOnceAllowed(number);
    await headReaches(number, updated.sha);
    expect(await refusal(mergeAt(number, updated.sha))).toMatchObject(STALE);
    // An approval of another head does not do either.
    await approve(number, head);
    expect(await refusal(mergeAt(number, updated.sha))).toMatchObject(STALE);

    await approve(number, updated.sha);
    const merged = await mergeAt(number, updated.sha);
    expect(merged.merged).toBe(true);
    await maintainerGit.ok(["fetch", "-q", "origin", `refs/pull/${number}/head`], baseWork);
    expect(await maintainerGit.ok(["rev-parse", "FETCH_HEAD"], baseWork)).toBe(updated.sha);
    await maintainerGit.ok(["fetch", "-q", "origin", "main"], baseWork);
    const parents = await maintainerGit.ok(["log", "-1", "--format=%P", merged.sha], baseWork);
    expect(parents).toBe(`${moved} ${updated.sha}`);
  });

  it("refuses a merge after a push to the fork's branch until that head is approved", {
    timeout: 240_000,
  }, async () => {
    const { number, head } = await openFromFork("fork-push", false);
    await approve(number, head);
    // The fork's author pushes again; the base follows it in the background.
    const pushed = await contributorGit.commit(forkWork, { "fork-push.txt": "again\n" }, "again");
    await contributorGit.ok(["push", "-q", "origin", "fork-push"], forkWork);
    await headReaches(number, pushed);
    const pullRef = `refs/pull/${number}/head`;
    await maintainerGit.ok(["fetch", "-q", "origin", pullRef], baseWork);
    expect(await maintainerGit.ok(["rev-parse", "FETCH_HEAD"], baseWork)).toBe(pushed);

    // The old head is not the pull request's any more, and its approval does not count.
    expect(await refusal(mergeAt(number, head))).toMatchObject({ status: 409, code: "head_moved" });
    expect(await refusal(mergeAt(number, pushed))).toMatchObject(STALE);

    await approve(number, pushed);
    const before = (await maintainerGit.remoteRefs(maintainer.handle, REPO))["refs/heads/main"];
    const merged = await mergeAt(number, pushed);
    expect(merged.merged).toBe(true);
    await maintainerGit.ok(["fetch", "-q", "origin", "main"], baseWork);
    // The base merged the revision its pull request ref names.
    expect(await maintainerGit.ok(["log", "-1", "--format=%P", merged.sha], baseWork)).toBe(
      `${before} ${pushed}`,
    );
    expect(await maintainerGit.ok(["show", `${merged.sha}:fork-push.txt`], baseWork)).toBe("again");
  });
});
