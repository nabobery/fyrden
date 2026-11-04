/**
 * The files the benchmark renders, made from the repository itself (the
 * files `git ls-files` lists at the checked-out commit), so a clean checkout
 * reproduces them byte for byte.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Esbuild from "esbuild";

export interface Fixture {
  id: string;
  /** The file name the renderer is given (its extension picks the language). */
  name: string;
  lang: string;
  kind: "ts" | "json" | "markdown" | "minified-js";
  path: string;
  bytes: number;
  lines: number;
  source: string;
}

const KiB = 1024;
/** Sizes of the TypeScript ladder, in KiB: the fit for "largest file within 10 ms". */
export const TS_LADDER = [1, 2, 4, 8, 16, 32, 64, 100, 128, 256, 512, 1024];

function trackedFiles(root: string, pattern: RegExp): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((path) => pattern.test(path))
    .sort();
}

/** The first `bytes` of `text`, cut back to the end of a line. */
function prefixLines(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) throw new Error(`source has only ${buffer.length} bytes`);
  const cut = buffer.lastIndexOf(0x0a, bytes - 1);
  return buffer.subarray(0, cut + 1).toString("utf8");
}

export function makeFixtures(root: string, dir: string, esbuild: typeof Esbuild): Fixture[] {
  const fixtures: Fixture[] = [];
  const add = (f: Omit<Fixture, "path" | "bytes" | "lines">, text: string) => {
    const path = join(dir, f.id + f.name.slice(f.name.lastIndexOf(".")));
    writeFileSync(path, text);
    fixtures.push({
      ...f,
      path,
      bytes: Buffer.byteLength(text),
      lines: text.split("\n").length,
    });
  };

  // TypeScript: the repository's own sources (no declaration files, nothing
  // generated), concatenated in path order; each size is a prefix of it.
  const tsFiles = trackedFiles(root, /\.tsx?$/).filter(
    (p) => !p.endsWith(".d.ts") && !p.endsWith("/generated.ts") && !p.startsWith("tools/bench/"),
  );
  const tsAll = tsFiles.map((p) => readFileSync(join(root, p), "utf8")).join("\n");
  for (const kib of TS_LADDER) {
    add(
      {
        id: `ts-${kib}k`,
        name: "file.ts",
        lang: "typescript",
        kind: "ts",
        source: `prefix of the repository's ${tsFiles.length} TypeScript sources, concatenated in path order`,
      },
      prefixLines(tsAll, kib * KiB),
    );
  }

  // JSON: the largest tracked JSON file as it is, and a 100 KiB document of
  // the repository's own file list (pretty-printed, as a lockfile or an API
  // answer would be).
  const jsonFiles = trackedFiles(root, /\.json$/)
    .map((p) => ({ p, size: readFileSync(join(root, p)).length }))
    .sort((a, b) => b.size - a.size);
  const largestJson = jsonFiles[0];
  if (!largestJson) throw new Error("no JSON file is tracked");
  add(
    { id: "json-real", name: "file.json", lang: "json", kind: "json", source: largestJson.p },
    readFileSync(join(root, largestJson.p), "utf8"),
  );
  const listing = trackedFiles(root, /./).map((path, index) => ({
    index,
    path,
    directory: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    extension: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : null,
    tracked: true,
  }));
  add(
    {
      id: "json-100k",
      name: "file.json",
      lang: "json",
      kind: "json",
      source: "the repository's tracked file list as pretty-printed JSON, cut to 100 KiB",
    },
    `${prefixLines(JSON.stringify(listing, null, 2), 100 * KiB)}`,
  );

  // Markdown: AGENTS.md as it is, and the docs concatenated to 100 KiB.
  add(
    { id: "md-real", name: "file.md", lang: "markdown", kind: "markdown", source: "AGENTS.md" },
    readFileSync(join(root, "AGENTS.md"), "utf8"),
  );
  const docs = trackedFiles(root, /^docs\/.*\.md$/)
    .map((p) => readFileSync(join(root, p), "utf8"))
    .join("\n");
  add(
    {
      id: "md-100k",
      name: "file.md",
      lang: "markdown",
      kind: "markdown",
      source: "docs/**/*.md concatenated in path order, cut to 100 KiB",
    },
    prefixLines(docs, 100 * KiB),
  );

  // Minified JavaScript: each TypeScript source minified by esbuild and the
  // results joined into one line, cut at a statement boundary.
  const minified = tsFiles
    .map((p) => {
      try {
        return esbuild
          .transformSync(readFileSync(join(root, p), "utf8"), {
            loader: p.endsWith(".tsx") ? "tsx" : "ts",
            minify: true,
            format: "esm",
          })
          .code.replaceAll("\n", "");
      } catch {
        return "";
      }
    })
    .join(";");
  for (const kib of [10, 100]) {
    const cut = minified.lastIndexOf(";", kib * KiB);
    add(
      {
        id: `minjs-${kib}k`,
        name: "file.min.js",
        lang: "javascript",
        kind: "minified-js",
        source: `the TypeScript sources minified by esbuild, joined into one line, cut to ${kib} KiB`,
      },
      `${minified.slice(0, cut + 1)}\n`,
    );
  }
  return fixtures;
}
