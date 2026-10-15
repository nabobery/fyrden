import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../app/lib/markdown.js";

describe("README rendering", () => {
  it("renders GitHub-flavored Markdown", () => {
    const html = renderMarkdown(
      "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~ https://example.com",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain('<a href="https://example.com">');
  });

  it("escapes raw HTML and drops unsafe links", () => {
    for (const source of [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      '<svg onload="alert(1)"><circle/></svg>',
      "<iframe src=javascript:alert(1)></iframe>",
    ]) {
      const html = renderMarkdown(source);
      expect(html).not.toMatch(/<(script|img|svg|iframe)\b/i);
    }
    for (const link of [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "[x](vbscript:msgbox(1))",
      "![x](javascript:alert(1))",
    ])
      expect(renderMarkdown(link)).not.toMatch(/(href|src)="(javascript|data|vbscript):/i);
  });

  it("keeps a Mermaid diagram as a code block for the client to draw", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B\n```");
    expect(html).toContain('<code class="language-mermaid">graph TD; A--&gt;B');
  });
});

describe("a Markdown file's own links", () => {
  const at = { base: "/ada/demo", ref: "main", dir: "sub dir" };
  const hrefs = (source: string) =>
    [...renderMarkdown(source, at).matchAll(/ (href|src)="([^"]*)"/g)].map((m) => m[2]);

  it("go to the repository's files at the same ref, from the file's directory", () => {
    expect(
      hrefs(
        "[a](guide.md) [b](./x/y.md#part) [c](../top.md) [d](/README.md) [e](docs/) [f](../../../../out.md) [g](a%20b.md?plain=1)",
      ),
    ).toEqual([
      "/ada/demo/blob/main/sub%20dir/guide.md",
      "/ada/demo/blob/main/sub%20dir/x/y.md#part",
      "/ada/demo/blob/main/top.md",
      "/ada/demo/blob/main/README.md",
      "/ada/demo/tree/main/sub%20dir/docs",
      "/ada/demo/blob/main/out.md",
      "/ada/demo/blob/main/sub%20dir/a%20b.md?plain=1",
    ]);
  });

  it("take a path with a colon, or what looks like an address, as a path from the top", () => {
    expect(hrefs("[a](/http:) [b](/http://[) [c](/foo:bar) ![d](/x:y.png)")).toEqual([
      "/ada/demo/blob/main/http:",
      "/ada/demo/blob/main/http://%5B",
      "/ada/demo/blob/main/foo:bar",
      "/ada/demo/raw/main/x:y.png",
    ]);
  });

  it("show the repository's images as their bytes", () => {
    expect(hrefs("![i](img/a.png)")).toEqual(["/ada/demo/raw/main/sub%20dir/img/a.png"]);
  });

  it("leave other sites, anchors and mail alone", () => {
    expect(
      hrefs("[a](https://e.example/x) [b](//e.example/y) [c](#top) [d](mailto:a@b.c)"),
    ).toEqual(["https://e.example/x", "//e.example/y", "#top", "mailto:a@b.c"]);
  });

  it("keep a link's escaping", () => {
    expect(hrefs('[a](x.md?a=1&b="2")')).toEqual([
      "/ada/demo/blob/main/sub%20dir/x.md?a=1&amp;b=%222%22",
    ]);
  });
});
