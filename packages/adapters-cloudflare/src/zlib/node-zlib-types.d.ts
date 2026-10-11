// Types for the part of `node:zlib` this package uses. The package does not
// depend on @types/node, whose Node globals do not exist in Workers; the
// runtime module comes from workerd's `nodejs_compat`. Signatures follow the
// Node.js zlib docs (nodejs.org/api/zlib.html).
declare module "node:zlib" {
  interface ZlibOptions {
    level?: number;
    chunkSize?: number;
    maxOutputLength?: number;
    info?: boolean;
  }
  export function inflateSync(
    input: Uint8Array,
    options: ZlibOptions & { info: true },
  ): { buffer: Uint8Array; engine: { bytesWritten: number } };
  export function deflateSync(input: Uint8Array, options?: ZlibOptions): Uint8Array;
}
