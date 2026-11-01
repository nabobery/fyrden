import { feedSink } from "../feed/sink.js";
import { referenceSink } from "../references/sink.js";
import { webhookSink } from "../webhooks/sink.js";
import type { EffectSink } from "./journal.js";
import type { EffectQueues } from "./queues.js";

/** The effect sinks of this deployment: webhook deliveries, activity feed entries, references between repositories. */
export const EFFECT_SINKS: readonly EffectSink[] = [webhookSink, feedSink, referenceSink];

/** Each sink's queue (wrangler.jsonc), by the queue's name, as the queue handler sees it. */
export const EFFECT_QUEUE_NAMES: Readonly<Record<string, string>> = {
  [webhookSink.name]: "fyrden-effects-webhooks",
  [feedSink.name]: "fyrden-effects-feed",
  [referenceSink.name]: "fyrden-effects-references",
};

/** Each sink's queue binding. */
export function effectQueues(env: Env): EffectQueues {
  return {
    [webhookSink.name]: env.EFFECTS_WEBHOOKS,
    [feedSink.name]: env.EFFECTS_FEED,
    [referenceSink.name]: env.EFFECTS_REFERENCES,
  };
}
