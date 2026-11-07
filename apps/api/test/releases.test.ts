// Releases through the API on the real app: a draft has no git state;
// publishing records the tag object and its peeled commit once and for all,
// racing a push by a synchronous recheck; a tag that moved during the peel
// answers a retryable 409 that leaves nothing behind.
import { MAX_RELEASES } from "@fyrden/domain";
import { oidFromHex } from "@fyrden/git-core";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { api, json } from "./helpers/api.js";
import { moveRef } from "./helpers/gc.js";
import { principalWithToken, scopedToken } from "./helpers/principals.js";
import { type ReleaseOut, type ReleaseRepo, releaseRepo, withKey } from "./helpers/releases.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("gcFixtures");
const refOf = (name: string) => fx.repo.refs.find((r) => r.name === name)?.oid as string;
const commitOids = new Set(fx.repo.commits.map((c) => c.oid));
const TAG = refOf("refs/tags/v1");
const MAIN = refOf("refs/heads/main");

let r: ReleaseRepo;
const call = <T = ReleaseOut>(
  method: string,
  tail: string,
  body?: unknown,
  token = r.owner.token,
) => json<T>(api(method, `${r.path}/releases${tail}`, token, body));

beforeEach(async () => {
  r = await releaseRepo(fx.repo);
});

const rows = (table: string) =>
  inRepo(
    r.stub,
    ({ git }) =>
      git.context.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n,
  );

const eventTypes = () =>
  inRepo(r.stub, ({ git }) =>
    git.context.storage.sql
      .exec<{ type: string }>(
        "SELECT json_extract(event, '$.type') AS type FROM outbox ORDER BY source_seq",
      )
      .toArray()
      .map((e) => e.type)
      .filter((t) => t.startsWith("release.")),
  );

describe("a draft", () => {
  it("has no git state and needs no tag", async () => {
    const made = await call("POST", "", { tag_name: "not-pushed", draft: true, name: "Soon" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      tag_name: "not-pushed",
      name: "Soon",
      draft: true,
      prerelease: false,
      tag_sha: null,
      commit_sha: null,
      published_at: null,
      tag_state: null,
      assets: [],
      author: { id: r.owner.principalId },
    });
  });

  it("refuses a tag git refuses, at the draft", async () => {
    for (const tag_name of ["v1..0", "v1 rc", "v1.lock", "a//b", "/v1", "v1/"]) {
      const made = await call("POST", "", { tag_name, draft: true });
      expect([made.status, made.body.code], tag_name).toEqual([422, "invalid_tag_name"]);
    }
  });

  it("can change its tag, and two releases can't share one", async () => {
    const a = await call("POST", "", { tag_name: "a", draft: true });
    await call("POST", "", { tag_name: "b", draft: true });
    expect((await call("PATCH", `/${a.body.id}`, { tag_name: "c" })).body.tag_name).toBe("c");
    const taken = await call("PATCH", `/${a.body.id}`, { tag_name: "b" });
    expect([taken.status, taken.body.code]).toEqual([422, "release_exists"]);
    const again = await call("POST", "", { tag_name: "b", draft: true });
    expect([again.status, again.body.code]).toEqual([422, "release_exists"]);
  });

  it("stops at the limit of a repository", async () => {
    await inRepo(r.stub, ({ git }) => {
      for (let i = 0; i < MAX_RELEASES; i++)
        git.context.storage.sql.exec(
          `INSERT INTO releases (tag_name, draft, prerelease, author, version, created_at, updated_at)
           VALUES (?, 1, 0, 'u', 1, 1, 1)`,
          `t${i}`,
        );
    });
    const over = await call("POST", "", { tag_name: "one-more", draft: true });
    expect([over.status, over.body.code]).toEqual([422, "too_many_releases"]);
  });
});

describe("publishing", () => {
  it("records an annotated tag's object and the commit it peels to", async () => {
    const made = await call("POST", "", { tag_name: "v1" });
    expect(made.status).toBe(201);
    expect(TAG).not.toBe(made.body.commit_sha);
    expect(commitOids.has(made.body.commit_sha as string)).toBe(true);
    expect(made.body).toMatchObject({ draft: false, tag_sha: TAG, tag_state: "current" });
    expect(made.body.published_at).toEqual(expect.any(Number));
  });

  it("records a lightweight tag as its own commit", async () => {
    await moveRef(r.stub, "refs/tags/light", null, MAIN);
    const made = await call("POST", "", { tag_name: "light" });
    expect(made.body).toMatchObject({ tag_sha: MAIN, commit_sha: MAIN });
  });

  it("publishes a draft, once", async () => {
    const draft = await call("POST", "", { tag_name: "v1", draft: true });
    const published = await call("PATCH", `/${draft.body.id}`, { draft: false });
    expect(published.body).toMatchObject({ draft: false, tag_sha: TAG });
    expect(await eventTypes()).toEqual([
      "release.created",
      "release.published",
      "release.released",
    ]);
    const again = await call("PATCH", `/${draft.body.id}`, { draft: false });
    expect(again.status).toBe(200);
    expect(again.body.published_at).toBe(published.body.published_at);
  });

  it("refuses without the tag, naming it", async () => {
    const made = await call("POST", "", { tag_name: "absent" });
    expect([made.status, made.body.code]).toEqual([422, "tag_not_found"]);
    expect(await rows("releases")).toBe(0);
  });

  it("refuses a tag of something other than a commit", async () => {
    const blob = fx.all.find((o) => !commitOids.has(o) && o !== TAG) as string;
    await moveRef(r.stub, "refs/tags/of-blob", null, blob);
    const made = await call("POST", "", { tag_name: "of-blob" });
    expect([made.status, made.body.code]).toEqual([422, "tag_not_a_commit"]);
  });

  it("answers a retryable 409 when the tag moved during the peel; the same key then records the new value", async () => {
    const draft = await call("POST", "", { tag_name: "t", draft: true });
    await moveRef(r.stub, "refs/tags/t", null, MAIN);
    await inRepo(r.stub, (repo) => {
      repo.changeHooks.beforeChange = async (changing) => {
        if (changing !== "updateRelease") return;
        repo.changeHooks = {};
        moveDirect(repo.git, "refs/tags/t", MAIN, fx.side);
      };
    });
    const key = crypto.randomUUID();
    const send = () =>
      json<ReleaseOut>(
        withKey("PATCH", `${r.path}/releases/${draft.body.id}`, r.owner.token, key, {
          draft: false,
        }),
      );
    const moved = await send();
    expect([moved.status, moved.body.code]).toEqual([409, "tag_moving"]);
    expect((await call("GET", `/${draft.body.id}`)).body).toMatchObject({
      draft: true,
      tag_sha: null,
    });
    const retried = await send();
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ draft: false, tag_sha: fx.side, commit_sha: fx.side });
  });

  it("create and publish in one call leaves nothing behind a 409, and the retry makes one release", async () => {
    await moveRef(r.stub, "refs/tags/t", null, MAIN);
    await inRepo(r.stub, (repo) => {
      repo.changeHooks.beforeChange = async (changing) => {
        if (changing !== "createRelease") return;
        repo.changeHooks = {};
        moveDirect(repo.git, "refs/tags/t", MAIN, fx.side);
      };
    });
    const key = crypto.randomUUID();
    const send = () =>
      json<ReleaseOut>(
        withKey("POST", `${r.path}/releases`, r.owner.token, key, { tag_name: "t" }),
      );
    const moved = await send();
    expect([moved.status, moved.body.code]).toEqual([409, "tag_moving"]);
    expect(await rows("releases")).toBe(0);
    expect(await eventTypes()).toEqual([]);
    const retried = await send();
    expect(retried.status).toBe(201);
    expect(retried.body).toMatchObject({ draft: false, tag_sha: fx.side });
    expect(await rows("releases")).toBe(1);
    expect(await eventTypes()).toEqual([
      "release.created",
      "release.published",
      "release.released",
    ]);
  });

  it("answers tag_not_found when the tag was deleted during the peel, changing nothing", async () => {
    const draft = await call("POST", "", { tag_name: "t", draft: true });
    await moveRef(r.stub, "refs/tags/t", null, MAIN);
    await inRepo(r.stub, (repo) => {
      repo.changeHooks.beforeChange = async (changing) => {
        if (changing !== "updateRelease") return;
        repo.changeHooks = {};
        moveDirect(repo.git, "refs/tags/t", MAIN, null);
      };
    });
    const gone = await call("PATCH", `/${draft.body.id}`, { draft: false });
    expect([gone.status, gone.body.code]).toEqual([422, "tag_not_found"]);
    expect((await call("GET", `/${draft.body.id}`)).body.draft).toBe(true);
  });
});

describe("a published release", () => {
  it("can't go back to draft or change its tag, but its title, notes and flag can change", async () => {
    const made = await call("POST", "", { tag_name: "v1" });
    const at = `/${made.body.id}`;
    for (const patch of [{ draft: true }, { tag_name: "other" }]) {
      const refused = await call("PATCH", at, patch);
      expect([refused.status, refused.body.code]).toEqual([422, "release_published"]);
    }
    const edited = await call("PATCH", at, { name: "One", body: "Notes", prerelease: true });
    expect(edited.body).toMatchObject({ name: "One", body: "Notes", prerelease: true });
    expect(edited.body.version).toBe(made.body.version + 1);
    expect(edited.body.tag_sha).toBe(TAG);
  });

  it("shows what became of its tag, while what it recorded stays", async () => {
    await moveRef(r.stub, "refs/tags/t", null, MAIN);
    const made = await call("POST", "", { tag_name: "t" });
    const at = `/${made.body.id}`;
    expect(made.body).toMatchObject({ tag_state: "current", current_tag_sha: null });
    await moveRef(r.stub, "refs/tags/t", MAIN, fx.side);
    expect((await call("GET", at)).body).toMatchObject({
      tag_state: "moved",
      tag_sha: MAIN,
      commit_sha: MAIN,
      current_tag_sha: fx.side,
    });
    await moveRef(r.stub, "refs/tags/t", fx.side, null);
    expect((await call("GET", at)).body).toMatchObject({
      tag_state: "deleted",
      tag_sha: MAIN,
      current_tag_sha: null,
    });
    await moveRef(r.stub, "refs/tags/t", null, MAIN);
    expect((await call("GET", at)).body.tag_state).toBe("current");
    await moveRef(r.stub, "refs/tags/t", MAIN, null);
    await moveRef(r.stub, "refs/tags/t", null, fx.side);
    expect((await call("GET", at)).body.tag_state).toBe("moved");
  });
});

describe("reading", () => {
  it("reaches each route, on the real app, whatever the tag's slashes", async () => {
    await moveRef(r.stub, "refs/tags/v2/rc", null, MAIN);
    const made = await call("POST", "", { tag_name: "v2/rc" });
    expect((await call("GET", "/latest")).body.id).toBe(made.body.id);
    expect((await call("GET", "/tags/v2/rc")).body.id).toBe(made.body.id);
    expect((await call("GET", "/tags/v2%2Frc")).body.id).toBe(made.body.id);
    expect((await call("GET", `/${made.body.id}`)).body.id).toBe(made.body.id);
    expect((await call("GET", "/9999")).body.code).toBe("release_not_found");
    expect((await call("GET", "/tags/none")).body.code).toBe("release_not_found");
    expect((await call("GET", "/not-a-number")).status).toBe(422);
  });

  it("takes the newest published release that isn't a prerelease as latest", async () => {
    expect((await call("GET", "/latest")).body.code).toBe("release_not_found");
    await moveRef(r.stub, "refs/tags/pre", null, MAIN);
    const first = await call("POST", "", { tag_name: "v1" });
    await call("POST", "", { tag_name: "pre", prerelease: true });
    await call("POST", "", { tag_name: "later-draft", draft: true });
    expect((await call("GET", "/latest")).body.id).toBe(first.body.id);
  });

  it("lists a full page and its lookahead, past SQLite's bound values per query", async () => {
    await inRepo(r.stub, ({ git }) => {
      const oid = oidFromHex(MAIN);
      for (let i = 0; i < 101; i++)
        git.context.storage.sql.exec(
          `INSERT INTO releases (tag_name, draft, prerelease, author, tag_oid, commit_oid,
             published_at, version, created_at, updated_at)
           VALUES (?, 0, 0, 'u', ?, ?, ?, 1, 1, 1)`,
          `t${i}`,
          oid,
          oid,
          i + 1,
        );
    });
    const page = await call<{ releases: ReleaseOut[]; next_cursor: string | null }>(
      "GET",
      "?per_page=100",
    );
    expect(page.status).toBe(200);
    expect(page.body.releases).toHaveLength(100);
    expect(page.body.next_cursor).not.toBeNull();
    expect(page.body.releases[0]).toMatchObject({ tag_name: "t100", tag_state: "deleted" });
  });

  it("shows drafts only to those who can write, and pages the rest", async () => {
    const draft = await call("POST", "", { tag_name: "d", draft: true });
    await moveRef(r.stub, "refs/tags/x", null, MAIN);
    await moveRef(r.stub, "refs/tags/y", null, MAIN);
    await call("POST", "", { tag_name: "v1" });
    await call("POST", "", { tag_name: "x" });
    await call("POST", "", { tag_name: "y" });
    const reader = await scopedToken(r.owner.principalId, ["contents:read"]);
    const list = (query: string, token?: string) =>
      call<{ releases: ReleaseOut[]; next_cursor: string | null }>(
        "GET",
        query,
        undefined,
        token ?? r.owner.token,
      );
    const all = await list("?per_page=2");
    expect(all.body.releases.map((x) => x.tag_name)).toEqual(["d", "y"]);
    const rest = await list(`?per_page=2&cursor=${all.body.next_cursor}`);
    expect(rest.body.releases.map((x) => x.tag_name)).toEqual(["x", "v1"]);
    expect(rest.body.next_cursor).toBeNull();
    const seen = await list("", reader);
    expect(seen.body.releases.map((x) => x.tag_name)).toEqual(["y", "x", "v1"]);
    expect((await call("GET", `/${draft.body.id}`, undefined, reader)).status).toBe(404);
    expect((await call("GET", "/tags/d", undefined, reader)).status).toBe(404);
    const outsider = await principalWithToken("user", "pat");
    expect((await call("GET", "", undefined, outsider.token)).status).toBe(404);
  });
});

describe("deleting", () => {
  const gcDue = () => inRepo(r.stub, ({ git }) => git.jobs.get("gc")?.state ?? null);

  it("asks for a collection only of a published release", async () => {
    const draft = await call("POST", "", { tag_name: "d", draft: true });
    expect((await call("DELETE", `/${draft.body.id}`)).status).toBe(200);
    expect(await gcDue()).toBeNull();
    const made = await call("POST", "", { tag_name: "v1" });
    expect((await call("DELETE", `/${made.body.id}`)).body).toEqual({
      id: made.body.id,
      state: "deleted",
    });
    expect(await gcDue()).toBe("queued");
    expect(await rows("releases")).toBe(0);
    expect((await call("GET", `/${made.body.id}`)).status).toBe(404);
  });

  it("frees the tag name", async () => {
    const made = await call("POST", "", { tag_name: "v1" });
    await call("DELETE", `/${made.body.id}`);
    expect((await call("POST", "", { tag_name: "v1", draft: true })).status).toBe(201);
  });
});

/** Moves one ref on the object's own storage, for use inside a hook already running there. */
function moveDirect(
  git: Parameters<Parameters<typeof inRepo>[1]>[0]["git"],
  name: string,
  from: string | null,
  to: string | null,
) {
  const result = git.refStore.commitSync({
    addPacks: [],
    removePacks: [],
    refUpdates: [
      {
        name,
        oldOid: from === null ? null : oidFromHex(from),
        newOid: to === null ? null : oidFromHex(to),
      },
    ],
    expectedVersion: git.refStore.state().version,
  });
  if (!result.ok) throw new Error(`ref update failed: ${JSON.stringify(result)}`);
}
