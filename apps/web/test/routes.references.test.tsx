// What refers to an issue or pull request: the page reads its references a
// page at a time and links each to its source (an issue, a pull request, or
// the comment naming it, by its permalink).

import { describe, expect, it } from "vitest";
import { loader, default as References } from "../app/routes/repo.issue.references.js";
import { json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const API = "/api/repos/ada/demo/issues/7";

const subject = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Crash on start",
  ...overrides,
});

const reference = (source: Record<string, unknown>) => ({
  source: { repository: "ada/demo", number: 3, kind: "issue", comment_id: null, ...source },
  created_at: Date.parse("2026-10-01T10:00:00Z"),
});

describe("what refers to an issue", () => {
  it("reads the issue and a page of its references after the cursor", async () => {
    const { context, calls } = api({
      [`GET ${API}`]: () => json(subject()),
      [`GET ${API}/references`]: () => json({ references: [], next_cursor: "N" }),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/issues/7/references?cursor=C`),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain(`GET ${API}/references?per_page=30&cursor=C`);
    expect(data).toMatchObject({
      pages: {
        next: "/ada/demo/issues/7/references?cursor=N",
        first: "/ada/demo/issues/7/references",
      },
    });
  });

  it("links each source: an issue, a pull request, a comment by its permalink", () => {
    const html = renderPage(References, "/ada/demo/issues/7/references", {
      at: { owner: "ada", repo: "demo", number: 7 },
      subject: subject({ title: HOSTILE }),
      references: [
        reference({}),
        reference({ repository: "bo/other", number: 4, kind: "pull_request" }),
        reference({ number: 5, comment_id: 12 }),
      ],
      pages: { next: null, first: null },
      viewer: VIEWER,
    });
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
    expect(html).toContain('href="/ada/demo/issues/3"');
    expect(html).toContain('href="/bo/other/pull/4"');
    expect(html).toContain('href="/ada/demo/issues/5?comment=12#comment-12"');
    expect(html).toContain("a comment on the issue");
    expect(html).toContain('href="/ada/demo/issues/7"');
  });

  it("goes back to a pull request's own page, and says when a page holds none", () => {
    const html = renderPage(References, "/ada/demo/issues/7/references", {
      at: { owner: "ada", repo: "demo", number: 7 },
      subject: subject({ pull_request: { merged_at: null } }),
      references: [],
      pages: { next: "/ada/demo/issues/7/references?cursor=N", first: null },
      viewer: VIEWER,
    });
    expect(html).toContain('href="/ada/demo/pull/7"');
    expect(html).toContain("None on this page");
  });
});
