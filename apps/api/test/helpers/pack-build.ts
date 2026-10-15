// Commits and trees built in a test, and the pack `git push` would send for them.

import { createWorkersZlib } from "@fyrden/adapters-cloudflare";
import {
  createSha1Hasher,
  encodeCommit,
  hashObject,
  type Ident,
  type MemoryBudget,
  type ObjectType,
  type Oid,
  PackBuilder,
} from "@fyrden/git-core";

const encoder = new TextEncoder();
const unbounded: MemoryBudget = {
  reserve: async (bytes) => ({ bytes, release() {} }),
  tryReserve: (bytes) => ({ bytes, release() {} }),
};
const sha1 = () => createSha1Hasher({ detectCollisions: false });

export interface BuiltObject {
  readonly type: ObjectType;
  readonly bytes: Uint8Array;
  readonly oid: Oid;
}

/** An object and its id. */
export async function object(type: ObjectType, bytes: Uint8Array): Promise<BuiltObject> {
  return { type, bytes, oid: await hashObject(sha1, type, bytes) };
}

const ident = (at: number): Ident => ({
  name: encoder.encode("Fyrden Test"),
  email: encoder.encode("test@fyrden.invalid"),
  timestamp: at,
  timezone: "+0000",
});

/** A commit of `tree` made at `at` (seconds). */
export function commit(tree: Oid, parents: readonly Oid[], at: number, message: string) {
  return object(
    "commit",
    encodeCommit({
      tree,
      parents: [...parents],
      author: ident(at),
      committer: ident(at),
      headers: [],
      message: encoder.encode(`${message}\n`),
    }),
  );
}

/** A self-contained pack of `objects`. */
export async function packOf(objects: readonly BuiltObject[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const builder = await PackBuilder.start(objects.length, {
    sink: { write: async (chunk) => void chunks.push(chunk.slice()) },
    zlib: createWorkersZlib(),
    memory: unbounded,
  });
  for (const o of objects) await builder.addObject(o.type, o.bytes, o.oid);
  (await builder.finish()).release();
  return concat(chunks);
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
