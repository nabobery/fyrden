// Downloading a release asset through the API on the real app: by tag and
// name, authorized before anything conditional, always an attachment of
// `application/octet-stream`, with ranges and conditionals answered from
// rows, and HEAD reading nothing from R2.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { api, json } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { bytesOf, draft, objectIds, upload } from "./helpers/release-assets.js";
import { type ReleaseRepo, releaseRepo } from "./helpers/releases.js";

const fx = inject("gcFixtures");

let r: ReleaseRepo;
let release: number;
const BYTES = bytesOf(100, 7);

beforeEach(async () => {
  r = await releaseRepo(fx.repo);
  release = await draft(r, "v1/rc");
  await upload(r, release, "app.zip", BYTES);
});

const download = (
  tail: string,
  headers: Record<string, string> = {},
  token = r.owner.token,
  method = "GET",
) =>
  exports.default.fetch(
    `${ORIGIN}/api/repos/${r.owner.handle}/${r.name}/releases/download/${tail}`,
    { method, headers: { Authorization: `Bearer ${token}`, ...headers } },
  );

const bodyOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe("a download", () => {
  it("sends the whole file as an attachment with every safety header", async () => {
    const res = await download("v1/rc/app.zip");
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual(BYTES);
    const { assets } = await objectIds(r.stub);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="app.zip"; filename*=UTF-8''app.zip`,
      "content-length": "100",
      "accept-ranges": "bytes",
      etag: `"${assets[0]}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "x-frame-options": "DENY",
      "cross-origin-resource-policy": "same-origin",
      "cache-control": "private, no-store",
    });
    expect(res.headers.get("last-modified")).toMatch(/GMT$/);
  });

  it("reaches the same asset with the tag's slash encoded", async () => {
    expect((await download("v1%2Frc/app.zip")).status).toBe(200);
  });

  it("finds the name folded, and refuses an empty or missing one", async () => {
    expect((await download("v1/rc/APP.zip")).status).toBe(200);
    for (const tail of ["v1/rc/", "v1/rc/other.zip", "app.zip", "v2/app.zip"]) {
      const res = await download(tail);
      expect(res.status, tail).toBe(404);
    }
  });

  it("sends each form of range, and 416 for one past the end", async () => {
    const part = await download("v1/rc/app.zip", { Range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(part.headers.get("content-length")).toBe("10");
    expect(await bodyOf(part)).toEqual(BYTES.subarray(10, 20));
    const open = await download("v1/rc/app.zip", { Range: "bytes=95-" });
    expect(await bodyOf(open)).toEqual(BYTES.subarray(95));
    const suffix = await download("v1/rc/app.zip", { Range: "bytes=-3" });
    expect(await bodyOf(suffix)).toEqual(BYTES.subarray(97));
    const past = await download("v1/rc/app.zip", { Range: "bytes=100-" });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */100");
    expect(await past.text()).toBe("");
  });

  it("answers conditionals from rows: 304 by tag and date, 412 both ways", async () => {
    const first = await download("v1/rc/app.zip");
    const etag = first.headers.get("etag") as string;
    const lastModified = first.headers.get("last-modified") as string;
    await first.arrayBuffer();
    expect((await download("v1/rc/app.zip", { "If-None-Match": etag })).status).toBe(304);
    expect((await download("v1/rc/app.zip", { "If-Modified-Since": lastModified })).status).toBe(
      304,
    );
    expect((await download("v1/rc/app.zip", { "If-Match": '"other"' })).status).toBe(412);
    expect(
      (await download("v1/rc/app.zip", { "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" }))
        .status,
    ).toBe(412);
  });

  it("resumes by its tag, and sends the whole file when the tag isn't its own", async () => {
    const first = await download("v1/rc/app.zip");
    const etag = first.headers.get("etag") as string;
    await first.arrayBuffer();
    const resumed = await download("v1/rc/app.zip", { Range: "bytes=50-", "If-Range": etag });
    expect(resumed.status).toBe(206);
    await resumed.arrayBuffer();
    const changed = await download("v1/rc/app.zip", { Range: "bytes=50-", "If-Range": '"old"' });
    expect(changed.status).toBe(200);
    expect(await bodyOf(changed)).toEqual(BYTES);
  });

  it("answers HEAD with the headers and no body, ignoring a range", async () => {
    const res = await download("v1/rc/app.zip", { Range: "bytes=0-9" }, r.owner.token, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("100");
    expect(await res.text()).toBe("");
  });

  it("reads nothing from R2 for HEAD, 304, 412 or 416: they answer with the object gone", async () => {
    const first = await download("v1/rc/app.zip");
    const etag = first.headers.get("etag") as string;
    await first.arrayBuffer();
    const { assets } = await objectIds(r.stub);
    await env.ASSETS.delete(`release-assets/${r.id}/${assets[0]}`);
    expect((await download("v1/rc/app.zip", {}, r.owner.token, "HEAD")).status).toBe(200);
    expect((await download("v1/rc/app.zip", { "If-None-Match": etag })).status).toBe(304);
    expect((await download("v1/rc/app.zip", { "If-Match": '"other"' })).status).toBe(412);
    expect((await download("v1/rc/app.zip", { Range: "bytes=500-" })).status).toBe(416);
    // A GET does read it, and finds it gone.
    expect((await download("v1/rc/app.zip")).status).toBe(404);
  });

  it("keeps a draft's asset from a reader, as if it weren't there", async () => {
    const reader = await scopedToken(r.owner.principalId, ["contents:read"]);
    const res = await download("v1/rc/app.zip", {}, reader);
    expect(res.status).toBe(404);
    // Published, a reader gets it (the tag must exist: publish from the fixture's tag).
    const published = await json<{ id: number }>(
      api("POST", `${r.path}/releases`, r.owner.token, { tag_name: "v1" }),
    );
    await upload(r, published.body.id, "pub.zip", bytesOf(3));
    expect((await download("v1/pub.zip", {}, reader)).status).toBe(200);
  });

  it("refuses a stranger and a token without contents:read before anything else", async () => {
    const stranger = await (await import("./helpers/api.js")).user();
    expect((await download("v1/rc/app.zip", {}, stranger.token)).status).toBe(404);
    const issues = await scopedToken(r.owner.principalId, ["issues:read"]);
    const res = await download("v1/rc/app.zip", { "If-None-Match": "*" }, issues);
    expect(res.status).toBe(403);
  });

  it("encodes any name in its attachment header so nothing can be injected", async () => {
    await upload(r, release, 'evil"; x=1 é.svg', bytesOf(5));
    const res = await download(`v1/rc/${encodeURIComponent('evil"; x=1 é.svg')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="evil_; x=1 _.svg"; filename*=UTF-8''evil%22%3B%20x%3D1%20%C3%A9.svg`,
    );
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("answers asset_missing when the row's object is gone", async () => {
    const { assets } = await objectIds(r.stub);
    await env.ASSETS.delete(`release-assets/${r.id}/${assets[0]}`);
    const res = await json(download("v1/rc/app.zip"));
    expect([res.status, res.body.code]).toEqual([404, "asset_missing"]);
  });
});
