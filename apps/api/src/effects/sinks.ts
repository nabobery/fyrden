import { feedSink } from "../feed/sink.js";
import { referenceSink } from "../references/sink.js";
import { webhookSink } from "../webhooks/sink.js";
import type { EffectSink } from "./journal.js";

/** The effect sinks of this deployment: webhook deliveries, activity feed entries, references between repositories. */
export const EFFECT_SINKS: readonly EffectSink[] = [webhookSink, feedSink, referenceSink];
