import { deflateSync, inflateSync } from "node:zlib";
import { type Zlib, ZlibError } from "../src/ports/zlib.js";

// The Workers adapter (`@fyrden/adapters-cloudflare`, src/zlib) uses the same
// node:zlib calls; both run the `describeZlibContract` suite.

interface InflateInfo {
  buffer: Uint8Array;
  // Bytes handed to zlib, which stops at the end of the stream; with the
  // whole input given at once this is the stream's length (Node docs,
  // "zlib.bytesWritten"; checked by the contract suite).
  engine: { bytesWritten: number };
}

/** The `Zlib` port over Node's `node:zlib`, for tests. */
export function createNodeZlib(): Zlib {
  return {
    inflate(input, { maxOutput }) {
      if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0) {
        throw new RangeError(`bad maxOutput ${maxOutput}`);
      }
      let result: InflateInfo;
      try {
        result = inflateSync(input, {
          info: true,
          maxOutputLength: maxOutput,
          // Small outputs get a buffer of their own size, not a view into a
          // 16 KiB chunk that would stay alive with them.
          chunkSize: Math.min(Math.max(maxOutput, 64), 64 * 1024),
        }) as unknown as InflateInfo;
      } catch (error) {
        throw toZlibError(error);
      }
      const { buffer } = result;
      return {
        output: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
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
