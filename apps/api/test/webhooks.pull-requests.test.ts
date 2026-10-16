// Pull request webhooks: the events pull requests, reviews and comments
// make, each body with its action and a snapshot of what changed, sent only
// to hooks that take the event.
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { describe, expect, inject, it } from "vitest";
import { webhookEventOf } from "../src/webhooks/events.js";
import { bodyOf } from "../src/webhooks/sink.js";
import { api, json } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

describe("pull request webhooks", () => {
  const fx = inject("pushFixtures");
  const commitOn = async (branch: string, content: string) => {
    const made = await json<{ commit: { sha: string } }>(
      api("POST", `${t.path}/file-commits`, t.owner.token, {
        branch,
        message: "change",
        changes: [{ path: "a.txt", content }],
      }),
    );
    expect(made.status).toBe(201);
    return made.body.commit.sha;
  };
  const branchAt = async (name: string, sha: string) => {
    const target: PushTarget = {
      repo: { id: t.repo.id, name: t.repo.name, stub: t.stub() },
      owner: {
        principalId: t.owner.principalId,
        token: await scopedToken(t.owner.principalId, [], "git"),
      },
      path: `/${t.owner.handle}/${t.repo.name}.git`,
    };
    const pushed = await postPush(
      target,
      pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
    );
    expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
  };
  /** The bodies the outbox's events make, in order. */
  const bodies = async () =>
    (await t.outbox())
      .filter((e) => e.webhooks && e.type !== "webhook.ping")
      .map((e) => bodyOf(e) as Record<string, unknown>);

  it("tell of pull requests, reviews and comments with their action and snapshot", async () => {
    await t.createHook({
      events: [
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "issue_comment",
      ],
    });
    await branchAt("feature", await commitOn("main", "one\n"));
    const head = await commitOn("feature", "one\ntwo\n");
    expect(
      (
        await api("POST", `${t.path}/pulls`, t.owner.token, {
          title: "A change",
          head: "feature",
          base: "main",
        })
      ).status,
    ).toBe(201);
    await api("PATCH", `${t.path}/pulls/1`, t.owner.token, { title: "A better change" });
    const comment = await json<{ id: number }>(
      api("POST", `${t.path}/issues/1/comments`, t.owner.token, { body: "Looks right." }),
    );
    await api("DELETE", `${t.path}/issues/comments/${comment.body.id}`, t.owner.token);
    const diff = await json<{ id: number }>(
      api("POST", `${t.path}/pulls/1/comments`, t.owner.token, {
        body: "Why?",
        commit_id: head,
        path: "a.txt",
        line: 2,
      }),
    );
    expect(diff.status).toBe(201);
    expect(
      (
        await api("POST", `${t.path}/pulls/1/reviews`, t.owner.token, {
          event: "COMMENT",
          body: "Ok",
          commit_id: head,
        })
      ).status,
    ).toBe(200);
    const made = await bodies();
    expect(made.map((b) => `${b.event}.${b.action}`)).toEqual([
      "pull_request.opened",
      "pull_request.edited",
      "issue_comment.created",
      "issue_comment.deleted",
      "pull_request_review_comment.created",
      "pull_request_review.submitted",
    ]);
    const [opened, edited, created, deleted, onDiff, review] = made;
    expect(opened).toMatchObject({
      number: 1,
      repository: { id: t.repo.id },
      sender: { id: t.owner.principalId },
      pull_request: {
        number: 1,
        state: "open",
        merged: false,
        title: "A change",
        head: { ref: "feature", sha: head, repo_id: null },
        base: { ref: "main" },
        user: { id: t.owner.principalId },
      },
    });
    expect((opened?.pull_request as { created_at?: string } | undefined)?.created_at).toMatch(
      /^\d{4}-\d\d-\d\dT/,
    );
    expect(edited).toMatchObject({
      pull_request: { title: "A better change" },
      changes: { title: { from: "A change" } },
    });
    expect(created).toMatchObject({
      number: 1,
      comment: { id: comment.body.id, body: "Looks right." },
    });
    // Gone: what it was on, and its id.
    expect(deleted).toMatchObject({ number: 1, comment: { id: comment.body.id } });
    expect(onDiff).toMatchObject({
      number: 1,
      comment: { id: diff.body.id, path: "a.txt", line: 2, commit_id: head, side: "RIGHT" },
    });
    expect(review).toMatchObject({ number: 1, review: { state: "COMMENTED", body: "Ok" } });
    // Each made its own delivery, with its action recorded.
    // One event per run: a run delivers only a few effects itself (the rest wait for the sweep).
    for (const event of (await t.outbox()).filter((e) => e.webhooks)) await t.materialize([event]);
    const actions = (
      await env.ORG_READ.prepare(
        "SELECT event, action FROM webhook_deliveries WHERE repo_id = ? AND event != 'ping'",
      )
        .bind(t.repo.id)
        .all<{ event: string; action: string }>()
    ).results.map((r) => `${r.event}.${r.action}`);
    expect(actions.sort()).toEqual(made.map((b) => `${b.event}.${b.action}`).sort());
  });

  it("show a dismissed review as dismissed, and tell of a head branch deleted or back", () => {
    const at = Date.now();
    const event = {
      id: { sourceId: t.repo.id, epochGen: 1, sourceSeq: 7 },
      type: "pull_request_review.dismissed",
      at,
      actor: t.owner.principalId,
      actChain: [],
      ownerGen: 1,
      entity: {
        type: "pull_review",
        id: `${t.repo.id}#1/reviews/3`,
        version: 2,
        deleted: false,
        row: {
          id: 3,
          number: 1,
          reviewerId: t.owner.principalId,
          actChain: [],
          state: "APPROVED",
          commitSha: "a".repeat(40),
          body: null,
          submittedAt: at,
          dismissedAt: at,
          dismissedBy: t.owner.principalId,
          dismissalMessage: "stale",
        },
      },
      data: null,
      stored: false,
      webhooks: {
        hooks: [{ id: 1, v: 1 }],
        repo: { name: t.repo.name, ownerId: t.owner.principalId, private: true },
      },
    } as unknown as DomainEvent;
    expect(bodyOf(event)).toMatchObject({
      action: "dismissed",
      review: { id: 3, state: "DISMISSED", dismissal_message: "stale" },
    });
    for (const action of ["head_ref_deleted", "head_ref_restored"])
      expect(webhookEventOf(`pull_request.${action}`)).toEqual({ event: "pull_request", action });
  });

  it("go only to hooks that take the event", async () => {
    await t.createHook({ events: ["issue_comment"] });
    await branchAt("feature", await commitOn("main", "one\n"));
    await commitOn("feature", "one\ntwo\n");
    await api("POST", `${t.path}/pulls`, t.owner.token, {
      title: "A change",
      head: "feature",
      base: "main",
    });
    await api("POST", `${t.path}/issues/1/comments`, t.owner.token, { body: "Hi." });
    expect((await bodies()).map((b) => b.event)).toEqual(["issue_comment"]);
  });
});
