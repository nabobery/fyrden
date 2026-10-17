// A pull request's conflicts with its base branch: read with git's
// markers, resolved by a merge of the base into the head made and signed
// by the server, refused when either branch moved or a conflict cannot be
// resolved here; and the head branch updated when nothing conflicts.
import { env } from "cloudflare:workers";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");

type ConflictFile = {
  path: string;
  kind: string;
  editable: boolean;
  content: string | null;
  conflicts: number;
};
type Conflicts = {
  base_sha: string;
  head_sha: string;
  conflict_snapshot: string;
  files: ConflictFile[];
  code?: string;
};
type Resolved = { sha: string; markers: string[]; code?: string; detail?: string };
type Commit = {
  sha: string;
  commit: {
    message: string;
    committer: { name: string };
    verification: { verified: boolean };
  };
  parents: { sha: string }[];
};

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const stub = () => env.REPO.getByName(repo.id);
const commitOn = async (branch: string, changes: Record<string, unknown>[], message = "change") => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, { branch, message, changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};
async function branchFrom(name: string, sha: string) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: stub() },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody([{ old: ZERO, new: sha, ref: `refs/heads/${name}` }], { pack: fx.packEmpty }),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}
const commitAt = async (ref: string) =>
  (await json<Commit>(api("GET", `${path}/commits/${ref}`, owner.token))).body;
const file = async (name: string, ref: string) => {
  const got = await json<{ content?: string }>(
    api("GET", `${path}/contents/${name}?ref=${ref}`, owner.token),
  );
  return got.body.content === undefined ? undefined : atob(got.body.content.replace(/\n/g, ""));
};
const conflicts = (who: Who = owner) =>
  json<Conflicts>(api("GET", `${path}/pulls/1/conflicts`, who.token));
const resolve = (body: Record<string, unknown>, who: Who = owner) =>
  json<Resolved>(api("POST", `${path}/pulls/1/conflicts`, who.token, body));
const update = (body: Record<string, unknown> = {}, who: Who = owner) =>
  json<{ sha: string; message: string; url: string; code?: string }>(
    api("PUT", `${path}/pulls/1/update-branch`, who.token, body),
  );
async function mergeable() {
  for (let i = 0; i < 3; i++) await inRepo(stub(), (r: RepoDO) => r.alarm());
  return (await json<{ mergeable: boolean | null }>(api("GET", `${path}/pulls/1`, owner.token)))
    .body.mergeable;
}

let base: string;
let opened: boolean;
beforeEach(async () => {
  opened = false;
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  base = await commitOn("main", [
    { path: "a.txt", content: "one\ntwo\nthree\n" },
    { path: "b.txt", content: "bee\n" },
    { path: "m.txt", content: "em\n" },
  ]);
  await branchFrom("feature", base);
});

/** Commits on the feature branch, then opens the pull request (once it has commits). */
async function featureCommit(changes: Record<string, unknown>[]): Promise<string> {
  const sha = await commitOn("feature", changes);
  if (!opened) {
    opened = true;
    expect(
      (
        await api("POST", `${path}/pulls`, owner.token, {
          title: "Feature",
          head: "feature",
          base: "main",
        })
      ).status,
    ).toBe(201);
  }
  return sha;
}

describe("conflicts", () => {
  it("are read with markers, resolved by a merge of the base into the head, and then gone", async () => {
    const head = await featureCommit([
      { path: "a.txt", content: "one\nTWO\nthree\n" },
      { path: "c.txt", content: "see\n" },
    ]);
    const tip = await commitOn("main", [
      { path: "a.txt", content: "one\n2\nthree\n" },
      { path: "b.txt", content: "BEE\n" },
    ]);
    const read = await conflicts();
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      base_sha: tip,
      head_sha: head,
      conflict_snapshot: tip + head,
      files: [
        {
          path: "a.txt",
          kind: "content",
          editable: true,
          conflicts: 1,
          content: "one\n<<<<<<< feature\nTWO\n=======\n2\n>>>>>>> main\nthree\n",
        },
      ],
    });
    expect(await mergeable()).toBe(false);

    const made = await resolve({
      conflict_snapshot: read.body.conflict_snapshot,
      files: [{ path: "a.txt", content: "one\nTWO and 2\nthree\n" }],
    });
    expect(made).toMatchObject({ status: 201, body: { markers: [] } });
    const merge = await commitAt("feature");
    expect(merge.sha).toBe(made.body.sha);
    expect(merge.parents.map((p) => p.sha)).toEqual([head, tip]);
    expect(merge.commit.message).toBe("Merge branch 'main' into feature\n");
    expect(merge.commit.committer.name).toBe("Fyrden");
    expect(merge.commit.verification.verified).toBe(true);
    expect(await file("a.txt", "feature")).toBe("one\nTWO and 2\nthree\n");
    expect(await file("b.txt", "feature")).toBe("BEE\n");
    expect(await file("c.txt", "feature")).toBe("see\n");
    expect((await conflicts()).body.files).toEqual([]);
    expect(await mergeable()).toBe(true);
  });

  it("accept contents still marked, naming them, and an add/add conflict", async () => {
    await featureCommit([
      { path: "a.txt", content: "one\nTWO\nthree\n" },
      { path: "n.txt", content: "ours\n" },
    ]);
    await commitOn("main", [
      { path: "a.txt", content: "one\n2\nthree\n" },
      { path: "n.txt", content: "theirs\n" },
    ]);
    const read = await conflicts();
    expect(read.body.files.map((f) => [f.path, f.kind, f.editable])).toEqual([
      ["a.txt", "content", true],
      ["n.txt", "add_add", true],
    ]);
    const marked = read.body.files[0]?.content as string;
    const made = await resolve({
      conflict_snapshot: read.body.conflict_snapshot,
      files: [
        { path: "a.txt", content: marked },
        { path: "n.txt", content: "both\n" },
      ],
    });
    expect(made).toMatchObject({ status: 201, body: { markers: ["a.txt"] } });
  });

  it("refuse what cannot be resolved here, a missing or extra file, and moved branches", async () => {
    await featureCommit([
      { path: "a.txt", content: "one\nTWO\nthree\n" },
      { path: "m.txt", content: "changed\n" },
    ]);
    await commitOn("main", [
      { path: "a.txt", content: "one\n2\nthree\n" },
      { path: "m.txt", delete: true },
    ]);
    const read = await conflicts();
    expect(read.body.files.map((f) => [f.path, f.kind, f.editable, f.content])).toEqual([
      ["a.txt", "content", true, expect.any(String)],
      ["m.txt", "modify_delete", false, null],
    ]);
    const snapshot = read.body.conflict_snapshot;
    const a = { path: "a.txt", content: "one\nboth\nthree\n" };
    expect((await resolve({ conflict_snapshot: snapshot, files: [a] })).body).toMatchObject({
      code: "not_editable",
    });

    // Without the file the other side deleted, only lines conflict.
    await featureCommit([{ path: "m.txt", delete: true }]);
    const again = await conflicts();
    const next = again.body.conflict_snapshot;
    expect((await resolve({ conflict_snapshot: next, files: [] })).body).toMatchObject({
      code: "unresolved",
    });
    expect(
      (
        await resolve({
          conflict_snapshot: next,
          files: [a, { path: "b.txt", content: "x\n" }],
        })
      ).body,
    ).toMatchObject({ code: "not_conflicted" });
    // An old snapshot: the head moved since.
    expect((await resolve({ conflict_snapshot: snapshot, files: [a] })).body).toMatchObject({
      code: "head_moved",
    });
    await commitOn("main", [{ path: "z.txt", content: "z\n" }]);
    expect((await resolve({ conflict_snapshot: next, files: [a] })).body).toMatchObject({
      code: "base_moved",
    });
  });

  it("are not resolved here in files that are not UTF-8, nor past the size limits", async () => {
    // Latin-1 bytes: lines conflict, but the API gives and takes text.
    const latin1 = (text: string) => ({
      path: "l.txt",
      content: btoa(text),
      encoding: "base64",
    });
    await featureCommit([
      latin1("caf\xe9\nOURS\n"),
      { path: "a.txt", content: "one\nTWO\nthree\n" },
    ]);
    await commitOn("main", [
      latin1("caf\xe9\nTHEIRS\n"),
      { path: "a.txt", content: "one\n2\nthree\n" },
    ]);
    const read = await conflicts();
    expect(read.body.files.map((f) => [f.path, f.editable])).toEqual([
      ["a.txt", true],
      ["l.txt", false],
    ]);
    const snapshot = read.body.conflict_snapshot;
    const a = { path: "a.txt", content: "one\nboth\nthree\n" };
    expect(
      (
        await resolve({
          conflict_snapshot: snapshot,
          files: [a, { path: "l.txt", content: "x\n" }],
        })
      ).body,
    ).toMatchObject({ code: "not_editable" });
    // Left out: still not resolvable here, not missing.
    expect((await resolve({ conflict_snapshot: snapshot, files: [a] })).body).toMatchObject({
      code: "not_editable",
    });
    // 1 MiB of UTF-8 bytes at most per file, though fewer characters.
    expect(
      (
        await resolve({
          conflict_snapshot: snapshot,
          files: [a, { path: "l.txt", content: "é".repeat(600_000) }],
        })
      ).body,
    ).toMatchObject({ code: "too_large" });
  });

  it("are read by readers, resolved only with write access", async () => {
    await featureCommit([{ path: "a.txt", content: "one\nTWO\nthree\n" }]);
    await commitOn("main", [{ path: "a.txt", content: "one\n2\nthree\n" }]);
    const reader = await user();
    await api("PUT", `${path}/collaborators/${reader.handle}`, owner.token, {
      permission: "pull",
    });
    const read = await conflicts(reader);
    expect(read.status).toBe(200);
    const refused = await resolve(
      {
        conflict_snapshot: read.body.conflict_snapshot,
        files: [{ path: "a.txt", content: "x\n" }],
      },
      reader,
    );
    // Without write access the repository answers as if it were not there to write to.
    expect(refused.status).toBe(404);
  });
});

describe("a merge into the head", () => {
  /** Runs `action` once, while the next merge into the head has its commit stored. */
  const during = (action: () => Promise<unknown>) =>
    inRepo(stub(), (r: RepoDO) => {
      r.headMergeHooks = {
        beforeFinish: async () => {
          r.headMergeHooks = {};
          await action();
        },
      };
    });

  for (const [what, action, code] of [
    [
      "the pull request is closed",
      () => api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" }),
      "pull_changed",
    ],
    [
      "the base branch moves",
      () => commitOn("main", [{ path: "z.txt", content: "z\n" }]),
      "base_moved",
    ],
    [
      "the head branch moves",
      () => commitOn("feature", [{ path: "y.txt", content: "y\n" }]),
      "head_moved",
    ],
  ] as const)
    it(`is refused when ${what} while it is made`, async () => {
      const head = await featureCommit([{ path: "c.txt", content: "see\n" }]);
      await commitOn("main", [{ path: "b.txt", content: "BEE\n" }]);
      await during(action);
      expect((await update()).body).toMatchObject({ code });
      if (code !== "head_moved") expect((await commitAt("feature")).sha).toBe(head);
    });
});

describe("updating the branch", () => {
  it("merges the base into the head when nothing conflicts, then has nothing to do", async () => {
    const head = await featureCommit([{ path: "c.txt", content: "see\n" }]);
    const tip = await commitOn("main", [{ path: "b.txt", content: "BEE\n" }]);
    expect((await update({ expected_head_sha: base })).body).toMatchObject({
      code: "head_moved",
    });
    const updated = await update({ expected_head_sha: head });
    expect(updated.status).toBe(202);
    expect(updated.body.message).toBe("Updating pull request branch.");
    expect(updated.body.url).toContain(`/repos/${owner.handle}/${repo.name}/pulls/1`);
    const merge = await commitAt("feature");
    expect(merge.sha).toBe(updated.body.sha);
    expect(merge.parents.map((p) => p.sha)).toEqual([head, tip]);
    expect(await file("b.txt", "feature")).toBe("BEE\n");
    expect((await update()).body).toMatchObject({ code: "up_to_date" });
  });

  it("is refused when the branches conflict", async () => {
    await featureCommit([{ path: "a.txt", content: "one\nTWO\nthree\n" }]);
    await commitOn("main", [{ path: "a.txt", content: "one\n2\nthree\n" }]);
    expect((await update()).body).toMatchObject({ code: "merge_conflict" });
  });
});
