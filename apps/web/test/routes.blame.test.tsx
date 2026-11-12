// The blame page as the server answers it, with no script: blame asked first, the text read
// at the commit it answered, every state's sentence, the table of groups and lines, and links
// that all name that commit.

import { describe, expect, it } from "vitest";
import Blame, { loader as blame, headers } from "../app/routes/repo.blame.js";
import Blob, { loader as blob } from "../app/routes/repo.blob.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const COMMIT = "c".repeat(40);
const BLOB = "b".repeat(40);
const A = "a".repeat(40);
const B = "d".repeat(40);

const contents = (text: string | Uint8Array, extra: Record<string, unknown> = {}) => {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  return {
    type: "file",
    path: "src/a.ts",
    name: "a.ts",
    sha: BLOB,
    mode: "100644",
    size: bytes.length,
    encoding: "base64",
    content: btoa(String.fromCharCode(...bytes)),
    download_url: `${ORIGIN}/api/repos/ada/demo/raw/src/a.ts?ref=${COMMIT}`,
    ...extra,
  };
};

const facts = (summary: string, name = "Ada") => ({
  summary,
  author: { name, email: "ada@example.com", date: "1700000000 +0000" },
});

const answer = (extra: Record<string, unknown> = {}) => ({
  commit: COMMIT,
  path: "src/a.ts",
  blob: BLOB,
  lines: 3,
  state: "complete",
  resolved_lines: 3,
  unresolved_lines: 0,
  pending_lines: 0,
  ranges: [
    { start_line: 1, line_count: 2, commit: A, source_start_line: 1 },
    { start_line: 3, line_count: 1, commit: B, source_start_line: 9 },
  ],
  commits: { [A]: facts("First"), [B]: facts("Second", "Grace") },
  next_continuation: null,
  ...extra,
});

/** The loader at `url`, with the API answering blame with `blameAnswer` and contents with `file`. */
async function open(
  url: string,
  blameAnswer: () => Response,
  file: () => Response = () => json(contents("one\ntwo\nthree\n")),
) {
  const { context, calls } = fakeApi((request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/repos/ada/demo/blame") return blameAnswer();
    if (path.startsWith("/api/repos/ada/demo/contents/")) return file();
    return json({ code: "not_found" }, 404);
  });
  const outcome = await Promise.resolve(
    blame({
      request: new Request(new URL(url, ORIGIN)),
      context,
      params: { owner: "ada", repo: "demo" },
      // biome-ignore lint/suspicious/noExplicitAny: the route's own argument type
    } as any),
  ).then(
    (value) => ({ value, thrown: undefined }),
    (thrown: unknown) => ({ value: undefined, thrown }),
  );
  return { ...outcome, calls };
}

/** Loader data, and the status a `data()` answer set. */
function unwrap(value: unknown): { data: unknown; status: number; headers: Headers } {
  if (value && typeof value === "object" && "init" in value && "data" in value) {
    const init = (value as { init?: ResponseInit }).init ?? {};
    return {
      data: (value as { data: unknown }).data,
      status: init.status ?? 200,
      headers: new Headers(init.headers),
    };
  }
  return { data: value, status: 200, headers: new Headers() };
}

/** The route's `headers` with a loader's own, as React Router calls it for the page. */
const pageHeaders = (loaderHeaders: Headers) =>
  // biome-ignore lint/suspicious/noExplicitAny: the generated argument's other fields go unread
  headers({ loaderHeaders } as any);

async function page(url: string, blameAnswer: () => Response, file?: () => Response) {
  const { value, thrown, calls } = await open(url, blameAnswer, file);
  if (thrown) throw thrown;
  const { data, status, headers } = unwrap(value);
  return { html: renderPage(Blame, url.split("#")[0] as string, data), status, headers, calls };
}

const URL_ = "/ada/demo/blame/main/src/a.ts";
const at = (query = "") => `/ada/demo/blame/${COMMIT}/src/a.ts${query}`;

describe("asking", () => {
  it("asks blame first, for the window holding the line, then the text at the commit it answered", async () => {
    // Past this three-line file's end, so it then redirects: only the calls matter here.
    const { calls } = await open(`${URL_}?line=2500`, () => json(answer()));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/repos/ada/demo/blame",
      "/api/repos/ada/demo/contents/src/a.ts",
    ]);
    const asked = new URL((calls[0] as Request).url).searchParams;
    expect(Object.fromEntries(asked)).toEqual({
      path: "src/a.ts",
      ref: "main",
      line_start: "501",
      line_end: "4499",
    });
    expect(new URL((calls[1] as Request).url).searchParams.get("ref")).toBe(COMMIT);
  });

  it("asks within the API's safe numbers whatever the URL says", async () => {
    const { calls } = await open(`${URL_}?from=9007199254740992`, () => json(answer()));
    const asked = new URL((calls[0] as Request).url).searchParams;
    expect(asked.get("line_start")).toBe("98001");
    expect(asked.get("line_end")).toBe("101999");
  });

  it("sends a go-to-line on without asking the API, capped at blame's limit", async () => {
    for (const [goto, location] of [
      ["7", `${URL_}?line=7#L7`],
      ["0007", `${URL_}?line=7#L7`],
      [`${"9".repeat(30)}`, `${URL_}?line=100000#L100000`],
      ["nonsense", URL_],
    ] as const) {
      const { thrown, calls } = await open(`${URL_}?goto=${goto}&from=5`, () => json(answer()));
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("Location")).toBe(location);
      expect(calls).toHaveLength(0);
    }
  });

  it("sends a line past the end to the last window at the commit read, naming the last line", async () => {
    const { thrown } = await open(`${URL_}?line=9000`, () => json(answer()));
    const location = (thrown as Response).headers.get("Location") as string;
    expect(location).toBe(at("?line=9000&from=1#L3"));
    // Followed while the branch has moved on: the page asks for the commit it was redirected to.
    const followed = await open(location.split("#")[0] as string, () =>
      json(answer({ commit: COMMIT })),
    );
    expect(followed.thrown).toBeUndefined();
    const asked = new URL((followed.calls[0] as Request).url).searchParams;
    expect(asked.get("ref")).toBe(COMMIT);
  });

  it("keeps a from past the end as a window only: the fragment is the page's own", async () => {
    const { thrown } = await open(`${URL_}?from=9000&line=2`, () => json(answer()));
    expect((thrown as Response).headers.get("Location")).toBe(at("?from=1&line=2"));
  });

  it("sends a signed-out viewer to sign in", async () => {
    const { thrown } = await open(URL_, () => json({ code: "unauthorized" }, 401));
    expect((thrown as Response).headers.get("Location")).toMatch(/^\/auth\/sign-in\?return_to=/);
  });
});

describe("the table", () => {
  it("draws each group above its lines, with links that name the commit", async () => {
    const { html, status } = await page(URL_, () => json(answer()));
    expect(status).toBe(200);
    const first = html.indexOf("First");
    const second = html.indexOf("Second");
    expect(first).toBeGreaterThan(0);
    expect(html.indexOf('id="L1"')).toBeGreaterThan(first);
    expect(html.indexOf('id="L2"')).toBeLessThan(second);
    expect(html.indexOf('id="L3"')).toBeGreaterThan(second);
    expect(html).toContain(`href="${at("?line=2#L2")}"`);
    expect(html).toContain(`href="/ada/demo/commits/${A}/src/a.ts"`);
    expect(html).toContain("Grace");
    expect(html).toContain("2023-11-14");
    expect(html).toContain("Renames aren&#x27;t followed.");
    expect(html).not.toContain("Continue");
  });

  it("marks the selected lines", async () => {
    const { html } = await page(`${URL_}?line=2-3`, () => json(answer()));
    expect(html.match(/<tr class="blame-line selected"/g)).toHaveLength(2);
  });

  it("numbers lines at line feeds only, drawing a lone CR as ␍", async () => {
    const { html } = await page(
      URL_,
      () =>
        json(
          answer({
            lines: 2,
            ranges: [{ start_line: 1, line_count: 2, commit: A, source_start_line: 1 }],
          }),
        ),
      () => json(contents("a\r\nb\rc\n")),
    );
    expect(html).toContain('id="L2"');
    expect(html).not.toContain('id="L3"');
    expect(html).toContain("b␍c");
    expect(html).not.toContain("\r");
  });

  it("escapes what commits say", async () => {
    const { html } = await page(URL_, () =>
      json(answer({ commits: { [A]: facts(HOSTILE, HOSTILE), [B]: facts("Second") } })),
    );
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain(escaped("<script>alert(1)</script>"));
  });

  it("names a commit with no facts by its id", async () => {
    const { html } = await page(URL_, () => json(answer({ commits: { [B]: facts("Second") } })));
    expect(html).toContain(A.slice(0, 7));
  });
});

describe("a partial blame", () => {
  const partial = () =>
    json(
      answer({
        state: "partial",
        resolved_lines: 1,
        unresolved_lines: 1,
        pending_lines: 1,
        ranges: [
          { start_line: 1, line_count: 1, commit: A, source_start_line: 1 },
          { start_line: 3, line_count: 1, unresolved: "object_limit" },
        ],
        commits: { [A]: facts("First") },
      }),
    );

  it("says what is worked out, marks pending and refused lines in words, and continues at the commit", async () => {
    const { html } = await page(`${URL_}?line=2`, partial);
    expect(html).toContain("2 of 3 lines worked out so far.");
    expect(html).toContain("Not worked out yet.");
    expect(html).toContain("requires an object larger than Fyrden&#x27;s 4 MiB blame limit");
    expect(html).toContain(`href="${at("?from=1&amp;line=2")}">Continue</a>`);
  });

  it("goes to lines at the commit, not the ref that may move", async () => {
    const { html } = await page(URL_, partial);
    expect(html).toContain(`action="${at()}"`);
  });
});

it("says a complete blame with unattributed lines isn't wholly attributed", async () => {
  const { html } = await page(URL_, () =>
    json(
      answer({
        resolved_lines: 2,
        unresolved_lines: 1,
        ranges: [
          { start_line: 1, line_count: 2, commit: A, source_start_line: 1 },
          { start_line: 3, line_count: 1, unresolved: "rename_possible" },
        ],
      }),
    ),
  );
  expect(html).toContain("1 of 3 lines couldn&#x27;t be attributed");
  expect(html).toContain("blame doesn&#x27;t follow renames");
  expect(html).not.toContain("Continue");
});

describe("pages of a large file", () => {
  it("draws one window, with the ranges over it and links to the next", async () => {
    const text = "x\n".repeat(4_500);
    const ranges = [
      { start_line: 1, line_count: 2_100, commit: A, source_start_line: 1 },
      { start_line: 2_101, line_count: 2_400, commit: B, source_start_line: 1 },
    ];
    const { html } = await page(
      `${URL_}?from=2001`,
      () => json(answer({ lines: 4_500, resolved_lines: 4_500, ranges })),
      () => json(contents(text)),
    );
    expect(html).toContain('id="L2001"');
    expect(html).toContain('id="L4000"');
    expect(html).not.toContain('id="L4001"');
    expect(html).toContain("Lines 2,001 to 4,000 of 4,500");
    expect(html).toContain(`href="${at("?from=1")}">Previous</a>`);
    expect(html).toContain(`href="${at("?from=4001")}">Next</a>`);
    // The group that started before this window is named again at its top.
    expect(html.indexOf("First")).toBeLessThan(html.indexOf('id="L2001"'));
  });
});

describe("states", () => {
  const refusal =
    (status: number, code: string, extra: Record<string, unknown> = {}) =>
    () =>
      json(
        { status, code, detail: "API words", ...extra },
        status,
        extra.retry_after ? { "Retry-After": String(extra.retry_after) } : {},
      );

  it("says blame is busy, with a link to try again, and passes the wait on", async () => {
    const { html, status, headers } = await page(
      URL_,
      refusal(503, "blame_busy", { retry_after: 3 }),
    );
    expect(status).toBe(503);
    expect(headers.get("Retry-After")).toBe("3");
    // The page's own answer carries it: a loader's headers reach it only through `headers`.
    expect(new Headers(pageHeaders(headers)).get("Retry-After")).toBe("3");
    expect(new Headers(pageHeaders(new Headers())).has("Retry-After")).toBe(false);
    expect(html).toContain("Blame is busy right now. Try again in a moment.");
    expect(html).toContain(`href="${URL_}">Try again</a>`);
  });

  it.each([
    ["file_too_large", "This file is too large to blame."],
    [
      "object_limit",
      "This file could not be blamed because reading it requires an object larger than Fyrden&#x27;s 4 MiB blame limit. The file itself may be smaller.",
    ],
    [
      "work_limit",
      "This file could not be blamed because reaching it takes more reads or decoding than one request allows.",
    ],
    ["ref_unreadable", "This ref couldn&#x27;t be read for blame."],
  ])("says a %s refusal in its own words", async (code, sentence) => {
    const { html, status } = await page(URL_, refusal(422, code));
    expect(status).toBe(422);
    expect(html).toContain(sentence);
    expect(html).not.toContain("API words");
  });

  it("leads a missing file back to its history", async () => {
    const { html, status, calls } = await page(URL_, refusal(404, "path_not_found"), () =>
      json({ code: "path_not_found" }, 404),
    );
    expect(status).toBe(404);
    expect(html).toContain("doesn&#x27;t exist at");
    expect(html).toContain('href="/ada/demo/commits/main/src/a.ts"');
    expect(new URL((calls[1] as Request).url).searchParams.get("ref")).toBe("main");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [500, "internal"],
  ])(
    "keeps a %i from the second look as the page's own, not a missing file",
    async (code, name) => {
      const { thrown, value } = await open(URL_, refusal(404, "path_not_found"), () =>
        json({ status: code, code: name, detail: "words" }, code),
      );
      expect(value).toBeUndefined();
      if (code === 401)
        expect((thrown as Response).headers.get("Location")).toMatch(/^\/auth\/sign-in/);
      else expect((thrown as { init?: ResponseInit }).init?.status).toBe(code);
    },
  );

  it("says a submodule is one: blame finds no file there", async () => {
    const { html, status } = await page(URL_, refusal(404, "path_not_found"), () =>
      json({ type: "submodule", path: "src/a.ts", name: "a.ts", sha: A }),
    );
    expect(status).toBe(200);
    expect(html).toContain(`A submodule at commit ${A}.`);
    expect(html).not.toContain("doesn&#x27;t exist");
  });

  it("sends a directory to its listing", async () => {
    const { thrown } = await open(URL_, refusal(404, "path_not_found"), () =>
      json({ type: "dir", entries: [] }),
    );
    expect((thrown as Response).headers.get("Location")).toBe("/ada/demo/tree/main/src/a.ts");
  });

  it("says an empty repository is empty", async () => {
    const { html, status } = await page(URL_, refusal(409, "repo_empty"));
    expect(status).toBe(409);
    expect(html).toContain("This repository is empty.");
  });

  it.each([
    ["empty", contents(""), "This file is empty.", false],
    ["binary", contents("a\0b"), "This is a binary file.", true],
    [
      "undecodable",
      contents(new Uint8Array([0xc3, 0x28])),
      "This file isn&#x27;t valid UTF-8.",
      true,
    ],
    [
      "too large",
      contents("", { encoding: "none", content: "", size: 2_000_000 }),
      "This file is too large to blame.",
      false,
    ],
    [
      "a symlink",
      { type: "symlink", path: "src/a.ts", name: "a.ts", sha: BLOB, target: "b.ts" },
      "A symbolic link to",
      false,
    ],
  ])("says what a %s file is, drawing no blame", async (_kind, file, message, linksFile) => {
    const { html } = await page(
      URL_,
      () => json(answer({ lines: 1 })),
      () => json(file),
    );
    expect(html).toContain(message);
    expect(html).not.toContain('id="L1"');
    expect(html).not.toContain("First");
    expect(html.includes(`href="/ada/demo/blob/${COMMIT}/src/a.ts"`)).toBe(true);
    if (linksFile) expect(html).toContain(">See the file</a>");
  });

  it("draws no blame when the text isn't the blob blame answered for", async () => {
    const { html, status } = await page(URL_, () => json(answer({ blob: "" })));
    expect(status).toBe(502);
    expect(html).toContain("This file&#x27;s lines couldn&#x27;t be matched to its blame.");
    expect(html).not.toContain("First");
  });

  it("draws no blame when the lines don't add up", async () => {
    const { html, status } = await page(URL_, () => json(answer({ lines: 4 })));
    expect(status).toBe(502);
    expect(html).toContain("This file&#x27;s lines couldn&#x27;t be matched to its blame.");
  });

  it("counts a file holding only a byte order mark as its one line", async () => {
    const { html } = await page(
      URL_,
      () =>
        json(
          answer({
            lines: 1,
            ranges: [{ start_line: 1, line_count: 1, commit: A, source_start_line: 1 }],
          }),
        ),
      () => json(contents(new Uint8Array([0xef, 0xbb, 0xbf]))),
    );
    expect(html).toContain('id="L1"');
    expect(html).toContain("First");
  });
});

describe("the file page", () => {
  async function blobPage(file: unknown) {
    const { context } = fakeApi(() => json(file));
    const value = await blob({
      request: new Request(`${ORIGIN}/ada/demo/blob/main/src/a.ts`),
      context,
      params: { owner: "ada", repo: "demo" },
      // biome-ignore lint/suspicious/noExplicitAny: the route's own argument type
    } as any);
    return renderPage(Blob, "/ada/demo/blob/main/src/a.ts", value);
  }

  it("links a file's blame beside its history", async () => {
    const html = await blobPage(contents("a\n"));
    expect(html).toMatch(
      />History<\/a><a class="button" href="\/ada\/demo\/blame\/main\/src\/a.ts"[^>]*>Blame<\/a>/,
    );
  });

  it("offers no blame for a symlink or a submodule", async () => {
    for (const file of [
      { type: "symlink", path: "src/a.ts", name: "a.ts", sha: BLOB, target: "b.ts" },
      { type: "submodule", path: "src/a.ts", name: "a.ts", sha: BLOB },
    ])
      expect(await blobPage(file)).not.toContain(">Blame</a>");
  });
});
