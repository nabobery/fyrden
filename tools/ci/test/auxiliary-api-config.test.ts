import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { unstable_getVarsForDev, unstable_readConfig } from "wrangler";
import { auxiliaryApiConfig } from "../e2e/auxiliary-api-config.js";

it("loads generated auxiliary secrets despite a conflicting developer file and preserves source paths", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "fyrden-aux-config-"));
  try {
    const sourceDirectory = join(scratch, "source");
    await mkdir(sourceDirectory);
    const source = join(sourceDirectory, "wrangler.jsonc");
    const original = JSON.stringify({
      name: "auxiliary-api",
      main: "worker.ts",
      compatibility_date: "2026-10-01",
      secrets: { required: ["BOOTSTRAP_SECRET"] },
      d1_databases: [
        { binding: "DIRECTORY", database_name: "test-directory", migrations_dir: "migrations" },
      ],
    });
    await writeFile(source, original);
    await writeFile(
      join(sourceDirectory, "worker.ts"),
      "export default { fetch() { return new Response('ok'); } };\n",
    );
    await writeFile(join(sourceDirectory, "tsconfig.json"), "{}\n");
    await writeFile(join(sourceDirectory, ".dev.vars"), "BOOTSTRAP_SECRET=developer-value\n");
    const envFile = join(scratch, "test.env");
    await writeFile(envFile, "BOOTSTRAP_SECRET=generated-test-value\n");
    const path = await auxiliaryApiConfig(source, join(scratch, "isolated"), envFile);
    const config = unstable_readConfig({ config: path }, { hideWarnings: true });
    const bindings = unstable_getVarsForDev(
      config.userConfigPath,
      undefined,
      config.vars,
      undefined,
      true,
      config.secrets,
    );
    expect(bindings.BOOTSTRAP_SECRET).toEqual({
      type: "secret_text",
      value: "generated-test-value",
    });
    expect(config.main).toBe(join(sourceDirectory, "worker.ts"));
    expect(config.tsconfig).toBeUndefined();
    expect(resolve(dirname(path), config.d1_databases[0]?.migrations_dir ?? "")).toBe(
      join(sourceDirectory, "migrations"),
    );
    expect(await readFile(source, "utf8")).toBe(original);
    expect(await readFile(join(sourceDirectory, ".dev.vars"), "utf8")).toBe(
      "BOOTSTRAP_SECRET=developer-value\n",
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
