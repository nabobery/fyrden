/**
 * Parses JSON with comments and trailing commas (wrangler.jsonc). One scan
 * handles strings, comments and trailing commas, so nothing inside a string
 * is ever changed.
 */
export function parseJsonc<T = unknown>(text: string): T {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === "}" || ch === "]") {
      // Drop a trailing comma (and the whitespace after it) before a closer.
      out = out.replace(/,\s*$/, "");
      out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out) as T;
}
