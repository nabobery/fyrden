// Who may use the two release asset routes outside the registry, a part's
// PUT and a download: the same checks a registry operation gets, the
// repository's own authorization after them, and a draft's asset kept from
// readers.
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { api, user } from "./helpers/api.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { begin, bytesOf, draft, putPart, upload } from "./helpers/release-assets.js";
import { type ReleaseRepo, releaseRepo } from "./helpers/releases.js";

const fx = inject("gcFixtures");

let r: ReleaseRepo;
let release: number;

beforeEach(async () => {
  r = await releaseRepo(fx.repo);
  release = await draft(r, "v-auth");
});

const download = (token: string) =>
  exports.default.fetch(
    `${ORIGIN}/api/repos/${r.owner.handle}/${r.name}/releases/download/v-auth/a.bin`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

describe("a part's PUT", () => {
  it("needs contents:write, the repository, and the session's own principal", async () => {
    const begun = await begin(r, release, { name: "a", size: 4 });
    const url = begun.body.parts_url;
    const reader = await scopedToken(r.owner.principalId, ["contents:read"]);
    const read = await putPart(url, 1, bytesOf(4), reader);
    expect([read.status, read.body.code]).toEqual([403, "missing_permission"]);
    const stranger = await user();
    expect((await putPart(url, 1, bytesOf(4), stranger.token)).status).toBe(404);
    const writer = await scopedToken(r.owner.principalId, ["contents:write"]);
    // Another token of the same principal may send parts; only completing is the beginner's.
    expect((await putPart(url, 1, bytesOf(4), writer)).status).toBe(200);
  });

  it("is refused to a collaborator who isn't the session's principal", async () => {
    const begun = await begin(r, release, { name: "a", size: 4 });
    const other = await user();
    await api("PUT", `${r.path}/collaborators/${other.handle}`, r.owner.token, {
      permission: "push",
    });
    const put = await putPart(begun.body.parts_url, 1, bytesOf(4), other.token);
    expect([put.status, put.body.code]).toEqual([404, "upload_not_found"]);
  });
});

describe("a download", () => {
  it("keeps a draft's asset from a token that only reads", async () => {
    await upload(r, release, "a.bin", bytesOf(4));
    const reader = await scopedToken(r.owner.principalId, ["contents:read"]);
    expect((await download(reader)).status).toBe(404);
    expect((await download(r.owner.token)).status).toBe(200);
  });

  it("is refused to a stranger as if the repository weren't there", async () => {
    await upload(r, release, "a.bin", bytesOf(4));
    const stranger = await user();
    const res = await download(stranger.token);
    expect(res.status).toBe(404);
    expect((await res.json<{ code: string }>()).code).toBe("repo_not_found");
  });
});
