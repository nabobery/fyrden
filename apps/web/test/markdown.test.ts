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
