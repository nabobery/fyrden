// Resolving a pull request's conflicts in the browser: conflict regions read
// from git's markers (the head's side first), a side kept, each file's line
// breaks restored after the browser sends them all as CRLF, the snapshot
// sent back, files that cannot be edited here explained, and hostile paths
// and branch names shown as text.

import { describe, expect, it } from "vitest";
import { MAX_JSON_BODY_BYTES, readBoundedBody } from "../../api/src/http/body.js";
import { leftText } from "../app/components/conflict-editor.js";
import { API_MAX_JSON_BODY_BYTES } from "../app/lib/api.server.js";
import {
  conflictsView,
  lineEnding,
  readConflicts,
  resolveRegion,
  shellQuote,
  withLineEndings,
} from "../app/lib/conflicts.js";
import {
  action,
  CONFLICTS_FORM_MAX_BYTES,
  loader,
  default as PullConflicts,
} from "../app/routes/repo.pull.conflicts.js";
import { fakeApi, formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, pullRequest, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo", number: "7" };
const SNAPSHOT = "e".repeat(80);
const LABELS = { head: "topic", base: "main" };
const MARKED =
  "top\n<<<<<<< topic\nours\n=======\ntheirs\n>>>>>>> main\nmid\n<<<<<<< topic\na\n=======\nb\nb2\n>>>>>>> main\nend\n";

describe("conflict markers", () => {
  it("are read as regions with each side's lines", () => {
    const { regions, ambiguous, starts } = readConflicts(MARKED, LABELS);
    expect(ambiguous).toBe(false);
    expect(regions.map((r) => [r.head, r.base])).toEqual([
      ["ours\n", "theirs\n"],
      ["a\n", "b\nb2\n"],
    ]);
    expect(MARKED.slice(regions[0]?.start, regions[0]?.end)).toBe(
      "<<<<<<< topic\nours\n=======\ntheirs\n>>>>>>> main\n",
    );
    expect(starts).toEqual(regions.map((r) => r.start));
  });

  it("keep the side chosen, or both with the head's first", () => {
    const [first, second] = readConflicts(MARKED, LABELS).regions;
    if (!first || !second) throw new Error("no regions");
    expect(resolveRegion(MARKED, first, "head").startsWith("top\nours\nmid\n")).toBe(true);
    expect(resolveRegion(MARKED, first, "base").startsWith("top\ntheirs\nmid\n")).toBe(true);
    expect(resolveRegion(MARKED, second, "both").endsWith("mid\na\nb\nb2\nend\n")).toBe(true);
  });

  it("are whole marker lines only, and work with CRLF lines", () => {
    // Lines that only start like markers, or name other branches, are content.
    const text = "<<<<<<< topic\n<<<<<<<< x\n======= no\n=======\n>>>>>>> mainline\n>>>>>>> main\n";
    const { regions, ambiguous } = readConflicts(text, LABELS);
    expect(ambiguous).toBe(false);
    expect(regions.map((r) => [r.head, r.base])).toEqual([
      ["<<<<<<<< x\n======= no\n", ">>>>>>> mainline\n"],
    ]);
    const crlf = "<<<<<<< topic\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> main\r\n";
    expect(readConflicts(crlf, LABELS).regions.map((r) => r.base)).toEqual(["theirs\r\n"]);
    // A separator outside a conflict (a heading's underline) is content.
    expect(readConflicts("Title\n=======\n", LABELS)).toEqual({
      regions: [],
      ambiguous: false,
      starts: [],
    });
  });

  it("that do not read as whole conflicts are ambiguous, never a clean file", () => {
    for (const text of [
      // A start marker inside a conflict (literal, or nested).
      "<<<<<<< topic\nbefore\n<<<<<<< topic\nx\n=======\nbase\n>>>>>>> main\n",
      // Left open.
      "<<<<<<< topic\nours\n=======\ntheirs\n",
      "<<<<<<< topic\nours\n",
      // An end with no start, or before its separator.
      "x\n>>>>>>> main\n",
      "<<<<<<< topic\nours\n>>>>>>> main\n",
      // Two separators.
      "<<<<<<< topic\na\n=======\nb\n=======\nc\n>>>>>>> main\n",
    ]) {
      const reading = readConflicts(text, LABELS);
      expect(reading.ambiguous, text).toBe(true);
      expect(leftText(reading), text).toMatch(/edit it by hand/);
    }
  });

  it("say what is left: conflicts, marker-like lines, or none", () => {
    expect(leftText(readConflicts(MARKED, LABELS))).toBe("2 conflicts left in this file.");
    expect(leftText(readConflicts("<<<<<<< other\nx\n", LABELS))).toMatch(
      /look like conflict markers/,
    );
    expect(leftText(readConflicts("done\n", LABELS))).toBe("No conflict markers left.");
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
      number: 7,
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

  it("edits the editable files, reading their markers only once in the browser", () => {
    const html = page([{ path: "a.txt", kind: "content", editable: true, content: MARKED }]);
    expect(html).toContain(`value="${SNAPSHOT}"`);
    // The server's page: the text to edit, the markers not read yet, every control that
    // needs them off until the browser has read them.
    expect(html).toContain("Reading the conflict markers…");
    expect(html).not.toContain("conflicts left in this file");
    expect(
      html.match(
        /<button type="button" disabled="">(Previous conflict|Next conflict|Keep head|Keep base|Keep both)/g,
      ),
    ).toHaveLength(5);
    // What the browser then says, as it reads them (also when they are ambiguous).
    expect(leftText(readConflicts(MARKED, LABELS))).toBe("2 conflicts left in this file.");
    expect(leftText(null)).toBe("Reading the conflict markers…");
  });

  it("offers to read the conflicts again when the first read failed", () => {
    const html = renderPage(PullConflicts, "/ada/demo/pull/7/conflicts", {
      owner: "ada",
      repo: "demo",
      number: 7,
      pull: pullRequest({ mergeable: false, mergeable_state: "dirty" }),
      viewer: VIEWER,
      conflicts: null,
      failure: "Try again later.",
    });
    expect(html).toContain("Try again later.");
    expect(html).toMatch(/<button type="button">Try again<\/button>/);
    expect(html).not.toContain("No conflicts:");
  });

  it("explains, quoted for the shell, the conflicts it cannot edit", () => {
    const html = page(
      [
        { path: "a.txt", kind: "content", editable: true, content: MARKED },
        { path: "gone.txt", kind: "modify_delete", editable: false, content: null },
      ],
      { head: { ref: "x;$(y)", sha: "b".repeat(40) } },
    );
    expect(html).toContain("One side changed this file and the other deleted it.");
    expect(html).toContain("git switch &#x27;x;$(y)&#x27;");
    expect(html).toMatch(/<button type="submit" class="primary" disabled=""/);
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
    // The refusal names the snapshot it was about, so a later read can tell it is old news.
    expect(outcome).toEqual({
      error: "The head moved since the conflicts were read.",
      stale: true,
      snapshot: SNAPSHOT,
    });
  });

  /** What the page says when it cannot know whether the merge was made. */
  const UNKNOWN =
    "It is not known whether the merge was made: look at the pull request before sending it again.";

  it("answers, keeping the edits, when no answer comes back: the merge may have been made", async () => {
    const { outcome, body } = await resolve({ conflict_snapshot: SNAPSHOT, count: "0" }, () => {
      throw new TypeError("The service binding refused the request.");
    });
    expect(body).toEqual({ conflict_snapshot: SNAPSHOT, files: [] });
    expect(outcome).toEqual({ error: UNKNOWN, snapshot: SNAPSHOT });
    // The page keeps its editors and says why; the next read tells whether the merge was made.
    expect(
      conflictsView({
        adopted: SNAPSHOT,
        latest: SNAPSHOT,
        failure: null,
        open: true,
        answer: outcome,
      }),
    ).toMatchObject({ editors: true, showRefusal: true, moved: false });
  });

  it("tells a refusal from an answer that cannot prove nothing was made", async () => {
    // A server error (the merge may be made before it fails), a gateway's page, or a
    // refusal whose problem cannot be read: the outcome is not known.
    for (const reply of [
      () => json({ code: "internal", detail: "Something failed." }, 500),
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => new Response("not json", { status: 409 }),
    ]) {
      const { outcome } = await resolve({ conflict_snapshot: SNAPSHOT, count: "0" }, reply);
      expect(outcome).toEqual({ error: UNKNOWN, snapshot: SNAPSHOT });
    }
    // A refusal with its problem is one.
    const refused = await resolve({ conflict_snapshot: SNAPSHOT, count: "0" }, () =>
      json({ code: "too_large", detail: "Too large to merge here." }, 422),
    );
    expect(refused.outcome).toEqual({
      error: "Too large to merge here.",
      stale: false,
      snapshot: SNAPSHOT,
    });
  });

  it("answers, keeping the edits, when a success's answer cannot be read", async () => {
    for (const reply of ["{", JSON.stringify({ sha: 7 }), ""]) {
      const made = await resolve(
        { conflict_snapshot: SNAPSHOT, count: "0" },
        () => new Response(reply, { status: 201 }),
      );
      expect(made.outcome, reply).toEqual({
        error: "The merge was made, but its answer could not be read: look at the pull request.",
        snapshot: SNAPSHOT,
      });
    }
  });

  it("answers, keeping the edits, when the session cannot be checked, sending nothing", async () => {
    for (const session of [
      () => {
        throw new TypeError("The service binding refused the request.");
      },
      () => json({ code: "internal", detail: "down" }, 503),
      () => new Response("not json", { status: 200 }),
      () => json({ user: null }),
    ]) {
      const { context, calls } = fakeApi((r) =>
        new URL(r.url).pathname === "/auth/session" ? session() : json({}, 201),
      );
      const outcome = await action({
        request: formPost("/ada/demo/pull/7/conflicts", {
          conflict_snapshot: SNAPSHOT,
          count: "0",
        }),
        context,
        params,
      } as never);
      expect(outcome).toEqual({
        error: "Your session could not be checked, so nothing was sent: try again.",
      });
      expect(calls.map(pathOf)).toEqual(["GET /auth/session"]);
    }
  });

  it("sends a browser the session confirms is signed out to sign in", async () => {
    const { context, calls } = fakeApi(() => json({ code: "unauthorized" }, 401));
    const thrown = await action({
      request: formPost("/ada/demo/pull/7/conflicts", { conflict_snapshot: SNAPSHOT, count: "0" }),
      context,
      params,
    } as never).catch((e: unknown) => e);
    expect((thrown as Response).status).toBe(302);
    expect(calls.map(pathOf)).toEqual(["GET /auth/session"]);
  });

  it("refuses a file over 1 MiB, or files over 4 MiB in all, without asking the API", async () => {
    const big = "a".repeat(1024 * 1024 + 1);
    const tooLarge = await resolve(
      {
        conflict_snapshot: SNAPSHOT,
        count: "1",
        "path:0": "a.txt",
        "eol:0": "lf",
        "content:0": big,
      },
      () => json({}, 201),
    );
    expect(tooLarge.outcome).toMatchObject({
      error: "a.txt is larger than 1 MiB: merge it locally.",
    });
    expect(tooLarge.body).toBeUndefined();
    // Five files of 900 KiB: each fits, together they do not.
    const fields: Record<string, string> = { conflict_snapshot: SNAPSHOT, count: "5" };
    for (let i = 0; i < 5; i++) {
      fields[`path:${i}`] = `f${i}`;
      fields[`eol:${i}`] = "lf";
      fields[`content:${i}`] = "a".repeat(900 * 1024);
    }
    const together = await resolve(fields, () => json({}, 201));
    expect(together.outcome).toMatchObject({
      error: "The resolved files are larger than 4 MiB in all: merge them locally.",
    });
    expect(together.body).toBeUndefined();
  });

  it("refuses a form past its byte bound before reading it", async () => {
    const { context, calls } = api({});
    const request = new Request(`${ORIGIN}/ada/demo/pull/7/conflicts`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Cookie: "fyrden_session=s",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": String(13 * 1024 * 1024),
      },
      body: "a=1",
    });
    const thrown = await action({ request, context, params } as never).catch((e: unknown) => e);
    expect((thrown as { init?: { status?: number } }).init?.status).toBe(413);
    expect(calls.map(pathOf)).toEqual(["GET /auth/session"]);
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

describe("reading the conflicts again", () => {
  const read = (answer: (r: Request) => Response | Promise<Response>) => {
    const { context } = fakeApi(answer);
    return Promise.resolve(
      loader({
        request: new Request(`${ORIGIN}/ada/demo/pull/7/conflicts`),
        context,
        params,
      } as never),
    ).then(
      (value) => ({ value }),
      (thrown: unknown) => ({ thrown }),
    );
  };
  const path = (r: Request) => new URL(r.url).pathname;
  const session = () => json({ user: { id: VIEWER, handle: "ada" } });

  it("answers a failure, never throwing, when the pull request cannot be read", async () => {
    for (const answer of [
      (r: Request) => (path(r) === "/auth/session" ? session() : json({ detail: "down" }, 503)),
      (r: Request) => {
        if (path(r) === "/auth/session") return session();
        throw new TypeError("The service binding refused the request.");
      },
    ]) {
      const outcome = await read(answer);
      expect(outcome).toEqual({
        value: expect.objectContaining({
          pull: null,
          conflicts: null,
          failure: "The pull request could not be read; try again.",
        }),
      });
    }
  });

  it("answers a failure, never throwing, when the conflicts cannot be read", async () => {
    const outcome = await read((r) => {
      if (path(r) === "/auth/session") return session();
      if (path(r).endsWith("/conflicts"))
        throw new TypeError("The service binding refused the request.");
      return json(pullRequest());
    });
    expect(outcome).toEqual({
      value: expect.objectContaining({
        conflicts: null,
        failure: "The conflicts could not be read; try again.",
      }),
    });
    expect((outcome as { value: { pull: unknown } }).value.pull).not.toBeNull();
  });

  it("still sends a signed-out browser to sign in, and shows a missing pull request as not found", async () => {
    const signedOut = await read(() => json({}, 401));
    expect((signedOut as { thrown: Response }).thrown.status).toBe(302);
    const missing = await read((r) =>
      path(r) === "/auth/session" ? session() : json({ detail: "Not found" }, 404),
    );
    expect((missing as { thrown: { init: { status: number } } }).thrown.init.status).toBe(404);
  });

  it("shows a first read that failed, with a way to try again", () => {
    const html = renderPage(PullConflicts, "/ada/demo/pull/7/conflicts", {
      owner: "ada",
      repo: "demo",
      number: 7,
      pull: null,
      viewer: null,
      conflicts: null,
      failure: "The pull request could not be read; try again.",
    });
    expect(html).toContain("The pull request could not be read; try again.");
    expect(html).toContain("Try again");
  });
});

describe("the conflicts page's state", () => {
  const A = "a".repeat(80);
  const B = "b".repeat(80);
  const view = (s: Partial<Parameters<typeof conflictsView>[0]>) =>
    conflictsView({ adopted: A, latest: A, failure: null, open: true, ...s });

  it("edits and sends the conflicts read", () => {
    expect(view({})).toMatchObject({ editors: true, moved: false, canSubmit: true });
  });

  it("keeps the edits, refusing to send them, when the branches moved and a read again fails", () => {
    // Sent, refused: the base moved since.
    const refused = { error: "The base moved.", stale: true, snapshot: A };
    expect(view({ latest: B, answer: refused })).toMatchObject({
      editors: true,
      moved: true,
      canSubmit: false,
      showRefusal: true,
      readAgain: "adopt",
    });
    // The read after the refusal fails: the editors stay, nothing can be sent, and reading
    // again asks for a new read instead of taking a failed one.
    expect(view({ latest: null, failure: "Too large.", answer: refused })).toMatchObject({
      editors: true,
      canSubmit: false,
      readAgain: "revalidate",
    });
    // Read again with success: the fresh conflicts are taken, the old refusal no longer shown.
    expect(view({ adopted: B, latest: B, answer: refused })).toMatchObject({
      editors: true,
      moved: false,
      canSubmit: true,
      showRefusal: false,
    });
  });

  it("says when conflicts appear or go while the page is open, and stops after a resolution", () => {
    expect(view({ adopted: null, latest: B })).toMatchObject({ editors: false, moved: true });
    expect(view({ latest: null })).toMatchObject({ editors: true, moved: true, canSubmit: false });
    expect(view({ answer: { ok: true } })).toMatchObject({ editors: false, moved: false });
    // Closed meanwhile: the edits stay on the page, nothing is sent.
    expect(view({ open: false, latest: null })).toMatchObject({ editors: true, canSubmit: false });
  });
});

describe("the conflicts form as a browser sends it", () => {
  /** A multipart form as a browser builds it: every line break of a textarea as CRLF. */
  function multipart(fields: Record<string, string>): Request {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields))
      data.append(name, value.replace(/\r?\n/g, "\r\n"));
    return new Request(`${ORIGIN}/ada/demo/pull/7/conflicts`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: "fyrden_session=s" },
      body: data,
    });
  }

  /** Files of nothing but line breaks, as a browser sends them. */
  function newlineFiles(files: number, lines: number): Request {
    const fields: Record<string, string> = { conflict_snapshot: SNAPSHOT, count: String(files) };
    for (let i = 0; i < files; i++) {
      fields[`path:${i}`] = `f${i}.txt`;
      fields[`eol:${i}`] = "lf";
      fields[`content:${i}`] = "\n".repeat(lines);
    }
    return multipart(fields);
  }

  /** fyrden-api's resolution, reading its body with the API's own limiter and limit. */
  const realApi = () =>
    api({
      "POST /api/repos/ada/demo/pulls/7/conflicts": () =>
        json({ sha: "c".repeat(40), markers: [] }, 201),
    });

  it("uses the API's own JSON body limit", () => {
    expect(API_MAX_JSON_BODY_BYTES).toBe(MAX_JSON_BODY_BYTES);
  });

  it("takes newline-heavy LF files within what the API reads, sending LF", async () => {
    // Three files of 1,048,575 line breaks: about 6 MiB as JSON (each line break escaped).
    const files = 3;
    const lines = 1024 * 1024 - 1;
    const { context, calls } = realApi();
    const outcome = await action({ request: newlineFiles(files, lines), context, params } as never);
    expect(outcome).toMatchObject({ ok: true });
    const post = calls.find((c) => c.method === "POST");
    if (!post) throw new Error("not sent");
    // The API's own reader takes it.
    const read = await readBoundedBody(post.clone(), MAX_JSON_BODY_BYTES);
    expect(read).toBeDefined();
    const body = (await post.json()) as { files: { content: string }[] };
    expect(body.files.map((f) => f.content.length)).toEqual(Array(files).fill(lines));
    expect(body.files.every((f) => !f.content.includes("\r"))).toBe(true);
  }, 60_000);

  it("refuses, without sending them, files within their limits that the API could not read as JSON", async () => {
    // Four files of 1,048,575 line breaks: 4 MiB less 4 bytes as resolved (within the limits),
    // about 8 MiB as the browser sends them, and more than the API reads once escaped as JSON.
    const files = 4;
    const lines = 1024 * 1024 - 1;
    const request = newlineFiles(files, lines);
    const sentBytes = (await request.clone().arrayBuffer()).byteLength;
    expect(sentBytes).toBeGreaterThan(8 * 1024 * 1024 - 1024);
    expect(sentBytes).toBeLessThanOrEqual(CONFLICTS_FORM_MAX_BYTES);
    // What the action would send, measured as the API's reader measures it.
    const json = JSON.stringify({
      conflict_snapshot: SNAPSHOT,
      files: Array.from({ length: files }, (_, i) => ({
        path: `f${i}.txt`,
        content: "\n".repeat(lines),
      })),
    });
    const tooLong = new Request(`${ORIGIN}/x`, { method: "POST", body: json });
    expect(await readBoundedBody(tooLong, MAX_JSON_BODY_BYTES)).toBeUndefined();
    const { context, calls } = realApi();
    const outcome = await action({ request, context, params } as never);
    expect(outcome).toMatchObject({
      error:
        "These files are too large to send in one resolution: merge the base branch into the head with git instead.",
    });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  }, 60_000);
});
