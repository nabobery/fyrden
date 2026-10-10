import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const directoryMigrations = await readD1Migrations("./migrations/directory");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            DIRECTORY_MIGRATIONS: directoryMigrations,
            BOOTSTRAP_SECRET: "test-bootstrap-secret",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup/apply-migrations.ts", "./test/setup/log-capture.ts"],
      // Istanbul only: V8 coverage is not supported inside workerd.
      coverage: {
        provider: "istanbul" as const,
        include: ["src/**"],
        reporter: ["text-summary", "json", "lcov"],
      },
    },
  };
});
