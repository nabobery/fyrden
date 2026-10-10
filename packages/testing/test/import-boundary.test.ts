import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Proves the Biome boundary rule in biome.json: git-core and domain must not
// import Cloudflare modules. Each case copies the real biome.json
// into a temporary tree with the same package layout and lints a probe file
// there, so the rule's path overrides apply and the repo is never touched.

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const biome = join(root, "node_modules", ".bin", "biome");

interface LintResult {
  processed: number;
  rules: string[];
}

async function lintProbe(pkg: string, source: string): Promise<LintResult> {
  const tree = await mkdtemp(join(tmpdir(), "fyrden-boundary-"));
  try {
    const config = JSON.parse(await readFile(join(root, "biome.json"), "utf8"));
    // The temporary tree is not a git checkout.
    config.vcs = { enabled: false };
    delete config.$schema;
    await writeFile(join(tree, "biome.json"), JSON.stringify(config));
    // Relative to the tree: override globs do not match absolute temp paths
    // (macOS resolves /var to /private/var).
    const file = join("packages", pkg, "src", "probe.ts");
    await mkdir(dirname(join(tree, file)), { recursive: true });
    await writeFile(join(tree, file), source);
    const { stdout } = await run(
      biome,
      ["lint", "--reporter=json", "--diagnostic-level=error", file],
      { cwd: tree },
    ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
    const report = JSON.parse(stdout) as {
      summary: { changed: number; unchanged: number };
      diagnostics: { category?: string }[];
    };
    return {
      // A probe Biome ignores proves nothing.
      processed: report.summary.changed + report.summary.unchanged,
      rules: report.diagnostics.map((d) => d.category ?? ""),
    };
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
}

const forbidden = [
  'import { env } from "cloudflare:workers";\nexport const probe = env;\n',
  'import { cloudflareTest } from "@cloudflare/vitest-plugin";\nexport const probe = cloudflareTest;\n',
  'import { unstable_dev } from "wrangler";\nexport const probe = unstable_dev;\n',
  'export * from "@fyrden/adapters-cloudflare";\n',
  'export { redact } from "../../adapters-cloudflare/src/obs/redact.js";\n',
  'export const probe = await import("cloudflare:workers");\n',
  'export const probe = await import("../../adapters-cloudflare/src/index.ts");\n',
  '// @ts-nocheck\nexport const probe = require("wrangler");\n',
  'export { handlers } from "../../../apps/api/src/ops/handlers.js";\n',
];

// Specifier rules cannot see a Cloudflare dependency reached through another
// workspace package, so the dependency graph is checked as well.
const FORBIDDEN_DEPENDENCY =
  /^(@cloudflare\/|wrangler$|miniflare$|@fyrden\/adapters-cloudflare$|@fyrden\/(api|web)$)/;

async function workspacePackages(): Promise<Map<string, Record<string, string>>> {
  const packages = new Map<string, Record<string, string>>();
  for (const dir of ["packages", "apps", "tools"]) {
    for (const name of await readdir(join(root, dir))) {
      try {
        const pkg = JSON.parse(await readFile(join(root, dir, name, "package.json"), "utf8")) as {
          name: string;
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        packages.set(pkg.name, { ...pkg.dependencies, ...pkg.peerDependencies });
      } catch {
        // Not a package directory.
      }
    }
  }
  return packages;
}

describe("core dependency graph", () => {
  it.each(["@fyrden/git-core", "@fyrden/domain"])(
    "%s depends on nothing Cloudflare-specific, directly or through workspace packages",
    async (start) => {
      const packages = await workspacePackages();
      const seen = new Set<string>();
      const reached: string[] = [];
      const visit = (name: string) => {
        if (seen.has(name)) return;
        seen.add(name);
        for (const dep of Object.keys(packages.get(name) ?? {})) {
          if (FORBIDDEN_DEPENDENCY.test(dep)) reached.push(`${name} -> ${dep}`);
          if (packages.has(dep)) visit(dep);
        }
      };
      visit(start);
      expect(packages.has(start)).toBe(true);
      expect(reached).toEqual([]);
    },
  );
});

describe("core import boundary", () => {
  for (const pkg of ["domain", "git-core"]) {
    it.each(forbidden)(`rejects a Cloudflare import in ${pkg}: %j`, async (source) => {
      const result = await lintProbe(pkg, source);
      expect(result.processed).toBe(1);
      expect(result.rules).toContain("lint/style/noRestrictedImports");
    });
  }

  it("allows the same import in adapters-cloudflare", async () => {
    const result = await lintProbe("adapters-cloudflare", forbidden[0] as string);
    expect(result.processed).toBe(1);
    expect(result.rules).not.toContain("lint/style/noRestrictedImports");
  });
});
