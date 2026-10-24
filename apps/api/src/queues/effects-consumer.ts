import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import { deliverEffects, invocationBudget } from "../effects/dispatcher.js";
import { EFFECT_POLICY, type EffectPolicy, type EffectSink } from "../effects/journal.js";
import { type EffectMessage, isEffectMessage, type Publish, publisher } from "../effects/queues.js";
import { EFFECT_QUEUE_NAMES, EFFECT_SINKS, effectQueues } from "../effects/sinks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";

/** Delay before a message whose outcome could not be recorded is delivered again. Proposed. */
export const EFFECT_RETRY_DELAY_SECONDS = 10;

/** The sink whose effects `queue` carries; undefined for a queue that is not an effects queue. */
export function sinkOfQueue(queue: string): string | undefined {
  return Object.entries(EFFECT_QUEUE_NAMES).find(([, name]) => name === queue)?.[0];
}

export interface EffectsConsumerOptions {
  readonly now?: () => number;
  readonly metrics?: Metrics;
  readonly sinks?: readonly EffectSink[];
  readonly publish?: Publish;
  readonly policy?: EffectPolicy;
}

/**
 * An effects queue's consumer: its messages name effects of the queue's
 * sink, delivered together (a batch sink's in one call per destination)
 * within one budget for the invocation; what it does not reach goes back
 * to the queue. The messages are acknowledged once the outcomes are
 * recorded, and retried when recording them or sending the rest failed
 * (what was done stays done). A malformed message, or one of another sink,
 * is acknowledged and dropped: the effects it might name are still in the
 * journal, and the effects cron sends them again when overdue.
 */
export async function consumeEffects(
  batch: MessageBatch<unknown>,
  env: Env,
  options: EffectsConsumerOptions = {},
): Promise<void> {
  const log = createLogger({ op: "effects.consume" });
  const now = options.now ?? Date.now;
  const sinks = options.sinks ?? EFFECT_SINKS;
  const sink = sinkOfQueue(batch.queue);
  const policy = options.policy ?? EFFECT_POLICY;
  const valid: Message<EffectMessage>[] = [];
  for (const message of batch.messages) {
    const body = message.body;
    if (isEffectMessage(body) && (sink === undefined || body.sink === sink))
      valid.push(message as Message<EffectMessage>);
    else {
      log.warn("dropping a malformed effects message", {
        messageId: message.id,
        queue: batch.queue,
      });
      message.ack();
    }
  }
  const [first] = valid;
  if (!first) return;
  const name = first.body.sink;
  // One sink per queue: a test's batch (no queue of the deployment's) is the first message's sink.
  const ours = valid.filter((message) => message.body.sink === name);
  for (const message of valid.filter((m) => m.body.sink !== name)) message.retry();
  try {
    await deliverEffects(
      {
        db: readModelFor(env, DEFAULT_ORG_SHARD),
        env,
        sinks,
        now,
        publish: options.publish ?? publisher(effectQueues(env), sinks, options.metrics),
        log,
        policy,
        ...(options.metrics && { metrics: options.metrics }),
      },
      name,
      ours.flatMap((message) => message.body.ids),
      invocationBudget(now(), policy),
    );
    options.metrics?.count("effects.consume", { sink: name, outcome: "ok" });
    for (const message of ours) message.ack();
  } catch (error) {
    options.metrics?.count("effects.consume", { sink: name, outcome: "error" });
    log.error("delivering effects messages failed", {
      messageIds: ours.map((message) => message.id),
      error,
    });
    for (const message of ours) message.retry({ delaySeconds: EFFECT_RETRY_DELAY_SECONDS });
  }
}
