// Pull requests: the list and its filters, opening one (from a branch here
// or a fork's), and its conversation: what each form sends the API, the
// timeline in the order things happened, and hostile titles, bodies,
// comments and branch names shown as text, never markup.

import { describe, expect, it } from "vitest";
import {
  default as Pull,
  action as pullAction,
  loader as pullLoader,
} from "../app/routes/repo.pull.js";
import {
  default as Pulls,
  action as pullsAction,
  loader as pullsLoader,
} from "../app/routes/repo.pulls.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };

describe("the pull request list", () => {
  it("lists the state the page names, open by default, a page at a time", async () => {
    for (const [query, state] of [
      ["", "open"],
      ["?state=closed", "closed"],
      ["?state=all&cursor=c2", "all"],
      ["?state=bogus", "open"],
    ] as const) {
      const { context, calls } = api({
        "GET /api/repos/ada/demo": () => json(repo),
        "GET /api/repos/ada/demo/pulls": () => json({ pull_requests: [], next_cursor: null }),
        "GET /api/repos/ada/demo/branches": () =>
          json({ branches: [{ name: "main" }], next_cursor: null }),
      });
      const data = await pullsLoader({
        request: new Request(`${ORIGIN}/ada/demo/pulls${query}`),
        context,
        params: { owner: "ada", repo: "demo" },
      } as never);
      expect(data.state).toBe(state);
      const listed = calls.map(pathOf).find((p) => p.startsWith("GET /api/repos/ada/demo/pulls"));
      expect(listed).toContain(`state=${state}`);
      if (query.includes("cursor")) expect(listed).toContain("cursor=c2");
      expect(data.branches).toEqual(["main"]);
    }
  });

  it("shows hostile titles and branch names as text", () => {
    const html = renderPage(Pulls, "/ada/demo/pulls", {
      repo,
      origin: ORIGIN,
      state: "open",
      pulls: [pullRequest({ title: HOSTILE, head: { ref: HOSTILE, sha: "b".repeat(40) } })],
      pages: { next: null, first: null },
      branches: [HOSTILE],
      viewer: VIEWER,
      proposed: { open: true, head: HOSTILE, base: "" },
    });
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toContain("Open pull request");
  });
});

describe("opening a pull request", () => {
  async function open(fields: Record<string, string>, reply: () => Response) {
    const { context, calls } = api({ "POST /api/repos/ada/demo/pulls": reply });
    const outcome = await pullsAction({
      request: formPost("/ada/demo/pulls", fields),
      context,
      params: { owner: "ada", repo: "demo" },
    } as never);
    const post = calls.find((c) => c.method === "POST");
    return { outcome, sent: post ? await post.json() : undefined };
  }

  it("sends a branch of this repository, and goes to the new pull request", async () => {
    const { outcome, sent } = await open(
      {
        title: " Fix ",
        head: "topic",
        base: "main",
        body: "  indented",
        maintainer_can_modify: "on",
      },
      () => json(pullRequest({ number: 12 }), 201),
    );
    expect(sent).toEqual({
      title: "Fix",
      head: "topic",
      base: "main",
      body: "  indented",
      draft: false,
    });
    expect((outcome as Response).headers.get("Location")).toBe("/ada/demo/pull/12");
  });

  it("sends a fork's branch with its repository and the maintainers' consent", async () => {
    const { sent } = await open(
      {
        title: "Fix",
        head: "bob:topic",
        head_repo: "demo-fork",
        base: "main",
        draft: "on",
        maintainer_can_modify: "on",
      },
      () => json(pullRequest(), 201),
    );
    expect(sent).toEqual({
      title: "Fix",
      head: "bob:topic",
      head_repo: "demo-fork",
      base: "main",
      draft: true,
      maintainer_can_modify: true,
    });
  });

  it("says why the API refused it", async () => {
    const { outcome } = await open({ title: "Fix", head: "main", base: "main" }, () =>
      json({ code: "validation_failed", detail: "The head and base are the same branch." }, 422),
    );
    expect(outcome).toEqual({ error: "The head and base are the same branch." });
  });
});

describe("a pull request's conversation", () => {
  it("is not found for a number that is not one, without asking the API", async () => {
    for (const number of ["0", "-1", "1e3", "abc", "07", "99999999999999999"]) {
      const { context, calls } = api({});
      const thrown = await Promise.resolve(
        pullLoader({
          request: new Request(`${ORIGIN}/ada/demo/pull/${number}`),
          context,
          params: { ...params, number },
        } as never),
      ).catch((e: unknown) => e);
      expect((thrown as { init: { status: number } }).init.status, number).toBe(404);
      expect(
        calls.filter((c) => new URL(c.url).pathname.startsWith("/api")),
        number,
      ).toEqual([]);
    }
  });

  it("orders comments and reviews as they happened, then the merge", async () => {
    const at = (h: number) => Date.parse(`2026-10-02T${String(h).padStart(2, "0")}:00:00Z`);
    const { context } = api({
      "GET /api/repos/ada/demo/pulls/7": () =>
        json(
          pullRequest({
            state: "closed",
            merged: true,
            merged_at: at(5),
            merged_by: { id: "usr_m" },
            merge_commit_sha: "c".repeat(40),
          }),
        ),
      "GET /api/repos/ada/demo/issues/7/comments": () =>
        json({
          comments: [
            {
              id: 1,
              user: { id: "usr_a" },
              performed_via_agents: [],
              body: "first",
              created_at: at(1),
              updated_at: at(1),
            },
            {
              id: 2,
              user: { id: "usr_b" },
              performed_via_agents: ["agt_x"],
              body: "third",
              created_at: at(3),
              updated_at: at(4),
            },
          ],
          next_cursor: "more",
        }),
      "GET /api/repos/ada/demo/pulls/7/reviews": () =>
        json({
          reviews: [
            {
              id: 9,
              user: { id: "usr_r" },
              performed_via_agents: [],
              state: "APPROVED",
              body: null,
              commit_id: "b".repeat(40),
              submitted_at: at(2),
              dismissal: null,
            },
          ],
          next_cursor: null,
        }),
    });
    const data = await pullLoader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7`),
      context,
      params,
    } as never);
    expect(data.timeline.map((i) => ("id" in i ? `${i.kind}${i.id}` : i.kind))).toEqual([
      "comment1",
      "review9",
      "comment2",
      "merged",
    ]);
    expect(data.timeline[2]).toMatchObject({ edited: true, agents: ["agt_x"] });
    // The next navigation reads the API's next page from its start.
    expect(data.commentPages.next).toBe("/ada/demo/pull/7?comments=0%3Amore");
    // Markdown goes as its source: the page renders it in the browser.
    expect(data.body).toBe("Some **words**");
    expect(JSON.stringify(data)).not.toContain("<strong>");
  });

  it("renders hostile titles, bodies, comments, reviews and branch names inert", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo/pulls/7": () =>
        json(
          pullRequest({
            title: HOSTILE,
            body: `${HOSTILE}\n\n[x](javascript:alert(4))`,
            head: { ref: HOSTILE, sha: "b".repeat(40) },
            base: { ref: HOSTILE, sha: "a".repeat(40) },
          }),
        ),
      "GET /api/repos/ada/demo/issues/7/comments": () =>
        json({
          comments: [
            {
              id: 1,
              user: { id: HOSTILE },
              performed_via_agents: [HOSTILE],
              body: HOSTILE,
              created_at: 1,
              updated_at: 1,
            },
          ],
          next_cursor: null,
        }),
      "GET /api/repos/ada/demo/pulls/7/reviews": () =>
        json({
          reviews: [
            {
              id: 2,
              user: { id: "usr_r" },
              performed_via_agents: [],
              state: "DISMISSED",
              body: `<iframe src="javascript:alert(5)"></iframe>`,
              commit_id: "b".repeat(40),
              submitted_at: 2,
              dismissal: { by: "usr_d", message: HOSTILE, at: 3 },
            },
          ],
          next_cursor: null,
        }),
    });
    const data = await pullLoader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7`),
      context,
      params,
    } as never);
    const html = renderPage(Pull, "/ada/demo/pull/7", data);
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows the maintainers' setting only to the author of a pull request from a fork", () => {
    const base = {
      owner: "ada",
      repo: "demo",
      body: null,
      timeline: [],
      commentPages: { next: null, first: null },
      reviewPages: { next: null, first: null },
    };
    const page = (pull: Record<string, unknown>, viewer: string | null) =>
      renderPage(Pull, "/ada/demo/pull/7", { ...base, pull: pullRequest(pull), viewer });
    expect(page({ head_repo_id: "rep_fork" }, VIEWER)).toContain("Allow edits by maintainers");
    expect(page({ head_repo_id: "rep_fork" }, "usr_other")).not.toContain(
      "Allow edits by maintainers",
    );
    expect(page({ head_repo_id: null }, VIEWER)).not.toContain("Allow edits by maintainers");
    // Draft or ready, closed or reopened: the buttons the state allows.
    expect(page({ draft: true }, VIEWER)).toContain("Ready for review");
    expect(page({}, VIEWER)).toContain("Convert to draft");
    expect(page({ state: "closed" }, VIEWER)).toContain("Reopen pull request");
    expect(page({ state: "closed", merged: true }, VIEWER)).not.toContain("Reopen pull request");
  });
});

describe("changing a pull request", () => {
  async function act(fields: Record<string, string>, status = 200) {
    const { context, calls } = api({
      "PATCH /api/repos/ada/demo/pulls/7": () =>
        status === 200
          ? json(pullRequest())
          : json({ code: "forbidden", detail: "Not yours." }, status),
      "POST /api/repos/ada/demo/issues/7/comments": () => json({ id: 1 }, 201),
    });
    const outcome = await pullAction({
      request: formPost("/ada/demo/pull/7", fields),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET");
    return { outcome, call: sent && pathOf(sent), body: sent ? await sent.json() : undefined };
  }

  it("sends each change as the API takes it", async () => {
    expect(await act({ intent: "close" })).toMatchObject({
      outcome: { ok: "close" },
      call: "PATCH /api/repos/ada/demo/pulls/7",
      body: { state: "closed" },
    });
    expect((await act({ intent: "reopen" })).body).toEqual({ state: "open" });
    expect((await act({ intent: "draft" })).body).toEqual({ draft: true });
    expect((await act({ intent: "ready" })).body).toEqual({ draft: false });
    expect((await act({ intent: "maintainer", maintainer_can_modify: "on" })).body).toEqual({
      maintainer_can_modify: true,
    });
    expect((await act({ intent: "maintainer" })).body).toEqual({ maintainer_can_modify: false });
    expect((await act({ intent: "edit", title: " New ", body: "  code" })).body).toEqual({
      title: "New",
      body: "  code",
    });
    expect((await act({ intent: "edit", title: "New", body: "  " })).body).toEqual({
      title: "New",
      body: null,
    });
    expect(await act({ intent: "comment", body: "  indented" })).toMatchObject({
      outcome: { ok: "comment" },
      call: "POST /api/repos/ada/demo/issues/7/comments",
      body: { body: "  indented" },
    });
  });

  it("refuses a blank comment without asking the API, and says why the API refused a change", async () => {
    expect(await act({ intent: "comment", body: " \n" })).toEqual({
      outcome: { error: "Write a comment first." },
      call: undefined,
      body: undefined,
    });
    expect((await act({ intent: "close" }, 403)).outcome).toEqual({ error: "Not yours." });
  });
});
