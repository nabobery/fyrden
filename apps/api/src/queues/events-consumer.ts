import { createLogger, type Metrics } from "@fyrden/adapters-cloudflare/obs";
import {
  compareVersion,
  type DomainEvent,
  type EntitySnapshot,
  eventKey,
  isId,
  parseEnvelope,
  parseRepoRow,
  REPO_ENTITY,
  type RepoRow,
} from "@fyrden/domain";
import { dispatchEffects } from "../effects/dispatcher.js";
import {
  type EffectSink,
  effectId,
  effectStatements,
  INLINE_BATCH_EFFECTS,
  INLINE_EFFECTS,
} from "../effects/journal.js";
import { EFFECT_SINKS } from "../effects/sinks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { feedSink } from "../feed/sink.js";

/** The queue repository outboxes send to. */
export const EVENTS_QUEUE = "fyrden-events";

/**
 * How long events of a repository the directory does not list are kept
 * waiting, from when the consumer first saw them, before they are dropped.
 * A repository's object is created before its directory row, so its first
 * events can arrive first; a creation that then fails (a lost race for the
 * name) leaves events no one will ever list. Proposed.
 */
export const UNLISTED_GRACE_MS = 10 * 60 * 1000;

/**
 * The first and the longest delay a waiting message is put back for; the
 * delay grows with the time waited in between. Proposed.
 */
export const UNLISTED_DELAY_SECONDS = { first: 30, max: 300 } as const;

/**
 * A message put back to wait: the envelope, unchanged, and when the
 * consumer first saw it. It is sent as a new message, so waiting does not
 * use up the retries meant for failures, and its deadline is the
 * consumer's own clock, not the events' times.
 */
export interface WaitingMessage {
  readonly waitingSince: number;
  readonly envelope: unknown;
}

function isWaiting(body: unknown): body is WaitingMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    Number.isSafeInteger((body as WaitingMessage).waitingSince) &&
    "envelope" in body
  );
}

/** Delay before a failed message is delivered again. Proposed. */
export const RETRY_DELAY_SECONDS = 10;

/** `unlisted`: the directory does not list the repository (yet). */
/** `deferred`: the invocation's D1 queries are spent; the message waits for a later one. */
export type ApplyOutcome = "applied" | "dropped" | "unlisted" | "deferred";

/**
 * D1 queries one consumer invocation spends on its messages (Free allows
 * 50; some are left for the rest). Proposed.
 */
export const INVOCATION_QUERIES = 45;
/** D1 queries one inline effect delivery costs at most (its claim, its work, its outcome). */
const QUERIES_PER_EFFECT = 6;
/**
 * D1 queries a message's inline effects of batch sinks cost at most (a
 * claim, the sink's own lookup, a mark, a retry).
 */
const QUERIES_PER_BATCH = 4;

/**
 * Calls to internal services (D1, Durable Objects, R2, queues) one
 * consumer invocation makes at most: Free allows 1,000 an invocation
 * (measured, see docs/operations/limits.md); some are left for the rest.
 * Proposed.
 */
export const INVOCATION_CALLS = 900;
/** Calls applying a message costs besides reading its stored events (its lookup, its batch, a send back). */
const CALLS_PER_MESSAGE = 3;
/** Calls one inline effect of a sink delivering one at a time costs at most (its claim, its work, its outcome). */
const CALLS_PER_EFFECT = 8;
/** Calls a message's inline effects of batch sinks cost besides their deliveries (as their queries). */
const CALLS_PER_BATCH = QUERIES_PER_BATCH;

/** The calls applying a message's envelope costs, its deliveries aside. */
function messageCalls(body: unknown): number {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return CALLS_PER_MESSAGE;
  return (
    CALLS_PER_MESSAGE + events.filter((e) => (e as { stored?: unknown })?.stored === true).length
  );
}

export interface ConsumerOptions {
  readonly now?: () => number;
  readonly metrics?: Metrics;
  /** The effect sinks (default: the deployment's). */
  readonly sinks?: readonly EffectSink[];
  /**
   * Effects the invocation may still deliver itself, shared by its
   * messages (default: its own): of sinks that deliver one at a time, and
   * of sinks that deliver in batches.
   */
  readonly inline?: { left: number; batched: number };
  /**
   * D1 queries the invocation may still spend, shared by its messages, and
   * whether one was applied (a message alone is applied whatever it costs).
   */
  readonly queries?: { left: number; applied: boolean };
  /**
   * Calls the invocation may still make, shared by its messages, and how
   * many of them applying the messages after this one needs.
   */
  readonly calls?: { left: number; reserved: number };
}

/**
 * The `events` consumer: each message (one envelope from one source) is
 * applied with one directory lookup and one read-model batch, then
 * acknowledged; a failure retries the message, and a message that keeps
 * failing goes to the dead-letter queue. A message for a repository not
 * listed yet is put back to wait (`WaitingMessage`) until the grace ends.
 */
export async function consumeEvents(
  batch: MessageBatch<unknown>,
  env: Env,
  options: ConsumerOptions = {},
): Promise<void> {
  const log = createLogger({ op: "events.consume" });
  // One share of inline deliveries and of D1 queries for the whole invocation, however many
  // messages it has.
  options = {
    ...options,
    inline: options.inline ?? { left: INLINE_EFFECTS, batched: INLINE_BATCH_EFFECTS },
    queries: options.queries ?? { left: INVOCATION_QUERIES, applied: false },
    calls: options.calls ?? { left: INVOCATION_CALLS, reserved: 0 },
  };
  const envelopes = batch.messages.map((message) =>
    isWaiting(message.body) ? message.body.envelope : message.body,
  );
  // What applying each message needs, kept for it while the ones before it deliver.
  const needs = envelopes.map(messageCalls);
  for (const [i, message] of batch.messages.entries()) {
    try {
      const waiting = isWaiting(message.body) ? message.body : undefined;
      const envelope = envelopes[i];
      if (options.calls) options.calls.reserved = needs.slice(i + 1).reduce((a, b) => a + b, 0);
      const outcome = await applyEnvelope(env, envelope, options);
      if (outcome === "deferred") {
        // A new message, not a retry: waiting for budget is no failure.
        await env.EVENTS.send(message.body, { contentType: "json", delaySeconds: 1 });
        options.metrics?.count("queue.send", { queue: "events" });
      } else if (outcome === "unlisted") {
        const now = options.now?.() ?? Date.now();
        const since = Math.min(waiting?.waitingSince ?? now, now);
        const waited = now - since;
        if (waited <= UNLISTED_GRACE_MS) {
          const put: WaitingMessage = { waitingSince: since, envelope };
          await env.EVENTS.send(put, {
            contentType: "json",
            delaySeconds: Math.min(
              Math.max(UNLISTED_DELAY_SECONDS.first, Math.ceil(waited / 1000)),
              UNLISTED_DELAY_SECONDS.max,
            ),
          });
          options.metrics?.count("queue.send", { queue: "events" });
        } else {
          log.warn("dropping events of a repository that was never listed", {
            messageId: message.id,
            waitedMs: waited,
          });
        }
      }
      message.ack();
    } catch (error) {
      log.error("applying events failed", {
        error,
        messageId: message.id,
        attempts: message.attempts,
      });
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}

/**
 * Applies one envelope to its source's read model. Snapshots are applied
 * with a version guard, so duplicates and any delivery order converge on
 * the newest snapshot of each entity. An account's events (what its access
 * changes mean for activity feeds) project nothing and go to the feed sink
 * only. Throws on a malformed envelope or row.
 */
export async function applyEnvelope(
  env: Env,
  body: unknown,
  options: ConsumerOptions = {},
): Promise<ApplyOutcome> {
  const parsed = parseEnvelope(body);
  if (!parsed.ok) throw new Error(`malformed event envelope: ${parsed.error}`);
  const { sourceId, events } = parsed.envelope;
  const now = options.now?.() ?? Date.now();
  const account = isId(sourceId, "org") || isId(sourceId, "usr");
  if (!account && !isId(sourceId, "rep")) return "dropped";
  const queries = options.queries ?? { left: INVOCATION_QUERIES, applied: false };
  if (queries.applied && queries.left < 3) return "deferred";
  const calls = options.calls ?? { left: INVOCATION_CALLS, reserved: 0 };
  const applying = messageCalls(parsed.envelope);
  if (queries.applied && applying > calls.left - calls.reserved) return "deferred";
  calls.left -= applying;

  // An account's read model is the deployment's (one organization for now).
  let shard = DEFAULT_ORG_SHARD;
  if (!account) {
    queries.left -= 1;
    options.metrics?.count("d1.query", { db: "directory", op: "events_route" });
    const listed = await env.DIRECTORY.prepare("SELECT state, org_shard FROM repos WHERE id = ?")
      .bind(sourceId)
      .first<{ state: string; org_shard: string }>();
    if (!listed) return "unlisted";
    // Events of a repository being deleted are dropped (purging its rows
    // comes with deletion).
    if (listed.state !== "active") return "dropped";
    shard = listed.org_shard;
  }

  const payloads = storedPayloads(env, sourceId);
  const snapshots = account ? [] : await resolveStored(payloads, newestSnapshots(events));
  const db = readModelFor(env, shard);
  // The newest epoch any event shows, projected or not: from then on, older
  // epochs are refused.
  const epochGen = Math.max(...events.map((e) => e.id.epochGen));
  const sinks = (options.sinks ?? EFFECT_SINKS).filter(
    (sink) => !account || sink.name === feedSink.name,
  );
  // Sinks see every event whole (stored ones with their row and data).
  const planned = sinks.length > 0 ? await hydrate(payloads, events) : events;
  const effects = effectStatements(db, sinks, sourceId, planned, now);
  const statements = [
    epochStatement(db, sourceId, epochGen, now),
    ...snapshots.map((event) => repoStatement(db, sourceId, event, now)),
    ...effects,
  ];
  // Past what is left of the invocation's queries: a later invocation applies it (one alone always).
  if (queries.applied && statements.length > queries.left) return "deferred";
  queries.left -= statements.length;
  queries.applied = true;
  options.metrics?.count("d1.query", { db: "org", op: "events_apply" }, statements.length);
  const results = await db.batch<{ effect_id: string; sink: string }>(statements);
  // Only the effects this batch inserted: one already journaled keeps its own schedule.
  const inserted = results
    .slice(statements.length - effects.length)
    .flatMap((result) => result.results);
  // Journaled with the projection; what cannot be delivered now, the sweeper retries.
  const inline = options.inline ?? { left: INLINE_EFFECTS, batched: INLINE_BATCH_EFFECTS };
  const batching = new Set(sinks.filter((s) => s.deliverBatch).map((s) => s.name));
  const single = inserted.filter((row) => !batching.has(row.sink)).map((row) => row.effect_id);
  const batched = inserted.filter((row) => batching.has(row.sink)).map((row) => row.effect_id);
  // What the invocation's calls allow now, the later messages' application kept aside.
  const spare = () => Math.max(0, calls.left - calls.reserved);
  const take = Math.min(
    inline.left,
    single.length,
    Math.max(0, Math.floor(queries.left / QUERIES_PER_EFFECT)),
    Math.floor(spare() / CALLS_PER_EFFECT),
  );
  inline.left -= take;
  queries.left -= take * QUERIES_PER_EFFECT;
  calls.left -= take * CALLS_PER_EFFECT;
  // A batch sink's effects go together: a few queries however many, and the calls each makes.
  const costs = batchCalls(sinks, planned);
  let takeBatched = 0;
  let batchCost = CALLS_PER_BATCH;
  if (queries.left >= QUERIES_PER_BATCH)
    for (const id of batched.slice(0, inline.batched)) {
      const cost = costs.get(id) ?? 1;
      if (batchCost + cost > spare()) break;
      batchCost += cost;
      takeBatched++;
    }
  if (takeBatched > 0) {
    inline.batched -= takeBatched;
    queries.left -= QUERIES_PER_BATCH;
    calls.left -= batchCost;
  }
  try {
    await dispatchEffects(
      {
        db,
        env,
        sinks,
        now: options.now ?? Date.now,
        log: createLogger({ op: "effects.dispatch" }),
        ...(options.metrics && { metrics: options.metrics }),
      },
      // The invocation's bounded share now: the effects cron takes the rest (every five minutes).
      [...single.slice(0, take), ...batched.slice(0, takeBatched)],
    );
  } catch (error) {
    createLogger({ op: "effects.dispatch" }).warn("dispatching effects failed", { error });
  }
  return "applied";
}

/** The calls each effect of a batch sink the events plan makes at most, by effect id. */
function batchCalls(
  sinks: readonly EffectSink[],
  events: readonly DomainEvent[],
): Map<string, number> {
  const costs = new Map<string, number>();
  for (const sink of sinks) {
    if (!sink.deliverBatch) continue;
    for (const event of events)
      for (const planned of sink.plan(event))
        costs.set(effectId(event, sink.name, planned.target), sink.calls?.(planned) ?? 1);
  }
  return costs;
}

export type Snapshot = DomainEvent & { entity: EntitySnapshot };

/** Records a source's newest epoch seen; from then on, older epochs are refused. */
export function epochStatement(
  db: D1Database,
  sourceId: string,
  epochGen: number,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO consumer_epochs (source_id, epoch_gen, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (source_id) DO UPDATE SET epoch_gen = excluded.epoch_gen,
         updated_at = excluded.updated_at
       WHERE excluded.epoch_gen > consumer_epochs.epoch_gen`,
    )
    .bind(sourceId, epochGen, now);
}

/** The newest snapshot of each entity in the envelope (activity events have no projection yet). */
function newestSnapshots(events: readonly DomainEvent[]): Snapshot[] {
  const newest = new Map<string, Snapshot>();
  for (const event of events) {
    const { entity } = event;
    if (!entity || entity.type !== REPO_ENTITY) continue;
    const key = `${entity.type}:${entity.id}`;
    const seen = newest.get(key);
    const position = (e: Snapshot) => ({ epochGen: e.id.epochGen, version: e.entity.version });
    if (!seen || compareVersion(position(event as Snapshot), position(seen)) > 0)
      newest.set(key, event as Snapshot);
  }
  return [...newest.values()];
}

/** A stored event's `{ row, data }` by event key, fetched once per envelope; null once gone. */
type Payloads = (event: DomainEvent) => Promise<{ row?: unknown; data?: unknown } | null>;

function storedPayloads(env: Env, sourceId: string): Payloads {
  const fetched = new Map<string, Promise<{ row?: unknown; data?: unknown } | null>>();
  const source = isId(sourceId, "rep") ? env.REPO.getByName(sourceId) : env.ORG.getByName(sourceId);
  return (event) => {
    const key = eventKey(event.id);
    let payload = fetched.get(key);
    if (!payload) {
      payload = source
        .eventPayload(key)
        .then((json) =>
          json === null ? null : (JSON.parse(json) as { row?: unknown; data?: unknown }),
        );
      fetched.set(key, payload);
    }
    return payload;
  };
}

/**
 * Fills in the rows of stored snapshots from the source. A payload already
 * gone (past its retention) leaves the entity to a later snapshot or a
 * rebuild; a payload that is there is used as it is, so a malformed one
 * fails the message.
 */
async function resolveStored(
  payloads: Payloads,
  snapshots: readonly Snapshot[],
): Promise<Snapshot[]> {
  const resolved: Snapshot[] = [];
  for (const event of snapshots) {
    if (!event.stored || event.entity.deleted) {
      resolved.push(event);
      continue;
    }
    const payload = await payloads(event);
    if (payload === null) continue;
    resolved.push({
      ...event,
      entity: { ...event.entity, row: payload.row as Record<string, unknown> },
    });
  }
  return resolved;
}

/**
 * Stored events with their row and data put back, for the sinks; an event
 * whose payload is gone stays as it travelled (`stored`, no data).
 */
async function hydrate(payloads: Payloads, events: readonly DomainEvent[]): Promise<DomainEvent[]> {
  const whole: DomainEvent[] = [];
  for (const event of events) {
    const payload = event.stored ? await payloads(event) : null;
    if (!payload) {
      whole.push(event);
      continue;
    }
    whole.push({
      ...event,
      stored: false,
      entity: event.entity && {
        ...event.entity,
        row: (payload.row ?? null) as Record<string, unknown> | null,
      },
      data: (payload.data ?? null) as Record<string, unknown> | null,
    });
  }
  return whole;
}

/**
 * The guarded upsert of one repository snapshot: written only if its epoch
 * is not older than the source's newest, its ownership generation is
 * current, and it is newer than the row it replaces.
 */
export function repoStatement(
  db: D1Database,
  sourceId: string,
  event: Snapshot,
  now: number,
): D1PreparedStatement {
  const { entity } = event;
  if (entity.id !== sourceId)
    throw new Error(`a repository event for another repository: ${entity.id}`);
  let row: RepoRow | undefined;
  if (!entity.deleted) {
    row = parseRepoRow(entity.row);
    if (!row) throw new Error(`malformed repository row in ${eventKey(event.id)}`);
  } else if (entity.row !== null) {
    // A tombstone a deletion kept (never an event's) carries the row it ended with.
    row = parseRepoRow(entity.row);
  }
  return db
    .prepare(
      `INSERT INTO repos (repo_id, owner_id, name, visibility, default_branch, pushed_at, created_at,
         deleted, epoch_gen, version, owner_gen, updated_seq, updated_at, description)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
       WHERE ?9 >= (SELECT epoch_gen FROM consumer_epochs WHERE source_id = ?1)
         AND ?11 >= coalesce((SELECT owner_gen FROM source_owner WHERE source_id = ?1), 0)
       -- An event's tombstone carries no row: the row's fields stay as they were.
       ON CONFLICT (repo_id) DO UPDATE SET
         owner_id = CASE WHEN ?15 = 1 THEN repos.owner_id ELSE excluded.owner_id END,
         name = CASE WHEN ?15 = 1 THEN repos.name ELSE excluded.name END,
         visibility = CASE WHEN ?15 = 1 THEN repos.visibility ELSE excluded.visibility END,
         default_branch = CASE WHEN ?15 = 1 THEN repos.default_branch
           ELSE excluded.default_branch END,
         pushed_at = CASE WHEN ?15 = 1 THEN repos.pushed_at ELSE excluded.pushed_at END,
         created_at = CASE WHEN ?15 = 1 THEN repos.created_at ELSE excluded.created_at END,
         description = CASE WHEN ?15 = 1 THEN repos.description
           ELSE excluded.description END,
         deleted = excluded.deleted,
         epoch_gen = excluded.epoch_gen,
         version = excluded.version,
         owner_gen = excluded.owner_gen,
         updated_seq = excluded.updated_seq,
         updated_at = excluded.updated_at
       WHERE (excluded.epoch_gen, excluded.version) > (repos.epoch_gen, repos.version)`,
    )
    .bind(
      sourceId,
      row?.ownerId ?? null,
      row?.name ?? null,
      row?.visibility ?? null,
      row?.defaultBranch ?? null,
      row?.pushedAt ?? null,
      row?.createdAt ?? null,
      entity.deleted ? 1 : 0,
      event.id.epochGen,
      entity.version,
      event.ownerGen,
      event.id.sourceSeq,
      now,
      row?.description ?? null,
      entity.deleted && row === undefined ? 1 : 0,
    );
}
