import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

/** Vitest's default on CI; 2 locally; FYRDEN_TEST_WORKERS overrides both. */
function localWorkers(): { maxWorkers?: number } {
  const workers = Number(process.env.FYRDEN_TEST_WORKERS) || (process.env.CI ? 0 : 2);
  return workers > 0 ? { maxWorkers: workers } : {};
}

// The pool sends every provided value with each test file it runs, serialized
// (@cloudflare/vitest-plugin 1.4.12, `send()` in dist/pool/index.mjs), and a
// project receives the root project's values too (vitest 5.0.3,
// `TestProject.getProvidedContext`). So no global setup sits at the root, and
// the chunked fixtures (23 MiB of the 25 MiB provided, measured 2026-11-11)
// are built only for the two files that read them.
const chunkedFiles = ["test/import.server-side.test.ts", "test/push.chunked-upload.test.ts"];

export default defineConfig(async () => {
  const directoryMigrations = await readD1Migrations("./migrations/directory");
  const orgMigrations = await readD1Migrations("./migrations/org");

  function apiProject(options: {
    name: string;
    include: string[];
    exclude: string[];
    globalSetup: string[];
  }): TestProjectInlineConfiguration {
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
              // A fixed key webhook secrets are sealed with (32 bytes).
              WEBHOOKS_KEY: "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8=",
              // A fixed key unsubscribe links are signed with (32 bytes, base64url).
              EMAIL_KEY: "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8",
              // Where notification emails' links point (email is sent only where a test turns it on).
              FYRDEN_PUBLIC_ORIGIN: "https://fyrden.test",
            },
          },
        }),
      ],
      test: {
        name: options.name,
        include: options.include,
        exclude: options.exclude,
        setupFiles: [
          "./test/setup/apply-migrations.ts",
          "./test/setup/log-capture.ts",
          "./test/setup/hold-alarms.ts",
          "./test/setup/live-memo.ts",
        ],
        // Node, once per run: real git's advertisement bytes for the smart HTTP tests,
        // and repositories git packed for the fetch and push tests.
        globalSetup: options.globalSetup,
        // Most tests here drive a sequence of Durable Object round trips (often
        // with git fixtures and repacks); about twenty files have tests that take
        // 1-5 s alone (measured 2026-10-11). Under a full parallel run, with
        // Istanbul instrumentation or beside another suite, they run several
        // times slower and passed the 5 s default. Hangs still fail: every wait
        // in the test helpers has its own, shorter deadline.
        testTimeout: 30_000,
        hookTimeout: 30_000,
      },
    };
  }

  return {
    test: {
      // Each test file starts its own runtime (and git processes), so local runs
      // are capped (CI keeps the default; FYRDEN_TEST_WORKERS overrides both).
      // At the root, it caps both projects together.
      ...localWorkers(),
      projects: [
        apiProject({
          name: "api",
          include: ["test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...chunkedFiles],
          globalSetup: [
            "./test/setup/git-oracle.ts",
            "./test/setup/fetch-fixtures.ts",
            "./test/setup/push-fixtures.ts",
            "./test/setup/gc-fixtures.ts",
            "./test/setup/browse-fixtures.ts",
            "./test/setup/blame-fixtures.ts",
          ],
        }),
        apiProject({
          name: "api-chunked",
          include: chunkedFiles,
          exclude: configDefaults.exclude,
          globalSetup: ["./test/setup/push-fixtures.ts", "./test/setup/chunked-import-fixtures.ts"],
        }),
      ],
      // Istanbul only: V8 coverage is not supported inside workerd. Coverage is
      // a root option: it covers both projects.
      coverage: {
        provider: "istanbul" as const,
        include: ["src/**"],
        reporter: ["text-summary", "json", "lcov"],
      },
    },
  };
});
