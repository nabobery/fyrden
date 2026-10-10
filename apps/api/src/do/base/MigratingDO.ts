import { DurableObject } from "cloudflare:workers";
import { applyDoMigrations, type DoMigration } from "@fyrden/adapters-cloudflare/migrations";

/**
 * Base class for Durable Objects with a SQLite schema. A subclass declares
 * `static readonly schema: readonly DoMigration[]`; the constructor applies any
 * missing migrations inside `blockConcurrencyWhile`, so no request ever sees a
 * half-migrated database.
 */
export abstract class MigratingDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const schema = (new.target as unknown as { schema?: readonly DoMigration[] }).schema;
    if (!schema) throw new Error(`${new.target.name} must declare static schema`);
    ctx.blockConcurrencyWhile(async () => {
      applyDoMigrations(ctx.storage, schema);
    });
  }
}
