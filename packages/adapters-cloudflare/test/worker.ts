// Test-only Worker for this package's workerd tests. Never deployed.
import { DurableObject } from "cloudflare:workers";
import { applyDoMigrations, type DoMigration, dumpSchema } from "../src/migrations/index.js";

export { GitStoreProbeDO } from "./git/probe-do.js";

export class MigrationProbeDO extends DurableObject {
  // Errors are returned rather than thrown: an exception crossing the RPC
  // boundary is also reported by workerd as uncaught, which fails the run.
  migrate(migrations: DoMigration[]) {
    try {
      return { ok: true as const, ...applyDoMigrations(this.ctx.storage, migrations) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  }

  schema(): string {
    return dumpSchema(this.ctx.storage);
  }

  query(sql: string): unknown[] {
    return this.ctx.storage.sql.exec(sql).toArray();
  }
}

export default {
  fetch: () => new Response("adapters-cloudflare test worker"),
} satisfies ExportedHandler;
