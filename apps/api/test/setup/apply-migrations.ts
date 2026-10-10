import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Applies the D1 migrations before each test file; applyD1Migrations skips
// migrations that are already applied.
await applyD1Migrations(env.DIRECTORY, env.DIRECTORY_MIGRATIONS);
