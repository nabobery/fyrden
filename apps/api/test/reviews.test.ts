// Reviews of pull requests: who may submit, dismiss and request them, and
// that each review stays bound to the head commit it reviewed.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { api, handleOf, json, user, type Who } from "./helpers/api.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Review = {
  id: number;
  state: string;
  commit_id: string;
  user: { id: string };
  body: string | null;
  dismissal: { by: string; message: string } | null;
  code?: string;
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

async function push(commands: { old: string; new: string; ref: string }[], pack: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  return postPush(target, pushBody(commands, { pack }));
}

async function collaborator(permission: "pull" | "triage" | "push"): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission,
  });
  expect(set.status).toBe(200);
  return who;
}

const review = (who: Who, body: Record<string, unknown>) =>
  json<Review>(api("POST", `${path}/pulls/1/reviews`, who.token, { commit_id: fx.c2, ...body }));
const dismiss = (who: Who, id: number, message = "Out of date") =>
  json<Review>(api("PUT", `${path}/pulls/1/reviews/${id}/dismissals`, who.token, { message }));
const requested = async () =>
  (
    await json<{ users: { id: string; login: string }[] }>(
      api("GET", `${path}/pulls/1/requested_reviewers`, owner.token),
    )
  ).body.users.map((u) => u.id);

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const first = await push(
    [
      { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
      { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
    ],
    fx.packC2,
  );
  expect(first.report).toContain("ok refs/heads/feature\n");
  const opened = await api("POST", `${path}/pulls`, owner.token, {
    title: "Change",
    head: "feature",
    base: "main",
  });
  expect(opened.status).toBe(201);
});

describe("submitting reviews", () => {
  it("lets anyone who reads approve or request changes; the author only comments", async () => {
    const reader = await collaborator("pull");
    const approved = await review(reader, { event: "APPROVE" });
    expect(approved).toMatchObject({
      status: 200,
      body: {
        state: "APPROVED",
        commit_id: fx.c2,
        user: { id: reader.principalId },
        dismissal: null,
      },
    });
    expect((await review(owner, { event: "APPROVE" })).body.code).toBe("own_pull_request");
    expect((await review(owner, { event: "REQUEST_CHANGES", body: "x" })).body.code).toBe(
      "own_pull_request",
    );
    expect((await review(owner, { event: "COMMENT", body: "Note" })).body.state).toBe("COMMENTED");
    expect((await review(reader, { event: "COMMENT" })).body.code).toBe("body_required");

    const listed = await json<{ reviews: Review[] }>(
      api("GET", `${path}/pulls/1/reviews`, owner.token),
    );
    expect(listed.body.reviews.map((r) => r.state)).toEqual(["APPROVED", "COMMENTED"]);
    const one = await json<Review>(
      api("GET", `${path}/pulls/1/reviews/${approved.body.id}`, owner.token),
    );
    expect(one.body).toEqual(approved.body);
  });

  it("binds a review to a head the pull request has had, an earlier one included", async () => {
    const reader = await collaborator("pull");
    await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/feature" }], fx.packC3ThinOnC2);
    // c2 was the head before the push: the review counts for c2 only.
    expect((await review(reader, { event: "APPROVE", commit_id: fx.c2 })).body.commit_id).toBe(
      fx.c2,
    );
    expect((await review(reader, { event: "APPROVE", commit_id: fx.c3 })).body.commit_id).toBe(
      fx.c3,
    );
    // main's commit was never the pull request's head.
    expect((await review(reader, { event: "APPROVE", commit_id: fx.c1 })).body.code).toBe(
      "commit_not_in_pull",
    );
  });

  it("keeps an earlier head reviewable after its reflog rows are pruned", async () => {
    const reader = await collaborator("pull");
    await push([{ old: fx.c2, new: fx.c3, ref: "refs/heads/feature" }], fx.packC3ThinOnC2);
    // As the reflog's retention would, long after.
    await inRepo(env.REPO.getByName(repo.id), (r) => {
      r.git.context.storage.sql.exec("DELETE FROM reflog");
    });
    expect((await review(reader, { event: "APPROVE", commit_id: fx.c2 })).body.commit_id).toBe(
      fx.c2,
    );
  });

  it("refuses reviews once the pull request is closed, and a stranger as if there were no repository", async () => {
    const reader = await collaborator("pull");
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    expect((await review(reader, { event: "APPROVE" })).body.code).toBe("wrong_state");
    expect((await review(await user(), { event: "APPROVE" })).status).toBe(404);
  });

  it("records the event and the audit row with the review", async () => {
    const reader = await collaborator("pull");
    const submitted = await review(reader, { event: "REQUEST_CHANGES", body: "Rename it" });
    const rows = await inRepo(env.REPO.getByName(repo.id), (r) => {
      const sql = r.git.context.storage.sql;
      return {
        events: sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map(
            (row) =>
              JSON.parse(row.event) as {
                type: string;
                entity: { type: string; row: { id: number } } | null;
              },
          ),
        audit: sql
          .exec<{ action: string; actor_id: string }>(
            "SELECT action, actor_id FROM audit_log WHERE action LIKE 'pull_request.review%'",
          )
          .toArray(),
      };
    });
    expect(
      rows.events.find((e) => e.type === "pull_request_review.submitted")?.entity,
    ).toMatchObject({
      type: "pull_request_review",
      row: { id: submitted.body.id },
    });
    expect(rows.audit).toEqual([{ action: "pull_request.review", actor_id: reader.principalId }]);
  });
});

describe("dismissing reviews", () => {
  it("takes write access and a reason, and only for a standing approval or request for changes", async () => {
    const reader = await collaborator("pull");
    const writer = await collaborator("push");
    const approved = await review(reader, { event: "APPROVE" });
    const comment = await review(reader, { event: "COMMENT", body: "Nit" });
    expect((await dismiss(reader, approved.body.id)).status).toBe(403);
    const dismissed = await dismiss(writer, approved.body.id);
    expect(dismissed.body).toMatchObject({
      state: "DISMISSED",
      dismissal: { by: writer.principalId, message: "Out of date" },
    });
    expect((await dismiss(writer, approved.body.id)).body.code).toBe("wrong_state");
    expect((await dismiss(writer, comment.body.id)).body.code).toBe("wrong_state");
    expect((await dismiss(writer, 999)).body.code).toBe("review_not_found");
  });
});

describe("requesting reviews", () => {
  it("lets the author ask people who can read, and ends a request when its reviewer reviews", async () => {
    const reader = await collaborator("pull");
    const writer = await collaborator("push");
    const added = await api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [reader.handle, writer.handle.toUpperCase()],
    });
    expect(added.status).toBe(201);
    expect(await requested()).toEqual([reader.principalId, writer.principalId].sort());
    await review(reader, { event: "APPROVE" });
    expect(await requested()).toEqual([writer.principalId]);
    const removed = await api("DELETE", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [writer.handle, "no-such-user"],
    });
    expect(removed.status).toBe(200);
    expect(await requested()).toEqual([]);
  });

  it("does not find an agent whose owner is disabled: it could never review", async () => {
    const helper = await principalWithToken("agent");
    const owner_ = await env.DIRECTORY.prepare("SELECT owner_id FROM principals WHERE id = ?")
      .bind(helper.principalId)
      .first<{ owner_id: string }>();
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(owner_?.owner_id)
      .run();
    const asked = await json<{ code: string; detail: string }>(
      api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
        reviewers: [handleOf(helper.principalId)],
      }),
    );
    expect(asked.body).toMatchObject({
      code: "reviewer_no_access",
      detail: expect.stringContaining("No user or agent"),
    });
    expect(await requested()).toEqual([]);
  });

  it("withdraws a request made of someone disabled since", async () => {
    const reader = await collaborator("pull");
    await api("POST", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [reader.handle],
    });
    await env.DIRECTORY.prepare("UPDATE principals SET disabled_at = 1 WHERE id = ?")
      .bind(reader.principalId)
      .run();
    const removed = await api("DELETE", `${path}/pulls/1/requested_reviewers`, owner.token, {
      reviewers: [reader.handle],
    });
    expect(removed.status).toBe(200);
    expect(await requested()).toEqual([]);
  });

  it("refuses the author, someone without access, an unknown handle, and a reader asking on another's pull request", async () => {
    const reader = await collaborator("pull");
    const ask = (who: Who, reviewers: string[]) =>
      json<{ code?: string }>(
        api("POST", `${path}/pulls/1/requested_reviewers`, who.token, { reviewers }),
      );
    expect((await ask(owner, [owner.handle])).body.code).toBe("reviewer_is_author");
    expect((await ask(owner, [(await user()).handle])).body.code).toBe("reviewer_no_access");
    expect((await ask(owner, ["no-such-user"])).body.code).toBe("reviewer_no_access");
    expect((await ask(reader, [owner.handle])).status).toBe(403);
    const triager = await collaborator("triage");
    expect((await ask(triager, [reader.handle])).status).toBe(201);
  });
});
