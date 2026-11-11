import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createGitSandbox, type GitSandbox } from "@fyrden/testing/git-cli";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedPaths,
  loadScopes,
  type MutationScope,
  parseScopes,
  selectMutationScopes,
} from "../src/select-mutation.ts";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../src/select-mutation.ts");
const author = ["-c", "user.name=Fyrden Test", "-c", "user.email=test@fyrden.invalid"];

const scopes: MutationScope[] = [
  { scope: "pack", dir: "pack" },
  { scope: "pack-write", dir: "pack-write" },
  { scope: "receive-pack", dir: "receive-pack" },
  { scope: "push-fsck", dir: "receive-pack" },
];
const names = (selected: MutationScope[]) => selected.map(({ scope }) => scope);

describe("selectMutationScopes", () => {
  it("selects nothing when no scope's source changed", () => {
    const paths = [
      "apps/web/app/root.tsx",
      "packages/git-core/test/pack/pack.test.ts",
      "README.md",
    ];
    expect(selectMutationScopes(paths, scopes)).toEqual([]);
  });

  it("selects the scope whose directory changed, not one sharing its name's prefix", () => {
    expect(names(selectMutationScopes(["packages/git-core/src/pack/delta.ts"], scopes))).toEqual([
      "pack",
    ]);
  });

  it("selects every scope mutating a shared directory", () => {
    const paths = ["packages/git-core/src/receive-pack/fsck.ts"];
    expect(names(selectMutationScopes(paths, scopes))).toEqual(["receive-pack", "push-fsck"]);
  });

  it("selects every scope when the mutation setup changed", () => {
    for (const path of [
      "packages/git-core/stryker.config.mjs",
      "packages/git-core/stryker/scopes.mjs",
      "packages/git-core/stryker/run-tests.mjs",
    ])
      expect(selectMutationScopes([path], scopes)).toEqual(scopes);
  });
});

describe("parseScopes", () => {
  it("reads every scope of the real table, with its directory", async () => {
    const parsed = await loadScopes();
    expect(parsed.length).toBeGreaterThanOrEqual(14);
    expect(parsed).toContainEqual({ scope: "push-fsck", dir: "receive-pack" });
    expect(parsed).toContainEqual({ scope: "pack", dir: "pack" });
  });

  it("refuses names a shell or a path could misread, and an empty table", () => {
    expect(() => parseScopes({ "a b": {} })).toThrow(/invalid scope/);
    expect(() => parseScopes({ ok: { dir: "../src" } })).toThrow(/invalid scope/);
    expect(() => parseScopes({})).toThrow(/none/);
    expect(() => parseScopes(null)).toThrow(/not a table/);
  });
});

describe("select-mutation (the script CI runs)", () => {
  let sandbox: GitSandbox | undefined;
  afterEach(() => sandbox?.dispose());

  async function write(path: string, content: string) {
    const file = join((sandbox as GitSandbox).dir, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }

  async function commit(message: string) {
    const git = (sandbox as GitSandbox).git.bind(sandbox);
    await git(["add", "-A"]);
    await git([...author, "commit", "-q", "-m", message]);
    return (await git(["rev-parse", "HEAD"])).stdout.trim();
  }

  it("counts both paths of a rename and a deleted file", async () => {
    sandbox = await createGitSandbox();
    await sandbox.git(["init", "-q", "-b", "main"]);
    await write("packages/git-core/src/pack/a.ts", "export const a = 1;\n");
    await write("packages/git-core/src/graph/b.ts", "export const b = 1;\n");
    const base = await commit("base");
    // The same content at a new path: a rename, unless renames are off.
    await write("packages/git-core/src/refs/a.ts", "export const a = 1;\n");
    await sandbox.git(["rm", "-q", "packages/git-core/src/pack/a.ts"]);
    await sandbox.git(["rm", "-q", "packages/git-core/src/graph/b.ts"]);
    const head = await commit("move and delete");
    expect(changedPaths(base, head, sandbox.dir).sort()).toEqual([
      "packages/git-core/src/graph/b.ts",
      "packages/git-core/src/pack/a.ts",
      "packages/git-core/src/refs/a.ts",
    ]);
  });

  it("prints the matrix of this repository's changed scopes", async () => {
    // Against this checkout: HEAD against itself changes nothing.
    const { stdout } = await run(process.execPath, [script, "HEAD", "HEAD"], {
      env: { ...process.env, GITHUB_OUTPUT: "" },
    });
    expect(stdout).toContain('matrix={"include":[]}');
    expect(stdout).toContain("any=false");
  });
});
