import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      /** Test-only binding set in vitest.config.ts. */
      DIRECTORY_MIGRATIONS: D1Migration[];
      /** Test-only binding set in vitest.config.ts. */
      ORG_MIGRATIONS: D1Migration[];
    }
  }
}
