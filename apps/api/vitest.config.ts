import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Vitest's default on CI; 2 locally; FYRDEN_TEST_WORKERS overrides both. */
function localWorkers(): { maxWorkers?: number } {
  const workers = Number(process.env.FYRDEN_TEST_WORKERS) || (process.env.CI ? 0 : 2);
  return workers > 0 ? { maxWorkers: workers } : {};
}

export default defineConfig(async () => {
  const directoryMigrations = await readD1Migrations("./migrations/directory");
  const orgMigrations = await readD1Migrations("./migrations/org");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            DIRECTORY_MIGRATIONS: directoryMigrations,
            ORG_MIGRATIONS: orgMigrations,
            BOOTSTRAP_SECRET: "test-bootstrap-secret",
            // A fixed platform signing key (an Ed25519 seed), so server-made commits are signed.
            SIGNING_KEY: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=",
          },
        },
      }),
    ],
    test: {
      // Each test file starts its own runtime (and git processes), so local runs
      // are capped (CI keeps the default; FYRDEN_TEST_WORKERS overrides both).
      ...localWorkers(),
      setupFiles: [
        "./test/setup/apply-migrations.ts",
        "./test/setup/log-capture.ts",
        "./test/setup/hold-alarms.ts",
      ],
      // Node, once per run: real git's advertisement bytes for the smart HTTP tests,
      // and repositories git packed for the fetch and push tests.
      globalSetup: [
        "./test/setup/git-oracle.ts",
        "./test/setup/fetch-fixtures.ts",
        "./test/setup/push-fixtures.ts",
        "./test/setup/chunked-import-fixtures.ts",
        "./test/setup/gc-fixtures.ts",
        "./test/setup/browse-fixtures.ts",
      ],
      // Most tests here drive a sequence of Durable Object round trips (often
      // with git fixtures and repacks); about twenty files have tests that take
      // 1-5 s alone (measured 2026-10-11). Under a full parallel run, with
      // Istanbul instrumentation or beside another suite, they run several
      // times slower and passed the 5 s default. Hangs still fail: every wait
      // in the test helpers has its own, shorter deadline.
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // Istanbul only: V8 coverage is not supported inside workerd.
      coverage: {
        provider: "istanbul" as const,
        include: ["src/**"],
        reporter: ["text-summary", "json", "lcov"],
      },
    },
  };
});
