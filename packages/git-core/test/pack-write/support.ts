import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { concatBytes } from "../../src/object/bytes.js";
import type { PackSink } from "../../src/pack-write/pack-builder.js";
import { createMemoryBudget } from "../../testing/fakes/memory-budget.js";
import type { GitSandbox } from "../../testing/git-cli.js";
import { createNodeZlib } from "../../testing/node-zlib.js";
import { MiB, parseBytes } from "../pack/parse-helpers.js";

export const zlib = createNodeZlib();
export const budget = () => createMemoryBudget(512 * MiB);
export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A sink that keeps every chunk it is given (copied, as a real writer must). */
export function memorySink(): PackSink & { bytes(): Uint8Array; chunks: Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    async write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
    bytes: () => concatBytes(chunks),
  };
}

export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of stream) parts.push(new Uint8Array(chunk));
  return concatBytes(parts);
}

let counter = 0;

/**
 * Runs `git index-pack --strict` on the pack in the sandbox repo (which may
 * be empty: `--strict` also checks that every link resolves). Returns the
 * `.idx` git wrote, or throws with git's message.
 */
export async function gitIndexStrict(sandbox: GitSandbox, pack: Uint8Array): Promise<Uint8Array> {
  const name = join(sandbox.dir, `.git/pw-${process.pid}-${counter++}`);
  await writeFile(`${name}.pack`, pack);
  try {
    await sandbox.git(["index-pack", "--strict", "-o", `${name}.idx`, `${name}.pack`]);
    return new Uint8Array(await readFile(`${name}.idx`));
  } finally {
    await rm(`${name}.pack`, { force: true });
    await rm(`${name}.idx`, { force: true });
  }
}

/** The object set of a pack as `git verify-pack -v` reports it: hex oid → type. */
export async function gitObjectSet(
  sandbox: GitSandbox,
  pack: Uint8Array,
): Promise<Map<string, string>> {
  const name = join(sandbox.dir, `.git/pw-set-${process.pid}-${counter++}`);
  await writeFile(`${name}.pack`, pack);
  try {
    await sandbox.git(["index-pack", "-o", `${name}.idx`, `${name}.pack`]);
    const { stdout } = await sandbox.git(["verify-pack", "-v", `${name}.idx`]);
    const set = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const [oid, type] = line.trim().split(/\s+/);
      if (oid && /^[0-9a-f]{40}$/.test(oid)) set.set(oid, type as string);
    }
    return set;
  } finally {
    await rm(`${name}.pack`, { force: true });
    await rm(`${name}.idx`, { force: true });
  }
}

export interface ParsedObjects {
  /** In pack order. */
  readonly objects: {
    oid: Uint8Array;
    type: "commit" | "tree" | "blob" | "tag";
    data: Uint8Array;
  }[];
  readonly byOid: Map<string, { type: "commit" | "tree" | "blob" | "tag"; data: Uint8Array }>;
}

/** Every object of a pack, through the engine's parser; a thin pack's bases come from `bases`. */
export async function objectsOf(
  pack: Uint8Array,
  bases?: ParsedObjects["byOid"],
): Promise<ParsedObjects> {
  const { pack: parsed, objects } = await parseBytes(
    pack,
    bases ? { externalBase: async (oid) => bases.get(hex(oid)) } : {},
  );
  const list: ParsedObjects["objects"] = [];
  for (let i = 0; i < parsed.entries.count; i++) {
    const oid = parsed.entries.oid(i);
    const found = objects.get(hex(oid)) as { type: string; data: Uint8Array };
    list.push({ oid, type: found.type as "blob", data: found.data });
  }
  parsed.release();
  const byOid = new Map(list.map((o) => [hex(o.oid), { type: o.type, data: o.data }]));
  return { objects: list, byOid };
}
