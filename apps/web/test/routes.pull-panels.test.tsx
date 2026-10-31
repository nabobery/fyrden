// A pull request's reviewers and code owners pages, and the blob view of a
// CODEOWNERS file: what each asks the API, what each role is offered, how
// each refusal reads, and hostile names shown as text.

import { describe, expect, it } from "vitest";
import { reviewRequest } from "../app/lib/reviewers.server.js";
import { default as Blob, loader as blobLoader } from "../app/routes/repo.blob.js";
import {
  default as CodeOwners,
  loader as codeOwnersLoader,
} from "../app/routes/repo.pull.code-owners.js";
import {
  default as Reviewers,
  action as reviewersAction,
  loader as reviewersLoader,
} from "../app/routes/repo.pull.reviewers.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const PULL = "/api/repos/ada/demo/pulls/7";
const TRIAGE = { admin: false, maintain: false, push: false, triage: true, pull: true };

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

describe("a review request", () => {
  it("takes handles and the owner's teams, by bare slug or owner/slug", () => {
    expect(
      reviewRequest(form({ reviewers: "@bo, cy  bo", teams: "core ada/Docs" }), "ada"),
    ).toEqual({
      reviewers: ["bo", "cy"],
      team_reviewers: ["core", "docs"],
    });
    expect(reviewRequest(form({ reviewers: "", teams: "ADA/core" }), "ada")).toEqual({
      reviewers: [],
      team_reviewers: ["core"],
    });
  });

  it("counts a handle once whatever its case, as the API matches it", () => {
    const fifteen = [...Array.from({ length: 15 }, (_, i) => `u${i}`), "U0", "@u1"].join(",");
    expect(reviewRequest(form({ reviewers: fifteen }), "ada")).toMatchObject({
      reviewers: Array.from({ length: 15 }, (_, i) => `u${i}`),
    });
  });

  it("refuses another account's team, what is no handle or slug, none, and too many", () => {
    for (const [fields, why] of [
      [{ teams: "other/core" }, "not a team of ada"],
      [{ reviewers: "not/a-handle" }, "no handle"],
      [{ teams: "bad_slug" }, "no team's slug"],
      [{ reviewers: "", teams: "" }, "Name a reviewer"],
      [{ reviewers: Array.from({ length: 16 }, (_, i) => `u${i}`).join(",") }, "At most 15"],
    ] as const)
      expect(reviewRequest(form(fields), "ada"), JSON.stringify(fields)).toMatchObject({
        refused: expect.stringContaining(why),
      });
  });
});

const requested = {
  users: [{ id: "usr_bo", login: "bo" }],
  teams: [{ id: "team_1", slug: "core", name: HOSTILE }],
};

describe("the reviewers page", () => {
  it("reads the pull request, its requested reviewers, the repository and the viewer", async () => {
    const { context, calls } = api({
      [`GET ${PULL}`]: () => json(pullRequest()),
      [`GET ${PULL}/requested_reviewers`]: () => json(requested),
      "GET /api/repos/ada/demo": () => json({ ...repo, owner_type: "User", permissions: TRIAGE }),
    });
    const data = await reviewersLoader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/reviewers`, {
        headers: { Cookie: "fyrden_session=s" },
      }),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain(`GET ${PULL}/requested_reviewers`);
    // A user's repository: no team field.
    expect(data).toMatchObject({ requested, triage: true, teamsOf: null, viewer: VIEWER });
  });

  const page = (overrides: Record<string, unknown> = {}) =>
    renderPage(Reviewers, "/ada/demo/pull/7/reviewers", {
      at: { owner: "ada", repo: "demo", number: 7 },
      pull: pullRequest({ user: { id: "usr_other" } }),
      requested,
      triage: true,
      teamsOf: "ada",
      viewer: VIEWER,
      viewerKnown: true,
      ...overrides,
    });

  it("lists users and teams, withdrawn by id, and asks more of triage or the author", () => {
    const html = page();
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toMatch(/value="withdraw-user"\/><input type="hidden" name="id" value="usr_bo"/);
    expect(html).toMatch(/value="withdraw-team"\/><input type="hidden" name="id" value="team_1"/);
    expect(html).toContain("Request a review");
    expect(html).toContain('name="teams"');
    // A user's repository takes no team reviewers: none offered.
    const personal = page({ teamsOf: null });
    expect(personal).toContain('name="reviewers"');
    expect(personal).not.toContain('name="teams"');
    // The author of their own, without triage.
    expect(page({ pull: pullRequest(), triage: false })).toContain("Request a review");
    // A reader of someone else's, and a closed one: nothing to change.
    for (const html of [
      page({ triage: false }),
      page({ pull: pullRequest({ state: "closed" }) }),
    ]) {
      expect(html).not.toMatch(/name="intent"/);
      expect(html).toContain("bo");
    }
  });

  async function send(
    fields: Record<string, string>,
    viewer = VIEWER,
    asked = () => json(pullRequest(), 201),
  ) {
    const { context, calls } = api({
      [`POST ${PULL}/requested_reviewers`]: asked,
      [`POST ${PULL}/requested_reviewers/teams`]: asked,
      [`DELETE ${PULL}/requested_reviewers`]: () => json(pullRequest()),
    });
    const outcome = await reviewersAction({
      request: formPost("/ada/demo/pull/7/reviewers", { viewer, ...fields }),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET" && !c.url.includes("/auth/"));
    return { outcome, sent: sent && { path: pathOf(sent), body: await sent.json() } };
  }

  it("asks a transferred repository's teams of its owner now, never its former one", async () => {
    // Teams are sent as the owner the form showed: the API refuses them once another owns it.
    const stale = await send({ intent: "request", teams: "core", teams_of: "ada" }, VIEWER, () =>
      json({ code: "stale", detail: "The repository belongs to another account." }, 409),
    );
    expect(stale.sent?.body).toEqual({
      reviewers: [],
      team_reviewers: ["core"],
      team_owner: "ada",
    });
    expect(stale.outcome).toMatchObject({ error: expect.any(String) });
    expect(stale.outcome).not.toHaveProperty("ok");
    // Drawn after the move (its old name in the URL): neworg's, named either way.
    for (const teams of ["core", "neworg/core"]) {
      const fresh = await send({ intent: "request", teams, teams_of: "neworg" });
      expect(fresh.sent?.path).toBe(`POST ${PULL}/requested_reviewers/teams`);
      expect(fresh.sent?.body, teams).toEqual({
        reviewers: [],
        team_reviewers: ["core"],
        team_owner: "neworg",
      });
    }
    // Another account's team, or a team on a form that showed no owner: never sent.
    for (const fields of [
      { intent: "request", teams: "ada/core", teams_of: "neworg" },
      { intent: "request", teams: "core" },
    ])
      expect((await send(fields)).sent, JSON.stringify(fields)).toBeUndefined();
    // An API that predates the check knows no such path: nothing asked, and said.
    const earlier = await send(
      { intent: "request", teams: "core", teams_of: "neworg" },
      VIEWER,
      () => json({ code: "not_found", detail: "Not found" }, 404),
    );
    expect(earlier.outcome).toMatchObject({ error: expect.any(String) });
    expect(earlier.outcome).not.toHaveProperty("ok");
    // People alone carry no owner, through the plain path.
    const people = await send({ intent: "request", reviewers: "bo", teams_of: "neworg" });
    expect(people.sent?.path).toBe(`POST ${PULL}/requested_reviewers`);
    expect(people.sent?.body).toEqual({ reviewers: ["bo"], team_reviewers: [] });
    // The page names the owner it is now.
    const { context } = api({
      [`GET ${PULL}`]: () => json(pullRequest()),
      [`GET ${PULL}/requested_reviewers`]: () => json(requested),
      "GET /api/repos/ada/demo": () =>
        json({ ...repo, owner: "neworg", owner_type: "Organization", permissions: TRIAGE }),
    });
    const data = await reviewersLoader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/reviewers`),
      context,
      params,
    } as never);
    expect(data.teamsOf).toBe("neworg");
  });

  it("requests, withdraws by id, and sends nothing it may not", async () => {
    expect(
      await send({ intent: "request", reviewers: "bo", teams: "core", teams_of: "ada" }),
    ).toMatchObject({
      outcome: { ok: "request" },
      sent: {
        path: `POST ${PULL}/requested_reviewers/teams`,
        body: { reviewers: ["bo"], team_reviewers: ["core"], team_owner: "ada" },
      },
    });
    expect((await send({ intent: "withdraw-team", id: "team_1" })).sent).toEqual({
      path: `DELETE ${PULL}/requested_reviewers`,
      body: { team_ids: ["team_1"] },
    });
    expect((await send({ intent: "withdraw-user", id: "usr_bo" })).sent?.body).toEqual({
      reviewer_ids: ["usr_bo"],
    });
    for (const [fields, viewer] of [
      [{ intent: "request", teams: "other/core", teams_of: "ada" }, VIEWER],
      // A team with no owner shown (a user's repository's form): never sent.
      [{ intent: "request", teams: "core" }, VIEWER],
      [{ intent: "withdraw-user", id: "../x" }, VIEWER],
      [{ intent: "request", reviewers: "bo" }, "usr_other"],
    ] as const) {
      const { sent, outcome } = await send(fields, viewer);
      expect(sent, JSON.stringify(fields)).toBeUndefined();
      expect(outcome).toMatchObject({ error: expect.any(String) });
    }
  });
});

const owners = (overrides: Record<string, unknown> = {}) => ({
  state: "complete",
  reason: null,
  retry_at: null,
  file: { path: ".github/CODEOWNERS", sha: "f".repeat(40) },
  errors: 0,
  rules: [{ line: 3, owners: ["@ada", HOSTILE], paths: 2, example_path: HOSTILE }],
  ownerless_paths: 0,
  unmatched_paths: 1,
  unmatchable_paths: 0,
  unmatchable_example: null,
  next_cursor: null,
  ...overrides,
});

describe("the code owners page", () => {
  async function load(answers: (() => Response)[], search = "") {
    let at = 0;
    const { context, calls } = api({
      [`GET ${PULL}`]: () => json(pullRequest()),
      [`GET ${PULL}/code-owners`]: () => (answers[at++] ?? answers.at(-1) ?? (() => json({})))(),
    });
    const data = await codeOwnersLoader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/code-owners${search}`),
      context,
      params,
    } as never);
    return { data, calls: calls.map(pathOf) };
  }

  it("shows the rules deciding its paths, their owners and counts; hostile text inert", async () => {
    const { data, calls } = await load([() => json(owners())]);
    expect(calls).toContain(`GET ${PULL}/code-owners?per_page=30`);
    const html = renderPage(CodeOwners, "/ada/demo/pull/7/code-owners", data);
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toContain("@ada, ");
    expect(html).toContain("1 changed path no rule matches");
    expect(html).toContain('href="/ada/demo/blob/main/.github/CODEOWNERS"');
  });

  it("explains each state, and a closed pull request's refusal", async () => {
    const said = async (answer: () => Response) =>
      renderPage(CodeOwners, "/ada/demo/pull/7/code-owners", (await load([answer])).data);
    expect(await said(() => json(owners({ state: "pending", rules: [] })))).toContain(
      "Being worked out",
    );
    expect(
      await said(() => json(owners({ state: "too_large", reason: "scan", rules: [] }))),
    ).toContain("the changes are too many to scan");
    expect(await said(() => json(owners({ errors: 2 })))).toContain("2 invalid lines");
    expect(await said(() => json({ code: "pull_not_open", detail: "x" }, 422))).toContain(
      "shown while the pull request is open",
    );
  });

  it("starts again from the first rule when its cursor is of an evaluation since replaced", async () => {
    const { data, calls } = await load(
      [() => json({ code: "invalid_cursor", detail: "x" }, 422), () => json(owners())],
      "?cursor=old",
    );
    // The stale page, then the first one again.
    expect(calls.filter((c) => c.includes("/code-owners"))).toEqual([
      `GET ${PULL}/code-owners?per_page=30&cursor=old`,
      `GET ${PULL}/code-owners?per_page=30`,
    ]);
    expect(data).toMatchObject({ restarted: true, pages: { first: null } });
  });
});

describe("a CODEOWNERS file's blob view", () => {
  const SHA = "a".repeat(40);
  async function view(path: string, errors: () => Response) {
    const { context, calls } = api({
      [`GET /api/repos/ada/demo/contents/${path}`]: () =>
        json({
          type: "file",
          path,
          name: "CODEOWNERS",
          sha: SHA,
          size: 10,
          encoding: "base64",
          content: btoa("* @ada\n"),
        }),
      "GET /api/repos/ada/demo/codeowners/errors": errors,
    });
    const data = await blobLoader({
      request: new Request(`${ORIGIN}/ada/demo/blob/main/${path}`),
      context,
      params: { owner: "ada", repo: "demo", "*": `main/${path}` },
    } as never);
    return {
      html: renderPage(Blob, `/ada/demo/blob/main/${path}`, data),
      calls: calls.map(pathOf),
    };
  }
  const answer =
    (file: { path: string; sha: string }, errors: unknown[] = []) =>
    () =>
      json({ errors, truncated: false, file, sha: "c".repeat(40) });

  it("shows its errors when it is the file in effect, read at the same blob", async () => {
    const { html, calls } = await view(
      ".github/CODEOWNERS",
      answer({ path: ".github/CODEOWNERS", sha: SHA }, [
        {
          line: 2,
          column: 1,
          kind: "bad",
          source: HOSTILE,
          suggestion: null,
          message: "No owner.",
          path: ".github/CODEOWNERS",
        },
      ]),
    );
    expect(calls).toContain("GET /api/repos/ada/demo/codeowners/errors?ref=main");
    expect(html).toContain("Line 2");
    expect(html).toContain("No owner.");
    expect(html).toContain("(bad)");
    expect(html).toContain(escaped(HOSTILE));
    expect(html).not.toMatch(ACTIVE_TAG);
  });

  it("names the file in effect when it is another, and says when the branch moved", async () => {
    const elsewhere = await view(
      "CODEOWNERS",
      answer({ path: ".github/CODEOWNERS", sha: "b".repeat(40) }),
    );
    expect(elsewhere.html).toContain("Not the CODEOWNERS file in effect here");
    expect(elsewhere.html).not.toContain("CODEOWNERS errors");
    const moved = await view("CODEOWNERS", answer({ path: "CODEOWNERS", sha: "b".repeat(40) }));
    expect(moved.html).toContain("moved while this page was read");
  });

  it("shows the file all the same when its errors cannot be read", async () => {
    for (const failing of [
      () => {
        throw new Error("binding down");
      },
      () => new Response("Service Unavailable", { status: 503 }),
      () => json({ code: "missing_permission", detail: "x" }, 403),
    ]) {
      const { html } = await view(".github/CODEOWNERS", failing as () => Response);
      expect(html).toContain("could not be read just now");
      expect(html).toContain("* @ada");
    }
    // No file in effect there: nothing said.
    const none = await view(".github/CODEOWNERS", () =>
      json({ code: "not_found", detail: "x" }, 404),
    );
    expect(none.html).not.toContain("CODEOWNERS errors");
    expect(none.html).not.toContain("could not be read");
  });

  it("asks nothing of another file", async () => {
    const { calls } = await view("src/CODEOWNERS", answer({ path: "x", sha: SHA }));
    expect(calls.some((c) => c.includes("codeowners/errors"))).toBe(false);
  });
});
