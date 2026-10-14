import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["schemathesis/**/*.test.ts"], testTimeout: 600_000 },
});
