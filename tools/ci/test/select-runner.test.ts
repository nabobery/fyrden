import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { RUNNER_PATHS, selectRunner } from "../src/select-runner.ts";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../../..");
const script = resolve(import.meta.dirname, "../src/select-runner.ts");

describe("selectRunner", () => {
  it("runs on every event but a pull request", () => {
    expect(selectRunner("push", []).runner).toBe(true);
    expect(selectRunner("workflow_dispatch", []).runner).toBe(true);
  });

  it("selects a pull request that changed a runner path", () => {
    for (const path of [
      "apps/api/src/runner/service.ts",
      "apps/api/src/runner/proto/messages.ts",
      "apps/api/test/helpers/runner-proto.ts",
      "apps/api/src/do/run/logs.ts",
      "apps/api/src/do/RunDO.ts",
      "apps/api/src/do/schema/run.ts",
      "packages/domain/src/ci/runner.ts",
      "packages/domain/src/ci/payload.ts",
      "packages/domain/src/ci/expressions.ts",
      ".nvmrc",
      "package.json",
      "pnpm-workspace.yaml",
      "tools/ci/src/select-mutation.ts",
      "tools/ci/runner/runner.test.ts",
      "tools/ci/corpus/corpus.test.ts",
      "tools/ci/vitest.corpus.config.ts",
      "packages/testing/src/ci-corpus/workflows/checkout.yml",
      "tools/ci/e2e/fixtures/run-seam/worker.js",
      "tools/ci/e2e/forge.ts",
      "tools/ci/e2e/auxiliary-api-config.ts",
      "tools/ci/e2e/wrangler-dev.ts",
      "tools/ci/vitest.runner.config.ts",
      "tools/ci/package.json",
      "apps/api/wrangler.jsonc",
      "pnpm-lock.yaml",
      ".github/actions/setup/action.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/nightly.yml",
    ])
      expect(selectRunner("pull_request", ["README.md", path]), path).toEqual({
        runner: true,
        reason: `${path} changed`,
      });
  });

  it("leaves out a pull request that changed none", () => {
    for (const paths of [
      [],
      ["apps/api/src/do/RepoDO.ts"],
      ["apps/api/src/do/schema/repo.ts"],
      ["packages/domain/src/principals/token.ts"],
      ["packages/domain/test/ci/expressions.test.ts"],
      ["apps/api/test/runner.logs.test.ts"],
      ["apps/web/wrangler.jsonc"],
      ["tools/ci/vitest.e2e.config.ts"],
      ["packages/api-contract/package.json"],
      [".github/actions/pinned-git/action.yml"],
      [".github/workflows/deploy.yml"],
      ["docs/testing.md"],
    ])
      expect(selectRunner("pull_request", paths).runner, paths.join()).toBe(false);
  });

  it("names only paths that exist, so a move cannot drop the job unnoticed", () => {
    for (const prefix of RUNNER_PATHS) {
      const path = join(root, prefix);
      const exists = prefix.endsWith("/")
        ? existsSync(path)
        : existsSync(path) ||
          readdirSync(dirname(path)).some((name) => name.startsWith(basename(path)));
      expect(exists, prefix).toBe(true);
    }
  });
});

describe("select-runner (the script CI runs)", () => {
  async function output(event: string, args: string[]) {
    const dir = await mkdtemp(join(tmpdir(), "select-runner-"));
    try {
      const file = join(dir, "output");
      await run(process.execPath, [script, ...args], {
        env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_OUTPUT: file },
      });
      return await readFile(file, "utf8");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("writes the decision for the job's condition", async () => {
    // Against this checkout: HEAD against itself changes nothing.
    expect(await output("pull_request", ["HEAD", "HEAD"])).toBe("runner=false\n");
    expect(await output("push", [])).toBe("runner=true\n");
  });
});
