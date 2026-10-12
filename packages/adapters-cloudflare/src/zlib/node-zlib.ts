import { deflateSync, inflateSync } from "node:zlib";
import { type Zlib, ZlibError } from "@fyrden/git-core";

/**
 * The `Zlib` port over `node:zlib`, which workerd provides under
 * `nodejs_compat`. That flag is on by default from compatibility date
 * 2026-08-04 (verified: `NODEJS_COMPAT_DEFAULT_ON_DATE` in the pinned
 * @cloudflare/vitest-plugin 1.4.0), so the pinned date needs no explicit
 * flag; `describeZlibContract` runs against it in workerd. Native, so much faster
 * than a TypeScript inflate: 32 MiB inflates in 179 ms inside a Durable
 * Object (measured).
 */
/**
 * `inflateSync` with `{ info: true }` returns the output and the zlib engine
 * (Node.js zlib docs). @types/node, which apps compile with, does not model
 * that overload, so the call goes through this one signature.
 */
const inflateWithInfo = inflateSync as unknown as (
  input: Uint8Array,
  options: { info: true; maxOutputLength: number; chunkSize: number },
) => { buffer: Uint8Array; engine: { bytesWritten: number } };

export function createWorkersZlib(): Zlib {
  return {
    inflate(input, { maxOutput }) {
      if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0) {
        throw new RangeError(`bad maxOutput ${maxOutput}`);
      }
      let result: { buffer: Uint8Array; engine: { bytesWritten: number } };
      try {
        result = inflateWithInfo(input, {
          info: true,
          maxOutputLength: maxOutput,
          // Small outputs get a buffer of their own size, not a view into a
          // larger chunk that would stay alive with them.
          chunkSize: Math.min(Math.max(maxOutput, 64), 64 * 1024),
        });
      } catch (error) {
        throw toZlibError(error);
      }
      const { buffer } = result;
      return {
        output: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        // Bytes handed to zlib, which stops at the end of the stream, so with
        // the whole input given at once this is the stream's length (checked
        // by the contract suite in workerd).
        consumed: result.engine.bytesWritten,
      };
    },
    deflate(input, options = {}) {
      const out = deflateSync(input, options.level === undefined ? {} : { level: options.level });
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    },
  };
}

function toZlibError(error: unknown): unknown {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "Z_BUF_ERROR") return new ZlibError("truncated", message);
  if (code === "ERR_BUFFER_TOO_LARGE") return new ZlibError("output-limit", message);
  if (code === "Z_DATA_ERROR" || code === "Z_NEED_DICT" || code === "Z_STREAM_ERROR") {
    return new ZlibError("corrupt", message);
  }
  return error;
}
