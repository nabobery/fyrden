// Browsing a repository: the ref and path a page names reach the API as
// written (a literal `%2F` in a name stays a part of it), a README's link to
// a directory opens its listing, and the history says when it cannot be
// read rather than showing none.

import { describe, expect, it } from "vitest";
import { loader as blob } from "../app/routes/repo.blob.js";
import { loader as commits } from "../app/routes/repo.commits.js";
import { action as edit, loader as editor } from "../app/routes/repo.edit.js";
import { loader as raw } from "../app/routes/repo.raw.js";
import { loader as tree } from "../app/routes/repo.tree.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";

// biome-ignore lint/suspicious/noExplicitAny: each loader's own argument type
type Loader = (args: any) => Promise<unknown> | unknown;

/** Runs `route` on `path` as React Router would: its params decoded (twice, as it does). */
async function run(route: Loader, path: string, answer: (r: Request) => Response, init?: Request) {
  const { context, calls } = fakeApi(answer);
  const request = init ?? new Request(`${ORIGIN}${path}`);
  const [, owner, repo, , ref, ...rest] = path.split("?")[0]?.split("/") ?? [];
  const twice = (s: string) => decodeURIComponent(decodeURIComponent(s));
  const params = {
    owner,
    repo,
    ...(ref !== undefined && { ref: twice(ref) }),
    "*": twice(rest.join("/")),
  };
  const outcome = await Promise.resolve(route({ request, context, params })).then(
    (value) => ({ value }),
    (thrown: unknown) => ({ thrown }),
  );
  return { ...outcome, calls };
}

const file = (path: string) =>
  json({ type: "file", path, sha: "a".repeat(40), size: 2, encoding: "base64", content: "aGk=" });

const apiPath = (call: Request | undefined) => {
  const url = new URL(call?.url ?? "");
  return `${url.pathname}${url.search}`;
};

describe("browsing a repository", () => {
  it("reads a file or branch whose name holds a literal %2F as that name", async () => {
    const shown = await run(blob, "/ada/demo/blob/main/x%252Fy", () => file("x%2Fy"));
    expect(apiPath(shown.calls[0])).toBe("/api/repos/ada/demo/contents/x%252Fy?ref=main");
    const branch = await run(blob, "/ada/demo/blob/topic%252Fnext/a", () => file("a"));
    expect(apiPath(branch.calls[0])).toBe("/api/repos/ada/demo/contents/a?ref=topic%252Fnext");
    const listed = await run(tree, "/ada/demo/tree/main/x%252Fy", () =>
      json({ type: "dir", entries: [], next_cursor: null }),
    );
    expect(apiPath(listed.calls[0])).toContain("/contents/x%252Fy?ref=main");
    const bytes = await run(raw, "/ada/demo/raw/main/x%252Fy", () => new Response("hi"));
    expect(apiPath(bytes.calls[0])).toBe("/api/repos/ada/demo/raw/x%252Fy?ref=main");
    const editing = await run(editor, "/ada/demo/edit/main/x%252Fy", () => file("x%2Fy"));
    expect(apiPath(editing.calls[0])).toBe("/api/repos/ada/demo/contents/x%252Fy?ref=main");
  });

  it("reads the ref and path of a navigation's data request as of its page", async () => {
    for (const [url, path] of [
      ["/ada/demo/blob/main/x%252Fy.data", "x%252Fy"],
      ["/ada/demo/blob/main/notes.data.data", "notes.data"],
      ["/ada/demo/tree/main/docs/_.data", "docs"],
    ] as const) {
      const route = url.includes("/tree/") ? tree : blob;
      const shown = await run(route, url, (r) =>
        new URL(r.url).pathname.includes("/docs")
          ? json({ type: "dir", entries: [], next_cursor: null })
          : file(path),
      );
      expect(apiPath(shown.calls[0]), url).toContain(`/contents/${path}?ref=main`);
    }
  });

  it("writes the file a literal %2F names, and shows it after", async () => {
    const path = "/ada/demo/edit/main/x%252Fy";
    const saved = await run(
      edit,
      path,
      (r) =>
        new URL(r.url).pathname === "/auth/session"
          ? json({ user: { id: "usr_1", handle: "ada" } })
          : json({}, 200),
      formPost(path, { content: "hi", sha: "a".repeat(40) }),
    );
    const put = saved.calls.find((c) => c.method === "PUT");
    expect(new URL(put?.url ?? "").pathname).toBe("/api/repos/ada/demo/contents/x%252Fy");
    expect((saved as { value: Response }).value.headers.get("Location")).toBe(
      "/ada/demo/blob/main/x%252Fy",
    );
  });

  it("opens a directory a link names without a trailing slash as its listing", async () => {
    const dir = await run(blob, "/ada/demo/blob/topic%2Fnext/docs", () =>
      json({ type: "dir", entries: [], next_cursor: null }),
    );
    const response = (dir as { thrown: Response }).thrown;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/ada/demo/tree/topic%2Fnext/docs");
  });

  describe("a file's history", () => {
    const REPO = { name: "demo", owner: "ada", default_branch: "main" };
    const commit = (sha: string) => ({
      sha,
      commit: {
        message: `Commit ${sha}\n\nMore.`,
        author: { name: "Ada", date: "2026-11-06T00:00:00Z" },
        verification: { verified: false, reason: "unsigned" },
      },
    });
    const history =
      (commits: unknown, status = 200) =>
      (r: Request) =>
        new URL(r.url).pathname.endsWith("/commits") ? json(commits, status) : json(REPO);
    const commitsCall = (calls: Request[]) =>
      apiPath(calls.find((c) => new URL(c.url).pathname.endsWith("/commits")));
    const state = (outcome: unknown) => (outcome as { value: { history: unknown } }).value.history;

    it("asks for the revision and path a page names, each as written", async () => {
      const { calls } = await run(
        commits,
        "/ada/demo/commits/topic%2Fnext/docs/a%252Fb.md?cursor=abc",
        history({ commits: [commit("a".repeat(40))], next_cursor: "n" }),
      );
      expect(commitsCall(calls)).toBe(
        "/api/repos/ada/demo/commits?per_page=50&sha=topic%2Fnext&path=docs%2Fa%252Fb.md&cursor=abc",
      );
    });

    it("leaves the path out of a revision's whole history", async () => {
      for (const page of ["/ada/demo/commits/main", "/ada/demo/commits/main/"]) {
        const { calls } = await run(commits, page, history({ commits: [], next_cursor: null }));
        expect(commitsCall(calls)).toBe("/api/repos/ada/demo/commits?per_page=50&sha=main");
      }
    });

    it("keeps today's page for the default branch", async () => {
      const { calls } = await run(
        commits,
        "/ada/demo/commits",
        history({ commits: [], next_cursor: null }),
      );
      expect(commitsCall(calls)).toBe("/api/repos/ada/demo/commits?per_page=50");
    });

    it("costs the repository and one page of history, however many rows", async () => {
      const rows = Array.from({ length: 50 }, (_, i) => commit(String(i).padStart(40, "0")));
      const { calls } = await run(
        commits,
        "/ada/demo/commits/main/a.md",
        history({ commits: rows, next_cursor: "n" }),
      );
      expect(calls).toHaveLength(2);
    });

    it("links pages within the revision and path", async () => {
      const outcome = await run(
        commits,
        "/ada/demo/commits/topic%2Fnext/docs/a%252Fb.md",
        history({ commits: [commit("a".repeat(40))], next_cursor: "n" }),
      );
      expect((outcome as { value: { firstPage: string } }).value.firstPage).toBe(
        "/ada/demo/commits/topic%2Fnext/docs/a%252Fb.md",
      );
    });

    it.each([
      ["rows", { commits: [commit("a".repeat(40))], next_cursor: "n" }, 200, "", "commits"],
      ["an empty stretch", { commits: [], next_cursor: "n" }, 200, "?cursor=c", "stretch-empty"],
      ["an empty first stretch", { commits: [], next_cursor: "n" }, 200, "", "stretch-empty"],
      ["a path nothing changed", { commits: [], next_cursor: null }, 200, "", "none-here"],
      ["the walk's end", { commits: [], next_cursor: null }, 200, "?cursor=c", "no-older"],
      ["a wide history", { code: "history_too_wide", detail: "x" }, 422, "?cursor=c", "too-wide"],
      ["an old cursor", { code: "invalid_cursor", detail: "x" }, 422, "?cursor=c", "stale-cursor"],
    ])("reads %s", async (_name, answer, status, query, expected) => {
      const outcome = await run(
        commits,
        `/ada/demo/commits/main/a.md${query}`,
        history(answer, status),
      );
      expect(state(outcome)).toBe(expected);
    });

    it("says a revision has no commits, without a path to blame", async () => {
      const outcome = await run(
        commits,
        "/ada/demo/commits/main",
        history({ commits: [], next_cursor: null }),
      );
      expect(state(outcome)).toBe("none-at-revision");
    });

    it("says an empty repository has no commits yet", async () => {
      const outcome = await run(
        commits,
        "/ada/demo/commits/main/a.md",
        history({ code: "repo_empty", detail: "x" }, 409),
      );
      expect(state(outcome)).toBe("repo-empty");
    });

    it("still fails as itself for anything else", async () => {
      const outcome = await run(
        commits,
        "/ada/demo/commits/main/a.md",
        history({ code: "invalid_path", detail: "x" }, 422),
      );
      expect((outcome as { thrown: { init: { status: number } } }).thrown.init.status).toBe(422);
    });
  });

  describe("a file that isn't there", () => {
    it("answers 404, naming where its history is, for a ref needing encoding", async () => {
      const outcome = await run(blob, "/ada/demo/blob/topic%2Fnext/gone/a%252Fb.md", () =>
        json({ code: "not_found", detail: "Not found" }, 404),
      );
      const { data: page, init } = (
        outcome as { value: { data: unknown; init: { status: number } } }
      ).value;
      expect(init.status).toBe(404);
      expect(page).toMatchObject({
        kind: "missing",
        ref: "topic/next",
        path: "gone/a%2Fb.md",
      });
    });
  });

  it("shows an empty history for an empty repository, and any other failure as one", async () => {
    const repo = { name: "demo", owner: { login: "ada" }, default_branch: "main" };
    const answer = (status: number, body: unknown) => (r: Request) =>
      new URL(r.url).pathname.endsWith("/commits") ? json(body, status) : json(repo);
    const empty = await run(
      commits,
      "/ada/demo/commits",
      answer(409, { code: "repo_empty", detail: "The repository is empty." }),
    );
    expect((empty as { value: { commits: unknown[] } }).value.commits).toEqual([]);
    for (const status of [422, 429, 500]) {
      const failed = await run(
        commits,
        "/ada/demo/commits",
        answer(status, { code: "x", detail: "no" }),
      );
      expect((failed as { thrown: { init: { status: number } } }).thrown.init.status).toBe(status);
    }
    const signedOut = await run(commits, "/ada/demo/commits", answer(401, {}));
    expect((signedOut as { thrown: Response }).thrown.status).toBe(302);
  });
});
