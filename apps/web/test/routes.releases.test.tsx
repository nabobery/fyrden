// Releases: the list and page show what a viewer may see, hostile text as
// text, and what became of a tag; forms create, save, publish and delete, a
// refusal keeping what was written; a slashed tag survives every link.

import { describe, expect, it } from "vitest";
import { releaseKind, releasePage, sourceArchive, tagNotice } from "../app/lib/releases.js";
import {
  action as pageAction,
  loader as pageLoader,
  default as ReleasePage,
} from "../app/routes/repo.release.js";
import { default as EditRelease, action as editAction } from "../app/routes/repo.release-edit.js";
import { action as newAction } from "../app/routes/repo.release-new.js";
import { loader, default as Releases } from "../app/routes/repo.releases.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo" };
const ALL = { admin: true, maintain: true, push: true, triage: true, pull: true };
const READ_ONLY = { admin: false, maintain: false, push: false, triage: false, pull: true };
const SHA = "a".repeat(40);

function release(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    tag_name: "v1/rc",
    name: "One",
    body: "Notes",
    draft: false,
    prerelease: false,
    author: { id: VIEWER },
    tag_sha: SHA,
    commit_sha: SHA,
    current_tag_sha: null,
    tag_state: "current",
    published_at: 5,
    created_at: 1,
    updated_at: 5,
    version: 2,
    assets: [],
    ...overrides,
  };
}

/** What a change sent, as JSON. */
const bodyOfChange = (calls: Request[]) => {
  const sent = calls.find((c) => c.method !== "GET" && !c.url.includes("/auth/"));
  return sent?.clone().json() as Promise<Record<string, unknown>>;
};

describe("how a release reads", () => {
  it("says its kind in words", () => {
    expect(releaseKind({ draft: true, prerelease: true })).toBe("Draft");
    expect(releaseKind({ draft: false, prerelease: true })).toBe("Prerelease");
    expect(releaseKind({ draft: false, prerelease: false })).toBe("Published");
  });

  it("says what became of a tag only when it changed, and where the archives stay", () => {
    expect(tagNotice({ tag_state: "current", commit_sha: SHA })).toBeNull();
    expect(tagNotice({ tag_state: null, commit_sha: null })).toBeNull();
    expect(tagNotice({ tag_state: "moved", commit_sha: SHA })).toContain("aaaaaaa");
    expect(tagNotice({ tag_state: "deleted", commit_sha: SHA })).toContain("deleted");
  });

  it("links a slashed or odd tag by segments, and archives by the recorded commit", () => {
    expect(releasePage("ada", "demo", "v1/r c#")).toBe("/ada/demo/releases/tag/v1/r%20c%23");
    expect(sourceArchive("ada", "demo", "zip", SHA)).toBe(`/ada/demo/archive/zip?ref=${SHA}`);
  });
});

describe("the releases list", () => {
  it("asks for a page, and links the next", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/releases": () => json({ releases: [release()], next_cursor: "N" }),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/releases?cursor=C`),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain("GET /api/repos/ada/demo/releases?per_page=30&cursor=C");
    expect(data.pages.next).toBe("/ada/demo/releases?cursor=N");
  });

  const page = (overrides: Record<string, unknown> = {}) => ({
    repo: { ...repo, permissions: ALL },
    origin: ORIGIN,
    releases: [release()],
    pages: { next: null, first: null },
    ...overrides,
  });

  it("shows hostile text as text, and the state in words", () => {
    const html = renderPage(
      Releases,
      "/ada/demo/releases",
      page({ releases: [release({ name: HOSTILE, tag_state: "moved" })] }),
    );
    expect(html).toContain(escaped(HOSTILE));
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain("Published");
    expect(html).toContain("has moved");
    expect(html).toContain('href="/ada/demo/releases/tag/v1/rc"');
  });

  it("offers a new release to those who can write", () => {
    expect(renderPage(Releases, "/ada/demo/releases", page())).toContain("New release");
    expect(
      renderPage(
        Releases,
        "/ada/demo/releases",
        page({ repo: { ...repo, permissions: READ_ONLY } }),
      ),
    ).not.toContain("New release");
  });
});

describe("a release's page", () => {
  it("reads a slashed tag by segments", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/releases/tags/v1/rc": () => json(release()),
    });
    await pageLoader({
      request: new Request(`${ORIGIN}/ada/demo/releases/tag/v1/rc`, {
        headers: { Cookie: "__Host-fyrden_session=s" },
      }),
      context,
      params: { ...params, "*": "v1/rc" },
    } as never);
    expect(calls.map(pathOf)).toContain("GET /api/repos/ada/demo/releases/tags/v1/rc");
  });

  it("reads a tag holding a literal %2F as itself, not as a slash", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/releases/tags/v%252Frc": () => json(release()),
    });
    await pageLoader({
      request: new Request(`${ORIGIN}/ada/demo/releases/tag/v%252Frc`, {
        headers: { Cookie: "__Host-fyrden_session=s" },
      }),
      context,
      params: { ...params, "*": "v/rc" },
    } as never);
    expect(calls.map(pathOf)).toContain("GET /api/repos/ada/demo/releases/tags/v%252Frc");
  });

  const data = (overrides: Record<string, unknown> = {}) => ({
    repo: { ...repo, permissions: ALL },
    release: release(),
    origin: ORIGIN,
    viewer: VIEWER,
    ...overrides,
  });

  it("links source archives at the recorded commit, with the tag's fate said", () => {
    const html = renderPage(
      ReleasePage,
      "/ada/demo/releases/tag/v1/rc",
      data({ release: release({ tag_state: "deleted" }) }),
    );
    expect(html).toContain(`/ada/demo/archive/tar.gz?ref=${SHA}`);
    expect(html).toContain("has been deleted");
  });

  it("has no source archives for a draft, and offers changes only to a writer", () => {
    const draft = renderPage(
      ReleasePage,
      "/ada/demo/releases/tag/v1/rc",
      data({ release: release({ draft: true, tag_sha: null, commit_sha: null, tag_state: null }) }),
    );
    expect(draft).not.toContain("archive/");
    expect(draft).toContain("Edit release");
    const reader = renderPage(
      ReleasePage,
      "/ada/demo/releases/tag/v1/rc",
      data({ repo: { ...repo, permissions: READ_ONLY } }),
    );
    expect(reader).not.toContain("Edit release");
    expect(reader).not.toContain("Delete release");
  });

  it("deletes by id, then goes back to the list", async () => {
    const { context, calls } = api({
      "DELETE /api/repos/ada/demo/releases/1": () => json({ id: 1, state: "deleted" }),
    });
    const answer = await pageAction({
      request: formPost("/ada/demo/releases/tag/v1/rc", { id: "1", viewer: VIEWER }),
      context,
      params: { ...params, "*": "v1/rc" },
    } as never).catch((thrown: unknown) => thrown);
    expect(calls.map(pathOf)).toContain("DELETE /api/repos/ada/demo/releases/1");
    expect((answer as Response).headers.get("Location")).toBe("/ada/demo/releases");
  });
});

describe("the release forms", () => {
  const fields = { tag_name: "v1", name: "One", body: "  kept\n", viewer: VIEWER };

  it("publishes with the named button, and saves a draft with the other", async () => {
    for (const [intent, draft] of [
      ["publish", false],
      ["draft", true],
    ] as const) {
      const { context, calls } = api({
        "POST /api/repos/ada/demo/releases": () => json(release({ tag_name: "v1" }), 201),
      });
      const answer = await newAction({
        request: formPost("/ada/demo/releases/new", { ...fields, intent }),
        context,
        params,
      } as never).catch((thrown: unknown) => thrown);
      expect(await bodyOfChange(calls)).toMatchObject({
        tag_name: "v1",
        draft,
        prerelease: false,
        name: "One",
      });
      expect((answer as Response).headers.get("Location")).toBe("/ada/demo/releases/tag/v1");
    }
  });

  it("sends a tag exactly as written: git takes names a trim would change", async () => {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/releases": () => json(release(), 201),
    });
    await newAction({
      request: formPost("/ada/demo/releases/new", {
        ...fields,
        tag_name: "\u00a0v1\u00a0",
        intent: "publish",
      }),
      context,
      params,
    } as never).catch((thrown: unknown) => thrown);
    expect((await bodyOfChange(calls)).tag_name).toBe("\u00a0v1\u00a0");
  });

  it("keeps what was written when the tag doesn't exist", async () => {
    const { context } = api({
      "POST /api/repos/ada/demo/releases": () =>
        json({ code: "tag_not_found", detail: "The tag doesn't exist. Push it first." }, 422),
    });
    const answer = await newAction({
      request: formPost("/ada/demo/releases/new", { ...fields, intent: "publish" }),
      context,
      params,
    } as never);
    expect(answer.error).toContain("Push it first");
    expect(answer.draft?.fields).toMatchObject({ tag_name: "v1", name: "One", body: "  kept\n" });
  });

  it("edits from the version it opened, sending no tag for a published release", async () => {
    const { context, calls } = api({
      "PATCH /api/repos/ada/demo/releases/1": () => json(release()),
    });
    await editAction({
      request: formPost("/ada/demo/releases/edit/v1/rc", {
        ...fields,
        tag_name: "v1/rc",
        id: "1",
        version: "2",
        published: "1",
        intent: "edit",
      }),
      context,
      params: { ...params, "*": "v1/rc" },
    } as never).catch((thrown: unknown) => thrown);
    const sent = await bodyOfChange(calls);
    expect(sent).toMatchObject({ expected_version: 2, name: "One" });
    expect(sent).not.toHaveProperty("tag_name");
    expect(sent).not.toHaveProperty("draft");
  });

  it("scopes a refused edit to its release, so another under the same tag takes none of it", async () => {
    const { context } = api({
      "PATCH /api/repos/ada/demo/releases/1": () =>
        json({ code: "release_not_found", detail: "No such release." }, 404),
    });
    const answer = await editAction({
      request: formPost("/ada/demo/releases/edit/v1", {
        ...fields,
        id: "1",
        version: "1",
        intent: "edit",
      }),
      context,
      params: { ...params, "*": "v1" },
    } as never);
    expect(answer.scope).toMatchObject({ release: "1" });
    expect(answer.draft?.fields.body).toBe("  kept\n");
  });

  it("shows publish only on a draft, and fixes a published release's tag", () => {
    const data = (r: unknown) => ({
      repo: { ...repo, permissions: ALL },
      at: { owner: "ada", repo: "demo" },
      release: r,
      origin: ORIGIN,
      viewer: VIEWER,
    });
    const published = renderPage(EditRelease, "/ada/demo/releases/edit/v1/rc", data(release()));
    expect(published).not.toContain("Publish release");
    expect(published).toContain("readOnly");
    const draft = renderPage(
      EditRelease,
      "/ada/demo/releases/edit/v1/rc",
      data(release({ draft: true })),
    );
    expect(draft).toContain("Publish release");
  });
});
