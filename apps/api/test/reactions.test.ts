// Reactions to issues, pull requests, conversation comments and diff
// comments: one per principal, content and target, counted on everything
// that answers the target, each kind only for a token that may act on it,
// taken back by whoever made them, and gone with their target.
import { env } from "cloudflare:workers";
import type { DomainEvent } from "@fyrden/domain";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Reaction = { id: number; content: string; user: { id: string }; code?: string };
type Rollup = { total_count: number } & Record<string, number>;

let owner: Who;
let repo: { id: string; name: string };
let path: string;
let pr: number;

const stub = () => env.REPO.getByName(repo.id);

const commitOn = async (branch: string, changes: Record<string, unknown>[]) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};

async function collaborator(permission: "pull" | "push"): Promise<Who> {
  const who = await user();
  expect(
    (await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, { permission })).status,
  ).toBe(200);
  return who;
}

const scoped = async (who: Who, scopes: string[]): Promise<Who> => ({
  ...who,
  token: await scopedToken(who.principalId, scopes, "pat"),
});

const react = (who: Who, on: string, content: string) =>
  json<Reaction>(api("POST", `${path}/${on}/reactions`, who.token, { content }));
const reactions = (who: Who, on: string, query = "") =>
  json<{ reactions: Reaction[]; next_cursor: string | null; code?: string }>(
    api("GET", `${path}/${on}/reactions${query}`, who.token),
  );
const rollupOf = async (who: Who, at: string) =>
  (await json<{ reactions: Rollup }>(api("GET", `${path}/${at}`, who.token))).body.reactions;

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const base = await commitOn("main", [{ path: "a.txt", content: "one\ntwo\n" }]);
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: base, ref: "refs/heads/feature" }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain("ok refs/heads/feature\n");
  await commitOn("feature", [{ path: "a.txt", content: "one\ntwo\nthree\n" }]);
  const opened = await json<{ number: number }>(
    api("POST", `${path}/pulls`, owner.token, { title: "Change", head: "feature", base: "main" }),
  );
  expect(opened.status).toBe(201);
  pr = opened.body.number;
});

describe("reactions", () => {
  it("are one per principal and content, counted on issues, pull requests and comments", async () => {
    const reader = await collaborator("pull");
    const issue = (
      await json<{ number: number }>(api("POST", `${path}/issues`, owner.token, { title: "Bug" }))
    ).body.number;
    const first = await react(reader, `issues/${issue}`, "+1");
    expect(first).toMatchObject({
      status: 201,
      body: { content: "+1", user: { id: reader.principalId } },
    });
    // The same again answers the one it has.
    expect((await react(reader, `issues/${issue}`, "+1")).body.id).toBe(first.body.id);
    await react(owner, `issues/${issue}`, "+1");
    await react(owner, `issues/${issue}`, "heart");
    expect(await rollupOf(reader, `issues/${issue}`)).toMatchObject({
      total_count: 3,
      "+1": 2,
      heart: 1,
      "-1": 0,
    });
    const listed = await json<{ issues: { number: number; reactions: Rollup }[] }>(
      api("GET", `${path}/issues?state=all`, owner.token),
    );
    expect(listed.body.issues.find((i) => i.number === issue)?.reactions.total_count).toBe(3);

    await react(reader, `issues/${pr}`, "rocket");
    expect((await rollupOf(owner, `pulls/${pr}`)).rocket).toBe(1);

    const comment = (
      await json<{ id: number }>(
        api("POST", `${path}/issues/${issue}/comments`, owner.token, { body: "Seen" }),
      )
    ).body.id;
    await react(reader, `issues/comments/${comment}`, "eyes");
    expect((await rollupOf(owner, `issues/comments/${comment}`)).eyes).toBe(1);
    const comments = await json<{ comments: { reactions: Rollup }[] }>(
      api("GET", `${path}/issues/${issue}/comments`, owner.token),
    );
    expect(comments.body.comments[0]?.reactions.eyes).toBe(1);

    const head = await json<{ head: { sha: string } }>(
      api("GET", `${path}/pulls/${pr}`, owner.token),
    );
    const diff = (
      await json<{ id: number }>(
        api("POST", `${path}/pulls/${pr}/comments`, owner.token, {
          body: "Look",
          commit_id: head.body.head.sha,
          path: "a.txt",
          line: 3,
        }),
      )
    ).body.id;
    expect((await react(reader, `pulls/comments/${diff}`, "hooray")).status).toBe(201);
    expect((await rollupOf(owner, `pulls/comments/${diff}`)).hooray).toBe(1);
  });

  it("are listed oldest first, by content if asked, a page at a time", async () => {
    const people = await Promise.all([
      collaborator("pull"),
      collaborator("pull"),
      collaborator("pull"),
    ]);
    for (const who of people) await react(who, `issues/${pr}`, "laugh");
    await react(owner, `issues/${pr}`, "confused");
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof reactions>> = await reactions(
        owner,
        `issues/${pr}`,
        `?content=laugh&per_page=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      seen.push(...page.body.reactions.map((r) => r.user.id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(people.map((p) => p.principalId));
  });

  it("are taken back by whoever made them only, on the target they are on", async () => {
    const reader = await collaborator("pull");
    const mine = (await react(reader, `issues/${pr}`, "+1")).body.id;
    expect(
      (await json(api("DELETE", `${path}/issues/${pr}/reactions/${mine}`, owner.token))).body,
    ).toMatchObject({ code: "reaction_not_found" });
    // Through another live target, of either kind, the reaction is not found.
    const issue = (
      await json<{ number: number }>(api("POST", `${path}/issues`, owner.token, { title: "Bug" }))
    ).body.number;
    const comment = (
      await json<{ id: number }>(
        api("POST", `${path}/issues/${issue}/comments`, owner.token, { body: "c" }),
      )
    ).body.id;
    for (const on of [`issues/${issue}`, `issues/comments/${comment}`])
      expect(
        (await json(api("DELETE", `${path}/${on}/reactions/${mine}`, reader.token))).body,
      ).toMatchObject({ code: "reaction_not_found" });
    expect((await rollupOf(owner, `pulls/${pr}`))["+1"]).toBe(1);
    // A token for issues only cannot reach its own reaction to a pull request.
    const issuesOnly = await scoped(reader, ["issues:write"]);
    expect(
      (await json(api("DELETE", `${path}/issues/${pr}/reactions/${mine}`, issuesOnly.token))).body,
    ).toMatchObject({ code: "issue_not_found" });
    expect(
      (await api("DELETE", `${path}/issues/${pr}/reactions/${mine}`, reader.token)).status,
    ).toBe(200);
    expect((await rollupOf(owner, `pulls/${pr}`)).total_count).toBe(0);
  });

  it("take the permission of the kind they are on", async () => {
    const issue = (
      await json<{ number: number }>(api("POST", `${path}/issues`, owner.token, { title: "Bug" }))
    ).body.number;
    const issuesOnly = await scoped(owner, ["issues:write"]);
    expect((await react(issuesOnly, `issues/${issue}`, "+1")).status).toBe(201);
    expect((await react(issuesOnly, `issues/${pr}`, "+1")).body.code).toBe("issue_not_found");
    const prComment = (
      await json<{ id: number }>(
        api("POST", `${path}/issues/${pr}/comments`, owner.token, { body: "c" }),
      )
    ).body.id;
    expect((await react(issuesOnly, `issues/comments/${prComment}`, "+1")).body.code).toBe(
      "comment_not_found",
    );
    expect((await reactions(issuesOnly, `issues/comments/${prComment}`)).status).toBe(404);
    const readOnly = await scoped(owner, ["issues:read", "pull_requests:read"]);
    expect((await react(readOnly, `issues/${issue}`, "+1")).body.code).toBe("missing_permission");
    expect((await reactions(readOnly, `issues/${issue}`)).status).toBe(200);
  });

  it("take write access while the conversation is locked", async () => {
    const reader = await collaborator("pull");
    const writer = await collaborator("push");
    expect((await api("PUT", `${path}/issues/${pr}/lock`, owner.token, {})).status).toBe(200);
    expect((await react(reader, `issues/${pr}`, "+1")).body.code).toBe("conversation_locked");
    expect((await react(writer, `issues/${pr}`, "+1")).status).toBe(201);
  });

  it("go with what they are on, and are told with their target's counts as they stand", async () => {
    const issue = (
      await json<{ number: number }>(api("POST", `${path}/issues`, owner.token, { title: "Bug" }))
    ).body.number;
    const comment = (
      await json<{ id: number }>(
        api("POST", `${path}/issues/${issue}/comments`, owner.token, { body: "c" }),
      )
    ).body.id;
    const other = (
      await json<{ id: number }>(
        api("POST", `${path}/issues/${issue}/comments`, owner.token, { body: "d" }),
      )
    ).body.id;
    await react(owner, `issues/${issue}`, "+1");
    await react(owner, `issues/comments/${comment}`, "heart");
    await react(owner, `issues/comments/${other}`, "eyes");
    expect((await api("DELETE", `${path}/issues/comments/${other}`, owner.token)).status).toBe(200);
    const left = async () =>
      inRepo(stub(), (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ target: string; target_id: number }>(
            "SELECT target, target_id FROM reactions UNION ALL SELECT target, target_id FROM reaction_counts",
          )
          .toArray()
          .map((row) => `${row.target}/${row.target_id}`)
          .sort(),
      );
    expect(await left()).toEqual(
      [`comment/${comment}`, `comment/${comment}`, `subject/${issue}`, `subject/${issue}`].sort(),
    );
    expect((await api("DELETE", `${path}/issues/${issue}`, owner.token)).status).toBe(200);
    expect(await left()).toEqual([]);
    const told = (
      await inRepo(stub(), (r: RepoDO) =>
        r.git.context.storage.sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map((row) => JSON.parse(row.event) as DomainEvent),
      )
    ).filter((e) => e.type.startsWith("reaction."));
    expect(told.map((e) => [e.type, (e.data as { counts: Rollup }).counts])).toEqual([
      ["reaction.created", expect.objectContaining({ "+1": 1 })],
      ["reaction.created", expect.objectContaining({ heart: 1 })],
      ["reaction.created", expect.objectContaining({ eyes: 1 })],
    ]);
  });
});
