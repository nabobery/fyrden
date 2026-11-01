// Review and diff comment webhooks made from their events' captures: the
// review or comment as the API shows it, as of the event (a comment
// outdated once its pull request's head moved past it), and the pull
// request as it stood; who dismissed a review as a user; an edit's
// changes; a deleted comment as it was, its reactions included.
import { describe, expect, inject, it } from "vitest";
import { api, user } from "./helpers/api.js";
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

describe("review webhooks made from captures", () => {
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
  /** Moves branch `name` from `old` to `sha` (both in the repository already). */
  const branchAt = async (name: string, sha: string, old = ZERO) => {
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
      pushBody([{ old, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
    );
  };
  /** A pull request from `feature` (one commit ahead of main); its head. */
  const opened = async () => {
    const base = await commitOn("main", "one\ntwo\n");
    await branchAt("feature", base);
    const head = await commitOn("feature", "one\ntwo\nthree\n");
    await ok(
      api("POST", `${t.path}/pulls`, t.owner.token, { title: "A", head: "feature", base: "main" }),
    );
    return head;
  };

  it("show a review and its pull request as of the event, who dismissed it as a user", async () => {
    const head = await opened();
    await t.createHook({ events: ["pull_request_review"] });
    const me = { id: t.owner.principalId, login: t.owner.handle };
    const reviewer = await user();
    await ok(
      api("PUT", `${t.path}/collaborators/${reviewer.handle}`, t.owner.token, {
        permission: "push",
      }),
    );
    const review = await ok<{ id: number }>(
      api("POST", `${t.path}/pulls/1/reviews`, reviewer.token, {
        commit_id: head,
        event: "APPROVE",
        body: "Ship it.",
      }),
    );
    await ok(
      api("PUT", `${t.path}/pulls/1/reviews/${review.id}/dismissals`, t.owner.token, {
        message: "Out of date",
      }),
    );
    // Changed before any body is made: no body shows it.
    await ok(api("PATCH", `${t.path}/pulls/1`, t.owner.token, { title: "Renamed" }));

    const [submitted, dismissed] = await t.bodies(await t.routed());
    const who = { id: reviewer.principalId, login: reviewer.handle };
    expect(submitted).toMatchObject({
      fyrden_payload: 1,
      event: "pull_request_review",
      action: "submitted",
      review: { id: review.id, user: who, state: "APPROVED", body: "Ship it.", commit_id: head },
      pull_request: { number: 1, title: "A", head: { sha: head } },
      sender: who,
    });
    expect((submitted?.review as Body | undefined)?.submitted_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(dismissed).toMatchObject({
      action: "dismissed",
      review: {
        state: "DISMISSED",
        dismissal: { by: me, message: "Out of date", at: expect.stringMatching(/^\d{4}-/) },
      },
      sender: me,
    });
  });

  it("show a diff comment as of the event, outdated once the head moved past it", async () => {
    const head = await opened();
    await t.createHook({ events: ["pull_request_review_comment"] });
    const me = { id: t.owner.principalId, login: t.owner.handle };
    const long = `${"This line could overflow.\n".repeat(60)}"why"`;
    const comment = await ok<{ id: number }>(
      api("POST", `${t.path}/pulls/1/comments`, t.owner.token, {
        body: long,
        commit_id: head,
        path: "a.txt",
        line: 3,
      }),
    );
    await ok(
      api("POST", `${t.path}/pulls/comments/${comment.id}/reactions`, t.owner.token, {
        content: "eyes",
      }),
    );
    const moved = await commitOn("feature", "one\ntwo\nthree\nfour\n");
    await ok(
      api("PATCH", `${t.path}/pulls/comments/${comment.id}`, t.owner.token, { body: "Fine." }),
    );
    await ok(api("DELETE", `${t.path}/pulls/comments/${comment.id}`, t.owner.token));

    const [created, edited, deleted] = await t.bodies(await t.routed());
    expect(created).toMatchObject({
      fyrden_payload: 1,
      event: "pull_request_review_comment",
      action: "created",
      comment: {
        id: comment.id,
        body: long,
        user: me,
        path: "a.txt",
        line: 3,
        commit_id: head,
        outdated: false,
        reactions: { total_count: 0 },
      },
      pull_request: { number: 1, head: { sha: head } },
    });
    // The head moved past it: outdated, as the pull request then was.
    expect(edited).toMatchObject({
      comment: { body: "Fine.", outdated: true, line: null, reactions: { eyes: 1 } },
      pull_request: { head: { sha: moved } },
      changes: { body: { from: long } },
    });
    expect(deleted).toMatchObject({
      action: "deleted",
      comment: { id: comment.id, body: "Fine.", reactions: { total_count: 1 } },
    });
  });

  it("judge a base-side comment as the API does, outdated once only the base moved", async () => {
    // main at B, the head two commits on (H1, then H2), each changing line 2.
    const base = await commitOn("main", "one\ntwo\n");
    await branchAt("feature", base);
    const h1 = await commitOn("feature", "one\n2\n");
    const h2 = await commitOn("feature", "one\nTWO\n");
    await ok(
      api("POST", `${t.path}/pulls`, t.owner.token, { title: "A", head: "feature", base: "main" }),
    );
    await t.createHook({ events: ["pull_request_review_comment"] });
    const left = await ok<{ id: number }>(
      api("POST", `${t.path}/pulls/1/comments`, t.owner.token, {
        body: "On the old line.",
        commit_id: h2,
        path: "a.txt",
        side: "LEFT",
        line: 2,
      }),
    );
    // main takes H1: the base side compares H1's line 2 now, not B's; the head did not move.
    await branchAt("main", h1, base);
    const reply = await ok<{ outdated: boolean }>(
      api("POST", `${t.path}/pulls/1/comments`, t.owner.token, {
        body: "Still?",
        in_reply_to: left.id,
      }),
    );
    expect(reply.outdated).toBe(true);

    const [created, replied] = await t.bodies(await t.routed());
    expect(created).toMatchObject({ comment: { side: "LEFT", outdated: false, line: 2 } });
    expect(replied).toMatchObject({
      comment: { in_reply_to_id: left.id, outdated: true, line: null },
      pull_request: { head: { sha: h2 } },
    });
  });
});
