// Reviewing and merging: the methods and requirements the base branch's
// active rulesets set, what the review, merge and update-branch forms send,
// a long rebase answered as still going on, refusals shown with their
// reason, and a draft that cannot be merged.

import { DEFAULT_PULL_REQUEST_PARAMETERS } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import { mergeRules } from "../app/lib/merge.server.js";
import { action, loader, default as Pull } from "../app/routes/repo.pull.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest, repo, VIEWER } from "./helpers/pulls.js";
import { renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const HEAD = "b".repeat(40);

function ruleset(extra: Record<string, unknown> = {}) {
  return {
    name: "main rules",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "pull_request",
        parameters: {
          ...DEFAULT_PULL_REQUEST_PARAMETERS,
          allowed_merge_methods: ["squash", "rebase"],
        },
      },
    ],
    ...extra,
  } as Parameters<typeof mergeRules>[0][number];
}

describe("what the base branch's rulesets ask of a merge", () => {
  it("allows every method, and asks nothing, without a ruleset", () => {
    expect(mergeRules([], "main", "main")).toEqual({
      methods: ["merge", "squash", "rebase"],
      approvals: 0,
      threadsResolved: false,
      lastPushApproval: false,
      upToDate: false,
      signatures: false,
      rulesets: [],
    });
  });

  it("allows the methods every applicable rule allows, and the most any asks", () => {
    const rules = mergeRules(
      [
        ruleset(),
        ruleset({
          name: "release",
          conditions: { ref_name: { include: ["refs/heads/**"], exclude: [] } },
          rules: [
            {
              type: "pull_request",
              parameters: {
                allowed_merge_methods: ["merge", "squash"],
                required_approving_review_count: 2,
                required_review_thread_resolution: true,
              },
            },
            { type: "require_up_to_date" },
            { type: "required_signatures" },
          ],
        }),
      ],
      "main",
      "main",
    );
    expect(rules).toMatchObject({
      methods: ["squash"],
      approvals: 2,
      threadsResolved: true,
      upToDate: true,
      signatures: true,
      rulesets: ["main rules", "release"],
    });
  });

  it("ignores rulesets that only evaluate, are disabled, target tags or leave the branch out", () => {
    const ignored = [
      ruleset({ enforcement: "evaluate" }),
      ruleset({ enforcement: "disabled" }),
      ruleset({ target: "tag" }),
      ruleset({ conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/main"] } } }),
      ruleset({ conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } } }),
    ];
    expect(mergeRules(ignored, "main", "main").methods).toEqual(["merge", "squash", "rebase"]);
    // The default branch only matches as the default branch.
    expect(mergeRules([ruleset()], "main", "trunk").methods).toEqual(["merge", "squash", "rebase"]);
  });
});

describe("the conversation's merge box", () => {
  it("reads the base branch's rulesets for an open pull request only", async () => {
    for (const [state, expected] of [
      ["open", ["squash", "rebase"]],
      ["closed", null],
    ] as const) {
      const { context, calls } = api({
        "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest({ state })),
        "GET /api/repos/ada/demo/issues/7/comments": () =>
          json({ comments: [], next_cursor: null }),
        "GET /api/repos/ada/demo/pulls/7/reviews": () => json({ reviews: [], next_cursor: null }),
        "GET /api/repos/ada/demo": () => json(repo),
        "GET /api/repos/ada/demo/rulesets": () => json({ rulesets: [ruleset()] }),
      });
      const data = await loader({
        request: new Request(`${ORIGIN}/ada/demo/pull/7`),
        context,
        params,
      } as never);
      expect(data.rules?.methods ?? null, state).toEqual(expected);
      expect(
        calls.some((c) => pathOf(c).endsWith("/rulesets")),
        state,
      ).toBe(state === "open");
    }
  });

  it("offers every method, saying so, when the rulesets cannot be read", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest()),
      "GET /api/repos/ada/demo/issues/7/comments": () => json({ comments: [], next_cursor: null }),
      "GET /api/repos/ada/demo/pulls/7/reviews": () => json({ reviews: [], next_cursor: null }),
      "GET /api/repos/ada/demo": () => json(repo),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7`),
      context,
      params,
    } as never);
    expect(data.rules).toBeNull();
    const html = renderPage(Pull, "/ada/demo/pull/7", data);
    expect(html).toContain("could not be read; every method is offered");
    expect(html).toContain("Rebase and merge");
  });

  const page = (pull: Record<string, unknown>, rules: unknown, viewer: string | null = VIEWER) =>
    renderPage(Pull, "/ada/demo/pull/7", {
      owner: "ada",
      repo: "demo",
      pull: pullRequest(pull),
      viewer,
      body: null,
      timeline: [],
      commentPages: { next: null, first: null },
      reviewPages: { next: null, first: null },
      rules,
    });

  it("offers only the allowed methods and lists what the rulesets ask", () => {
    const html = page(
      {},
      mergeRules(
        [
          ruleset({
            rules: [
              {
                type: "pull_request",
                parameters: {
                  allowed_merge_methods: ["squash"],
                  required_approving_review_count: 1,
                },
              },
            ],
          }),
        ],
        "main",
        "main",
      ),
    );
    expect(html).toContain("Squash and merge");
    expect(html).not.toContain("Create a merge commit");
    expect(html).not.toContain("Rebase and merge");
    expect(html).toContain("1 approving review of the head");
    expect(html).toContain("No conflicts with the base branch.");
  });

  it("says when no method is allowed, or the pull request conflicts, is a draft or is being checked", () => {
    expect(page({}, { ...mergeRules([], "main", "main"), methods: [] })).toContain(
      "allow no merge method in common",
    );
    const dirty = page(
      { mergeable: false, mergeable_state: "dirty" },
      mergeRules([], "main", "main"),
    );
    expect(dirty).toContain("This branch has conflicts");
    expect(dirty).toContain('href="/ada/demo/pull/7/conflicts"');
    const draft = page({ draft: true, mergeable_state: "draft" }, mergeRules([], "main", "main"));
    expect(draft).toContain("A draft cannot be merged.");
    expect(draft).toMatch(
      /<button type="submit" class="primary" disabled=""[^>]*>Merge pull request/,
    );
    expect(page({ mergeable: null, mergeable_state: "unknown" }, null)).toContain(
      "Checking whether it merges cleanly",
    );
    expect(page({ state: "closed" }, null)).not.toContain("Merge pull request");
  });

  it("lets the author only comment in a review", () => {
    expect(page({}, null)).toContain("you may only comment");
    expect(page({}, null, "usr_other")).not.toContain("you may only comment");
    expect(page({}, null, null)).not.toContain("Submit review");
  });
});

describe("reviewing, merging and updating the branch", () => {
  async function act(fields: Record<string, string>, reply: () => Response = () => json({}, 200)) {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/pulls/7/reviews": reply,
      "PUT /api/repos/ada/demo/pulls/7/merge": reply,
      "PUT /api/repos/ada/demo/pulls/7/update-branch": reply,
    });
    const outcome = await action({
      request: formPost("/ada/demo/pull/7", fields),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET");
    return { outcome, call: sent && pathOf(sent), body: sent ? await sent.json() : undefined };
  }

  it("submits a review of the head it showed", async () => {
    expect(await act({ intent: "review", event: "APPROVE", commit_id: HEAD, body: "" })).toEqual({
      outcome: { ok: "review" },
      call: "POST /api/repos/ada/demo/pulls/7/reviews",
      body: { commit_id: HEAD, event: "APPROVE" },
    });
    expect(
      (await act({ intent: "review", event: "REQUEST_CHANGES", commit_id: HEAD, body: "  fix" }))
        .body,
    ).toEqual({ commit_id: HEAD, event: "REQUEST_CHANGES", body: "  fix" });
  });

  it("refuses a review without asking the API when it lacks what it needs", async () => {
    for (const fields of [
      { event: "COMMENT", body: " " },
      { event: "REQUEST_CHANGES", body: "" },
      { event: "DISMISS", body: "x" },
    ])
      expect((await act({ intent: "review", commit_id: HEAD, ...fields })).call).toBeUndefined();
  });

  it("merges with the method chosen, at the head shown", async () => {
    expect(
      await act({
        intent: "merge",
        merge_method: "squash",
        sha: HEAD,
        commit_title: "T",
        commit_message: "M",
      }),
    ).toEqual({
      outcome: { ok: "merge" },
      call: "PUT /api/repos/ada/demo/pulls/7/merge",
      body: { merge_method: "squash", sha: HEAD, commit_title: "T", commit_message: "M" },
    });
    // A rebase takes no message; a malformed head is not sent.
    expect(
      (
        await act({
          intent: "merge",
          merge_method: "rebase",
          sha: "x",
          commit_title: "T",
          commit_message: "M",
        })
      ).body,
    ).toEqual({ merge_method: "rebase" });
    expect((await act({ intent: "merge", merge_method: "octopus" })).call).toBeUndefined();
  });

  it("answers a rebase still going on as pending, and a refusal with its reason", async () => {
    const inProgress = () =>
      json({ code: "merge_in_progress", detail: "The rebase goes on in the background." }, 409);
    expect((await act({ intent: "merge", merge_method: "rebase" }, inProgress)).outcome).toEqual({
      pending: true,
    });
    const refused = () =>
      json(
        { code: "merge_refused", detail: "Ruleset main rules: 1 approving review is required." },
        405,
      );
    expect((await act({ intent: "merge", merge_method: "merge" }, refused)).outcome).toEqual({
      error: "Ruleset main rules: 1 approving review is required.",
    });
    const moved = () => json({ code: "head_moved", detail: "The head moved." }, 409);
    expect((await act({ intent: "merge", merge_method: "merge" }, moved)).outcome).toEqual({
      error: "The head moved.",
    });
  });

  it("updates the branch from the head it showed, saying why not when it cannot", async () => {
    expect(
      await act({ intent: "update-branch", expected_head_sha: HEAD }, () =>
        json({ sha: HEAD }, 202),
      ),
    ).toEqual({
      outcome: { ok: "update-branch" },
      call: "PUT /api/repos/ada/demo/pulls/7/update-branch",
      body: { expected_head_sha: HEAD },
    });
    const upToDate = () =>
      json({ code: "up_to_date", detail: "The head already has the base." }, 422);
    expect(
      (await act({ intent: "update-branch", expected_head_sha: HEAD }, upToDate)).outcome,
    ).toEqual({
      error: "The head already has the base.",
    });
  });
});
