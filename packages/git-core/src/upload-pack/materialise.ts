import type { PackSink } from "../pack-write/pack-builder.js";
import { frameSidebandData } from "../pack-write/sideband-frame.js";
import type { PackInfo, PackWriter } from "../ports/pack-store.js";

/**
 * Where a fetch plan keeps the objects it writes: regenerated packs and
 * side-band framed copies (in production, R2 objects under
 * `net/<network_id>/fetch/` with a registry row of kind `fetch`, so they
 * can be leased like any pack). Objects are found again by key until the
 * store expires them.
 */
export interface MaterialisedPackStore {
  /** The object written earlier under `key` (40 lowercase hex digits), if it is still readable. */
  find(key: string): Promise<PackInfo | undefined>;
  /** Starts writing the object for `key`; after `finish` it is readable by its pack id and found by `key`. */
  begin(key: string): PackWriter;
}

/** Writes an object with `produce`, aborting the upload if it fails. */
export async function materialise(
  store: MaterialisedPackStore,
  key: string,
  produce: (sink: PackSink) => Promise<void>,
): Promise<PackInfo> {
  const writer = store.begin(key);
  try {
    await produce(writer);
    return await writer.finish();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

/** Copies a stream into `sink` as side-band 1 packets of `payloadBytes`. */
export async function writeFramed(
  source: AsyncIterable<Uint8Array>,
  sink: PackSink,
  payloadBytes: number,
): Promise<void> {
  for await (const chunk of frameSidebandData(source, { payloadBytes })) await sink.write(chunk);
}

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A sink whose bytes reach `out` as side-band 1 packets, for a writer that
 * pushes (the pack builder) into the framer, which pulls. A `write`
 * resolves when the framer asks for the next chunk, by which time it has
 * copied this one, so the caller may reuse its buffer. Call `end` after
 * the last write; it resolves once everything is written to `out`.
 */
export function framingSink(
  out: PackSink,
  payloadBytes: number,
): { readonly sink: PackSink; end(): Promise<void> } {
  let offered: { chunk: Uint8Array; pending: Pending } | undefined;
  let held: Pending | undefined;
  let pull: ((next: IteratorResult<Uint8Array>) => void) | undefined;
  let ended = false;
  let failure: { error: unknown } | undefined;

  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next(): Promise<IteratorResult<Uint8Array>> {
        held?.resolve();
        held = undefined;
        if (offered) {
          const { chunk, pending } = offered;
          offered = undefined;
          held = pending;
          return Promise.resolve({ done: false, value: chunk });
        }
        if (ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          pull = resolve;
        });
      },
    }),
  };
  const done = writeFramed(source, out, payloadBytes).catch((error: unknown) => {
    failure = { error };
    offered?.pending.reject(error);
    held?.reject(error);
    offered = undefined;
    held = undefined;
    throw error;
  });
  // Failures reach the caller through `write` and `end`.
  done.catch(() => {});

  return {
    sink: {
      write(chunk) {
        if (failure) return Promise.reject(failure.error);
        if (ended) return Promise.reject(new Error("write after end"));
        return new Promise<void>((resolve, reject) => {
          const pending = { resolve, reject };
          if (pull) {
            const give = pull;
            pull = undefined;
            held = pending;
            give({ done: false, value: chunk });
          } else offered = { chunk, pending };
        });
      },
    },
    async end() {
      ended = true;
      if (pull) {
        const give = pull;
        pull = undefined;
        give({ done: true, value: undefined });
      }
      await done;
    },
  };
}
