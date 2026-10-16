// Resolving a pull request's conflicts in the browser: conflict regions read
// from git's markers (the head's side first), a side kept, each file's line
// breaks restored after the browser sends them all as CRLF, the snapshot
// sent back, files that cannot be edited here explained, and hostile paths
// and branch names shown as text.

import { describe, expect, it } from "vitest";
import {
  conflictRegions,
  lineEnding,
  resolveRegion,
  shellQuote,
  withLineEndings,
} from "../app/lib/conflicts.js";
import { action, loader, default as PullConflicts } from "../app/routes/repo.pull.conflicts.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const SNAPSHOT = "e".repeat(80);
const MARKED =
  "top\n<<<<<<< head\nours\n=======\ntheirs\n>>>>>>> base\nmid\n<<<<<<< head\na\n||||||| base\nold\n=======\nb\nb2\n>>>>>>> base\nend\n";

describe("conflict markers", () => {
  it("are read as regions with each side's lines, a base section skipped", () => {
    const regions = conflictRegions(MARKED);
    expect(regions.map((r) => [r.head, r.base])).toEqual([
      ["ours\n", "theirs\n"],
      ["a\n", "b\nb2\n"],
    ]);
    expect(MARKED.slice(regions[0]?.start, regions[0]?.end)).toBe(
      "<<<<<<< head\nours\n=======\ntheirs\n>>>>>>> base\n",
    );
  });

  it("keep the side chosen, or both with the head's first", () => {
    const [first, second] = conflictRegions(MARKED);
    if (!first || !second) throw new Error("no regions");
    expect(resolveRegion(MARKED, first, "head").startsWith("top\nours\nmid\n")).toBe(true);
    expect(resolveRegion(MARKED, first, "base").startsWith("top\ntheirs\nmid\n")).toBe(true);
    expect(resolveRegion(MARKED, second, "both").endsWith("mid\na\nb\nb2\nend\n")).toBe(true);
  });

  it("are not a region when a marker is missing, and work with CRLF lines", () => {
    expect(conflictRegions("<<<<<<< head\nours\n=======\ntheirs\n")).toEqual([]);
    expect(conflictRegions("x\n=======\n>>>>>>> base\n")).toEqual([]);
    const crlf = "<<<<<<< head\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> base\r\n";
    expect(conflictRegions(crlf).map((r) => r.base)).toEqual(["theirs\r\n"]);
  });
});

describe("a file's line breaks", () => {
  it("are told apart, and restored after the browser sends them as CRLF", () => {
    expect(lineEnding("a\nb\n")).toBe("lf");
    expect(lineEnding("no break")).toBe("lf");
    expect(lineEnding("a\r\nb\r\n")).toBe("crlf");
    expect(lineEnding("a\r\nb\n")).toBe("mixed");
    expect(withLineEndings("a\r\nb\r\n", "lf")).toBe("a\nb\n");
    expect(withLineEndings("a\r\nb\r\n", "crlf")).toBe("a\r\nb\r\n");
    expect(withLineEndings("a\r\nb\r\n", "mixed")).toBe("a\nb\n");
  });
});

describe("a branch name in a shell command", () => {
  it("is quoted, whatever it holds", () => {
    expect(shellQuote("topic")).toBe("'topic'");
    expect(shellQuote("x$(touch y);`z`")).toBe("'x$(touch y);`z`'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

const conflicts = (files: unknown[]) =>
  json({ base_sha: "a".repeat(40), head_sha: "b".repeat(40), conflict_snapshot: SNAPSHOT, files });

describe("the conflicts page", () => {
  it("reads an open pull request's conflicts with each file's line breaks", async () => {
    const { context } = api({
      "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest()),
      "GET /api/repos/ada/demo/pulls/7/conflicts": () =>
        conflicts([
          { path: "a.txt", kind: "content", editable: true, content: "x\r\ny\r\n", conflicts: 1 },
          { path: "b.bin", kind: "binary", editable: false, content: null, conflicts: 0 },
        ]),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/conflicts`),
      context,
      params,
    } as never);
    expect(data.conflicts?.files.map((f) => f.ending)).toEqual(["crlf", "lf"]);
  });

  it("shows the API's reason when the conflicts cannot be read, and none for a closed pull request", async () => {
    const tooBig = api({
      "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest()),
      "GET /api/repos/ada/demo/pulls/7/conflicts": () =>
        json({ code: "too_expensive", detail: "Too large to merge here: merge locally." }, 422),
    });
    const failed = await loader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/conflicts`),
      context: tooBig.context,
      params,
    } as never);
    expect(failed.failure).toBe("Too large to merge here: merge locally.");
    const closed = api({
      "GET /api/repos/ada/demo/pulls/7": () => json(pullRequest({ state: "closed" })),
    });
    const none = await loader({
      request: new Request(`${ORIGIN}/ada/demo/pull/7/conflicts`),
      context: closed.context,
      params,
    } as never);
    expect(none.conflicts).toBeNull();
    expect(closed.calls.some((c) => pathOf(c).includes("/conflicts"))).toBe(false);
  });

  const page = (files: Record<string, unknown>[], pull: Record<string, unknown> = {}) =>
    renderPage(PullConflicts, "/ada/demo/pull/7/conflicts", {
      owner: "ada",
      repo: "demo",
      pull: pullRequest({ mergeable: false, mergeable_state: "dirty", ...pull }),
      viewer: VIEWER,
      conflicts: {
        base_sha: "a".repeat(40),
        head_sha: "b".repeat(40),
        conflict_snapshot: SNAPSHOT,
        files: files.map((f) => ({ conflicts: 1, ending: "lf", ...f })),
      },
      failure: null,
    });

  it("edits the editable files and explains, quoted for the shell, the ones it cannot", () => {
    const html = page(
      [
        { path: "a.txt", kind: "content", editable: true, content: MARKED },
        { path: "gone.txt", kind: "modify_delete", editable: false, content: null },
      ],
      { head: { ref: "x;$(y)", sha: "b".repeat(40) } },
    );
    expect(html).toContain("2 conflicts left in this file.");
    expect(html).toContain("One side changed this file and the other deleted it.");
    expect(html).toContain("git switch &#x27;x;$(y)&#x27;");
    expect(html).toMatch(/<button type="submit" class="primary" disabled=""/);
    expect(html).toContain("Previous conflict");
    expect(html).toContain(`value="${SNAPSHOT}"`);
  });

  it("shows hostile paths, contents and branch names as text", () => {
    const html = page(
      [
        { path: HOSTILE, kind: "content", editable: true, content: `${HOSTILE}\n` },
        { path: `${HOSTILE}2`, kind: "symlink", editable: false, content: null },
      ],
      { head: { ref: HOSTILE, sha: "b".repeat(40) }, base: { ref: HOSTILE, sha: "a".repeat(40) } },
    );
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped(HOSTILE));
  });
});

describe("resolving conflicts", () => {
  async function resolve(fields: Record<string, string>, reply: () => Response) {
    const { context, calls } = api({ "POST /api/repos/ada/demo/pulls/7/conflicts": reply });
    const outcome = await action({
      request: formPost("/ada/demo/pull/7/conflicts", fields),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method === "POST");
    return { outcome, body: sent ? await sent.json() : undefined };
  }

  it("sends each file with its own line breaks, and the snapshot it was read at", async () => {
    const { outcome, body } = await resolve(
      {
        conflict_snapshot: SNAPSHOT,
        count: "2",
        "path:0": "a.txt",
        "eol:0": "lf",
        "content:0": "one\r\ntwo\r\n",
        "path:1": "dir/b.txt",
        "eol:1": "crlf",
        "content:1": "one\r\ntwo\r\n",
        commit_message: "",
      },
      () => json({ sha: "c".repeat(40), markers: ["dir/b.txt"] }, 201),
    );
    expect(body).toEqual({
      conflict_snapshot: SNAPSHOT,
      files: [
        { path: "a.txt", content: "one\ntwo\n" },
        { path: "dir/b.txt", content: "one\r\ntwo\r\n" },
      ],
    });
    expect(outcome).toEqual({ ok: true, sha: "c".repeat(40), markers: ["dir/b.txt"] });
  });

  it("says when either branch moved since, so the conflicts are read again", async () => {
    const { outcome } = await resolve({ conflict_snapshot: SNAPSHOT, count: "0" }, () =>
      json({ code: "head_moved", detail: "The head moved since the conflicts were read." }, 409),
    );
    expect(outcome).toEqual({
      error: "The head moved since the conflicts were read.",
      stale: true,
    });
  });

  it("refuses a form that is not one of its own without asking the API", async () => {
    for (const fields of [
      { conflict_snapshot: "nope", count: "0" },
      { conflict_snapshot: SNAPSHOT, count: "51" },
      { conflict_snapshot: SNAPSHOT, count: "1" },
    ]) {
      const { outcome, body } = await resolve(fields, () => json({}, 201));
      expect(outcome).toHaveProperty("error");
      expect(body).toBeUndefined();
    }
  });
});
