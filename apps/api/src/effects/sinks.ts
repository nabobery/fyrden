import { feedSink } from "../feed/sink.js";
import { webhookSink } from "../webhooks/sink.js";
import type { EffectSink } from "./journal.js";

/** The effect sinks of this deployment: webhook deliveries and activity feed entries. */
export const EFFECT_SINKS: readonly EffectSink[] = [webhookSink, feedSink];
