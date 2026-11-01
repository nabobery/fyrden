import { z } from "zod";
import { isId } from "../ids.js";
import { FeedBlockSchema } from "./feed.js";

/**
 * Domain events. A source (a repository or organization object) gives every
 * event an immutable id, `(source, epoch, sequence)`, in the transaction
 * that makes the change. Events carry versioned snapshots of whole entity
 * rows, not deltas, so a consumer applies them in any order and any number
 * of times: the higher `(epoch, version)` wins. An envelope is one queue
 * message from one source and is transport only; every deduplication key is
 * the event id.
 */

const position = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Ids, names and actors are short; only `row` and `data` may be large. */
const short = z.string().max(256);
// Repositories, and accounts (organizations, users' own) for their access changes.
const sourceId = z
  .string()
  .refine((s) => isId(s, "rep") || isId(s, "org") || isId(s, "usr"), "not a source id");

export const EventIdSchema = z.strictObject({
  sourceId,
  /** The source's restore generation, allocated by the directory (never restored with the source). */
  epochGen: position,
  /** The source's per-event sequence within the epoch. */
  sourceSeq: position,
});
export type EventId = z.infer<typeof EventIdSchema>;

export const EntitySnapshotSchema = z.strictObject({
  type: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z_]*$/),
  id: short.min(1),
  /** Bumped on every change of the entity, within the epoch. */
  version: position,
  deleted: z.boolean(),
  /** The full current row; null for a deletion, or when the event is stored. */
  row: z.record(z.string(), z.unknown()).nullable(),
});
export type EntitySnapshot = z.infer<typeof EntitySnapshotSchema>;

export const DomainEventSchema = z
  .strictObject({
    id: EventIdSchema,
    /** `entity.action` or an activity name, e.g. `repo.updated`, `push`. */
    type: z
      .string()
      .max(64)
      .regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)*$/),
    /** When the source committed the change (milliseconds since the epoch, UTC). */
    at: z.number().int().min(0),
    actor: short.nullable(),
    /** The delegation chain the actor acted under, outermost first. */
    actChain: z.array(short).max(8),
    /** The repository's ownership generation, bumped by a transfer. */
    ownerGen: position,
    entity: EntitySnapshotSchema.nullable(),
    /** What an activity event says beyond the entity (e.g. a push's ref updates). */
    data: z.record(z.string(), z.unknown()).nullable(),
    /**
     * The row and data are too large for a queue message: the source keeps
     * them by event id, and the consumer fetches them.
     */
    stored: z.boolean(),
    /**
     * The repository's webhooks the event goes to (each at the configuration
     * version it had then), and what a delivery says of the repository, as
     * it was when the event happened. Absent when no hook takes the event.
     */
    webhooks: z
      .strictObject({
        hooks: z
          .array(
            z.strictObject({
              id: z.number().int().positive(),
              v: z.number().int().positive(),
            }),
          )
          .min(1)
          .max(20),
        repo: z.strictObject({
          name: short,
          ownerId: short,
          private: z.boolean(),
        }),
      })
      .optional(),
    /**
     * What the event means for principals' activity feeds (see `feed.ts`),
     * decided with the change. Absent when it means nothing for any feed.
     */
    feed: FeedBlockSchema.optional(),
  })
  .superRefine((event, ctx) => {
    const { entity, stored } = event;
    if (stored && (entity?.row != null || event.data !== null))
      ctx.addIssue({ code: "custom", message: "a stored event carries no row or data" });
    if (entity?.deleted && entity.row !== null)
      ctx.addIssue({ code: "custom", message: "a deletion carries no row" });
    if (entity && !entity.deleted && !stored && entity.row === null)
      ctx.addIssue({ code: "custom", message: "a live entity carries its row" });
  });
export type DomainEvent = z.infer<typeof DomainEventSchema>;

/**
 * Events one envelope carries at most: far above what a source's outbox
 * sends in one (50), and what bounds validating a malformed one (its
 * events are not read past it).
 */
export const MAX_ENVELOPE_EVENTS = 1_000;

export const EnvelopeSchema = z
  .strictObject({
    sourceId,
    events: z.array(DomainEventSchema).min(1).max(MAX_ENVELOPE_EVENTS),
  })
  .superRefine((envelope, ctx) => {
    const seen = new Set<string>();
    for (const event of envelope.events) {
      if (event.id.sourceId !== envelope.sourceId)
        ctx.addIssue({ code: "custom", message: "an event from another source" });
      const key = eventKey(event.id);
      if (seen.has(key)) ctx.addIssue({ code: "custom", message: `event ${key} twice` });
      seen.add(key);
    }
  });
export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * `EnvelopeSchema.safeParse`, its events validated one at a time first and
 * stopping at the first invalid one: what validating a malformed envelope
 * holds is one event's issues (bounded by the event's own limits), however
 * many invalid events it carries.
 */
export function safeParseEnvelope(value: unknown): z.ZodSafeParseResult<Envelope> {
  const events = (value as { events?: unknown } | null)?.events;
  if (Array.isArray(events) && events.length <= MAX_ENVELOPE_EVENTS)
    for (const [i, event] of events.entries()) {
      const parsed = DomainEventSchema.safeParse(event);
      if (!parsed.success)
        return {
          success: false,
          // Where in the envelope they are; an envelope's error (it has no data of its own).
          error: new z.ZodError(
            parsed.error.issues.map((issue) => ({ ...issue, path: ["events", i, ...issue.path] })),
          ) as z.ZodError<Envelope>,
        };
    }
  return EnvelopeSchema.safeParse(value);
}

export function parseEnvelope(
  value: unknown,
): { ok: true; envelope: Envelope } | { ok: false; error: string } {
  const parsed = safeParseEnvelope(value);
  return parsed.success
    ? { ok: true, envelope: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

/** The event id as one string, `<source>:<epoch>:<sequence>`: the key every deduplication uses. */
export function eventKey(id: EventId): string {
  return `${id.sourceId}:${id.epochGen}:${id.sourceSeq}`;
}

const KEY_PATTERN = /^([^:]+):([1-9][0-9]*):([1-9][0-9]*)$/;

export function parseEventKey(key: string): EventId | undefined {
  const match = KEY_PATTERN.exec(key);
  if (!match) return undefined;
  const parsed = EventIdSchema.safeParse({
    sourceId: match[1],
    epochGen: Number(match[2]),
    sourceSeq: Number(match[3]),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A position in a source's history: compare `(epochGen, version)` lexicographically. */
export interface VersionPosition {
  readonly epochGen: number;
  readonly version: number;
}

export function compareVersion(a: VersionPosition, b: VersionPosition): -1 | 0 | 1 {
  if (a.epochGen !== b.epochGen) return a.epochGen < b.epochGen ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return 0;
}

const encoder = new TextEncoder();

/** The size of the envelope's JSON in UTF-8 bytes, as a queue message carries it. */
export function envelopeBytes(envelope: Envelope): number {
  return encoder.encode(JSON.stringify(envelope)).length;
}
