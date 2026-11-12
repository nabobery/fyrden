// Release assets in the web Worker: the download route asks the API for the
// asset its path names (a slashed tag, a `.data` name, a trailing slash, each
// segment encoded again), passes ranges, conditions and HEAD on, and sends a
// signed-out browser to sign in; the upload route begins, completes and ends
// sessions through the binding, with the browser's completion key and only the
// fields it names; the pages link each asset to the web route, never the
// API's own URL, and offer the uploader only to writers.

import { describe, expect, it } from "vitest";
import { assetDownload, formatBytes } from "../app/lib/releases.js";
import { default as ReleasePage } from "../app/routes/repo.release.js";
import { loader as downloadLoader } from "../app/routes/repo.release-download.js";
import { default as EditRelease } from "../app/routes/repo.release-edit.js";
import { action as uploadsAction } from "../app/routes/repo.release-uploads.js";
import {
  default as Releases,
  action as releasesAction,
  loader as releasesLoader,
} from "../app/routes/repo.releases.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";
import { api, repo, VIEWER } from "./helpers/pulls.js";
import { escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo" };
const ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const KEY = "4f0c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f";

const ASSET = {
  id: 3,
  name: "a b%.zip",
  content_type: "application/zip",
  size: 3 * 1024 * 1024,
  uploader: { id: VIEWER },
  created_at: 1,
  updated_at: 1,
  download_url: "https://api.example/api/repos/ada/demo/releases/download/v1/rc/a%20b%25.zip",
};

const release = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  tag_name: "v1/rc",
  name: "One",
  body: null,
  draft: false,
  prerelease: false,
  author: { id: VIEWER },
  tag_sha: "a".repeat(40),
  commit_sha: "a".repeat(40),
  current_tag_sha: null,
  tag_state: "current",
  published_at: 5,
  created_at: 1,
  updated_at: 5,
  version: 2,
  assets: [ASSET],
  ...overrides,
});

/** A download through the route, with the API answering `reply`. */
async function download(path: string, init: RequestInit = {}, reply = () => new Response("x")) {
  const { context, calls } = fakeApi(reply);
  const request = new Request(`${ORIGIN}${path}`, init);
  const answer = await downloadLoader({
    request,
    context,
    params: { ...params, "*": "" },
  } as never).catch((thrown: unknown) => thrown);
  return { answer: answer as Response, call: calls[0] };
}

describe("an asset's download", () => {
  it("asks the API for the asset its path names, each segment encoded again", async () => {
    for (const [path, api] of [
      [
        "/ada/demo/releases/download/v1/rc/a.zip",
        "/api/repos/ada/demo/releases/download/v1/rc/a.zip",
      ],
      // An encoded slash in the tag is a slash, as the API takes it.
      [
        "/ada/demo/releases/download/v1%2Frc/a%20b%25%23%3F.zip",
        "/api/repos/ada/demo/releases/download/v1/rc/a%20b%25%23%3F.zip",
      ],
      // A `.data` name arrives with the slash its redirect added.
      [
        "/ada/demo/releases/download/v1/notes.data/",
        "/api/repos/ada/demo/releases/download/v1/notes.data",
      ],
    ] as const) {
      const { call } = await download(path);
      expect(new URL(call?.url ?? "").pathname, path).toBe(api);
      expect(call?.headers.get("X-Fyrden-Session")).toBe("1");
    }
  });

  it("is not found without a tag and a name, or with a bad escape, asking nothing", async () => {
    for (const path of [
      "/ada/demo/releases/download/a.zip",
      "/ada/demo/releases/download/v1/",
      "/ada/demo/releases/download/v1/%E0%A4%A.zip",
    ]) {
      const { answer, call } = await download(path);
      expect(
        answer.status ?? (answer as unknown as { init: { status: number } }).init?.status,
        path,
      ).toBe(404);
      expect(call).toBeUndefined();
    }
  });

  it("passes a range, its conditions and HEAD on, and the partial answer back", async () => {
    const { answer, call } = await download(
      "/ada/demo/releases/download/v1/a.zip",
      {
        method: "HEAD",
        headers: { Range: "bytes=0-1", "If-Range": '"o"', "If-None-Match": '"o"' },
      },
      () =>
        new Response(null, {
          status: 206,
          headers: { "Content-Range": "bytes 0-1/9", "Accept-Ranges": "bytes", ETag: '"o"' },
        }),
    );
    expect(call?.method).toBe("HEAD");
    expect(call?.headers.get("Range")).toBe("bytes=0-1");
    expect(call?.headers.get("If-Range")).toBe('"o"');
    expect(call?.headers.get("If-None-Match")).toBe('"o"');
    expect(answer.status).toBe(206);
    expect(answer.headers.get("Content-Range")).toBe("bytes 0-1/9");
    expect(answer.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("sends a signed-out browser to sign in and back", async () => {
    const { answer } = await download("/ada/demo/releases/download/v1/a.zip", {}, () =>
      json({ code: "invalid_token" }, 401),
    );
    expect(answer.status).toBe(302);
    expect(answer.headers.get("Location")).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/ada/demo/releases/download/v1/a.zip")}`,
    );
  });

  it("passes a refusal on without the API's body", async () => {
    const { answer } = await download("/ada/demo/releases/download/v1/a.zip", {}, () =>
      json({ code: "asset_not_found", detail: "No such asset." }, 404),
    );
    expect(answer.status).toBe(404);
    expect(await answer.text()).toBe("");
  });
});

/** A same-origin JSON post to the upload route. */
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/ada/demo/releases/uploads`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: "__Host-fyrden_session=s", ...headers },
    body: JSON.stringify(body),
  });

async function upload(body: unknown, reply = () => json({ id: ID }), headers = {}) {
  const { context, calls } = fakeApi(reply);
  const answer = (await uploadsAction({
    request: post(body, headers),
    context,
    params,
  } as never).catch((thrown: unknown) => thrown)) as Response;
  return { answer, calls };
}

describe("an upload's session", () => {
  it("begins with only the fields it names, and the browser's own key", async () => {
    const { answer, calls } = await upload(
      {
        intent: "begin",
        release_id: 7,
        name: "a.zip",
        size: 12,
        content_type: "application/zip",
        replace: true,
        key: KEY,
        extra: "dropped",
      },
      () => json({ id: ID }, 201),
    );
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ id: ID });
    const [call] = calls;
    expect(`${call?.method} ${new URL(call?.url ?? "").pathname}`).toBe(
      "POST /api/repos/ada/demo/releases/7/assets/uploads",
    );
    expect(await call?.json()).toEqual({
      name: "a.zip",
      size: 12,
      content_type: "application/zip",
      replace: true,
    });
    expect(call?.headers.get("Idempotency-Key")).toBe(KEY);
  });

  it("completes with the browser's own key, and passes the API's answer back as it came", async () => {
    const parts = [{ part_number: 1, etag: "e1" }];
    const { answer, calls } = await upload(
      { intent: "complete", upload_id: ID, parts, key: KEY },
      () => json({ code: "quota_unavailable", detail: "later" }, 503, { "Retry-After": "2" }),
    );
    expect(answer.status).toBe(503);
    expect(answer.headers.get("Retry-After")).toBe("2");
    expect(await answer.json()).toEqual({ code: "quota_unavailable", detail: "later" });
    const [call] = calls;
    expect(`${call?.method} ${new URL(call?.url ?? "").pathname}`).toBe(
      `POST /api/repos/ada/demo/releases/assets/uploads/${ID}/complete`,
    );
    expect(call?.headers.get("Idempotency-Key")).toBe(KEY);
    expect(await call?.json()).toEqual({ parts });
  });

  it("ends a session", async () => {
    const { calls } = await upload({ intent: "abort", upload_id: ID });
    expect(`${calls[0]?.method} ${new URL(calls[0]?.url ?? "").pathname}`).toBe(
      `DELETE /api/repos/ada/demo/releases/assets/uploads/${ID}`,
    );
  });

  it("refuses, asking nothing, a key that isn't a UUID, an id that isn't one, and anything else", async () => {
    for (const body of [
      { intent: "complete", upload_id: ID, parts: [], key: "k" },
      { intent: "complete", upload_id: ID, parts: [], key: `${KEY}\r\nX: 1` },
      { intent: "complete", upload_id: "../../x", parts: [], key: KEY },
      { intent: "abort", upload_id: `${ID}/../x` },
      { intent: "begin", release_id: "7/../../x", name: "a", size: 1, replace: false, key: KEY },
      { intent: "begin", release_id: 7, name: "a", size: "1", replace: false, key: KEY },
      { intent: "begin", release_id: 7, name: "a", size: 1, replace: false },
      { intent: "begin", release_id: 7, name: "a", size: 1, replace: false, key: "k" },
      { intent: "delete" },
      [],
    ]) {
      const { answer, calls } = await upload(body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(calls).toEqual([]);
    }
  });

  it("takes a post only from this origin's own pages", async () => {
    const { answer, calls } = await upload({ intent: "abort", upload_id: ID }, undefined, {
      Origin: "https://evil.example",
    });
    expect((answer as unknown as { init: { status: number } }).init?.status ?? answer.status).toBe(
      403,
    );
    expect(calls).toEqual([]);
  });
});

describe("a release's assets on its pages", () => {
  const loaded = (permissions: Record<string, boolean>, overrides = {}) => ({
    repo: { ...repo, permissions },
    release: release(overrides),
    at: params,
    origin: ORIGIN,
    viewer: VIEWER,
  });
  const WRITE = { admin: false, maintain: false, push: true, triage: true, pull: true };
  const READ = { admin: false, maintain: false, push: false, triage: false, pull: true };

  it("links each asset to its download on this site, by tag and name, never the API's URL", () => {
    const html = renderPage(ReleasePage, "/ada/demo/releases/tag/v1/rc", loaded(READ));
    const href = assetDownload("ada", "demo", "v1/rc", "a b%.zip");
    expect(href).toBe("/ada/demo/releases/download/v1/rc/a%20b%25.zip");
    expect(html).toContain(`href="${href}"`);
    expect(html).not.toContain("api.example");
    expect(html).toContain("3.0 MiB");
  });

  it("shows a hostile name as text", () => {
    const html = renderPage(
      ReleasePage,
      "/ada/demo/releases/tag/v1/rc",
      loaded(READ, { assets: [{ ...ASSET, name: HOSTILE }] }),
    );
    expect(html).toContain(escaped(HOSTILE));
  });

  it("says when there are none", () => {
    expect(
      renderPage(ReleasePage, "/ada/demo/releases/tag/v1/rc", loaded(READ, { assets: [] })),
    ).toContain("No assets.");
  });

  it("offers the uploader to a writer only, naming the API for a browser without scripts", () => {
    const writer = renderPage(EditRelease, "/ada/demo/releases/edit/v1/rc", loaded(WRITE));
    expect(writer).toContain("Upload assets");
    expect(writer).toContain("<noscript>");
    expect(writer).toContain("/api/repos/ada/demo/releases/1/assets/uploads");
    const reader = renderPage(EditRelease, "/ada/demo/releases/edit/v1/rc", loaded(READ));
    expect(reader).not.toContain("Upload assets");
    expect(reader).toContain(assetDownload("ada", "demo", "v1/rc", "a b%.zip"));
  });

  it("reads sizes in binary units", () => {
    expect([0, 1, 1023, 1024, 1536, 5 * 1024 ** 2, 2 * 1024 ** 3].map(formatBytes)).toEqual([
      "0 bytes",
      "1 byte",
      "1023 bytes",
      "1.0 KiB",
      "1.5 KiB",
      "5.0 MiB",
      "2.0 GiB",
    ]);
  });
});

describe("retained files of replaced and deleted assets", () => {
  const ADMIN = { admin: true, maintain: true, push: true, triage: true, pull: true };
  const MAINTAIN = { admin: false, maintain: true, push: true, triage: true, pull: true };
  const RETAINED = { objects: 2, bytes: 3 * 1024 * 1024, next_purge_at: 9 };
  const listed = (permissions: Record<string, boolean> | undefined) =>
    api({
      "GET /api/repos/ada/demo": () => json({ ...repo, ...(permissions && { permissions }) }),
      "GET /api/repos/ada/demo/releases": () => json({ releases: [], next_cursor: null }),
      "GET /api/repos/ada/demo/releases/retained": () => json(RETAINED),
    });
  const load = async (permissions: Record<string, boolean> | undefined) => {
    const { context, calls } = listed(permissions);
    const data = await releasesLoader({
      request: new Request(`${ORIGIN}/ada/demo/releases`, {
        headers: { Cookie: "__Host-fyrden_session=s" },
      }),
      context,
      params,
    } as never);
    const asked = calls.some((c) => new URL(c.url).pathname.endsWith("/releases/retained"));
    return { data, asked };
  };

  it("are shown, with a purge, to an admin only; a missing permission means no", async () => {
    const admin = await load(ADMIN);
    expect(admin.asked).toBe(true);
    expect(admin.data.retained).toEqual(RETAINED);
    for (const permissions of [MAINTAIN, undefined]) {
      const other = await load(permissions);
      expect(other.asked).toBe(false);
      expect(other.data.retained).toBeNull();
    }
    const html = renderPage(Releases, "/ada/demo/releases", admin.data);
    expect(html).toContain("2 files of replaced or deleted assets, 3.0 MiB");
    expect(html).toContain("Purge retained files");
    expect(html).toContain("A restore can&#x27;t bring them back");
    const plain = renderPage(Releases, "/ada/demo/releases", (await load(MAINTAIN)).data);
    expect(plain).not.toContain("Purge");
  });

  it("offers no purge when nothing is kept", async () => {
    const data = {
      ...(await load(ADMIN)).data,
      retained: { objects: 0, bytes: 0, next_purge_at: null },
    };
    const html = renderPage(Releases, "/ada/demo/releases", data);
    expect(html).toContain("No files of replaced or deleted assets are kept.");
    expect(html).not.toContain("Purge retained files");
  });

  /** The purge posted from a page drawn for `viewer`, the session answering `session`. */
  const purge = async (
    reply: () => Response,
    {
      origin = ORIGIN,
      viewer = VIEWER,
      session = () => json({ user: { id: VIEWER, handle: "ada" } }),
    }: { origin?: string; viewer?: string; session?: () => Response } = {},
  ) => {
    const { context, calls } = fakeApi((request) =>
      new URL(request.url).pathname === "/auth/session" ? session() : reply(),
    );
    const request = formPost("/ada/demo/releases", { intent: "purge", viewer });
    if (origin !== ORIGIN) request.headers.set("Origin", origin);
    const answer = await releasesAction({ request, context, params } as never).catch(
      (thrown: unknown) => thrown,
    );
    const changes = calls.filter((c) => !new URL(c.url).pathname.startsWith("/auth/"));
    return { answer, changes };
  };

  it("purges through the API, and says what it covers or why not", async () => {
    const started = await purge(() => json({ state: "purging", objects: 2, bytes: 5 }, 202));
    expect(started.answer).toEqual({ purging: { objects: 2, bytes: 5 } });
    expect(`${started.changes[0]?.method} ${new URL(started.changes[0]?.url ?? "").pathname}`).toBe(
      "POST /api/repos/ada/demo/releases/retained/purge",
    );
    const refused = await purge(() =>
      json({ code: "repo_transferring", detail: "The repository is moving." }, 409),
    );
    expect(refused.answer).toEqual({ error: "The repository is moving." });
    const elsewhere = await purge(() => json({}, 202), { origin: "https://evil.example" });
    expect(elsewhere.changes).toEqual([]);
  });

  it("sends nothing for a viewer other than the page's, or a session it can't check", async () => {
    const other = await purge(() => json({}, 202), { viewer: "usr_someone_else" });
    expect(other.answer).toEqual({ error: expect.stringMatching(/signed in as someone else/) });
    expect(other.changes).toEqual([]);
    const unchecked = await purge(() => json({}, 202), {
      session: () => new Response("down", { status: 503 }),
    });
    expect(unchecked.answer).toEqual({ error: expect.stringMatching(/could not be checked/) });
    expect(unchecked.changes).toEqual([]);
    const loaded = await load(ADMIN);
    expect(loaded.data.viewer).toBe(VIEWER);
    expect(renderPage(Releases, "/ada/demo/releases", loaded.data)).toContain(
      `name="viewer" value="${VIEWER}"`,
    );
  });
});
