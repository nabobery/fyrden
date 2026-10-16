// Markdown is rendered in the browser only: the server's page shows the
// source as plain text (escaped, whitespace kept), and the renderer the
// browser runs keeps hostile comments, reviews and READMEs inert.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "../app/components/markdown.js";
import { renderMarkdown } from "../app/lib/markdown.client.js";
import { ACTIVE_TAG, escaped, HOSTILE } from "./helpers/render.js";

describe("Markdown on the server's page", () => {
  it("is its source as escaped plain text, whitespace kept, until the browser renders it", () => {
    const source = `# Title\n\n    indented\n${HOSTILE}\n[x](javascript:alert(1))`;
    const html = renderToString(<Markdown source={source} />);
    expect(html).toBe(
      `<div class="markdown"><pre class="markdown-source">${escaped(source)}</pre></div>`,
    );
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).not.toContain("<h1>");
  });

  it("keeps a README's place for the browser, without rendering it", () => {
    const html = renderToString(
      <Markdown source="[a](guide.md)" at={{ base: "/ada/demo", ref: "main", dir: "docs" }} />,
    );
    expect(html).toContain("[a](guide.md)");
    expect(html).not.toContain("href");
  });
});

describe("the renderer the browser runs", () => {
  const hostile = [
    HOSTILE,
    '<img src=x onerror="alert(1)">',
    "<iframe src=javascript:alert(1)></iframe>",
    "[x](javascript:alert(1))",
    "![x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "```suggestion\n<script>alert(1)</script>\n```",
    '<a href="javascript:alert(1)">x</a>',
  ];

  // An image whose URL is unsafe keeps no URL (`src=""`): no script-capable tag, handler or URL.
  const SCRIPTABLE =
    /<(script|svg|iframe|object|embed|style|link|meta|base)\b|<[a-z][^<>]*\son[a-z]+=/i;

  it("keeps hostile comments and reviews inert", () => {
    for (const body of hostile) {
      const html = renderMarkdown(body);
      expect(html, body).not.toMatch(SCRIPTABLE);
      expect(html, body).not.toMatch(/(href|src)="(javascript|data|vbscript):/i);
      expect(html, body).not.toMatch(/<a [^>]*\son[a-z]+=/i);
    }
  });

  it("keeps a hostile README inert, its links in the repository", () => {
    const at = { base: "/ada/demo", ref: "main", dir: "" };
    for (const body of hostile) {
      const html = renderMarkdown(body, at);
      expect(html, body).not.toMatch(SCRIPTABLE);
      expect(html, body).not.toMatch(/(href|src)="(javascript|data|vbscript):/i);
    }
    expect(renderMarkdown("[g](docs/guide.md)", at)).toContain(
      'href="/ada/demo/blob/main/docs/guide.md"',
    );
  });
});
