import { readFile } from "node:fs/promises";
import { parseJsonc } from "./jsonc.ts";

/** Cloudflare resources a deployment needs, read from fyrden-api's wrangler.jsonc (the single source). */
export interface ResourcePlan {
  d1: { binding: string; name: string; migrationsDir?: string }[];
  r2: string[];
  queues: string[];
  kv: { binding: string; title: string }[];
}

interface ApiConfig {
  name: string;
  d1_databases?: { binding: string; database_name: string; migrations_dir?: string }[];
  r2_buckets?: { bucket_name: string }[];
  queues?: { producers?: { queue: string }[]; consumers?: { queue: string }[] };
  kv_namespaces?: { binding: string }[];
}

export async function readApiConfig(path: string): Promise<ApiConfig & Record<string, unknown>> {
  return parseJsonc(await readFile(path, "utf8"));
}

export function resourcePlan(config: ApiConfig): ResourcePlan {
  const queues = new Set([
    ...(config.queues?.producers ?? []).map((q) => q.queue),
    ...(config.queues?.consumers ?? []).map((q) => q.queue),
  ]);
  return {
    d1: (config.d1_databases ?? []).map((d) => ({
      binding: d.binding,
      name: d.database_name,
      ...(d.migrations_dir && { migrationsDir: d.migrations_dir }),
    })),
    r2: (config.r2_buckets ?? []).map((b) => b.bucket_name),
    queues: [...queues],
    // KV namespaces have no name in the config; Fyrden names them <worker>-<binding>.
    kv: (config.kv_namespaces ?? []).map((k) => ({
      binding: k.binding,
      title: `${config.name}-${k.binding.toLowerCase()}`,
    })),
  };
}
