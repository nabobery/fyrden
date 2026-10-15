import { constants, gunzipSync } from "node:zlib";
import { COMMAND_READ_BYTES } from "@fyrden/git-core";

/**
 * Bytes of a body read at most to find its whole command section (and push
 * options): a longer one is not checked before it is stored (its commit
 * still is). Proposed.
 */
export const COMMAND_SECTION_MAX_BYTES = 1024 * 1024;

/**
 * Compressed bytes of a gzip body inflated to find its command section: one
 * bounded inflate (at most `COMMAND_SECTION_MAX_BYTES` out), never more, so
 * a body built to inflate hugely costs nothing before it is stored. A
 * command section that does not fit is checked at the commit. Proposed.
 */
export const GZIP_COMMAND_READ_BYTES = 64 * 1024;

/**
 * Reads the start of a request body: until it holds the push's whole
 * command section (and push options, when the commands ask for them), the
 * whole body, or `COMMAND_SECTION_MAX_BYTES` (for a gzip body, its first
 * `GZIP_COMMAND_READ_BYTES`). `commands` is that start as the push sends
 * it (inflated, for a gzip body; empty when it does not inflate within the
 * bound); `head` the bytes read as they came. Then either `rest` gives the
 * whole body again as one stream (of the declared length, when there is
 * one, so R2 still takes it with one PUT): the bytes read first, then the
 * rest as it is read, cancelling the request body when the stream is
 * cancelled; or `cancel` gives the body up.
 */
export async function readBodyHead(
  body: ReadableStream<Uint8Array>,
  options: { readonly gzip?: boolean } = {},
): Promise<{
  head: Uint8Array;
  commands: Uint8Array;
  rest: (declaredBytes: number | undefined) => ReadableStream<Uint8Array>;
  cancel: () => Promise<void>;
}> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  let commands: Uint8Array = new Uint8Array();
  const readTo = async (target: number) => {
    while (length < target) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      chunks.push(next.value);
      length += next.value.length;
    }
  };
  try {
    if (options.gzip) {
      await readTo(GZIP_COMMAND_READ_BYTES);
      // A chunk may run past the bound: what it holds past it is only replayed.
      commands = inflatedPrefix(concat(chunks, length).subarray(0, GZIP_COMMAND_READ_BYTES));
    } else {
      // Doubling ranges until the sections are whole (or there is no more to read).
      for (let target = COMMAND_READ_BYTES; ; target *= 2) {
        await readTo(Math.min(target, COMMAND_SECTION_MAX_BYTES));
        commands = concat(chunks, length).subarray(0, COMMAND_SECTION_MAX_BYTES);
        if (done || sectionsComplete(commands) || length >= COMMAND_SECTION_MAX_BYTES) break;
      }
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  const head = concat(chunks, length);
  const rest = (declaredBytes: number | undefined): ReadableStream<Uint8Array> => {
    let sentHead = false;
    const replay = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHead) {
          sentHead = true;
          if (head.length > 0) {
            controller.enqueue(head);
            return;
          }
        }
        const next = done ? { done: true as const, value: undefined } : await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    if (declaredBytes === undefined) return replay;
    // R2 takes a stream only with its length known: pipeTo carries errors and cancellation both ways.
    const fixed = new FixedLengthStream(declaredBytes);
    void replay.pipeTo(fixed.writable).catch(() => {});
    return fixed.readable as ReadableStream<Uint8Array>;
  };
  return { head, commands, rest, cancel: () => reader.cancel().catch(() => {}) };
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * What the start of a gzip stream inflates to: one synchronous inflate that
 * stops at `COMMAND_SECTION_MAX_BYTES` of output (refusing more) and keeps
 * what a stream cut short inflated so far. Empty when it is not gzip or
 * inflates past the bound: the commit's check then stands alone.
 */
export function inflatedPrefix(compressed: Uint8Array): Uint8Array {
  try {
    const out = gunzipSync(compressed, {
      maxOutputLength: COMMAND_SECTION_MAX_BYTES,
      finishFlush: constants.Z_SYNC_FLUSH,
    });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    return new Uint8Array();
  }
}

const decoder = new TextDecoder();

/**
 * Whether `bytes` hold a push's whole command section, and its push
 * options when the first command asks for them: pkt-lines up to a flush,
 * twice then. Capabilities follow a NUL on the first command line, after
 * any `shallow` lines; a line may end with LF.
 */
export function sectionsComplete(bytes: Uint8Array): boolean {
  let at = 0;
  let sections = 1;
  let first = true;
  for (let section = 0; section < sections; section++) {
    for (;;) {
      if (at + 4 > bytes.length) return false;
      const size = Number.parseInt(decoder.decode(bytes.subarray(at, at + 4)), 16);
      if (Number.isNaN(size) || (size !== 0 && size < 4)) return true;
      if (size === 0) {
        at += 4;
        break;
      }
      if (at + size > bytes.length) return false;
      if (section === 0 && first) {
        const line = bytes.subarray(at + 4, at + size);
        if (!decoder.decode(line.subarray(0, 8)).startsWith("shallow ")) {
          first = false;
          const nul = line.indexOf(0);
          const caps = nul < 0 ? "" : decoder.decode(line.subarray(nul + 1)).replace(/\n$/, "");
          if (caps.split(" ").includes("push-options")) sections = 2;
        }
      }
      at += size;
    }
  }
  return true;
}
