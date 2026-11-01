import type { Publish } from "../../src/effects/queues.js";

/** What was sent to effects queues, in order. */
export type Sent = { sink: string; ids: string[]; delaySeconds?: number }[];

/**
 * A stand-in for the effects queues: messages are kept, not sent (a real
 * queue's consumer would deliver them in the background while a test reads
 * them). `failNext(n)` makes the next `n` sends fail.
 */
export function recordingPublish() {
  const sent: Sent = [];
  let failing = 0;
  const publish: Publish = async (sink, ids, delaySeconds) => {
    if (failing > 0) {
      failing--;
      throw new Error("queue unavailable");
    }
    sent.push({ sink, ids: [...ids], ...(delaySeconds !== undefined && { delaySeconds }) });
  };
  return { publish, sent, failNext: (n: number) => (failing = n) };
}
