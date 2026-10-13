import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { type DomainEvent, type Envelope, type EventId, eventKey } from "@fyrden/domain";

/**
 * A Durable Object's transactional outbox. `append` runs inside the
 * transaction that makes the change, so an event exists exactly when its
 * change does. The object's alarm calls `drain`, which sends the events in
 * sequence order, one queue message per batch, and deletes only what was
 * sent. Batches are transport only: an event keeps its id whichever batch
 * carries it, and a batch resent after a failed delete carries the same ids.
 */

/** Proposed values (design: one message under 64 KB, a 128 KB message limit). */
export interface OutboxPolicy {
  /** Events in one message at most. */
  readonly maxEvents: number;
  /** Envelope bytes in one message at most, unless a single event alone is larger. */
  readonly maxBytes: number;
  /** An event larger than this keeps its row and data in `event_payloads`. */
  readonly storeAboveBytes: number;
  /** Wait after a write before draining, so one message carries more events. */
  readonly delayMs: number;
  /** Messages one drain sends at most; the rest waits for the next alarm. */
  readonly maxBatches: number;
  /** First retry delay after a failed send; doubles per attempt up to `maxBackoffMs`. */
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

/**
 * The largest envelope the outbox sends: Queues accept 128 KB per message,
 * including some metadata (verified:
 * https://developers.cloudflare.com/queues/platform/limits/).
 */
export const MAX_MESSAGE_BYTES = 120_000;

export const OUTBOX_POLICY: OutboxPolicy = {
  maxEvents: 50,
  maxBytes: 60 * 1024,
  storeAboveBytes: 96 * 1024,
  delayMs: 1_000,
  maxBatches: 10,
  backoffMs: 1_000,
  maxBackoffMs: 5 * 60 * 1_000,
};

/** An event before the outbox gives it its place in the stream. */
export type NewEvent = Omit<DomainEvent, "id" | "stored">;

export type DrainResult =
  | { readonly ok: true; readonly sent: number; readonly remaining: boolean }
  | { readonly ok: false; readonly sent: number; readonly error: unknown };

type Storage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

export class Outbox {
  constructor(
    private readonly storage: Storage,
    private readonly deps: {
      readonly now: () => number;
      readonly send: (envelope: Envelope) => Promise<void>;
      readonly policy?: OutboxPolicy;
      /** Cost counters: rows written and queue messages sent, by the object's class. */
      readonly metrics?: Metrics;
      readonly doClass?: string;
    },
  ) {}

  #exec(op: string, query: string, ...bindings: unknown[]): void {
    const cursor = this.storage.sql.exec(query, ...bindings);
    cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.metrics?.count(
        "do.rows_written",
        { class: this.deps.doClass ?? "unknown", op },
        cursor.rowsWritten,
      );
  }

  get #policy(): OutboxPolicy {
    return this.deps.policy ?? OUTBOX_POLICY;
  }

  /**
   * Appends one event with its id. Must run inside the caller's
   * transaction; the caller allocates `id.sourceSeq` there too. Throws, and
   * so rolls the change back, if the event cannot travel in a message even
   * without its row and data.
   */
  append(id: EventId, event: NewEvent): DomainEvent {
    const now = this.deps.now();
    let stored: DomainEvent = { ...event, id, stored: false };
    let json = JSON.stringify(stored);
    if (byteLength(json) > this.#policy.storeAboveBytes) {
      this.#exec(
        "outbox.payload",
        "INSERT INTO event_payloads (event_key, payload, created_at) VALUES (?, ?, ?)",
        eventKey(id),
        JSON.stringify({ row: event.entity?.row ?? null, data: event.data }),
        now,
      );
      stored = {
        ...stored,
        entity: event.entity && { ...event.entity, row: null },
        data: null,
        stored: true,
      };
      json = JSON.stringify(stored);
    }
    if (envelopeOverhead(id.sourceId) + byteLength(json) > MAX_MESSAGE_BYTES)
      throw new RangeError(`event ${eventKey(id)} is too large for a queue message`);
    this.#exec(
      "outbox.append",
      "INSERT INTO outbox (source_seq, event, bytes, created_at) VALUES (?, ?, ?, ?)",
      id.sourceSeq,
      json,
      byteLength(json),
      now,
    );
    // Drain after the delay, unless a drain is already due sooner (or is
    // backing off: then the backoff stands).
    this.#exec(
      "outbox.state",
      `INSERT INTO outbox_state (id, next_drain_at) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET next_drain_at = excluded.next_drain_at
       WHERE next_drain_at IS NULL`,
      now + this.#policy.delayMs,
    );
    return stored;
  }

  /** When the next drain is due, or null when the outbox is empty. */
  dueAt(): number | null {
    const row = this.storage.sql
      .exec<{ at: number | null }>(
        "SELECT next_drain_at AS at FROM outbox_state WHERE id = 1 AND EXISTS (SELECT 1 FROM outbox)",
      )
      .toArray()[0];
    return row ? (row.at ?? this.deps.now()) : null;
  }

  /** Rows waiting to be sent. */
  pending(): number {
    return this.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM outbox").one().n;
  }

  /**
   * Sends due events, one message per batch, in sequence order. Never
   * throws: a failure keeps the unsent rows and backs off; anything sent is
   * deleted up to the last sequence actually sent, so rows appended while a
   * send was in flight stay. A batch sent whose rows could not be deleted
   * is sent again with the same ids.
   */
  async drain(sourceId: string): Promise<DrainResult> {
    const policy = this.#policy;
    let sent = 0;
    try {
      for (let batch = 0; batch < policy.maxBatches; batch++) {
        const events = this.#nextBatch(sourceId);
        if (events.length === 0) break;
        const last = (events.at(-1) as DomainEvent).id.sourceSeq;
        await this.deps.send({ sourceId, events });
        this.deps.metrics?.count("queue.send", { queue: "events" });
        this.storage.transactionSync(() => {
          this.#exec("outbox.delete", "DELETE FROM outbox WHERE source_seq <= ?", last);
          this.#exec(
            "outbox.state",
            "UPDATE outbox_state SET attempts = 0, last_error = NULL WHERE id = 1 AND attempts > 0",
          );
        });
        sent += events.length;
      }
      const remaining = this.pending() > 0;
      // More to send: due now. Otherwise the next append sets the delay again.
      this.#exec(
        "outbox.state",
        `INSERT INTO outbox_state (id, next_drain_at) VALUES (1, ?)
         ON CONFLICT (id) DO UPDATE SET next_drain_at = excluded.next_drain_at`,
        remaining ? this.deps.now() : null,
      );
      return { ok: true, sent, remaining };
    } catch (error) {
      try {
        this.#backOff(error);
      } catch {
        // Storage itself is failing: the alarm's re-arm retries later.
      }
      return { ok: false, sent, error };
    }
  }

  /** The oldest rows that fit one message: at least one, then while under both limits. */
  #nextBatch(sourceId: string): DomainEvent[] {
    const policy = this.#policy;
    const rows = this.storage.sql
      .exec<{ event: string; bytes: number }>(
        "SELECT event, bytes FROM outbox ORDER BY source_seq LIMIT ?",
        policy.maxEvents,
      )
      .toArray();
    const events: DomainEvent[] = [];
    let bytes = envelopeOverhead(sourceId);
    for (const row of rows) {
      // One comma between events.
      const added = row.bytes + (events.length > 0 ? 1 : 0);
      if (events.length > 0 && bytes + added > policy.maxBytes) break;
      events.push(JSON.parse(row.event) as DomainEvent);
      bytes += added;
    }
    return events;
  }

  #backOff(error: unknown): void {
    const policy = this.#policy;
    const attempts =
      (this.storage.sql
        .exec<{ attempts: number }>("SELECT attempts FROM outbox_state WHERE id = 1")
        .toArray()[0]?.attempts ?? 0) + 1;
    const delay = Math.min(policy.backoffMs * 2 ** (attempts - 1), policy.maxBackoffMs);
    this.#exec(
      "outbox.state",
      `INSERT INTO outbox_state (id, next_drain_at, attempts, last_error) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET next_drain_at = excluded.next_drain_at,
         attempts = excluded.attempts, last_error = excluded.last_error`,
      this.deps.now() + delay,
      attempts,
      (error instanceof Error ? error.message : String(error)).slice(0, 500),
    );
  }
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** The bytes of an envelope around its events. */
function envelopeOverhead(sourceId: string): number {
  return byteLength(JSON.stringify({ sourceId, events: [] }));
}
