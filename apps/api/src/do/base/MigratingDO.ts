import { DurableObject } from "cloudflare:workers";
import {
  applyDoMigrations,
  type DoMigration,
  type MigrationResult,
} from "@fyrden/adapters-cloudflare/migrations";

/**
 * Base class for Durable Objects with a SQLite schema. A subclass declares
 * `static readonly schema: readonly DoMigration[]`; the constructor applies any
 * missing migrations inside `blockConcurrencyWhile`, so no request ever sees a
 * half-migrated database.
 */
export abstract class MigratingDO extends DurableObject<Env> {
  /**
   * The versions this instance migrated its storage from and to (equal when
   * it was current), for a subclass that must act once after an upgrade.
   */
  protected migration: MigrationResult | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const schema = (new.target as unknown as { schema?: readonly DoMigration[] }).schema;
    if (!schema) throw new Error(`${new.target.name} must declare static schema`);
    ctx.blockConcurrencyWhile(async () => {
      this.migration = applyDoMigrations(ctx.storage, schema);
    });
  }
}
