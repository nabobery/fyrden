// Forks as the API shows them: a fork names its parent, a repository lists
// the forks the caller can read, and two forks of one repository never see
// each other's commits, though their network shares packs.

import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";

const fx = inject("browseFixtures");

let owner: Who;
let target: PushTarget;
let base: string;

beforeAll(async () => {
  // Made through the API, so its account records collaborators.
  owner = await user();
  const created = await json<{ id: string; name: string }>(
    api("POST", "/user/repos", owner.token, { name: uniqueId("parent") }),
  );
  expect(created.status).toBe(201);
  const git = await scopedToken(owner.principalId, [], "git");
  target = {
    repo: {
      id: created.body.id,
      name: created.body.name,
      stub: env.REPO.getByName(created.body.id),
    },
    owner: { principalId: owner.principalId, token: git },
    path: `/${owner.handle}/${created.body.name}.git`,
  };
  const reply = await postPush(
    target,
    pushBody(
      fx.refs.map((r) => ({ old: ZERO, new: r.oid, ref: r.name })),
      { pack: fx.packHex },
    ),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  base = `/repos/${owner.handle}/${target.repo.name}`;
});

async function forkAs(who: Who, name = uniqueId("fork")) {
  const res = await json<{ id: string; name: string; fork: boolean; parent_id: string | null }>(
    api("POST", `${base}/forks`, who.token, { name }),
  );
  expect(res.status).toBe(201);
  return res.body;
}

describe("forks", () => {
  it("name their parent, and their parent is no fork", async () => {
    const fork = await forkAs(owner);
    expect(fork).toMatchObject({ fork: true, parent_id: target.repo.id });
    const read = await json(api("GET", `/repos/${owner.handle}/${fork.name}`, owner.token));
    expect(read.body).toMatchObject({ fork: true, parent_id: target.repo.id });
    expect((await json(api("GET", base, owner.token))).body).toMatchObject({
      fork: false,
      parent_id: null,
    });
  });

  it("are listed, oldest first and a page at a time, for the caller's own forks only", async () => {
    const reader = await user();
    await api("PUT", `${base}/collaborators/${reader.handle}`, owner.token, { permission: "pull" });
    const theirs = await forkAs(reader);
    const before = await json<{ repos: { name: string }[] }>(
      api("GET", `${base}/forks?per_page=100`, owner.token),
    );
    const mine = [await forkAs(owner), await forkAs(owner)];

    // Every page is full but the last, and none depends on forks the caller cannot see.
    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ per_page: "1" });
      if (cursor) query.set("cursor", cursor);
      const res = await json<{ repos: { name: string }[]; next_cursor: string | null }>(
        api("GET", `${base}/forks?${query}`, owner.token),
      );
      expect(res.status).toBe(200);
      pages.push(res.body.repos.map((r) => r.name));
      cursor = res.body.next_cursor;
    } while (cursor && pages.length < 50);
    for (const page of pages) expect(page).toHaveLength(1);
    const names = pages.flat();
    expect(names.slice(-2)).toEqual(mine.map((f) => f.name));
    expect(names).toHaveLength(before.body.repos.length + 2);
    expect(names).not.toContain(theirs.name);
    expect(
      (
        await json<{ repos: { name: string }[] }>(api("GET", `${base}/forks`, reader.token))
      ).body.repos.map((r) => r.name),
    ).toEqual([theirs.name]);
    // A token limited to one fork lists that one only, and nothing after it.
    const limited = await scopedToken(owner.principalId, [], "pat", [
      target.repo.id,
      mine[0]?.id as string,
    ]);
    const limitedPage = await json<{ repos: { name: string }[]; next_cursor: string | null }>(
      api("GET", `${base}/forks?per_page=1`, limited),
    );
    expect(limitedPage.body).toEqual({
      repos: [expect.objectContaining({ name: mine[0]?.name })],
      next_cursor: null,
    });
    // Without read access to the repository, nothing at all; a cursor it did not make, refused.
    const stranger = await user();
    expect((await api("GET", `${base}/forks`, stranger.token)).status).toBe(404);
    for (const bad of [
      "AAAA",
      btoa("12:rep_x"),
      btoa("9007199254740993:rep_01ABCDEFGHJKMNPQRSTVWXYZ01"),
    ])
      expect(
        (await json(api("GET", `${base}/forks?cursor=${bad}`, owner.token))).body,
      ).toMatchObject({
        code: "invalid_cursor",
      });
  });

  it("name their network's source, a fork of a fork too, only to a caller who can see it", async () => {
    const fork = await forkAs(owner);
    const path = `/repos/${owner.handle}/${fork.name}`;
    const grandchild = await json<{ name: string }>(
      api("POST", `${path}/forks`, owner.token, { name: uniqueId("grand") }),
    );
    const read = await json<{ parent_id: string; source_id: string | null }>(
      api("GET", `/repos/${owner.handle}/${grandchild.body.name}`, owner.token),
    );
    expect(read.body).toMatchObject({ parent_id: fork.id, source_id: target.repo.id });
    // The source itself, and a repository forked from nothing, have none.
    expect((await json(api("GET", base, owner.token))).body).toMatchObject({ source_id: null });
    // A token limited to the fork does not see the source.
    const limited = await scopedToken(owner.principalId, [], "pat", [fork.id]);
    expect((await json(api("GET", path, limited))).body).toMatchObject({ source_id: null });
  });

  it("name their parent only to a caller who can see it", async () => {
    const reader = await user();
    await api("PUT", `${base}/collaborators/${reader.handle}`, owner.token, { permission: "pull" });
    const fork = await forkAs(reader);
    const path = `/repos/${reader.handle}/${fork.name}`;
    expect((await json(api("GET", path, reader.token))).body).toMatchObject({
      fork: true,
      parent_id: target.repo.id,
      source_id: target.repo.id,
    });
    // A token limited to the fork does not see the parent.
    const limited = await scopedToken(reader.principalId, [], "pat", [fork.id]);
    expect((await json(api("GET", path, limited))).body).toMatchObject({
      fork: true,
      parent_id: null,
    });
    // Nor does the reader, once its access to the parent is gone: not in the
    // repository, its update or the reader's listing.
    await api("DELETE", `${base}/collaborators/${reader.handle}`, owner.token);
    expect((await json(api("GET", path, reader.token))).body).toMatchObject({
      fork: true,
      parent_id: null,
      source_id: null,
    });
    expect(
      (await json(api("PATCH", path, reader.token, { description: "mine now" }))).body,
    ).toMatchObject({ fork: true, parent_id: null });
    const listed = await json<{ repos: { name: string; parent_id: string | null }[] }>(
      api("GET", "/user/repos?per_page=100", reader.token),
    );
    expect(listed.body.repos.find((r) => r.name === fork.name)).toMatchObject({
      parent_id: null,
    });
    // A fork of a fork names the fork.
    const grandchild = await json<{ parent_id: string }>(
      api("POST", `${path}/forks`, reader.token, { name: uniqueId("grand") }),
    );
    expect(grandchild.body.parent_id).toBe(fork.id);
  });

  it("never show one fork's commit through another fork of the same repository", async () => {
    const other = await user();
    await api("PUT", `${base}/collaborators/${other.handle}`, owner.token, { permission: "pull" });
    const left = await forkAs(owner);
    const right = await forkAs(other);
    // The other user pushes a commit only their fork has.
    const git = await scopedToken(other.principalId, [], "git");
    const reply = await postPush(
      {
        ...target,
        owner: { principalId: other.principalId, token: git },
        path: `/${other.handle}/${right.name}.git`,
      },
      pushBody([{ old: ZERO, new: fx.siblingCommit, ref: "refs/heads/sibling" }], {
        pack: fx.siblingPackHex,
      }),
    );
    expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
    expect(
      (
        await api(
          "GET",
          `/repos/${other.handle}/${right.name}/commits/${fx.siblingCommit}`,
          other.token,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await api(
          "GET",
          `/repos/${owner.handle}/${left.name}/commits/${fx.siblingCommit}`,
          owner.token,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api(
          "GET",
          `/repos/${owner.handle}/${left.name}/contents/secret.txt?ref=${fx.siblingCommit}`,
          owner.token,
        )
      ).status,
    ).toBe(404);
  });
});
