// A pull request's files: the server lists them (with their review threads)
// and leaves the hunks out of the page, which loads them a page at a time
// from its own route; diff comments, replies, resolving and suggestions
// reach the API as it takes them; hostile file names and comments stay text.

import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../app/lib/pulls.js";
import { threadsOf } from "../app/lib/review-threads.server.js";
import { action, loader, default as PullFiles } from "../app/routes/repo.pull.files.js";
import { loader as patches } from "../app/routes/repo.pull.patches.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

const file = (filename: string, extra: Record<string, unknown> = {}) => ({
  sha: "c".repeat(40),
  filename,
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: "@@ -1 +1 @@\n-a\n+b\n",
  ...extra,
});

const filesPage = (files: unknown[], next: string | null = null) =>
  json({ files, merge_base_sha: BASE, head_sha: HEAD, truncated: false, next_cursor: next });

function comment(extra: Record<string, unknown>): ReviewComment {
  return {
    id: 1,
    thread_id: 1,
    user: { id: "usr_a" },
    performed_via_agents: [],
    body: "hi",
    commit_id: HEAD,
    original_commit_id: HEAD,
    path: "a.ts",
    side: "RIGHT",
    line: 1,
    original_line: 1,
    start_line: null,
    start_side: null,
    outdated: false,
    resolved: false,
    created_at: 1,
    updated_at: 1,
    ...extra,
  } as ReviewComment;
}

describe("the files page", () => {
  it("lists a page of files without their hunks, and their threads", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest()),
      "GET /api/repos/ada/demo/pulls/7/files": () =>
        filesPage(
          [file("a.ts"), file("b.bin", { patch: undefined, patch_omitted: "binary" })],
          "n2",
        ),
      "GET /api/repos/ada/demo/pulls/7/comments": () =>
        json({
          comments: [
            comment({ id: 1, thread_id: 1 }),
            comment({ id: 2, thread_id: 1, in_reply_to_id: 1, body: "reply" }),
            comment({ id: 3, thread_id: 2, path: "elsewhere.ts" }),
          ],
          next_cursor: null,
        }),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/files?cursor=c1&style=split`),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain(
      "GET /api/repos/ada/demo/pulls/7/files?per_page=30&cursor=c1",
    );
    expect(data.files.map((f) => [f.filename, f.hasPatch, "patch" in f])).toEqual([
      ["a.ts", true, false],
      ["b.bin", false, false],
    ]);
    expect(data.threads.map((t) => [t.id, t.comments.map((c) => c.id)])).toEqual([[1, [1, 2]]]);
    expect(data.diffStyle).toBe("split");
    expect(data.pages.next).toBe("/ada/demo/pull/7/files?cursor=n2&style=split");
    expect(JSON.stringify(data)).not.toContain("@@ -1 +1 @@");
  });

  it("follows review comments a page at a time, up to its bound", async () => {
    let served = 0;
    const { context } = api({
      "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest()),
      "GET /api/repos/ada/demo/pulls/7/files": () => filesPage([file("a.ts")]),
      "GET /api/repos/ada/demo/pulls/7/comments": () => {
        served++;
        return json({
          comments: [comment({ id: served, thread_id: served })],
          next_cursor: "more",
        });
      },
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/files`),
      context,
      params,
    } as never);
    expect(served).toBe(10);
    expect(data.threadsComplete).toBe(false);
    expect(data.threads).toHaveLength(10);
  });

  it("serves a page's patches alone, never cached", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo/pulls/7/files": () =>
        filesPage([file("a.ts"), file("b.bin", { patch: undefined, patch_omitted: "binary" })]),
    });
    const response = (await patches({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/files/patches?cursor=c%2B1`),
      context,
      params,
    } as never)) as Response;
    expect(calls.map(pathOf)).toEqual([
      "GET /api/repos/ada/demo/pulls/7/files?per_page=30&cursor=c%2B1",
    ]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      head_sha: HEAD,
      merge_base_sha: BASE,
      patches: [
        { filename: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" },
        { filename: "b.bin", patch: null },
      ],
    });
  });

  it("shows hostile file names, comments and authors as text", () => {
    const thread = threadsOf(
      [
        comment({
          path: HOSTILE,
          body: `${HOSTILE}\n\n<iframe src=javascript:alert(7)>`,
          user: { id: HOSTILE },
        }),
      ],
      pullRequest() as never,
      new Set([HOSTILE]),
    );
    const html = renderPage(PullFiles, "/ada/demo/pull/7/files", {
      owner: "ada",
      repo: "demo",
      pull: pullRequest({ title: HOSTILE }),
      viewer: VIEWER,
      cursor: null,
      files: [
        {
          ...file(HOSTILE, { previous_filename: HOSTILE, status: "renamed" }),
          patch: undefined,
          hasPatch: true,
        },
        { ...file("x"), patch: undefined, hasPatch: false, patch_omitted: "too_large" },
      ],
      headSha: HEAD,
      mergeBaseSha: BASE,
      truncated: true,
      pages: { next: null, first: null },
      threads: thread,
      threadsComplete: true,
      diffStyle: "unified",
    });
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    // Before the browser loads the hunks: the threads are listed, never an empty diff.
    expect(html).toContain("Loading changes");
    expect(html).toContain("Comments on this file");
    expect(html).toContain("This file is too large to compare here.");
    expect(html).toContain("only the first 3,000 are listed");
  });
});

describe("a review thread", () => {
  const pull = { state: "open" as const, head: { ref: "topic", sha: HEAD } };
  const suggestion = "```suggestion\nnew line\n```";

  it("offers a suggestion only on the head's side, at the current head, while open", () => {
    const applicable = (
      c: Record<string, unknown>,
      p: typeof pull | { state: "closed"; head: typeof pull.head } = pull,
    ) =>
      threadsOf([comment({ body: suggestion, ...c })], p, new Set(["a.ts"]))[0]?.comments[0]
        ?.applicable;
    expect(applicable({})).toBe(true);
    expect(applicable({ side: "LEFT" })).toBe(false);
    expect(applicable({ commit_id: "d".repeat(40) })).toBe(false);
    expect(applicable({ outdated: true, line: null })).toBe(false);
    expect(applicable({ body: "no suggestion" })).toBe(false);
    expect(applicable({}, { state: "closed", head: pull.head })).toBe(false);
  });

  it("keeps an outdated thread's lines off the diff", () => {
    const [thread] = threadsOf(
      [comment({ outdated: true, line: null, original_line: 5, start_line: 3 })],
      pull,
      new Set(["a.ts"]),
    );
    expect(thread).toMatchObject({ line: null, startLine: null, originalLine: 5, outdated: true });
  });
});

describe("diff comments", () => {
  async function act(fields: Record<string, string>) {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/pulls/7/comments": () => json({ id: 1 }, 201),
      "PUT /api/repos/ada/demo/pulls/7/threads/4/resolution": () => json({ id: 4 }),
      "DELETE /api/repos/ada/demo/pulls/7/threads/4/resolution": () => json({ id: 4 }),
      "POST /api/repos/ada/demo/pulls/7/suggestions/apply": () => json({}, 201),
    });
    const outcome = await action({
      request: formPost("/ada/demo/pull/7/files", fields),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET");
    const text = sent ? await sent.text() : "";
    return { outcome, call: sent && pathOf(sent), body: text ? JSON.parse(text) : undefined };
  }

  const line = { intent: "comment", body: "nit", path: "dir/a b.ts", commit_id: HEAD };

  it("comment on a line or a range, on either side", async () => {
    expect(await act({ ...line, side: "RIGHT", line: "4" })).toEqual({
      outcome: { ok: "comment" },
      call: "POST /api/repos/ada/demo/pulls/7/comments",
      body: { body: "nit", commit_id: HEAD, path: "dir/a b.ts", line: 4, side: "RIGHT" },
    });
    expect((await act({ ...line, side: "LEFT", start_line: "2", line: "4" })).body).toEqual({
      body: "nit",
      commit_id: HEAD,
      path: "dir/a b.ts",
      line: 4,
      side: "LEFT",
      start_line: 2,
      start_side: "LEFT",
    });
    // A range of one line is that line.
    expect(
      (await act({ ...line, side: "RIGHT", start_line: "4", line: "4" })).body,
    ).not.toHaveProperty("start_line");
  });

  it("are refused without asking the API when their lines are not lines", async () => {
    for (const fields of [
      { ...line, line: "" },
      { ...line, line: "0" },
      { ...line, line: "1.5" },
      { ...line, line: "4", start_line: "5" },
      { ...line, line: "4", start_line: "x" },
      { ...line, line: "4", body: "  " },
    ]) {
      const { outcome, call } = await act(fields);
      expect(outcome, JSON.stringify(fields)).toHaveProperty("error");
      expect(call).toBeUndefined();
    }
  });

  it("reply, resolve, unresolve and apply suggestions", async () => {
    expect(await act({ intent: "reply", body: "ok", in_reply_to: "3" })).toMatchObject({
      call: "POST /api/repos/ada/demo/pulls/7/comments",
      body: { body: "ok", in_reply_to: 3 },
    });
    expect(await act({ intent: "resolve", thread_id: "4" })).toMatchObject({
      outcome: { ok: "resolve" },
      call: "PUT /api/repos/ada/demo/pulls/7/threads/4/resolution",
    });
    expect(await act({ intent: "unresolve", thread_id: "4" })).toMatchObject({
      outcome: { ok: "unresolve" },
      call: "DELETE /api/repos/ada/demo/pulls/7/threads/4/resolution",
    });
    expect(await act({ intent: "apply", comment_id: "9" })).toMatchObject({
      outcome: { ok: "apply" },
      call: "POST /api/repos/ada/demo/pulls/7/suggestions/apply",
      body: { comment_ids: [9] },
    });
    expect((await act({ intent: "resolve", thread_id: "../x" })).call).toBeUndefined();
  });
});
