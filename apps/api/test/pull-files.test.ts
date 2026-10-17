// A pull request's files: compared from the merge base of its base and head
// (three dots, as GitHub's), with patches, renames, pages that keep their
// comparison, cursors checked before they are used, and the files changed
// kept so that later pages and listings of a comparison read no trees.
import { env } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { type ObjectReader, type Oid, oidFromHex, oidToHex } from "@fyrden/git-core";
import { uniqueId } from "@fyrden/testing";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { RepoBrowse } from "../src/do/repo/browse.js";
import {
  type ChangeList,
  ChangeLists,
  type ChangeListsPolicy,
} from "../src/do/repo/change-lists.js";
import { TREE_ENTRY_MEMORY_BYTES } from "../src/do/repo/held-reads.js";
import {
  type ListingCursor,
  PULL_FILES_POLICY,
  type PullFilesPolicy,
  pullCommits,
  pullFiles,
  pullFilesListing,
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

/** The work a files listing does: R2 GETs, trees read, objects located together. */
type Work = { gets: number; trees: number; located: string[] };

/** `reader`, counting into `work` the trees it reads and the objects it locates together. */
function watched(reader: ObjectReader, work: Work): ObjectReader {
  return new Proxy(reader, {
    get(target, property) {
      if (property === "readHeader")
        return async (oid: Oid) => {
          const header = await target.readHeader(oid);
          if (header?.type === "tree") work.trees++;
          return header;
        };
      if (property === "prefetch")
        return (oids: Iterable<Oid>) => {
          const all = [...oids];
          work.located.push(...all.map(oidToHex));
          return target.prefetch(all);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a kept files listing", () => {
  /** A page of pull request 1's files as the repository lists it, and the work it did. */
  const listed = (from: ListingCursor | null, limit: number) =>
    inRepo(env.REPO.getByName(repo.id), async (r) => {
      const work: Work = { gets: 0, trees: 0, located: [] };
      const browse = new RepoBrowse({ git: r.git, memoryBlocks: createClockBlockCache() });
      const reader = browse.reader.bind(browse);
      browse.reader = async () => watched(await reader(), work);
      const bucket = r.git.bucket;
      const get = bucket.get;
      bucket.get = ((...args: Parameters<R2Bucket["get"]>) => {
        work.gets++;
        return get.apply(bucket, args);
      }) as R2Bucket["get"];
      try {
        const page = await pullFilesListing(browse, r.pulls, r.git.commitGraph, r.changeLists, {
          number: 1,
          from,
          limit,
        });
        if (!page.ok) throw new Error(page.code);
        return { page: page.value, ...work };
      } finally {
        bucket.get = get;
        browse.close();
      }
    });

  it("lists the same comparison again without reading its trees, locating the page's files together", async () => {
    const cold = await listed(null, 30);
    expect(cold.trees).toBeGreaterThan(0);
    const warm = await listed(null, 30);
    expect(warm.trees).toBe(0);
    expect(warm.page).toEqual(cold.page);
    // The page's blobs (a.txt's two sides, b.txt, bin.dat, new.txt; the rename has no lines to compare).
    expect(warm.located).toHaveLength(5);
    expect(warm.located).toEqual(
      expect.arrayContaining(
        warm.page.files.filter((f) => f.status !== "renamed").map((f) => f.sha),
      ),
    );
    expect(warm.gets).toBeLessThan(cold.gets);
    // At most a batched index lookup (two reads) for each pack, and a read for each blob.
    const packs = await inRepo(env.REPO.getByName(repo.id), (r) => r.git.registry.liveOwn().length);
    expect(warm.gets).toBeLessThanOrEqual(2 * packs + warm.located.length);
  });

  it("reads no trees for a later page, and locates only that page's files", async () => {
    const one = await listed(null, 1);
    expect(one.trees).toBeGreaterThan(0);
    expect(one.page.files.map((f) => f.filename)).toEqual(["a.txt"]);
    const cursor = { listing: one.page.listing as string, start: one.page.next as number };
    const two = await listed(cursor, 1);
    expect(two.trees).toBe(0);
    expect(two.page.files.map((f) => [f.filename, f.status])).toEqual([["b.txt", "removed"]]);
    expect(two.located).toEqual([two.page.files[0]?.sha]);
  });

  it("works out a new head's comparison anew", async () => {
    await listed(null, 30);
    await commit("feature", [{ path: "late.txt", content: "late\n" }]);
    const moved = await listed(null, 30);
    expect(moved.trees).toBeGreaterThan(0);
    expect(moved.page.files.map((f) => f.filename)).toContain("late.txt");
  });

  it("answers a kept listing byte for byte as it answered it first", async () => {
    const text = async (query: string) =>
      (await api("GET", `${path}/pulls/1/files${query}`, owner.token)).text();
    const first = await text("?per_page=2");
    const whole = await text("");
    expect(await text("?per_page=2")).toBe(first);
    expect(await text("")).toBe(whole);
  });
});

describe("kept change lists", () => {
  const list = (path: string): ChangeList => ({
    changes: [
      {
        status: "added",
        path,
        previousPath: null,
        oldMode: null,
        newMode: 0o100644,
        oldOid: null,
        newOid: oidFromHex("1".repeat(40)),
      },
    ],
    truncated: false,
  });
  const inFreshRepo = <R>(use: (lists: (policy: ChangeListsPolicy) => ChangeLists) => R) =>
    inRepo(env.REPO.getByName(uniqueId("repo")), (r) =>
      use((policy) => new ChangeLists(r.git, policy)),
    );

  it("keeps a bounded number of lists, found by their commits and limits, dropping the oldest", async () => {
    const kept = await inFreshRepo((make) => {
      const lists = make({ maxLists: 2, maxBytes: 1024 * 1024, maxListBytes: 1024 * 1024 });
      for (const n of [1, 2, 3]) lists.keep(`base${n}`, "head", "limits", list(`file${n}`));
      // The same comparison kept again (two requests worked it out at once): the first stays.
      lists.keep("base3", "head", "limits", list("again"));
      return {
        dropped: lists.get("base1", "head", "limits"),
        kept: lists.get("base3", "head", "limits"),
        otherLimits: lists.get("base3", "head", "others"),
        count: [2, 3].filter((n) => lists.get(`base${n}`, "head", "limits")).length,
      };
    });
    expect(kept).toEqual({
      dropped: undefined,
      kept: list("file3"),
      otherLimits: undefined,
      count: 2,
    });
  });

  it("keeps a bounded size of lists, dropping the oldest, and never one too long", async () => {
    const kept = await inFreshRepo((make) => {
      // Each list below takes a little over 1,000 bytes.
      const lists = make({ maxLists: 100, maxBytes: 2_500, maxListBytes: 2_000 });
      for (const n of [1, 2, 3])
        lists.keep(`base${n}`, "head", "limits", list(`${n}`.repeat(1_000)));
      lists.keep("long", "head", "limits", list("x".repeat(3_000)));
      return ["base1", "base2", "base3", "long"].map(
        (base) => lists.get(base, "head", "limits") !== undefined,
      );
    });
    expect(kept).toEqual([false, true, true, false]);
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
  /** The listing with `policy`; `held` gets the size of each memory hold it makes. */
  const listWith = async (policy: PullFilesPolicy, held?: number[]) => {
    const { merge_base_sha, head_sha } = (await files()).body;
    return inRepo(env.REPO.getByName(repo.id), async (r) => {
      const browse = new RepoBrowse({ git: r.git, memoryBlocks: createClockBlockCache() });
      const hold = browse.hold.bind(browse);
      browse.hold = (bytes) => {
        held?.push(bytes);
        return hold(bytes);
      };
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

  it("holds memory for each entry a tree may have before parsing it, however short the names", async () => {
    const names = Array.from({ length: 100 }, (_, i) => `many/${i}`);
    await commit(
      "feature",
      names.map((name) => ({ path: name, content: "x\n" })),
    );
    const held: number[] = [];
    const listed = await listWith(PULL_FILES_POLICY, held);
    if (!("files" in listed)) return expect.fail(listed.code);
    expect(listed.files.map((f) => f.filename)).toContain("many/0");
    // The directory's tree: a hundred entries of a few bytes each.
    expect(Math.max(...held)).toBeGreaterThanOrEqual(100 * TREE_ENTRY_MEMORY_BYTES);
  });
});
