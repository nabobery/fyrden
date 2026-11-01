// Conversation comment webhooks made from their events' captures: what the
// comment is on (an issue, or a pull request as the issue endpoints show
// one) and the comment as the API shows them, as of the event; an edit's
// changes; a deleted comment as it was, its reactions included.
import { describe, expect, inject, it } from "vitest";
import { api, json } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

type Body = Record<string, unknown>;

/** Fails with the answer when a call does not succeed; the answer's JSON otherwise. */
async function ok<T = Body>(res: Promise<Response>): Promise<T> {
  const answer = await res;
  if (answer.status >= 300) throw new Error(`${answer.status}: ${await answer.text()}`);
  return (answer.status === 204 ? {} : await answer.json()) as T;
}

describe("comment webhooks made from captures", () => {
  const fx = inject("pushFixtures");

  it("show the comment and what it is on as the API does, as of each event", async () => {
    await t.createHook({ events: ["issue_comment"] });
    const at = t.path;
    const me = { id: t.owner.principalId, login: t.owner.handle };
    await ok(api("POST", `${at}/labels`, t.owner.token, { name: "triage", color: "d73a4a" }));
    await ok(api("POST", `${at}/milestones`, t.owner.token, { title: "v1" }));
    await ok(
      api("POST", `${at}/issues`, t.owner.token, {
        title: "Broken",
        body: "It fails.",
        labels: ["triage"],
        assignees: [t.owner.handle],
        milestone: 1,
      }),
    );
    const long = `${"Reproduced.\n".repeat(200)}\u0000 "end"`;
    const comment = await ok<{ id: number }>(
      api("POST", `${at}/issues/1/comments`, t.owner.token, { body: long }),
    );
    await ok(
      api("POST", `${at}/issues/comments/${comment.id}/reactions`, t.owner.token, {
        content: "+1",
      }),
    );
    await ok(
      api("PATCH", `${at}/issues/comments/${comment.id}`, t.owner.token, { body: "Fixed." }),
    );
    await ok(api("DELETE", `${at}/issues/comments/${comment.id}`, t.owner.token));
    // After every event above, before any body is made: no body shows it.
    await ok(
      api("PATCH", `${at}/issues/1`, t.owner.token, {
        title: "Renamed",
        labels: [],
        assignees: [],
        milestone: null,
      }),
    );
    await ok(api("PATCH", `${at}/labels/triage`, t.owner.token, { new_name: "renamed" }));

    const [created, edited, deleted] = await t.bodies(await t.routed());
    expect(created).toMatchObject({
      fyrden_payload: 1,
      event: "issue_comment",
      action: "created",
      issue: {
        number: 1,
        title: "Broken",
        body: "It fails.",
        user: me,
        labels: [{ name: "triage", color: "d73a4a" }],
        assignees: [me],
        milestone: { number: 1, title: "v1", open_issues: 1, creator: me },
        reactions: { total_count: 0 },
      },
      comment: {
        id: comment.id,
        issue_number: 1,
        body: long,
        user: me,
        performed_via_agents: [],
        reactions: { total_count: 0 },
      },
      sender: me,
    });
    expect((created?.issue as Body | undefined)?.pull_request).toBeUndefined();
    expect((created?.comment as Body | undefined)?.created_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(edited).toMatchObject({
      comment: { body: "Fixed.", reactions: { total_count: 1, "+1": 1 } },
      changes: { body: { from: long } },
    });
    // Deleted: as it was, its reactions counted before they went.
    expect(deleted).toMatchObject({
      action: "deleted",
      issue: { number: 1, title: "Broken" },
      comment: { id: comment.id, body: "Fixed.", reactions: { total_count: 1 } },
    });
  });

  it("show a pull request it is on as the issue endpoints do", async () => {
    await t.createHook({ events: ["issue_comment"] });
    const made = await json<{ commit: { sha: string } }>(
      api("POST", `${t.path}/file-commits`, t.owner.token, {
        branch: "main",
        message: "change",
        changes: [{ path: "a.txt", content: "one\n" }],
      }),
    );
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
      pushBody([{ old: ZERO, new: made.body.commit.sha, ref: "refs/heads/feature" }], {
        pack: fx.packEmpty,
      }),
    );
    await ok(
      api("POST", `${t.path}/file-commits`, t.owner.token, {
        branch: "feature",
        message: "more",
        changes: [{ path: "a.txt", content: "one\ntwo\n" }],
      }),
    );
    await ok(
      api("POST", `${t.path}/pulls`, t.owner.token, { title: "A", head: "feature", base: "main" }),
    );
    await ok(api("POST", `${t.path}/issues/1/comments`, t.owner.token, { body: "Looks good." }));

    const [created] = await t.bodies(await t.routed());
    expect(created).toMatchObject({
      action: "created",
      issue: { number: 1, title: "A", state: "open", pull_request: { merged_at: null } },
      comment: { body: "Looks good.", issue_number: 1 },
    });
  });
});
