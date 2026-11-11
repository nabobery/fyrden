import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  type CiSelection,
  coveragePackages,
  outputLines,
  type SelectionInput,
  selectCi,
} from "../src/select-ci.ts";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");

const workspace = [
  "@fyrden/adapters-cloudflare",
  "@fyrden/api",
  "@fyrden/ci-tools",
  "@fyrden/cli",
  "@fyrden/domain",
  "@fyrden/testing",
  "@fyrden/web",
];

function select(input: Partial<SelectionInput>): CiSelection {
  return selectCi({ event: "pull_request", paths: [], affected: [], workspace, ...input });
}

const ALL_JOBS = {
  api: true,
  e2e: true,
  contract: true,
  interop: true,
  shuffleApi: true,
  shuffleAdapters: true,
};

describe("selectCi", () => {
  it("runs static checks alone for documentation only", () => {
    const selection = select({ paths: ["docs/testing.md", "docs/operations/ci.md"] });
    expect(selection).toMatchObject({
      api: false,
      coveragePackages: [],
      e2e: false,
      contract: false,
      interop: false,
      shuffleApi: false,
      shuffleAdapters: false,
    });
    expect(selection.reason).toMatch(/documentation only/);
  });

  it("runs web coverage and end to end, not the API's jobs, for a web change", () => {
    const selection = select({
      paths: ["apps/web/app/routes/home.tsx"],
      affected: ["@fyrden/web"],
    });
    expect(selection).toMatchObject({
      api: false,
      coveragePackages: ["@fyrden/web"],
      e2e: true,
      contract: false,
      shuffleApi: false,
    });
  });

  it("runs the API's coverage, shuffle and every integration tier for an API change", () => {
    const selection = select({ paths: ["apps/api/src/app.ts"], affected: ["@fyrden/api"] });
    expect(selection).toMatchObject({ ...ALL_JOBS, shuffleAdapters: false, coveragePackages: [] });
  });

  it("runs every consumer Turbo reports for a shared package change", () => {
    const affected = ["@fyrden/domain", "@fyrden/api", "@fyrden/web", "@fyrden/cli"];
    const selection = select({ paths: ["packages/domain/src/authz/permissions.ts"], affected });
    expect(selection).toMatchObject({ ...ALL_JOBS, shuffleAdapters: false });
    expect(selection.coveragePackages).toEqual(["@fyrden/cli", "@fyrden/domain", "@fyrden/web"]);
  });

  it("runs the adapters' shuffle guard for an adapters change", () => {
    const affected = ["@fyrden/adapters-cloudflare", "@fyrden/api"];
    const selection = select({ paths: ["packages/adapters-cloudflare/src/r2.ts"], affected });
    expect(selection).toMatchObject(ALL_JOBS);
  });

  it("runs the integration tiers for a change to their shared server helper", () => {
    const selection = select({
      paths: ["tools/ci/e2e/wrangler-dev.ts"],
      affected: ["@fyrden/ci-tools"],
    });
    expect(selection).toMatchObject({ e2e: true, contract: true, interop: true, api: false });
  });

  it.each([
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "apps/web/package.json",
    "turbo.json",
    "apps/api/turbo.json",
    "tsconfig.base.json",
    "biome.json",
    ".nvmrc",
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    "packages/testing/src/unique-id.ts",
    "apps/api/migrations/org/0009_x.sql",
    "apps/api/wrangler.jsonc",
    "AGENTS.md",
    "tools/bench/path-finder/wide-30k.ts",
    "docs/diagram.png",
  ])("runs every job when %s changed", (path) => {
    const selection = select({ paths: ["docs/testing.md", path], affected: [] });
    expect(selection).toMatchObject(ALL_JOBS);
    expect(selection.coveragePackages).toEqual(workspace.filter((name) => name !== "@fyrden/api"));
  });

  it("runs every job outside pull requests and when nothing changed", () => {
    expect(select({ event: "push", paths: ["docs/testing.md"] })).toMatchObject(ALL_JOBS);
    expect(select({ event: "schedule" })).toMatchObject(ALL_JOBS);
    expect(select({ paths: [] })).toMatchObject(ALL_JOBS);
  });

  it("refuses a package Turbo names that the workspace does not have", () => {
    expect(() => select({ paths: ["apps/web/app/x.ts"], affected: ["@evil/pkg"] })).toThrow(
      /unknown package/,
    );
  });
});

describe("outputLines", () => {
  it("gives every job a literal boolean and the packages as compact JSON", () => {
    const selection = select({
      paths: ["apps/web/app/routes/home.tsx"],
      affected: ["@fyrden/web"],
    });
    expect(outputLines(selection)).toEqual([
      "api=false",
      "e2e=true",
      "contract=false",
      "interop=false",
      "shuffleApi=false",
      "shuffleAdapters=false",
      'coverage-packages=["@fyrden/web"]',
    ]);
  });
});

describe("coveragePackages", () => {
  it("reads the packages with a coverage task, not their dependencies' transit nodes", () => {
    const dryRun = {
      tasks: [
        { package: "@fyrden/web", task: "test:coverage" },
        { package: "@fyrden/domain", task: "transit" },
        { package: "@fyrden/api", task: "test:coverage" },
      ],
    };
    expect(coveragePackages(dryRun)).toEqual(["@fyrden/api", "@fyrden/web"]);
  });

  it("refuses output of another shape", () => {
    expect(() => coveragePackages({})).toThrow(/no tasks list/);
    expect(() => coveragePackages({ tasks: [{ task: "test:coverage" }] })).toThrow(
      /without a package/,
    );
  });
});

describe("the real workspace graph", () => {
  async function dryRun(...args: string[]): Promise<string[]> {
    const { stdout } = await run("pnpm", ["turbo", "run", "test:coverage", "--dry=json", ...args], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return coveragePackages(JSON.parse(stdout));
  }

  // Turbo's own answer for this repository: a change to the domain package
  // reaches the API and the web app through their dependencies.
  it("reports the API and web consumers of the domain package", async () => {
    const [affected, all] = await Promise.all([dryRun("--filter=...@fyrden/domain"), dryRun()]);
    expect(affected).toEqual(
      expect.arrayContaining(["@fyrden/domain", "@fyrden/api", "@fyrden/web"]),
    );
    const paths = ["packages/domain/src/index.ts"];
    const selection = selectCi({ event: "pull_request", paths, affected, workspace: all });
    expect(selection).toMatchObject({ api: true, e2e: true, shuffleApi: true });
  });
});
