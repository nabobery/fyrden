import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { Unstable_RawConfig } from "wrangler";
import { parseJsonc } from "../../../packages/cli/src/jsonc.ts";

export async function auxiliaryApiConfig(
  source: string,
  directory: string,
  envFile: string,
  vars?: Readonly<Record<string, string>>,
): Promise<string> {
  const config = parseJsonc<Unstable_RawConfig>(await readFile(source, "utf8"));
  if (typeof config.main !== "string") throw new Error("The API config needs a main path.");
  const sourceDirectory = dirname(source);
  const relocated = (path: string) => relative(directory, resolve(sourceDirectory, path));
  await mkdir(directory);
  await copyFile(envFile, join(directory, ".dev.vars"));
  const path = join(directory, "wrangler.jsonc");
  await writeFile(
    path,
    JSON.stringify({
      ...config,
      main: relocated(config.main),
      ...(vars && { vars: { ...config.vars, ...vars } }),
      d1_databases: config.d1_databases?.map((database) => ({
        ...database,
        ...(database.migrations_dir && { migrations_dir: relocated(database.migrations_dir) }),
      })),
    }),
  );
  return path;
}
