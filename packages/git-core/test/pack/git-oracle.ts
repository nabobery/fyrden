import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitSandbox } from "../../testing/git-cli.js";
import type { EntryRow } from "./parse-helpers.js";

let counter = 0;

/**
 * What git says about a pack: `git index-pack` indexes it (with
 * `--fix-thin` when `fixThin`, inside the sandbox repo that holds the
 * bases), then `git verify-pack -v` and `git show-index` describe each entry.
 * Returns undefined when index-pack rejects the pack.
 */
export async function gitPackRows(
  sandbox: GitSandbox,
  pack: Uint8Array,
  options: { fixThin?: boolean } = {},
): Promise<{ rows: EntryRow[]; packBytes: Uint8Array } | undefined> {
  const name = join(sandbox.dir, `.git/oracle-${process.pid}-${counter++}`);
  const packPath = `${name}.pack`;
  const idxPath = `${name}.idx`;
  try {
    if (options.fixThin) {
      await sandbox.git(["index-pack", "--stdin", "--fix-thin", "-o", idxPath, packPath], {
        input: pack,
      });
    } else {
      await writeFile(packPath, pack);
      await sandbox.git(["index-pack", "-o", idxPath, packPath]);
    }
  } catch {
    return undefined;
  }
  const { stdout } = await sandbox.git(["verify-pack", "-v", idxPath]);
  const crcs = new Map<number, number>();
  const shown = await sandbox.git(["show-index"], { input: await readFile(idxPath) });
  for (const line of shown.stdout.trim().split("\n")) {
    const [offset, , crc] = line.split(" ");
    crcs.set(Number(offset), Number.parseInt((crc as string).slice(1, -1), 16));
  }
  const rows: EntryRow[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{40}$/.test(fields[0] ?? "")) continue;
    const [oid, type, size, sizeInPack, offset, depth, baseOid] = fields as string[];
    rows.push({
      oid: oid as string,
      type: type as string,
      size: Number(size),
      sizeInPack: Number(sizeInPack),
      offset: Number(offset),
      depth: depth === undefined ? 0 : Number(depth),
      baseOid,
      crc32: crcs.get(Number(offset)),
    });
  }
  return { rows: rows.sort((a, b) => a.offset - b.offset), packBytes: await readFile(packPath) };
}

/** True when `git index-pack` accepts the pack as it is (no thin fixing). */
export async function gitAccepts(sandbox: GitSandbox, pack: Uint8Array): Promise<boolean> {
  const name = join(sandbox.dir, `.git/accept-${process.pid}-${counter++}`);
  await writeFile(`${name}.pack`, pack);
  try {
    await sandbox.git(["index-pack", "-o", `${name}.idx`, `${name}.pack`]);
    return true;
  } catch {
    return false;
  } finally {
    await rm(`${name}.pack`, { force: true });
    await rm(`${name}.idx`, { force: true });
  }
}
