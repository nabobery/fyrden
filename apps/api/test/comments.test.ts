// Conversation comments on pull requests: who may write, edit and delete
// them, and the events and audit rows each change records.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { agentFor } from "./helpers/agents.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Comment = {
  id: number;
  issue_number: number;
  body: string;
  user: { id: string };
  code?: string;
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

async function collaborator(permission: "pull" | "triage" | "push"): Promise<Who> {
  const who = await user();
  expect(
    (await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission })).status,
  ).toBe(200);
  return who;
}

const comment = (who: Who, body = "Thoughts", number = 1) =>
  json<Comment>(api("POST", `${path}/issues/${number}/comments`, who.token, { body }));
const edit = (who: Who, id: number, body: string) =>
  json<Comment>(api("PATCH", `${path}/issues/comments/${id}`, who.token, { body }));
const remove = (who: Who, id: number) =>
  json<{ code?: string }>(api("DELETE", `${path}/issues/comments/${id}`, who.token));

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody(
      [
        { old: ZERO, new: fx.c1, ref: "refs/heads/main" },
        { old: ZERO, new: fx.c2, ref: "refs/heads/feature" },
      ],
      { pack: fx.packC2 },
    ),
  );
  expect(pushed.report).toContain("ok refs/heads/feature\n");
  expect(
    (
      await api("POST", `${path}/pulls`, owner.token, {
        title: "Change",
        head: "feature",
        base: "main",
      })
    ).status,
  ).toBe(201);
});

describe("conversation comments", () => {
  it("are written by anyone who reads, listed oldest first, on open and closed pull requests", async () => {
    const reader = await collaborator("pull");
    const first = await comment(reader, "First");
    expect(first).toMatchObject({
      status: 201,
      body: { issue_number: 1, body: "First", user: { id: reader.principalId } },
    });
    await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" });
    expect((await comment(owner, "Second")).status).toBe(201);
    const listed = await json<{ comments: Comment[] }>(
      api("GET", `${path}/issues/1/comments`, owner.token),
    );
    expect(listed.body.comments.map((c) => c.body)).toEqual(["First", "Second"]);
    const one = await json<Comment>(
      api("GET", `${path}/issues/comments/${first.body.id}`, owner.token),
    );
    expect(one.body).toEqual(first.body);
    expect((await comment(owner, "x", 99)).body.code).toBe("pull_not_found");
    expect((await comment(await user())).status).toBe(404);
  });

  it("are edited and deleted by their author, or by write access and above", async () => {
    const reader = await collaborator("pull");
    const triager = await collaborator("triage");
    const writer = await collaborator("push");
    const written = await comment(reader, "Draft");
    expect((await edit(reader, written.body.id, "Final")).body.body).toBe("Final");
    expect((await edit(triager, written.body.id, "Mine")).status).toBe(403);
    expect((await edit(writer, written.body.id, "Tidied")).body.body).toBe("Tidied");
    expect((await remove(triager, written.body.id)).status).toBe(403);
    expect((await remove(reader, written.body.id)).status).toBe(200);
    expect((await remove(reader, written.body.id)).body.code).toBe("comment_not_found");
  });

  it("keep a body as written, and refuse a blank one", async () => {
    const code = "    const answer = 42;\n";
    const written = await comment(owner, code);
    expect(written.body.body).toBe(code);
    expect((await edit(owner, written.body.id, `  ${code}`)).body.body).toBe(`  ${code}`);
    expect((await comment(owner, " \n ")).status).toBe(422);
  });

  it("are the author's to change when its own agent acts for it, and not another reader's agent", async () => {
    const reader = await collaborator("pull");
    const other = await collaborator("pull");
    const written = await comment(reader, "Mine");
    const own = await agentFor(reader, ["pull_requests:write"]);
    const theirs = await agentFor(other, ["pull_requests:write"]);
    const asAgent = (token: string, body: string) =>
      json<Comment>(api("PATCH", `${path}/issues/comments/${written.body.id}`, token, { body }));
    expect((await asAgent(theirs.delegated, "Not yours")).status).toBe(403);
    expect((await asAgent(own.delegated, "Edited for me")).body.body).toBe("Edited for me");
    expect(
      (await api("DELETE", `${path}/issues/comments/${written.body.id}`, own.delegated)).status,
    ).toBe(200);
  });

  it("record each change as an event with its snapshot and an audit row", async () => {
    const written = await comment(owner, "Hello");
    await edit(owner, written.body.id, "Hello again");
    await remove(owner, written.body.id);
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
                entity: { version: number; deleted: boolean; row: unknown } | null;
              },
          )
          .filter((e) => e.type.startsWith("issue_comment.")),
        audit: sql
          .exec<{ action: string }>(
            "SELECT action FROM audit_log WHERE action LIKE 'issue_comment.%' ORDER BY seq",
          )
          .toArray()
          .map((a) => a.action),
      };
    });
    expect(
      rows.events.map((e) => [
        e.type,
        e.entity?.version,
        e.entity?.deleted,
        e.entity?.row === null,
      ]),
    ).toEqual([
      ["issue_comment.created", 1, false, false],
      ["issue_comment.edited", 2, false, false],
      ["issue_comment.deleted", 3, true, true],
    ]);
    expect(rows.audit).toEqual([
      "issue_comment.create",
      "issue_comment.edit",
      "issue_comment.delete",
    ]);
  });
});
