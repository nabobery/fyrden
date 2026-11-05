/**
 * Where the benchmark finds its tools: everything comes from the workspace
 * as installed (`pnpm install --frozen-lockfile`), nothing is added. The
 * renderer packages are apps/web's dependencies; esbuild, workerd and
 * wrangler are the versions apps/web's pinned wrangler uses.
 */
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Esbuild from "esbuild";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const WEB = join(ROOT, "apps/web");
/** apps/web's node_modules: esbuild resolves the renderer packages from here. */
export const WEB_MODULES = join(WEB, "node_modules");
export const WRANGLER_BIN = join(WEB_MODULES, ".bin/wrangler");

const wranglerRequire = createRequire(realpathSync(join(WEB_MODULES, "wrangler/package.json")));

export function loadEsbuild(): typeof Esbuild {
  return wranglerRequire("esbuild") as typeof Esbuild;
}

/** The workerd binary wrangler runs (`workerd` exports its path). */
export function workerdBinary(): string {
  const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
  const workerd = miniflareRequire("workerd") as { default: string } | string;
  return typeof workerd === "string" ? workerd : workerd.default;
}

export function workerdVersion(): string {
  const miniflareRequire = createRequire(wranglerRequire.resolve("miniflare"));
  return (miniflareRequire("workerd/package.json") as { version: string }).version;
}

export function packageVersion(name: string): string {
  // Read directly: @pierre/diffs does not export its package.json.
  const path = join(WEB_MODULES, name, "package.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
}

/**
 * @pierre/diffs reaches Shiki (its grammars, engines and themes) only by
 * dynamic import, and only for the Shiki highlighters; a bundler still
 * carries all of it (about 11 MB unminified, measured). This replaces each
 * dynamic import of Shiki, of the renderer's Shiki backend and of the Shiki
 * theme collection with a module that throws: what a server build that
 * highlights with Highlights alone could do. A render that reached one
 * would fail, so a run that completes shows the path never needs them.
 */
const SHIKI_ONLY =
  /^(shiki($|\/)|@shikijs\/|\.\/backends\/shiki\.js$|@pierre\/theming\/themes$|\.\/shiki-)/;
const withoutShiki: Esbuild.Plugin = {
  name: "without-shiki",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) =>
      args.kind === "dynamic-import" && SHIKI_ONLY.test(args.path)
        ? { path: args.path, namespace: "without-shiki" }
        : undefined,
    );
    build.onLoad({ filter: /.*/, namespace: "without-shiki" }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`left out of this build: ${args.path}`)});`,
      loader: "js",
    }));
  },
};

/**
 * Bundles `entry` with esbuild, the renderer packages resolved from apps/web.
 * `conditions` picks the build: workerd's (as wrangler and the Cloudflare
 * Vite plugin bundle for Workers) or the default (a browser's).
 */
export async function bundle(
  esbuild: typeof Esbuild,
  options: {
    entry: string;
    outfile: string;
    platform: "neutral" | "node" | "browser";
    conditions: string[];
    minify?: boolean;
    external?: string[];
    /** Leave Shiki out: see `withoutShiki`. */
    withoutShiki?: boolean;
  },
): Promise<void> {
  await esbuild.build({
    plugins: options.withoutShiki ? [withoutShiki] : [],
    entryPoints: [options.entry],
    outfile: options.outfile,
    bundle: true,
    format: "esm",
    platform: options.platform,
    target: "es2024",
    conditions: options.conditions,
    mainFields: ["module", "main"],
    nodePaths: [WEB_MODULES],
    minify: options.minify ?? false,
    external: options.external ?? [],
    // Highlights' workerd build imports its .wasm as a compiled module: kept
    // as a file next to the bundle, loaded by workerd as a Wasm module.
    loader: { ".wasm": "copy" },
    assetNames: "[name]",
    logLevel: "warning",
  });
}
