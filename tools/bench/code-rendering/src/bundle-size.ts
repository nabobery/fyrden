/**
 * What the renderer adds to what is shipped: the web Worker's upload as
 * `wrangler deploy --dry-run --outdir` reports it, without and with the
 * server-side file renderer, and the browser bundle for the client path.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import type * as Esbuild from "esbuild";
import { bundle, ROOT, WEB, WEB_MODULES, WRANGLER_BIN } from "./toolchain.ts";

export interface Upload {
  totalKiB: number;
  gzipKiB: number;
}

export interface Sized {
  bytes: number;
  gzipBytes: number;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  return output;
}

function dryRun(cwd: string, outdir: string, config?: string): Upload {
  const args = ["deploy", "--dry-run", "--outdir", outdir, ...(config ? ["-c", config] : [])];
  const output = run(WRANGLER_BIN, args, cwd);
  const match = /Total Upload: ([\d.]+) KiB \/ gzip: ([\d.]+) KiB/.exec(output);
  if (!match) throw new Error(`no upload size in wrangler's output:\n${output}`);
  return { totalKiB: Number(match[1]), gzipKiB: Number(match[2]) };
}

function sized(path: string): Sized {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
}

function sizedDir(dir: string, filter: (name: string) => boolean): Sized {
  return readdirSync(dir)
    .filter(filter)
    .map((name) => sized(join(dir, name)))
    .reduce((a, b) => ({ bytes: a.bytes + b.bytes, gzipBytes: a.gzipBytes + b.gzipBytes }), {
      bytes: 0,
      gzipBytes: 0,
    });
}

/**
 * The web app's built server with the file renderer added: the build copied,
 * the renderer bundled for workerd next to it (Highlights' .wasm a module of
 * its own), and an entry that loads it on demand for one path.
 */
async function serverWithRenderer(
  esbuild: typeof Esbuild,
  work: string,
  name: string,
  withoutShiki: boolean,
) {
  const server = join(work, name, "server");
  cpSync(join(WEB, "build/server"), server, { recursive: true });
  symlinkSync(join(WEB, "build/client"), join(work, name, "client"));
  const entry = join(work, name, "renderer-entry.ts");
  writeFileSync(entry, `export { preloadFile } from "@pierre/diffs/ssr";\n`);
  await bundle(esbuild, {
    entry,
    outfile: join(server, "assets/file-renderer.js"),
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    withoutShiki,
  });
  writeFileSync(
    join(server, "index-with-renderer.js"),
    `export * from "./index.js";
import web from "./index.js";
export default {
  ...web,
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/__file") {
      const { preloadFile } = await import("./assets/file-renderer.js");
      const file = await preloadFile({ file: { name: "a.ts", contents: await request.text() } });
      return new Response(file.prerenderedHTML, { headers: { "content-type": "text/html" } });
    }
    return web.fetch(request, env, ctx);
  },
};
`,
  );
  const config = JSON.parse(readFileSync(join(server, "wrangler.json"), "utf8"));
  config.main = "index-with-renderer.js";
  config.rules = [...(config.rules ?? []), { type: "CompiledWasm", globs: ["**/*.wasm"] }];
  writeFileSync(join(server, "wrangler.json"), JSON.stringify(config));
  return {
    upload: dryRun(server, join(work, name, "dry-run"), "wrangler.json"),
    rendererModule: sized(join(server, "assets/file-renderer.js")),
    wasmModule: sizedDir(join(server, "assets"), (n) => n.endsWith(".wasm")),
  };
}

/**
 * Browser bundles split as Vite splits them (dynamic imports become chunks
 * loaded on demand), minified, React left out (every page has it). For each
 * entry: what a page loads before it can draw (the entry and the chunks it
 * imports statically) and what it may load later (its dynamic imports).
 */
async function clientBundles(esbuild: typeof Esbuild, work: string) {
  const dir = join(work, "client-bundles");
  mkdirSync(dir, { recursive: true });
  const entries = {
    fileDiff: `export { FileDiff } from "@pierre/diffs/react";\n`,
    file: `export { File } from "@pierre/diffs/react";\n`,
  };
  for (const [name, source] of Object.entries(entries))
    writeFileSync(join(dir, `${name}.ts`), source);
  const result = await esbuild.build({
    entryPoints: Object.keys(entries).map((n) => join(dir, `${n}.ts`)),
    outdir: join(dir, "out"),
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    minify: true,
    metafile: true,
    nodePaths: [WEB_MODULES],
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
    loader: { ".wasm": "file" },
    logLevel: "warning",
  });
  const outputs = result.metafile.outputs;
  // Metafile paths are relative to the working directory.
  const key = (path: string) => relative(process.cwd(), path);
  const reach = (start: string, follow: (kind: string) => boolean) => {
    const seen = new Set<string>();
    const walk = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      for (const i of outputs[path]?.imports ?? []) if (!i.external && follow(i.kind)) walk(i.path);
    };
    walk(start);
    return seen;
  };
  const total = (paths: Iterable<string>): Sized => {
    let bytes = 0;
    let gzipBytes = 0;
    for (const p of paths) {
      const s = sized(join(process.cwd(), p));
      bytes += s.bytes;
      gzipBytes += s.gzipBytes;
    }
    return { bytes, gzipBytes };
  };
  const of = (name: string) => {
    const out = key(join(dir, "out", `${name}.js`));
    const initial = reach(out, (kind) => kind === "import-statement");
    const all = reach(out, () => true);
    return { initial, lazy: [...all].filter((p) => !initial.has(p)) };
  };
  const fileDiff = of("fileDiff");
  const file = of("file");
  // The chunks holding Highlights (its WebAssembly inlined), the one a file view fetches to highlight.
  const highlights = file.lazy.filter((p) =>
    Object.keys(outputs[p]?.inputs ?? {}).some((i) => i.includes("@pierre+highlights@")),
  );
  return {
    fileHighlightsChunks: total(highlights),
    fileDiffInitial: total(fileDiff.initial),
    fileInitial: total(file.initial),
    fileInitialNotInFileDiff: total([...file.initial].filter((p) => !fileDiff.initial.has(p))),
    fileLazy: total(file.lazy),
  };
}

export async function measureBundles(esbuild: typeof Esbuild, work: string) {
  // The web app as it ships (the build `pnpm --filter @fyrden/web deploy:dry-run` uploads).
  run("pnpm", ["--filter", "@fyrden/web", "build"], ROOT);
  const webOnly = dryRun(WEB, join(work, "dry-web"));
  const withRenderer = await serverWithRenderer(esbuild, work, "with-shiki", false);
  const withRendererNoShiki = await serverWithRenderer(esbuild, work, "without-shiki", true);

  // What the browser build already ships (apps/web/build/client/assets).
  const assets = join(WEB, "build/client/assets");
  return {
    server: { webOnly, withRenderer, withRendererNoShiki },
    client: {
      ...(await clientBundles(esbuild, work)),
      shippedJs: sizedDir(assets, (n) => n.endsWith(".js")),
      shippedWasm: sizedDir(assets, (n) => n.endsWith(".wasm")),
      workerChunks: readdirSync(assets)
        .filter((n) => n.endsWith(".js") && /worker/i.test(n))
        .map((n) => ({ name: n, ...sized(join(assets, n)) })),
    },
  };
}
