import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GitSandbox } from "../git-cli.js";
import { FileRepo } from "./file-repo.js";
import type { ExtConfig } from "./receive-pack-handler.js";

/** The entry script, run by the `ext::` remote helper. */
export const EXT_MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));

/**
 * The remote URL that makes git talk to the test server for `repoDir`.
 * Pass it with `-c protocol.ext.allow=always`. Paths must not contain
 * spaces (the helper splits its command on them).
 */
export function extRemote(repoDir: string): string {
  if (/\s/.test(repoDir) || /\s/.test(EXT_MAIN))
    throw new Error("ext:: paths cannot contain spaces");
  return `ext::${process.execPath} --no-warnings --experimental-transform-types ${EXT_MAIN} %S ${repoDir}`;
}

/** git arguments for a push to the test server. */
export function extPushArgs(repoDir: string, ...rest: string[]): string[] {
  return ["-c", "protocol.ext.allow=always", "push", extRemote(repoDir), ...rest];
}

/** A test server repository directory; `dispose` removes it. */
export interface ServerRepo {
  readonly dir: string;
  dispose(): Promise<void>;
}

/** A new, empty server repository directory. Dispose it when the test ends. */
export async function createServerRepo(config?: ExtConfig): Promise<ServerRepo> {
  const dir = await mkdtemp(join(tmpdir(), "fyrden-ext-"));
  if (config) await writeExtConfig(dir, config);
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeExtConfig(dir: string, config: ExtConfig): Promise<void> {
  await writeFile(join(dir, "ext-config.json"), JSON.stringify(config));
}

/**
 * A bare git repository holding the objects of the server repository's
 * live packs and its refs, for `git fsck` and other git commands to judge
 * what the push path stored. A received thin pack and its completion pack
 * form one unit that Fyrden's reader resolves across, but git reads a
 * REF_DELTA base only from the same pack, so each pack is fed through
 * `git index-pack --fix-thin`, completion packs before the packs they
 * complete (newest first). It lives in `sandbox` and goes with it.
 */
export async function reconstructRepo(sandbox: GitSandbox, repoDir: string): Promise<string> {
  const repo = await FileRepo.open(repoDir);
  const target = await sandbox.tempDir("rebuilt-");
  await sandbox.git(["init", "-q", "--bare", target]);
  for (const packId of [...repo.livePacks].reverse()) {
    await sandbox.git(["--git-dir", target, "index-pack", "--stdin", "--fix-thin"], {
      input: await repo.readPack(packId),
    });
  }
  const snapshot = await repo.refStore.readRefs();
  for (const [name, oid] of snapshot.refs) {
    await sandbox.git(["--git-dir", target, "update-ref", name, Buffer.from(oid).toString("hex")]);
  }
  return target;
}

/**
 * Whether each live pack's stored `.idx` is byte-identical to the one
 * `git index-pack` writes for it (thin packs, which git cannot index
 * alone, are skipped). Returns the packs compared.
 */
export async function compareIdxWithGit(sandbox: GitSandbox, repoDir: string): Promise<number> {
  const repo = await FileRepo.open(repoDir);
  const scratch = await sandbox.tempDir("idx-");
  try {
    return await compareEachIdx(sandbox, repo, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function compareEachIdx(
  sandbox: GitSandbox,
  repo: FileRepo,
  scratch: string,
): Promise<number> {
  let compared = 0;
  for (const packId of repo.livePacks) {
    const packPath = join(scratch, `${packId}.pack`);
    await copyFile(repo.packPath(packId, "pack"), packPath);
    try {
      await sandbox.git(["index-pack", "-o", join(scratch, `${packId}.idx`), packPath]);
    } catch {
      continue;
    }
    const ours = await repo.loadIdx(packId);
    const theirs = new Uint8Array(await readFile(join(scratch, `${packId}.idx`)));
    if (Buffer.compare(Buffer.from(ours), Buffer.from(theirs)) !== 0) {
      throw new Error(`stored .idx of pack ${packId} differs from git index-pack's`);
    }
    compared++;
  }
  return compared;
}
