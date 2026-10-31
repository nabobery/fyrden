// Pull request webhooks made from their events' captures: the pull request
// as the API shows it, as of the event (labels, assignees, milestone,
// head and base, whether it merged), with GitHub's top-level number, what
// a metadata action touched in full, a synchronize's head before and
// after, an edit's changes, and the reviewer a review request names.
import { describe, expect, inject, it } from "vitest";
import { api, user } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

type Body = Record<string, unknown>;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/** Fails with the answer when a call does not succeed; the answer's JSON otherwise. */
async function ok<T = Body>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

describe("pull request webhooks made from captures", () => {
  const fx = inject("pushFixtures");
  const commitOn = async (branch: string, content: string) =>
    (
      await ok<{ commit: { sha: string } }>(
        api("POST", `${t.path}/file-commits`, t.owner.token, {
          branch,
          message: "change",
          changes: [{ path: "a.txt", content }],
        }),
      )
    ).commit.sha;
  const branchAt = async (name: string, sha: string) => {
    const target: PushTarget = {
      repo: { id: t.repo.id, name: t.repo.name, stub: t.stub() },
      owner: {
        principalId: t.owner.principalId,
        token: await scopedToken(t.owner.principalId, [], "git"),
      },
      path: `/${t.owner.handle}/${t.repo.name}.git`,
    };
    await postPush(
      target,
      pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
    );
  };

  it("show the pull request as the API does, as of each event, what each change touched in full", async () => {
    await t.createHook({ events: ["pull_request"] });
    const at = t.path;
    const me = { id: t.owner.principalId, login: t.owner.handle };
    const reviewer = await user();
    await ok(
      api("PUT", `${at}/collaborators/${reviewer.handle}`, t.owner.token, { permission: "push" }),
    );
    await ok(api("POST", `${at}/labels`, t.owner.token, { name: "triage", color: "d73a4a" }));
    await ok(api("POST", `${at}/milestones`, t.owner.token, { title: "v1" }));
    await branchAt("feature", await commitOn("main", "one\n"));
    const first = await commitOn("feature", "one\ntwo\n");
    const long = `${"Why this change:\n".repeat(200)}"done"`;
    await ok(
      api("POST", `${at}/pulls`, t.owner.token, {
        title: "A",
        body: long,
        head: "feature",
        base: "main",
      }),
    );
    await ok(api("PATCH", `${at}/pulls/1`, t.owner.token, { title: "A better" }));
    await ok(api("POST", `${at}/issues/1/labels`, t.owner.token, { labels: ["triage"] }));
    await ok(
      api("POST", `${at}/issues/1/assignees`, t.owner.token, { assignees: [t.owner.handle] }),
    );
    await ok(api("PATCH", `${at}/issues/1`, t.owner.token, { milestone: 1 }));
    await ok(
      api("POST", `${at}/pulls/1/requested_reviewers`, t.owner.token, {
        reviewers: [reviewer.handle],
      }),
    );
    const second = await commitOn("feature", "one\ntwo\nthree\n");
    await ok(api("PATCH", `${at}/pulls/1`, t.owner.token, { state: "closed" }));
    // After every event above, before any body is made: no body shows it.
    await ok(api("PATCH", `${at}/labels/triage`, t.owner.token, { new_name: "renamed" }));

    const bodies = await t.bodies(await t.routed());
    const by = (action: string) => bodies.find((b) => b.action === action);
    expect(bodies.map((b) => b.action)).toEqual([
      "opened",
      "edited",
      "labeled",
      "assigned",
      "milestoned",
      "review_requested",
      "synchronize",
      "closed",
    ]);
    expect(by("opened")).toMatchObject({
      fyrden_payload: 1,
      event: "pull_request",
      number: 1,
      pull_request: {
        number: 1,
        title: "A",
        body: long,
        state: "open",
        merged: false,
        draft: false,
        user: me,
        head: { ref: "feature", sha: first },
        base: { ref: "main" },
        labels: [],
        assignees: [],
        milestone: null,
        merged_by: null,
      },
      sender: me,
    });
    expect((by("opened")?.pull_request as Body | undefined)?.created_at).toMatch(ISO);
    expect(by("edited")).toMatchObject({
      pull_request: { title: "A better" },
      changes: { title: { from: "A" } },
    });
    const triage = { name: "triage", color: "d73a4a", default: false };
    expect(by("labeled")).toMatchObject({ label: triage, pull_request: { labels: [triage] } });
    expect(by("assigned")).toMatchObject({ assignee: me, pull_request: { assignees: [me] } });
    expect(by("milestoned")).toMatchObject({
      milestone: { number: 1, title: "v1", open_issues: 1, creator: me },
      pull_request: { milestone: { number: 1 } },
    });
    expect(by("review_requested")).toMatchObject({
      number: 1,
      requested_reviewer: { id: reviewer.principalId, login: reviewer.handle },
      pull_request: { number: 1, title: "A better" },
    });
    expect(by("synchronize")).toMatchObject({
      before: first,
      after: second,
      pull_request: { head: { sha: second } },
    });
    expect(by("closed")).toMatchObject({ pull_request: { state: "closed", merged: false } });
    expect((by("closed")?.pull_request as Body | undefined)?.closed_at).toMatch(ISO);
  });

  it("tell of a draft made ready and merged, by whom and into what", async () => {
    await t.createHook({ events: ["pull_request"] });
    const me = { id: t.owner.principalId, login: t.owner.handle };
    await branchAt("feature", await commitOn("main", "one\n"));
    await commitOn("feature", "one\ntwo\n");
    await ok(
      api("POST", `${t.path}/pulls`, t.owner.token, {
        title: "Draft",
        head: "feature",
        base: "main",
        draft: true,
      }),
    );
    await ok(api("PATCH", `${t.path}/pulls/1`, t.owner.token, { draft: false }));
    const merged = await ok<{ sha: string }>(
      api("PUT", `${t.path}/pulls/1/merge`, t.owner.token, {}),
    );

    const bodies = await t.bodies(await t.routed());
    expect(bodies.map((b) => b.action)).toEqual(["opened", "ready_for_review", "closed"]);
    expect(bodies[0]).toMatchObject({ pull_request: { draft: true } });
    expect(bodies[1]).toMatchObject({ pull_request: { draft: false } });
    const pull = bodies[2]?.pull_request as Body | undefined;
    expect(pull).toMatchObject({
      state: "closed",
      merged: true,
      merged_by: me,
      merge_commit_sha: merged.sha,
    });
    expect(pull?.merged_at).toMatch(ISO);
  });
});
