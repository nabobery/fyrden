import { COMMAND_READ_BYTES } from "@fyrden/git-core";

/**
 * Reads the start of a request body (at least `COMMAND_READ_BYTES`, or all
 * of a shorter body): enough for the command section of a push. Then
 * either `rest` gives the whole body again as one stream (of the declared
 * length, when there is one, so R2 still takes it with one PUT): the bytes
 * read first, then the rest as it is read, cancelling the request body when
 * the stream is cancelled; or `cancel` gives the body up.
 */
export async function readBodyHead(body: ReadableStream<Uint8Array>): Promise<{
  head: Uint8Array;
  rest: (declaredBytes: number | undefined) => ReadableStream<Uint8Array>;
  cancel: () => Promise<void>;
}> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  try {
    while (length < COMMAND_READ_BYTES) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      chunks.push(next.value);
      length += next.value.length;
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  const head = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    head.set(chunk, at);
    at += chunk.length;
  }
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
  return { head, rest, cancel: () => reader.cancel().catch(() => {}) };
}
