// A pull request's files: compared from the merge base of its base and head
// (three dots, as GitHub's), with patches, renames, pages that keep their
// comparison, and cursors checked before they are used.
import { env } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { oidFromHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { RepoBrowse } from "../src/do/repo/browse.js";
import {
  PULL_FILES_POLICY,
  type PullFilesPolicy,
  pullCommits,
  pullFiles,
} from "../src/do/repo/pull-files.js";
import { api, json, user, type Who } from "./helpers/api.js";
import { advance, runJob, setPolicy } from "./helpers/maintenance.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

type File = {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  patch_omitted?: string;
};
type Page = {
  files: File[];
  merge_base_sha: string;
  head_sha: string;
  next_cursor: string | null;
  code?: string;
};

const fx = inject("pushFixtures");

let owner: Who;
let repo: { id: string; name: string };
let path: string;

const commit = async (branch: string, changes: Record<string, unknown>[]) => {
  const made = await json<{ commit: { sha: string } }>(
    api("POST", `${path}/file-commits`, owner.token, { branch, message: "change", changes }),
  );
  expect(made.status).toBe(201);
  return made.body.commit.sha;
};

/** Pushes branch `name` from `old` to `sha` (ZERO deletes it), a force push when it must be. */
async function branchAt(name: string, sha: string, old = ZERO) {
  const target: PushTarget = {
    repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
    owner: {
      principalId: owner.principalId,
      token: await scopedToken(owner.principalId, [], "git"),
    },
    path: `/${owner.handle}/${repo.name}.git`,
  };
  const pushed = await postPush(
    target,
    pushBody(
      [{ old, new: sha, ref: `refs/heads/${name}` }],
      sha === ZERO ? {} : { pack: fx.packEmpty },
    ),
  );
  expect(pushed.report).toContain(`ok refs/heads/${name}\n`);
}

const files = (query = "") => json<Page>(api("GET", `${path}/pulls/1/files${query}`, owner.token));

beforeEach(async () => {
  owner = await user();
  repo = (
    await json<{ id: string; name: string }>(
      api("POST", "/user/repos", owner.token, { name: uniqueId("r") }),
    )
  ).body;
  path = `/repos/${owner.handle}/${repo.name}`;
  const base = await commit("main", [
    { path: "a.txt", content: "one\ntwo\nthree\n" },
    { path: "b.txt", content: "bye\n" },
    { path: "dir/c.txt", content: "moving\n" },
  ]);
  await branchAt("feature", base);
  await commit("feature", [
    { path: "a.txt", content: "one\nTWO\nthree\n" },
    { path: "b.txt", delete: true },
    { path: "dir/c.txt", delete: true },
    { path: "dir/d.txt", content: "moving\n" },
    { path: "new.txt", content: "hello\n" },
    { path: "bin.dat", content: btoa("a\u0000b"), encoding: "base64" },
  ]);
  // The base moves on: its own change is no part of the pull request.
  await commit("main", [{ path: "z.txt", content: "base only\n" }]);
  expect(
    (
      await api("POST", `${path}/pulls`, owner.token, {
        title: "Change",
        head: "feature",
        base: "main",
      })
    ).status,
  ).toBe(201);
});

describe("pull request files", () => {
  it("lists what the head changed since the merge base, with patches and renames", async () => {
    const page = await files();
    expect(page.status).toBe(200);
    expect(page.body.files.map((f) => [f.filename, f.status, f.previous_filename ?? null])).toEqual(
      [
        ["a.txt", "modified", null],
        ["b.txt", "removed", null],
        ["bin.dat", "added", null],
        ["dir/d.txt", "renamed", "dir/c.txt"],
        ["new.txt", "added", null],
      ],
    );
    const [a, b, bin, d, added] = page.body.files as File[];
    expect(a).toMatchObject({
      additions: 1,
      deletions: 1,
      patch: "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n",
    });
    expect(b).toMatchObject({ deletions: 1, patch: "@@ -1 +0,0 @@\n-bye\n" });
    expect(bin).toMatchObject({ patch_omitted: "binary" });
    expect(d).toMatchObject({ additions: 0, deletions: 0 });
    expect(d?.patch).toBeUndefined();
    expect(added).toMatchObject({ additions: 1, patch: "@@ -0,0 +1 @@\n+hello\n" });
    expect(page.body.next_cursor).toBeNull();
  });

  it("keeps a listing's comparison across pages though the head moves, and refuses a forged cursor", async () => {
    const first = await files("?per_page=2");
    expect(first.body.files.map((f) => f.filename)).toEqual(["a.txt", "b.txt"]);
    // The same comparison started again shares its listing: no new row each time.
    expect((await files("?per_page=2")).body.next_cursor).toBe(first.body.next_cursor);
    const cursor = first.body.next_cursor as string;
    await commit("feature", [{ path: "late.txt", content: "late\n" }]);
    const rest = await files(`?per_page=10&cursor=${cursor}`);
    expect(rest.body.head_sha).toBe(first.body.head_sha);
    expect(rest.body.files.map((f) => f.filename)).toEqual(["bin.dat", "dir/d.txt", "new.txt"]);
    // A fresh listing compares the new head.
    expect((await files()).body.files.map((f) => f.filename)).toContain("late.txt");
    // A cursor names a listing the repository made; one it never made is refused.
    const forged = btoa(`${"0".repeat(32)} 2`).replaceAll("=", "");
    expect((await files(`?cursor=${forged}`)).body.code).toBe("invalid_cursor");
  });

  it("answers 404 for a pull request that does not exist", async () => {
    const missing = await json<{ code: string }>(api("GET", `${path}/pulls/9/files`, owner.token));
    expect(missing).toMatchObject({ status: 404, body: { code: "pull_not_found" } });
  });
});

describe("pull request commits", () => {
  it("lists the head's commits the base lacks, oldest first, pages keeping their comparison", async () => {
    const firstSha = (
      await json<{ commits: { sha: string }[] }>(api("GET", `${path}/pulls/1/commits`, owner.token))
    ).body.commits[0]?.sha as string;
    const second = await commit("feature", [{ path: "second.txt", content: "2\n" }]);
    const third = await commit("feature", [{ path: "third.txt", content: "3\n" }]);
    const page = (cursor?: string) =>
      json<{ commits: { sha: string }[]; next_cursor: string | null }>(
        api(
          "GET",
          `${path}/pulls/1/commits?per_page=1${cursor ? `&cursor=${cursor}` : ""}`,
          owner.token,
        ),
      );
    const one = await page();
    expect(one.body.commits.map((c) => c.sha)).toEqual([firstSha]);
    // The base moves onto the first commit meanwhile: a fresh listing no
    // longer has it, and this one still pages through what it started on.
    const mainTip = (
      await json<{ commit: { sha: string } }>(api("GET", `${path}/branches/main`, owner.token))
    ).body.commit.sha;
    const target: PushTarget = {
      repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
      owner: {
        principalId: owner.principalId,
        token: await scopedToken(owner.principalId, [], "git"),
      },
      path: `/${owner.handle}/${repo.name}.git`,
    };
    const moved = await postPush(
      target,
      pushBody([{ old: mainTip, new: firstSha, ref: "refs/heads/main" }], { pack: fx.packEmpty }),
    );
    expect(moved.report).toContain("ok refs/heads/main\n");
    const fresh = await json<{ commits: { sha: string }[] }>(
      api("GET", `${path}/pulls/1/commits`, owner.token),
    );
    expect(fresh.body.commits.map((c) => c.sha)).toEqual([second, third]);
    const two = await page(one.body.next_cursor as string);
    const three = await page(two.body.next_cursor as string);
    expect([two.body.commits[0]?.sha, three.body.commits[0]?.sha]).toEqual([second, third]);
    expect(three.body.next_cursor).toBeNull();
  });

  it("answers unreadable, as files do, for a base no longer stored", async () => {
    const { head_sha } = (await files()).body;
    const listed = await inRepo(env.REPO.getByName(repo.id), async (r) => {
      const browse = new RepoBrowse({ git: r.git, memoryBlocks: createClockBlockCache() });
      try {
        return await pullCommits(browse, r.git.commitGraph, {
          base: oidFromHex("1".repeat(40)),
          head: oidFromHex(head_sha),
          start: 0,
          limit: 30,
        });
      } finally {
        browse.close();
      }
    });
    expect(listed).toMatchObject({ ok: false, status: 422, code: "unreadable" });
  });
});

describe("a pull request whose base branch is gone", () => {
  it("compares from its recorded base", async () => {
    const tip = (
      await json<{ commit: { sha: string } }>(api("GET", `${path}/branches/main`, owner.token))
    ).body.commit.sha;
    await branchAt("release", tip);
    expect((await api("PATCH", `${path}/pulls/1`, owner.token, { base: "release" })).status).toBe(
      200,
    );
    const target: PushTarget = {
      repo: { id: repo.id, name: repo.name, stub: env.REPO.getByName(repo.id) },
      owner: {
        principalId: owner.principalId,
        token: await scopedToken(owner.principalId, [], "git"),
      },
      path: `/${owner.handle}/${repo.name}.git`,
    };
    await postPush(target, pushBody([{ old: tip, new: ZERO, ref: "refs/heads/release" }]));
    const listed = await files();
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((f) => f.filename)).toContain("a.txt");
  });
});

describe("a merged or closed pull request", () => {
  const tipOf = async (branch: string) =>
    (await json<{ commit: { sha: string } }>(api("GET", `${path}/branches/${branch}`, owner.token)))
      .body.commit.sha;
  const listed = async () => ({
    files: (await files()).body.files.map((f) => f.filename),
    commits: (
      await json<{ commits: { sha: string }[] }>(api("GET", `${path}/pulls/1/commits`, owner.token))
    ).body.commits.map((c) => c.sha),
  });
  /** Onto a branch of its own, which can be moved and deleted later. */
  const retargeted = async () => {
    const tip = await tipOf("main");
    await branchAt("release", tip);
    expect((await api("PATCH", `${path}/pulls/1`, owner.token, { base: "release" })).status).toBe(
      200,
    );
    return tip;
  };

  for (const method of ["merge", "squash", "rebase"] as const)
    it(`keeps the comparison it was merged with (${method}), though its base branch moves on or goes`, async () => {
      const tip = await retargeted();
      const before = await listed();
      expect(before.files).toHaveLength(5);
      expect(before.commits).toHaveLength(1);
      const merged = await json<{ sha: string; merged: boolean }>(
        api("PUT", `${path}/pulls/1/merge`, owner.token, { merge_method: method }),
      );
      expect(merged.body.merged).toBe(true);
      expect(await listed()).toEqual(before);
      // Its base is the one it was merged onto, whatever the branch does next.
      const pull = await json<{ base: { sha: string } }>(
        api("GET", `${path}/pulls/1`, owner.token),
      );
      expect(pull.body.base.sha).toBe(tip);
      // The branch moves to the head itself (as a merge of it would take it), then goes.
      const head = before.commits[0] as string;
      await branchAt("release", head, merged.body.sha);
      expect(await listed()).toEqual(before);
      await branchAt("release", ZERO, head);
      expect(await listed()).toEqual(before);
    });

  it("keeps the base it was merged onto through garbage collection, once no branch reaches it", async () => {
    const tip = await retargeted();
    const before = await listed();
    const merged = await json<{ sha: string }>(api("PUT", `${path}/pulls/1/merge`, owner.token));
    // Both branches move to the head: only the recorded base still reaches `tip`.
    const head = before.commits[0] as string;
    await branchAt("release", head, merged.body.sha);
    await branchAt("main", head, tip);
    // Past the reflog's retention, two runs a garbage time to live apart condemn what nothing reaches.
    const stub = env.REPO.getByName(repo.id);
    await setPolicy(stub);
    expect(["done", "scheduled"]).toContain((await runJob(stub, "gc")).state);
    await advance(stub, 2 * 24 * 60 * 60 * 1000);
    expect(["done", "scheduled"]).toContain((await runJob(stub, "gc")).state);
    // The merge commit went (the run did collect), the recorded base did not.
    expect((await api("GET", `${path}/commits/${merged.body.sha}`, owner.token)).status).toBe(404);
    expect((await api("GET", `${path}/commits/${tip}`, owner.token)).status).toBe(200);
    expect(await listed()).toEqual(before);
  });

  it("is compared from its base as it was when it closed, and from the branch's tip once reopened", async () => {
    const tip = await retargeted();
    const before = await listed();
    expect((await api("PATCH", `${path}/pulls/1`, owner.token, { state: "closed" })).status).toBe(
      200,
    );
    // The base takes the head's commits while it is closed.
    const head = before.commits[0] as string;
    await branchAt("release", head, tip);
    expect(await listed()).toEqual(before);
    // Reopened, it compares the branch as it is now: nothing is left to merge.
    expect((await api("PATCH", `${path}/pulls/1`, owner.token, { state: "open" })).status).toBe(
      200,
    );
    expect(await listed()).toEqual({ files: [], commits: [] });
  });
});

describe("pull request file limits", () => {
  const small = (over: Partial<PullFilesPolicy>) => ({ ...PULL_FILES_POLICY, ...over });
  const listWith = async (policy: PullFilesPolicy) => {
    const { merge_base_sha, head_sha } = (await files()).body;
    return inRepo(env.REPO.getByName(repo.id), async (r) => {
      const browse = new RepoBrowse({ git: r.git, memoryBlocks: createClockBlockCache() });
      try {
        const page = await pullFiles(
          browse,
          r.git.commitGraph,
          {
            mergeBase: oidFromHex(merge_base_sha),
            head: oidFromHex(head_sha),
            start: 0,
            limit: 30,
          },
          policy,
        );
        return page.ok ? page.value : page;
      } finally {
        browse.close();
      }
    });
  };

  it("caps the listing after renames pair, and says it was truncated", async () => {
    const listed = await listWith(small({ maxFiles: 3 }));
    if (!("files" in listed)) return expect.fail(listed.code);
    expect(listed.files.map((f) => f.filename)).toEqual(["a.txt", "b.txt", "bin.dat"]);
    expect(listed.truncated).toBe(true);
    // The rename's removal is never listed on its own, wherever the cap falls.
    const whole = await listWith(small({ maxFiles: 4 }));
    if (!("files" in whole)) return expect.fail(whole.code);
    expect(whole.files.at(-1)).toMatchObject({ filename: "dir/d.txt", status: "renamed" });
  });

  it("pairs no renames once the changes gathered are cut off, so none shows half paired", async () => {
    const listed = await listWith(small({ maxRawChanges: 5 }));
    if (!("files" in listed)) return expect.fail(listed.code);
    expect(listed.truncated).toBe(true);
    expect(listed.files.map((f) => [f.filename, f.status])).toEqual([
      ["a.txt", "modified"],
      ["b.txt", "removed"],
      ["bin.dat", "added"],
      ["dir/c.txt", "removed"],
      ["dir/d.txt", "added"],
    ]);
  });

  it("leaves out patches of a side too large and of a patch too long, with counts kept", async () => {
    const tooLarge = await listWith(small({ maxSideBytes: 5 }));
    if (!("files" in tooLarge)) return expect.fail(tooLarge.code);
    expect(tooLarge.files[0]).toMatchObject({ filename: "a.txt", patchOmitted: "too_large" });
    const tooLong = await listWith(small({ maxInlinePatchBytes: 10 }));
    if (!("files" in tooLong)) return expect.fail(tooLong.code);
    expect(tooLong.files[0]).toMatchObject({
      filename: "a.txt",
      patchOmitted: "patch_too_large",
      additions: 1,
      deletions: 1,
    });
  });

  it("refuses trees past their limits as too expensive", async () => {
    expect(await listWith(small({ maxTreeBytesTotal: 10 }))).toMatchObject({
      code: "too_expensive",
    });
  });
});
