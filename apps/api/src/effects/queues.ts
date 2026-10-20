import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { type EffectSink, PER_MESSAGE } from "./journal.js";

/**
 * The messages that carry effect ids to their sink's queue. A message only
 * says which effects to look at: the journal decides whether each is still
 * to be delivered, so a lost, repeated, early or late message changes
 * nothing but when.
 */

/** A message of an effects queue: one sink's effects, by id. */
export interface EffectMessage {
  readonly v: 1;
  readonly sink: string;
  readonly ids: readonly string[];
}

export function isEffectMessage(body: unknown): body is EffectMessage {
  if (typeof body !== "object" || body === null) return false;
  const message = body as Partial<EffectMessage>;
  return (
    message.v === 1 &&
    typeof message.sink === "string" &&
    Array.isArray(message.ids) &&
    message.ids.length > 0 &&
    message.ids.every((id) => typeof id === "string")
  );
}

/**
 * Sends `ids` of `sink` to its queue, after `delaySeconds` (none: at once).
 * Throws when a send failed (some may have gone: a repeat is harmless).
 */
export type Publish = (
  sink: string,
  ids: readonly string[],
  delaySeconds?: number,
) => Promise<void>;

/**
 * A message's bytes at most, as JSON: under the 64 KB a queue operation
 * counts (each message carries about 100 bytes of the platform's own), so
 * a message costs one operation each to write, read and delete
 * (https://developers.cloudflare.com/queues/platform/pricing/).
 */
export const MESSAGE_BYTES = 60_000;

/** Messages one `sendBatch` takes at most, and their bytes (https://developers.cloudflare.com/queues/platform/limits/). */
const SEND_BATCH = { messages: 100, bytes: 250_000 } as const;

/** A queue's longest delay (24 hours, the platform's limit), less a margin. */
export const MAX_DELAY_SECONDS = 12 * 60 * 60;

const encoder = new TextEncoder();
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** `ids` as messages of at most `perMessage` ids and `MESSAGE_BYTES` each, in order. */
export function effectMessages(
  sink: string,
  ids: readonly string[],
  perMessage: number,
): EffectMessage[] {
  const messages: EffectMessage[] = [];
  let current: string[] = [];
  const empty = bytesOf({ v: 1, sink, ids: [] });
  let bytes = empty;
  for (const id of ids) {
    // The id as JSON, with the comma before it.
    const size = bytesOf(id) + 1;
    if (current.length > 0 && (current.length >= perMessage || bytes + size > MESSAGE_BYTES)) {
      messages.push({ v: 1, sink, ids: current });
      current = [];
      bytes = empty;
    }
    current.push(id);
    bytes += size;
  }
  if (current.length > 0) messages.push({ v: 1, sink, ids: current });
  return messages;
}

/** Where each sink's effects are sent: its queue's binding. */
export type EffectQueues = Readonly<Record<string, Queue<EffectMessage>>>;

/**
 * Publishing through `queues`, each sink's messages in as few `sendBatch`
 * calls as their number and bytes allow. Counts each call (`queue.send`).
 */
export function publisher(
  queues: EffectQueues,
  sinks: readonly EffectSink[],
  metrics?: Metrics,
): Publish {
  return async (sinkName, ids, delaySeconds) => {
    if (ids.length === 0) return;
    const sink = sinks.find((s) => s.name === sinkName);
    const queue = queues[sinkName];
    if (!sink || !queue) throw new Error(`no queue for the effects of sink ${sinkName}`);
    const messages = effectMessages(sinkName, ids, sink.perMessage ?? PER_MESSAGE);
    const delay =
      delaySeconds === undefined
        ? {}
        : { delaySeconds: Math.min(Math.max(0, Math.ceil(delaySeconds)), MAX_DELAY_SECONDS) };
    let batch: MessageSendRequest<EffectMessage>[] = [];
    let bytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      metrics?.count("queue.send", { queue: `effects_${sinkName}` });
      await queue.sendBatch(batch);
      batch = [];
      bytes = 0;
    };
    for (const body of messages) {
      const size = bytesOf(body);
      if (batch.length >= SEND_BATCH.messages || bytes + size > SEND_BATCH.bytes) await flush();
      batch.push({ body, contentType: "json", ...delay });
      bytes += size;
    }
    await flush();
  };
}
