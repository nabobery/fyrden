import { webhookSink } from "../webhooks/sink.js";
import type { EffectSink } from "./journal.js";

/** The effect sinks of this deployment: webhook deliveries (the activity feed's comes later). */
export const EFFECT_SINKS: readonly EffectSink[] = [webhookSink];
