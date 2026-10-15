// Comments on a pull request's diff: threads anchored to lines of a file
// at a head the pull request has had, replies, who may edit, delete and
// resolve, and a ruleset that needs every thread resolved before a merge.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type Comment = {
  id: number;
  thread_id: number;
  in_reply_to_id?: number;
  user: { id: string };
  body: string;
  commit_id: string;
  path: string;
  side: string;
  line: number | null;
  original_line: number;
  start_line: number | null;
  outdated: boolean;
  resolved: boolean;
  code?: string;
};
type Thread = { id: number; resolved: boolean; outdated: boolean; comments: number; code?: string };

let owner: Who;
let repo: { id: string; name: string };
let path: string;
let head: string;

const commitOn = async (branch: string, changes: Record<string, unknown>[]) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};

async function branchAt(name: string, sha: string) {
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
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

async function collaborator(permission: "pull" | "triage" | "push"): Promise<Who> {
  const who = await user();
  const set = await api("PUT", `${path}/collaborators/${who.handle}`, owner.token, {
    permission,
  });
  expect(set.status).toBe(200);
  return who;
}

const comment = (who: Who, body: Record<string, unknown>) =>
  json<Comment>(
    api("POST", `${path}/pulls/1/comments`, who.token, { body: "Look here.", ...body }),
  );
const onHead = (who: Who, body: Record<string, unknown> = {}) =>
  comment(who, { commit_id: head, path: "a.txt", line: 2, ...body });
const resolve = (who: Who, thread: number, resolved = true) =>
  json<Thread>(
    api(resolved ? "PUT" : "DELETE", `${path}/pulls/1/threads/${thread}/resolution`, who.token),
  );
const threads = async () =>
  (await json<{ threads: Thread[] }>(api("GET", `${path}/pulls/1/threads`, owner.token))).body
    .threads;

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const base = await commitOn("main", [{ path: "a.txt", content: "one\ntwo\n" }]);
  await branchAt("feature", base);
  head = await commitOn("feature", [{ path: "a.txt", content: "one\ntwo\nthree\nfour\n" }]);
  const opened = await api("POST", `${path}/pulls`, owner.token, {
    title: "Change",
    head: "feature",
    base: "main",
  });
  expect(opened.status).toBe(201);
});

describe("diff comments", () => {
  it("start a thread at lines of the head's file, and go outdated when the head moves", async () => {
    const reader = await collaborator("pull");
    const made = await onHead(reader, { start_line: 1, line: 3 });
    expect(made).toMatchObject({
      status: 201,
      body: {
        user: { id: reader.principalId },
        commit_id: head,
        path: "a.txt",
        side: "RIGHT",
        start_line: 1,
        line: 3,
        original_line: 3,
        outdated: false,
        resolved: false,
      },
    });
    const got = await json<Comment>(
      api("GET", `${path}/pulls/comments/${made.body.id}`, owner.token),
    );
    expect(got.body).toEqual(made.body);

    await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
    const listed = await json<{ comments: Comment[] }>(
      api("GET", `${path}/pulls/1/comments`, owner.token),
    );
    expect(listed.body.comments).toEqual([
      expect.objectContaining({ id: made.body.id, outdated: true, line: null, original_line: 3 }),
    ]);
  });

  it("anchor the base side to the merge base's file", async () => {
    // The merge base has two lines: a third is out of range there.
    expect((await onHead(owner, { side: "LEFT", line: 2 })).status).toBe(201);
    expect((await onHead(owner, { side: "LEFT", line: 3 })).body.code).toBe("line_out_of_range");
  });

  it("refuse anchors that do not fit", async () => {
    expect((await onHead(owner, { commit_id: "f".repeat(40) })).body.code).toBe(
      "commit_not_in_pull",
    );
    expect(await onHead(owner, { path: "nope.txt" })).toMatchObject({
      status: 422,
      body: { code: "path_not_found" },
    });
    // On the base side, a file only the head has.
    await commitOn("feature", [{ path: "new.txt", content: "n\n" }]);
    const now = (await json<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token)))
      .body.head.sha;
    expect(
      await comment(owner, { commit_id: now, path: "new.txt", line: 1, side: "LEFT" }),
    ).toMatchObject({ status: 422, body: { code: "path_not_found" } });
    expect((await onHead(owner, { line: 5 })).body.code).toBe("line_out_of_range");
    expect((await onHead(owner, { start_line: 2, line: 2 })).body.code).toBe("invalid_range");
    expect((await onHead(owner, { start_side: "LEFT" })).body.code).toBe("invalid_input");
    expect((await comment(owner, { path: "a.txt" })).body.code).toBe("invalid_input");
  });

  it("take replies in the thread, on this pull request only", async () => {
    const first = (await onHead(owner)).body;
    const reply = await comment(owner, { in_reply_to: first.id, body: "Agreed." });
    expect(reply).toMatchObject({
      status: 201,
      body: { thread_id: first.thread_id, in_reply_to_id: first.id, path: "a.txt", line: 2 },
    });
    expect((await comment(owner, { in_reply_to: first.id, line: 1 })).body.code).toBe(
      "invalid_input",
    );
    expect((await comment(owner, { in_reply_to: 999_999 })).body.code).toBe("comment_not_found");
    expect(await threads()).toEqual([
      expect.objectContaining({ id: first.thread_id, comments: 2 }),
    ]);
  });

  it("are edited and deleted by their author or write access; a thread goes with its last", async () => {
    const reader = await collaborator("pull");
    const other = await collaborator("pull");
    const writer = await collaborator("push");
    const first = (await onHead(reader)).body;
    const reply = (await comment(other, { in_reply_to: first.id })).body;
    const edit = (who: Who, id: number) =>
      json<Comment>(api("PATCH", `${path}/pulls/comments/${id}`, who.token, { body: "Edited." }));
    const remove = (who: Who, id: number) =>
      json<Comment>(api("DELETE", `${path}/pulls/comments/${id}`, who.token));
    expect((await edit(other, first.id)).status).toBe(403);
    expect((await edit(reader, first.id)).body).toMatchObject({ body: "Edited." });
    expect((await remove(other, first.id)).status).toBe(403);
    expect((await remove(writer, first.id)).status).toBe(200);
    expect(await threads()).toEqual([expect.objectContaining({ comments: 1 })]);
    expect((await remove(other, reply.id)).status).toBe(200);
    expect(await threads()).toEqual([]);
  });
});

describe("anchors", () => {
  it("are checked against files of 1 MiB at most", async () => {
    const line = "x".repeat(1023);
    const mib = `${`${line}\n`.repeat(1024)}`;
    const big = await commitOn("feature", [
      { path: "mib.txt", content: mib },
      { path: "over.txt", content: `${mib}y` },
    ]);
    const on = (file: string) => comment(owner, { commit_id: big, path: file, line: 1 });
    expect((await on("mib.txt")).status).toBe(201);
    expect((await on("over.txt")).body).toMatchObject({ code: "too_large" });
  });
});

describe("earlier heads", () => {
  it("are refused once no longer stored", async () => {
    const earlier = head;
    await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
    // As garbage collection leaves a head force-pushed away once the reflog lets it go.
    await inRepo(env.REPO.getByName(repo.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "DELETE FROM commits WHERE oid = ?",
        Uint8Array.from(earlier.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
      ),
    );
    expect(await onHead(owner, { commit_id: earlier })).toMatchObject({
      status: 422,
      body: { code: "commit_unavailable" },
    });
  });

  it("refuse the base side once the base's commits are no longer stored", async () => {
    // The base tip, gone: the merge base cannot be worked out.
    const tip = (await json<{ sha: string }>(api("GET", `${path}/commits/main`, owner.token))).body
      .sha;
    await inRepo(env.REPO.getByName(repo.id), (r: RepoDO) =>
      r.git.context.storage.sql.exec(
        "DELETE FROM commits WHERE oid = ?",
        Uint8Array.from(tip.match(/../g) ?? [], (h) => Number.parseInt(h, 16)),
      ),
    );
    expect(await onHead(owner, { side: "LEFT", line: 1 })).toMatchObject({
      status: 422,
      body: { code: "unreadable" },
    });
  });
});

describe("threads", () => {
  it("are resolved by the pull request's author or write access, with events", async () => {
    const reader = await collaborator("pull");
    const writer = await collaborator("push");
    const { thread_id: id } = (await onHead(reader)).body;
    expect((await resolve(reader, id)).status).toBe(403);
    expect((await resolve(owner, id)).body).toMatchObject({ id, resolved: true });
    expect((await resolve(owner, id)).body).toMatchObject({ resolved: true });
    expect((await resolve(writer, id, false)).body).toMatchObject({ resolved: false });
    expect((await resolve(owner, 999_999)).body.code).toBe("thread_not_found");

    const rows = await inRepo(env.REPO.getByName(repo.id), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      return {
        events: sql
          .exec<{ event: string }>("SELECT event FROM outbox ORDER BY source_seq")
          .toArray()
          .map((row) => (JSON.parse(row.event) as { type: string }).type)
          .filter((type) => type.startsWith("pull_request_review_")),
        audit: sql
          .exec<{ action: string }>("SELECT action FROM audit_log ORDER BY at")
          .toArray()
          .map((row) => row.action)
          .filter((action) => action.startsWith("pull_request_review_")),
      };
    });
    expect(rows.events).toEqual([
      "pull_request_review_comment.created",
      "pull_request_review_thread.resolved",
      "pull_request_review_thread.unresolved",
    ]);
    expect(rows.audit).toEqual([
      "pull_request_review_comment.create",
      "pull_request_review_thread.resolve",
      "pull_request_review_thread.unresolve",
    ]);
  });

  it("never reuse the id of a deleted thread", async () => {
    await onHead(owner);
    const second = (await onHead(owner)).body;
    expect((await api("DELETE", `${path}/pulls/comments/${second.id}`, owner.token)).status).toBe(
      200,
    );
    const third = (await onHead(owner)).body;
    expect(third.thread_id).toBeGreaterThan(second.thread_id);
    expect((await resolve(owner, second.thread_id)).body.code).toBe("thread_not_found");
  });

  it("must all be resolved to merge when a ruleset says so", async () => {
    await api("POST", `${path}/rulesets`, owner.token, {
      name: "conversations",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
      rules: [{ type: "pull_request", parameters: { required_review_thread_resolution: true } }],
    });
    const { thread_id: id } = (await onHead(owner)).body;
    const merge = () =>
      json<{ code?: string; detail?: string }>(api("PUT", `${path}/pulls/1/merge`, owner.token));
    const refused = await merge();
    expect(refused.body).toMatchObject({ code: "merge_refused" });
    expect(refused.body.detail).toContain("1 review thread is unresolved");
    await resolve(owner, id);
    expect((await merge()).status).toBe(200);
  });

  it("stop a merge when one is started while it is made", async () => {
    await inRepo(env.REPO.getByName(repo.id), (r: RepoDO) => {
      r.mergeHooks = {
        beforeFinish: async () => {
          r.mergeHooks = {};
          await onHead(owner);
        },
      };
    });
    const merged = await json<{ code?: string }>(api("PUT", `${path}/pulls/1/merge`, owner.token));
    expect(merged.body.code).toBe("pull_changed");
  });
});

describe("suggestions", () => {
  const suggest = (who: Who, lines: string, at: Record<string, unknown> = {}) =>
    onHead(who, { body: `Better:\n\`\`\`suggestion\n${lines}\n\`\`\``, ...at });
  const apply = (who: Who, ids: number[], extra: Record<string, unknown> = {}) =>
    json<{
      commit: { sha: string; commit: { message: string } };
      files: { path: string }[];
      code?: string;
    }>(api("POST", `${path}/pulls/1/suggestions/apply`, who.token, { comment_ids: ids, ...extra }));
  const file = async (name: string) =>
    atob(
      (
        await json<{ content: string }>(
          api("GET", `${path}/contents/${name}?ref=feature`, owner.token),
        )
      ).body.content.replace(/\n/g, ""),
    );

  it("are applied as one commit on the head, crediting their authors, and resolve their threads", async () => {
    const reviewer = await collaborator("pull");
    const first = (await suggest(reviewer, "TWO", { line: 2 })).body;
    const second = (await suggest(owner, "3a\n3b", { line: 3 })).body;
    const applied = await apply(owner, [first.id, second.id]);
    expect(applied.status).toBe(201);
    expect(applied.body.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(await file("a.txt")).toBe("one\nTWO\n3a\n3b\nfour\n");
    expect(applied.body.commit.commit.message).toMatch(
      new RegExp(
        `^Apply suggestions from code review\\n\\nCo-authored-by: ${reviewer.handle} <${reviewer.principalId}@[^>]+>\\n$`,
      ),
    );
    const pull = await json<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token));
    expect(pull.body.head.sha).toBe(applied.body.commit.sha);
    expect((await threads()).every((t) => t.resolved)).toBe(true);
  });

  it("refuse what is not a suggestion on the head's current lines", async () => {
    const plain = (await onHead(owner)).body;
    expect((await apply(owner, [plain.id])).body.code).toBe("not_a_suggestion");
    const left = (await suggest(owner, "x", { side: "LEFT", line: 1 })).body;
    expect((await apply(owner, [left.id])).body.code).toBe("not_applicable");
    const a = (await suggest(owner, "x", { start_line: 1, line: 2 })).body;
    const b = (await suggest(owner, "y", { line: 2 })).body;
    expect((await apply(owner, [a.id, b.id])).body.code).toBe("overlapping");
    expect((await apply(owner, [999_999])).body.code).toBe("comment_not_found");
    await commitOn("feature", [{ path: "b.txt", content: "b\n" }]);
    expect((await apply(owner, [b.id])).body.code).toBe("outdated");
  });

  const during = (action: () => Promise<unknown>) =>
    inRepo(env.REPO.getByName(repo.id), (r: RepoDO) => {
      r.suggestionHooks = {
        beforeWrite: async () => {
          r.suggestionHooks = {};
          await action();
        },
      };
    });

  it("are not applied once the pull request is merged meanwhile", async () => {
    const made = (await suggest(owner, "TWO", { line: 2 })).body;
    await during(() => api("PUT", `${path}/pulls/1/merge`, owner.token));
    const head = (await json<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token)))
      .body.head.sha;
    expect((await apply(owner, [made.id])).body.code).toBe("pull_changed");
    expect(
      (await json<{ head: { sha: string } }>(api("GET", `${path}/pulls/1`, owner.token))).body.head
        .sha,
    ).toBe(head);
    expect((await threads()).map((t) => t.resolved)).toEqual([false]);
  });

  it("are not applied when a comment is edited meanwhile", async () => {
    const made = (await suggest(owner, "TWO", { line: 2 })).body;
    await during(() =>
      api("PATCH", `${path}/pulls/comments/${made.id}`, owner.token, {
        body: "```suggestion\nOTHER\n```",
      }),
    );
    expect((await apply(owner, [made.id])).body.code).toBe("pull_changed");
    expect(await file("a.txt")).toBe("one\ntwo\nthree\nfour\n");
  });

  it("stop at what one write may carry", async () => {
    const mib = `${"x".repeat(1023)}\n`.repeat(1024);
    await commitOn("feature", [
      { path: "f1.txt", content: mib },
      { path: "f2.txt", content: mib },
    ]);
    const tip = await commitOn("feature", [
      { path: "f3.txt", content: mib },
      { path: "f4.txt", content: mib },
      { path: "f5.txt", content: mib },
    ]);
    const ids: number[] = [];
    for (const name of ["f1", "f2", "f3", "f4", "f5"])
      ids.push(
        (
          await comment(owner, {
            commit_id: tip,
            path: `${name}.txt`,
            line: 1,
            body: "```suggestion\ny\n```",
          })
        ).body.id,
      );
    expect((await apply(owner, ids)).body.code).toBe("too_large");
  });

  it("need write access", async () => {
    const reader = await collaborator("pull");
    const own = (await suggest(reader, "x")).body;
    expect((await apply(reader, [own.id])).body.code).toBe("repo_not_found");
  });
});
