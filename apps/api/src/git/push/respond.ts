import { encodeFatalError } from "@fyrden/git-core";
import type { PushProgress } from "./repo-push.js";
import type { PushTuning } from "./tuning.js";

/**
 * The keepalive git's own receive-pack sends on side-band while it works
 * (an empty packet on band 1; git v2.53.0 builtin/receive-pack.c
 * `copy_to_sideband`, unverified here): the client's demultiplexer reads
 * it as no data.
 */
const KEEPALIVE = new Uint8Array([0x30, 0x30, 0x30, 0x35, 0x01]);

/** Errors in a row from the Durable Object (evicted, reset) before the Worker gives up. */
const MAX_CALL_FAILURES = 5;

export interface PushCalls {
  /** Where the push stands (runs due indexing in the Durable Object). */
  status(): Promise<PushProgress>;
  /** Re-authorizes the pusher and commits; returns the response body. */
  finalize(): Promise<Uint8Array>;
}

export interface PushWaitOptions {
  readonly tuning: Pick<PushTuning, "pollMs" | "maxPollMs" | "maxWaitMs">;
  /** Keeps the invocation alive while the response streams. */
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly onError?: (error: unknown) => void;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The response body of a push, given where it stood after the Worker's
 * first call. When it is done or ready, the body is returned whole. While
 * it is still indexing, the body is streamed: the Worker waits between
 * calls (no CPU), sends git's keepalive on side-band, and writes the
 * report when the push is over. The client's connection is held by the
 * Worker, never by the Durable Object.
 */
export async function pushResponseBody(
  first: PushProgress,
  calls: PushCalls,
  options: PushWaitOptions,
): Promise<Uint8Array | ReadableStream<Uint8Array>> {
  if (first.state === "done") return first.response;
  if (first.state === "ready") return finish(calls);

  let sideband = first.sideband;
  const sleep = options.sleep ?? defaultSleep;
  const { readable, writable } = new IdentityTransformStream();
  const writer = writable.getWriter();
  const pump = (async () => {
    try {
      const deadline = Date.now() + options.tuning.maxWaitMs;
      let failures = 0;
      let delay = options.tuning.pollMs;
      let progress: PushProgress = first;
      while (progress.state === "indexing") {
        if (Date.now() > deadline) {
          await writer.write(
            encodeFatalError("the push took too long to index; try again", sideband),
          );
          await writer.close();
          return;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, Math.max(options.tuning.pollMs, options.tuning.maxPollMs));
        if (sideband) await writer.write(KEEPALIVE);
        try {
          progress = await calls.status();
          if (progress.state !== "done") sideband = progress.sideband;
          failures = 0;
        } catch (error) {
          options.onError?.(error);
          if (++failures >= MAX_CALL_FAILURES) throw error;
        }
      }
      await writer.write(progress.state === "done" ? progress.response : await finish(calls));
      await writer.close();
    } catch (error) {
      options.onError?.(error);
      try {
        await writer.write(encodeFatalError("the push failed on the server; try again", sideband));
        await writer.close();
      } catch {
        await writer.abort(error).catch(() => {});
      }
    }
  })();
  options.waitUntil(pump);
  return readable;
}

/**
 * Finalizes; when the call itself fails (the object was reset after the
 * commit, say), asks once where the push stands: a committed push has kept
 * its response.
 */
async function finish(calls: PushCalls): Promise<Uint8Array> {
  try {
    return await calls.finalize();
  } catch (error) {
    const progress = await calls.status().catch(() => undefined);
    if (progress?.state === "done") return progress.response;
    throw error;
  }
}
