// The file page as the server answers it: each kind of file's message and whether Raw can
// work, the numbered lines every link starts from, and the go-to-line redirect.

import { describe, expect, it } from "vitest";
import Blob, { loader as blob } from "../app/routes/repo.blob.js";
import { loader as raw } from "../app/routes/repo.raw.js";
import { dataSuffixRedirect } from "../workers/app.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";
import { renderPage } from "./helpers/render.js";

const SHA = "b".repeat(40);
const COMMIT = "c".repeat(40);

/** Runs the loader on `url` as React Router would, with the API answering `contents`. */
async function open(url: string, contents: unknown) {
  const { context, calls } = fakeApi(() => json(contents));
  const [, owner, repo] = new URL(url, ORIGIN).pathname.split("/");
  const outcome = await Promise.resolve(
    blob({
      request: new Request(new URL(url, ORIGIN)),
      context,
      params: { owner, repo },
      // biome-ignore lint/suspicious/noExplicitAny: the route's own argument type
    } as any),
  ).then(
    (value) => ({ value }),
    (thrown: unknown) => ({ thrown }),
  );
  return { ...outcome, calls };
}

const file = (text: string, path = "a.ts") => ({
  type: "file",
  path,
  name: path,
  sha: SHA,
  mode: "100644",
  size: new TextEncoder().encode(text).length,
  encoding: "base64",
  content: btoa(text),
  download_url: `${ORIGIN}/api/repos/ada/demo/raw/${path}?ref=${COMMIT}`,
});

/** The page at `url`, as the server draws it for `contents`. */
async function page(url: string, contents: unknown): Promise<string> {
  const { value } = (await open(url, contents)) as { value: unknown };
  return renderPage(Blob, url, value);
}

const rawButton = /<a class="button" href="([^"]*\/raw\/[^"]*)"/;
const TOO_LARGE = { ...file(""), encoding: "none", content: "" };

describe("each kind of file", () => {
  it.each([
    ["empty", file(""), "This file is empty."],
    ["binary", file("a\0b"), "This is a binary file."],
    ["undecodable", file("\xc3\x28"), "This file isn&#x27;t valid UTF-8."],
    ["too large", { ...TOO_LARGE, size: 2_000_000 }, "This file is too large to show here."],
  ])("says what a file %s is, with Raw", async (_kind, contents, message) => {
    const html = await page("/ada/demo/blob/main/a.ts", contents);
    expect(html).toContain(message);
    expect(html).toMatch(rawButton);
    // A file that can't be shown never reads as anything else.
    expect(html).not.toContain('id="L1"');
  });

  it("offers no Raw for a file over the raw route's limit, and says so", async () => {
    const html = await page("/ada/demo/blob/main/a.ts", { ...TOO_LARGE, size: 25 * 1024 * 1024 });
    expect(html).toContain("This file is too large to view or download here.");
    expect(html).not.toMatch(rawButton);
    expect(html).not.toContain("This file is too large to show here.");
  });

  it("names a submodule's commit, with no Raw", async () => {
    const html = await page("/ada/demo/blob/main/vendor", {
      type: "submodule",
      path: "vendor",
      name: "vendor",
      sha: SHA,
    });
    expect(html).toContain(`A submodule at commit <code>${SHA}</code>.`);
    expect(html).not.toMatch(rawButton);
  });

  it("names a symlink's target, with no Raw", async () => {
    const html = await page("/ada/demo/blob/main/link", {
      type: "symlink",
      path: "link",
      name: "link",
      sha: SHA,
      size: 6,
      target: "a/b.ts",
      content: btoa("a/b.ts"),
    });
    expect(html).toContain("A symbolic link to <code>a/b.ts</code>.");
    expect(html).not.toMatch(rawButton);
  });

  it("keeps Edit for what is text, the empty file included, and only that", async () => {
    const edit = /<a class="button"[^>]* href="[^"]*\/edit\//;
    expect(await page("/ada/demo/blob/main/a.ts", file("a\n"))).toMatch(edit);
    expect(await page("/ada/demo/blob/main/a.ts", file(""))).toMatch(edit);
    expect(await page("/ada/demo/blob/main/a.ts", file("a\0"))).not.toMatch(edit);
    expect(await page("/ada/demo/blob/main/a.ts", { ...TOO_LARGE, size: 2_000_000 })).not.toMatch(
      edit,
    );
  });

  it("links Raw with a trailing slash, which a name ending in .data needs", async () => {
    const html = await page("/ada/demo/blob/main/notes.data/", file("a\n", "notes.data"));
    expect(html.match(rawButton)?.[1]).toBe("/ada/demo/raw/main/notes.data/");
  });

  it("still leads a missing file back to its history", async () => {
    const { context } = fakeApi(() => json({ code: "not_found", detail: "Not found" }, 404));
    const { data: missing } = (await blob({
      request: new Request(`${ORIGIN}/ada/demo/blob/main/gone.ts`),
      context,
      params: { owner: "ada", repo: "demo" },
      // biome-ignore lint/suspicious/noExplicitAny: the route's own argument type
    } as any)) as unknown as { data: unknown };
    const html = renderPage(Blob, "/ada/demo/blob/main/gone.ts", missing);
    expect(html).toContain("This file doesn&#x27;t exist at");
    expect(html).toContain('href="/ada/demo/commits/main/gone.ts"');
  });
});

describe("a file's numbered lines", () => {
  const lineCount = (html: string) => html.match(/ id="L\d+"/g)?.length ?? 0;

  it("numbers lines as the renderer does: the final ending off", async () => {
    for (const [text, lines] of [
      ["a\n", 1],
      ["a", 1],
      ["\n", 1],
      ["a\r\nb\r\n", 2],
      ["a\rb", 2],
      ["a\nb\r\nc\rd\n", 4],
    ] as const) {
      const html = await page("/ada/demo/blob/main/a.ts", file(text));
      expect(lineCount(html), JSON.stringify(text)).toBe(lines);
    }
  });

  it("gives every line a canonical link", async () => {
    const html = await page("/ada/demo/blob/main/a.ts", file("a\nb\n"));
    expect(html).toContain('<a id="L1" href="?line=1#L1"');
    expect(html).toContain('<a id="L2" href="?line=2#L2"');
  });

  it("marks the query's lines with <mark>, and no others", async () => {
    const html = await page("/ada/demo/blob/main/a.ts?line=3-2", file("a\nb\nc\nd\n"));
    expect(html.match(/<mark/g)?.length).toBe(2);
    expect(html).toMatch(/<mark[^>]*><a id="L2"/);
    expect(html).toMatch(/<mark[^>]*><a id="L3"/);
  });

  it("escapes the file's text", async () => {
    const html = await page("/ada/demo/blob/main/a.ts", file('<img src=x onerror="alert(1)">\n'));
    expect(html).not.toContain("<img");
  });

  it("offers go-to-line as a native form, on a numbered file only", async () => {
    const html = await page("/ada/demo/blob/main/a.ts", file("a\n"));
    expect(html).toMatch(/<form[^>]*method="get"/);
    expect(html).toContain('name="goto"');
    expect(html).not.toContain('name="plain"');
    expect(await page("/ada/demo/blob/main/a.ts", file(""))).not.toContain('name="goto"');
  });
});

describe("a file sent in blocks", () => {
  const big = (lines: number) =>
    file(Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"));
  const hrefOf = (html: string, label: string) => {
    const link = new RegExp(`<a href="([^"]*)"[^>]*>${label}`).exec(html)?.[1];
    return link?.replaceAll("&amp;", "&");
  };

  it("sends one block, and pages by links that keep the range", async () => {
    const first = await page("/ada/demo/blob/main/a.ts?line=1999-2002", big(4_500));
    expect(first).toContain('id="L1"');
    expect(first).toContain('id="L2000"');
    expect(first).not.toContain('id="L2001"');
    expect(first.match(/<mark/g)?.length).toBe(2);
    expect(hrefOf(first, "Next")).toBe("?from=2001&line=1999-2002");
    expect(hrefOf(first, "Previous")).toBeUndefined();

    const second = await page("/ada/demo/blob/main/a.ts?from=2001&line=1999-2002", big(4_500));
    expect(second).toContain('id="L2001"');
    expect(second).not.toContain('id="L2000"');
    expect(second.match(/<mark/g)?.length).toBe(2);
    expect(hrefOf(second, "Previous")).toBe("?from=1&line=1999-2002");
    expect(hrefOf(second, "Next")).toBe("?from=4001&line=1999-2002");
  });

  it("marks a line over the limit as cut, and leads to Raw", async () => {
    const html = await page(
      "/ada/demo/blob/main/a.ts",
      file(`${"y".repeat(64 * 1024 + 1)}\nafter\n`),
    );
    expect(html).toContain("This line is cut at 64 KiB");
    expect(html).toMatch(/This line is cut at 64 KiB[^<]*<a href="\/ada\/demo\/raw\/main\/a.ts\/"/);
  });

  it("does not send the rest of the file", async () => {
    const { value } = (await open("/ada/demo/blob/main/a.ts", big(4_500))) as {
      value: { file: { text: string } };
    };
    expect(value.file.text).not.toContain("line 2001");
    expect(value.file.text.length).toBeLessThan(20_000);
  });
});

describe("a Markdown file", () => {
  const md = (text: string) => file(text, "README.md");

  it("shows its rendered view whole, with a link to its source", async () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n");
    const html = await page("/ada/demo/blob/main/README.md?line=5", md(lines));
    expect(html).not.toContain('id="L1"');
    expect(html).not.toContain("<mark");
    expect(html).toContain("line 2999");
    expect(html).toMatch(/<a class="button" href="\?plain=1"[^>]*>Source/);
  });

  it("shows its source with plain=1, keeping it on every link", async () => {
    const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n");
    const html = await page("/ada/demo/blob/main/README.md?plain=1&line=5", md(lines));
    expect(html).toContain('<a id="L5" href="?plain=1&amp;line=5#L5"');
    expect(html.match(/<mark/g)?.length).toBe(1);
    expect(html).toContain('href="?plain=1&amp;from=2001&amp;line=5"');
    expect(html).toMatch(/<input type="hidden" name="plain" value="1"/);
    expect(html).not.toContain(">Source<");
  });

  it("is an ordinary file's message when its bytes aren't text", async () => {
    expect(await page("/ada/demo/blob/main/README.md", md(""))).toContain("This file is empty.");
    expect(await page("/ada/demo/blob/main/README.md", md("a\0"))).toContain(
      "This is a binary file.",
    );
  });

  it("treats plain=1 as nothing on a file that isn't Markdown", async () => {
    const html = await page("/ada/demo/blob/main/a.ts?plain=1", file("a\n"));
    expect(html).toContain('<a id="L1" href="?line=1#L1"');
  });
});

describe("go to line", () => {
  const FOUR = file("a\nb\nc\nd\n");

  /** Asks for `url`: the redirect, then what its target answers, which must not be another. */
  async function follow(url: string, contents: unknown = FOUR) {
    const first = (await open(url, contents)) as { thrown?: Response; value?: unknown };
    const answer = first.thrown;
    if (!(answer instanceof Response)) throw new Error(`no redirect from ${url}`);
    expect(answer.status).toBe(302);
    const location = answer.headers.get("Location") ?? "";
    const target = new URL(location, ORIGIN);
    expect(target.origin).toBe(ORIGIN);
    // What the browser asks for next: the Worker's own redirect, then the page's loader.
    const next = new Request(target, { headers: { "Sec-Fetch-Mode": "navigate" } });
    expect(dataSuffixRedirect(next), location).toBeUndefined();
    const second = (await open(`${target.pathname}${target.search}`, contents)) as {
      thrown?: unknown;
      value?: unknown;
    };
    expect(second.thrown, location).toBeUndefined();
    return { location, page: second.value };
  }

  it("redirects to the line, and the answer there is the page", async () => {
    const { location, page: opened } = await follow("/ada/demo/blob/main/a.ts?goto=3");
    expect(location).toBe("/ada/demo/blob/main/a.ts?line=3#L3");
    expect(opened).toMatchObject({ file: { selected: { start: 3, end: 3 } } });
  });

  it("clamps to the last line, past the first block too", async () => {
    const big = file(Array.from({ length: 4_500 }, (_, i) => `line ${i + 1}`).join("\n"));
    const { location, page: opened } = await follow("/ada/demo/blob/main/a.ts?goto=99999", big);
    expect(location).toBe("/ada/demo/blob/main/a.ts?line=4500#L4500");
    expect(opened).toMatchObject({ file: { firstLine: 4_001 } });
  });

  it("drops from, and keeps plain=1", async () => {
    const md = file("a\nb\n", "README.md");
    const { location } = await follow("/ada/demo/blob/main/README.md?plain=1&from=2&goto=2", md);
    expect(location).toBe("/ada/demo/blob/main/README.md?plain=1&line=2#L2");
  });

  it.each([
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    "+1",
    "L3",
    "%0d%0aSet-Cookie:x=1",
    "//evil.test",
    "https://evil.test/",
  ])("goes nowhere for goto=%s", async (value) => {
    const { location } = await follow(`/ada/demo/blob/main/a.ts?line=2&goto=${value}`);
    expect(location).toBe("/ada/demo/blob/main/a.ts");
  });

  it("keeps a name ending in .data, on a page and on its data request", async () => {
    const notes = file("a\nb\n", "notes.data");
    const fromPage = await follow("/ada/demo/blob/main/notes.data/?goto=2", notes);
    expect(fromPage.location).toBe("/ada/demo/blob/main/notes.data/?line=2#L2");
    const fromData = await follow("/ada/demo/blob/main/notes.data.data?goto=2&_routes=x", notes);
    expect(fromData.location).toBe("/ada/demo/blob/main/notes.data/?line=2#L2");
  });

  it("goes nowhere on a file with no lines to go to", async () => {
    const { location } = await follow("/ada/demo/blob/main/a.ts?goto=2", file(""));
    expect(location).toBe("/ada/demo/blob/main/a.ts");
  });

  it("answers a directory's redirect first, as it always did", async () => {
    const { thrown } = (await open("/ada/demo/blob/main/docs?goto=2", {
      type: "dir",
      entries: [],
      next_cursor: null,
    })) as { thrown: Response };
    expect(thrown.headers.get("Location")).toBe("/ada/demo/tree/main/docs");
  });
});

describe("the raw route with a trailing slash", () => {
  it("reads the same file, whatever its name ends in", async () => {
    const { context, calls } = fakeApi(() => new Response("hi"));
    await raw({
      request: new Request(`${ORIGIN}/ada/demo/raw/${COMMIT}/docs/notes.data/`),
      context,
      params: { owner: "ada", repo: "demo" },
      // biome-ignore lint/suspicious/noExplicitAny: the route's own argument type
    } as any);
    const asked = new URL(calls[0]?.url ?? "");
    expect(`${asked.pathname}${asked.search}`).toBe(
      `/api/repos/ada/demo/raw/docs/notes.data?ref=${COMMIT}`,
    );
  });
});
