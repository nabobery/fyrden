// Files and directories through the REST API (contents, README, trees and
// raw bytes), checked against `git ls-tree` and `git cat-file` on the
// repository test/setup/browse-fixtures.ts built.

import { exports } from "cloudflare:workers";
import { createClockBlockCache } from "@fyrden/adapters-cloudflare";
import { MemoryWaitTimeoutError } from "@fyrden/adapters-cloudflare/git";
import { uniqueId } from "@fyrden/testing";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { type BrowsePolicy, guarded, RepoBrowse } from "../src/do/repo/browse.js";
import { treeListing } from "../src/do/repo/contents.js";
import type { TreeLine } from "./helpers/browse-fixtures.js";
import { ORIGIN } from "./helpers/git-http.js";
import { scopedToken } from "./helpers/principals.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("browseFixtures");

let target: PushTarget;
let pat: string;
let base: string;

async function get(path: string, token = pat): Promise<Response> {
  return exports.default.fetch(path.startsWith("http") ? path : `${ORIGIN}/api${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function json<T = Record<string, unknown>>(path: string, token = pat) {
  const res = await get(path, token);
  return { status: res.status, body: await res.json<T>() };
}

const TYPE: Record<string, string> = {
  "040000": "dir",
  "160000": "submodule",
  "120000": "symlink",
  "100644": "file",
  "100755": "file",
};

/** An entry as the contents API lists it, from `git ls-tree`. */
const entryOf = (line: TreeLine) => ({
  type: TYPE[line.mode],
  name: line.path.split("/").at(-1),
  path: line.path,
  sha: line.sha,
  mode: line.mode,
});

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

beforeAll(async () => {
  target = await pushTarget();
  pat = await scopedToken(target.owner.principalId, [], "pat");
  const reply = await postPush(
    target,
    pushBody(
      fx.refs.map((r) => ({ old: ZERO, new: r.oid, ref: r.name })),
      { pack: fx.packHex },
    ),
  );
  expect(reply.report.filter((line) => line.startsWith("ng"))).toEqual([]);
  base = `/repos/${target.owner.principalId.toLowerCase().replace("_", "-")}/${target.repo.name}`;
});

describe("contents", () => {
  it("lists the root as git ls-tree does: files, directories, a symlink, a submodule", async () => {
    const res = await json<{ type: string; entries: unknown[]; next_cursor: string | null }>(
      `${base}/contents`,
    );
    expect(res.body).toMatchObject({ type: "dir", path: "", next_cursor: null });
    expect(res.body.entries).toEqual(fx.trees.root.map(entryOf));
  });

  it("lists a directory a page at a time", async () => {
    const entries: unknown[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 20; pages++) {
      const query = new URLSearchParams({ per_page: "7", ref: "main" });
      if (cursor) query.set("cursor", cursor);
      const res = await json<{ entries: unknown[]; next_cursor: string | null }>(
        `${base}/contents/many?${query}`,
      );
      expect(res.status).toBe(200);
      entries.push(...res.body.entries);
      cursor = res.body.next_cursor;
      if (!cursor) break;
    }
    expect(entries).toEqual(fx.trees.many.map(entryOf));
  });

  it("gives a file's content, and a raw link to it at the same commit", async () => {
    for (const path of ["README.md", "run.sh", "docs/ünï.md", "many/f07.txt"]) {
      const file = fx.files[path] as { sha: string; mode: string; base64: string };
      const res = await json<{ content: string; download_url: string }>(
        `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
      );
      expect(res.body, path).toMatchObject({
        type: "file",
        path,
        name: path.split("/").at(-1),
        sha: file.sha,
        mode: file.mode,
        size: bytesOf(file.base64).length,
        encoding: "base64",
        content: file.base64,
      });
      expect(res.body.download_url).toContain(`ref=${fx.revs.main}`);
      const raw = await get(res.body.download_url);
      expect(raw.status).toBe(200);
      expect(raw.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(raw.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytesOf(file.base64));
    }
  });

  it("leaves out the content of a file over 1 MiB, which the raw link serves", async () => {
    const file = fx.files["big.bin"] as { sha: string; base64: string };
    const res = await json<{ download_url: string }>(`${base}/contents/big.bin`);
    expect(res.body).toMatchObject({ encoding: "none", content: "", size: 1_536 * 1024 });
    const raw = await get(res.body.download_url);
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytesOf(file.base64));
  });

  it("shows a symlink's target and a submodule's commit", async () => {
    expect((await json(`${base}/contents/link`)).body).toMatchObject({
      type: "symlink",
      target: "README.md",
      content: btoa("README.md"),
    });
    // A target that is not UTF-8: shown lossily, its bytes kept in `content`.
    expect((await json(`${base}/contents/badlink`)).body).toMatchObject({
      type: "symlink",
      size: 2,
      content: "/v8=",
    });
    const sub = fx.trees.root.find((l) => l.path === "sub") as TreeLine;
    expect((await json(`${base}/contents/sub`)).body).toEqual({
      type: "submodule",
      path: "sub",
      name: "sub",
      sha: sub.sha,
    });
  });

  it("answers 404 for what is not there, and 422 for a path that names nothing", async () => {
    expect((await json(`${base}/contents/missing.txt`)).body).toMatchObject({
      code: "path_not_found",
    });
    expect((await json(`${base}/contents/README.md/x`)).status).toBe(404);
    expect((await json(`${base}/contents/a//b`)).body).toMatchObject({ code: "invalid_path" });
    expect((await json(`${base}/contents/README.md?ref=nope`)).body).toMatchObject({
      code: "ref_not_found",
    });
    // A file at an older commit, and gone at the tip.
    const old = await json(`${base}/contents/src/lib/util.ts?ref=v1`);
    expect(old.body).toMatchObject({ type: "file", path: "src/lib/util.ts" });
    expect((await json(`${base}/contents/src/lib/util.ts`)).status).toBe(404);
  });

  it("keeps a name's byte order mark, so the listed path finds the file", async () => {
    const root = await json<{ entries: { path: string }[] }>(`${base}/contents`);
    const bom = root.body.entries.find((e) => e.path.startsWith("\uFEFF"));
    expect(bom?.path).toBe("\uFEFFbom.txt");
    expect(
      (await json(`${base}/contents/${encodeURIComponent(bom?.path ?? "")}`)).body,
    ).toMatchObject({
      type: "file",
      content: btoa("bom\n"),
    });
  });

  it("answers a cursor from another version of the directory with cursor_stale", async () => {
    const first = await json<{ next_cursor: string }>(`${base}/contents?per_page=2`);
    expect(first.body.next_cursor).toBeTruthy();
    const stale = await json(`${base}/contents?ref=v1&per_page=2&cursor=${first.body.next_cursor}`);
    expect(stale).toMatchObject({ status: 409, body: { code: "cursor_stale" } });
    expect((await json(`${base}/contents?cursor=AAAA`)).body).toMatchObject({
      code: "invalid_cursor",
    });
  });

  it("links raw bytes on the origin the request came to, port included", async () => {
    const res = await exports.default.fetch(`http://127.0.0.1:8787/api${base}/contents/README.md`, {
      headers: { Authorization: `Bearer ${pat}` },
    });
    const body = await res.json<{ download_url: string }>();
    expect(body.download_url).toBe(
      `http://127.0.0.1:8787/api${base}/raw/README.md?ref=${fx.revs.main}`,
    );
  });

  it("finds the README", async () => {
    const readme = fx.files["README.md"] as { sha: string; base64: string };
    // README.md wins over README.MD.
    expect((await json(`${base}/readme`)).body).toMatchObject({
      type: "file",
      path: "README.md",
      sha: readme.sha,
      content: readme.base64,
    });
  });
});

describe("trees", () => {
  it("lists every entry below the root as git ls-tree -r -t does, or the root alone", async () => {
    const recursive = await json<{ tree: unknown[]; truncated: boolean; sha: string }>(
      `${base}/git/trees/main?recursive=1`,
    );
    expect(recursive.body.truncated).toBe(false);
    expect(recursive.body.sha).toBe(fx.commits[fx.revs.main as string]?.tree);
    expect(recursive.body.tree).toEqual(fx.trees.recursive.map((l) => ({ ...l })));
    const root = await json<{ tree: unknown[] }>(`${base}/git/trees/${fx.revs.main}`);
    expect(root.body.tree).toEqual(fx.trees.root.map((l) => ({ ...l })));
  });

  it("ends a listing that runs out of reads with what it has, truncated", async () => {
    const listing = (policy: Partial<BrowsePolicy>) =>
      inRepo(target.repo.stub, async ({ git }) => {
        const b = new RepoBrowse({ git, memoryBlocks: createClockBlockCache(), policy });
        try {
          return await treeListing(b, "main", true);
        } finally {
          b.close();
        }
      });
    const whole = fx.trees.recursive.map((l) => l.path);
    const outcomes = new Set<string>();
    const policies: Partial<BrowsePolicy>[] = [];
    for (let reads = 0; reads <= 40; reads++) {
      policies.push({ maxReads: reads, cacheCalls: 0 });
      policies.push({ walkReads: reads, cacheCalls: 0 });
    }
    for (const policy of policies) {
      const result = await listing(policy);
      if (!result.ok) {
        expect(result.code).toBe("too_expensive");
        outcomes.add("refused");
        continue;
      }
      const paths = result.value.entries.map((e) => e.path);
      expect(paths).toEqual(whole.slice(0, paths.length));
      expect(result.value.truncated).toBe(paths.length < whole.length);
      outcomes.add(result.value.truncated ? "truncated" : "whole");
    }
    expect([...outcomes].sort()).toEqual(["refused", "truncated", "whole"]);
  });

  it("stops before the directories it is inside would hold too many bytes, and at its entry limit", async () => {
    const listing = (limits: { maxTreeEntries: number; maxHeldTreeBytes: number }) =>
      inRepo(target.repo.stub, async ({ git }) => {
        const b = new RepoBrowse({ git, memoryBlocks: createClockBlockCache() });
        try {
          return await treeListing(b, "main", true, limits);
        } finally {
          b.close();
        }
      });
    const whole = fx.trees.recursive.map((l) => l.path);
    // Room for the root alone: the listing ends at its first subdirectory.
    const held = await listing({ maxTreeEntries: 10_000, maxHeldTreeBytes: 1 });
    expect(held.ok && held.value.truncated).toBe(true);
    const firstDir = fx.trees.recursive.findIndex((l) => l.type === "tree");
    expect(held.ok && held.value.entries.map((e) => e.path)).toEqual(whole.slice(0, firstDir + 1));
    const few = await listing({ maxTreeEntries: 3, maxHeldTreeBytes: 1 << 30 });
    expect(few.ok && few.value).toMatchObject({ truncated: true });
    expect(few.ok && few.value.entries.map((e) => e.path)).toEqual(whole.slice(0, 3));
  });

  it("reserves the trees it holds from the object's memory, answering busy when none is free", async () => {
    const outcome = await inRepo(target.repo.stub, async ({ git }) => {
      const b = new RepoBrowse({ git, memoryBlocks: createClockBlockCache() });
      await b.reader();
      const free = git.memory.stats().totalBytes - git.memory.stats().reservedBytes;
      const hog = git.memory.tryReserve(free);
      try {
        return await treeListing(b, "main", true);
      } finally {
        hog?.release();
        b.close();
      }
    });
    expect(outcome).toMatchObject({ ok: false, status: 409, code: "busy" });
  });

  it("answers busy, not an error, when working memory stays taken past the wait", async () => {
    expect(
      await guarded(async () => {
        throw new MemoryWaitTimeoutError(1024, 60_000);
      }),
    ).toMatchObject({ ok: false, status: 409, code: "busy" });
  });

  it("does not take a bare tree SHA", async () => {
    const tree = fx.commits[fx.revs.main as string]?.tree as string;
    expect((await json(`${base}/git/trees/${tree}`)).status).toBe(404);
  });
});

describe("raw", () => {
  it("answers 304 to a matching If-None-Match, and the file otherwise", async () => {
    const first = await get(`${base}/raw/README.md`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag") as string;
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    const conditional = (condition: string) =>
      exports.default.fetch(`${ORIGIN}/api${base}/raw/README.md`, {
        headers: { Authorization: `Bearer ${pat}`, "If-None-Match": condition },
      });
    for (const condition of [etag, `W/${etag}`, `"x", ${etag}`, "*"]) {
      const res = await conditional(condition);
      expect(res.status, condition).toBe(304);
      expect(res.headers.get("ETag")).toBe(etag);
      expect(await res.text()).toBe("");
    }
    expect((await conditional('"0000"')).status).toBe(200);
    // Not to someone who cannot read it.
    const stranger = await scopedToken((await pushTarget()).owner.principalId, [], "pat");
    const hidden = await exports.default.fetch(`${ORIGIN}/api${base}/raw/README.md`, {
      headers: { Authorization: `Bearer ${stranger}`, "If-None-Match": "*" },
    });
    expect(hidden.status).toBe(404);
  });

  it("needs read access, a token, and a file", async () => {
    const stranger = await scopedToken((await pushTarget()).owner.principalId, [], "pat");
    expect((await get(`${base}/raw/README.md`, stranger)).status).toBe(404);
    const anonymous = await exports.default.fetch(`${ORIGIN}/api${base}/raw/README.md`);
    expect(anonymous.status).toBe(401);
    expect((await get(`${base}/raw/src`)).status).toBe(404);
    expect((await get(`${base}/raw/README.md?ref=${"0".repeat(40)}`)).status).toBe(404);
    const metadataOnly = await scopedToken(target.owner.principalId, ["metadata:read"], "pat");
    expect((await get(`${base}/raw/README.md`, metadataOnly)).status).toBe(403);
  });

  it("never serves a fork's file through its parent", async () => {
    const forkName = uniqueId("fork");
    const forked = await exports.default.fetch(`${ORIGIN}/api${base}/forks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ name: forkName }),
    });
    expect(forked.status).toBe(201);
    const forkPath = base.replace(target.repo.name, forkName);
    await postPush(
      { ...target, path: `${forkPath.slice("/repos".length)}.git` },
      pushBody([{ old: ZERO, new: fx.siblingCommit, ref: "refs/heads/sibling" }], {
        pack: fx.siblingPackHex,
      }),
    );
    expect((await get(`${forkPath}/raw/secret.txt?ref=${fx.siblingCommit}`)).status).toBe(200);
    expect((await get(`${base}/raw/secret.txt?ref=${fx.siblingCommit}`)).status).toBe(404);
    expect((await json(`${base}/contents/secret.txt?ref=${fx.siblingCommit}`)).status).toBe(404);
  });
});
