import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  compareVersion,
  type DomainEvent,
  type Envelope,
  envelopeBytes,
  eventKey,
  parseEnvelope,
  parseEventKey,
} from "../../src/events/envelope.js";

const REPO = "rep_01K742SG0021RA8PP539MVRVBJ";
const OTHER = "rep_01K742SG00YFQ5D2E90NP22GMM";

const position = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });

function event(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: { sourceId: REPO, epochGen: 1, sourceSeq: 1 },
    type: "repo.updated",
    at: 1_760_000_000_000,
    actor: "usr_01K742SG00NAWD8WB4RTMJF8H7",
    actChain: [],
    ownerGen: 1,
    entity: {
      type: "repo",
      id: REPO,
      version: 1,
      deleted: false,
      row: { name: "r" },
    },
    data: null,
    stored: false,
    ...overrides,
  };
}

const envelope = (events: DomainEvent[]): Envelope => ({ sourceId: REPO, events });

describe("event keys", () => {
  it("round-trip every id", () => {
    fc.assert(
      fc.property(fc.constantFrom(REPO, OTHER), position, position, (sourceId, epochGen, seq) => {
        const id = { sourceId, epochGen, sourceSeq: seq };
        expect(parseEventKey(eventKey(id))).toEqual(id);
      }),
    );
  });

  it("reject anything that is not a key", () => {
    for (const key of [
      "",
      REPO,
      `${REPO}:1`,
      `${REPO}:0:1`,
      `${REPO}:1:0`,
      `${REPO}:1:-1`,
      `${REPO}:1:1.5`,
      `${REPO}:01:1`,
      `${REPO}:1:1:1`,
      `${REPO}:1:9007199254740992`,
      "usr_x:1:1",
    ])
      expect(parseEventKey(key), key).toBeUndefined();
  });
});

describe("compareVersion", () => {
  const version = fc.record({ epochGen: position, version: position });

  it("orders by epoch first, then by version", () => {
    expect(compareVersion({ epochGen: 2, version: 1 }, { epochGen: 1, version: 9 })).toBe(1);
    expect(compareVersion({ epochGen: 1, version: 9 }, { epochGen: 2, version: 1 })).toBe(-1);
    expect(compareVersion({ epochGen: 1, version: 3 }, { epochGen: 1, version: 2 })).toBe(1);
    expect(compareVersion({ epochGen: 1, version: 3 }, { epochGen: 1, version: 3 })).toBe(0);
  });

  it("is a total order", () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(compareVersion(a, b)).toBe(-compareVersion(b, a) || 0);
        if (compareVersion(a, b) <= 0 && compareVersion(b, c) <= 0)
          expect(compareVersion(a, c)).toBeLessThanOrEqual(0);
        expect(compareVersion(a, a)).toBe(0);
      }),
    );
  });
});

describe("parseEnvelope", () => {
  it("accepts a well-formed envelope", () => {
    const value = envelope([event(), event({ id: { sourceId: REPO, epochGen: 1, sourceSeq: 2 } })]);
    expect(parseEnvelope(JSON.parse(JSON.stringify(value)))).toEqual({ ok: true, envelope: value });
  });

  it("accepts an event without an entity (activity) and a stored one", () => {
    const value = envelope([
      event({ type: "push", entity: null, data: { refs: [] } }),
      event({
        id: { sourceId: REPO, epochGen: 1, sourceSeq: 2 },
        entity: { type: "repo", id: REPO, version: 2, deleted: false, row: null },
        stored: true,
      }),
    ]);
    expect(parseEnvelope(value).ok).toBe(true);
  });

  it.each<[string, unknown]>([
    ["not an object", "hello"],
    ["no events", { sourceId: REPO, events: [] }],
    [
      "an event from another source",
      envelope([event({ id: { sourceId: OTHER, epochGen: 1, sourceSeq: 1 } })]),
    ],
    ["a duplicate event", envelope([event(), event()])],
    ["a bad source id", { sourceId: "repo-1", events: [event()] }],
    ["a zero epoch", envelope([event({ id: { sourceId: REPO, epochGen: 0, sourceSeq: 1 } })])],
    [
      "a fractional sequence",
      envelope([event({ id: { sourceId: REPO, epochGen: 1, sourceSeq: 1.5 } })]),
    ],
    ["a bad type", envelope([event({ type: "Repo Updated" })])],
    [
      "a live entity without its row",
      envelope([
        event({ entity: { type: "repo", id: REPO, version: 1, deleted: false, row: null } }),
      ]),
    ],
    [
      "a deleted entity with a row",
      envelope([event({ entity: { type: "repo", id: REPO, version: 1, deleted: true, row: {} } })]),
    ],
    ["a stored event that still carries its row", envelope([event({ stored: true })])],
    [
      "a stored event that still carries data",
      envelope([event({ entity: null, data: {}, stored: true })]),
    ],
    ["an unknown field", envelope([{ ...event(), extra: 1 } as DomainEvent])],
    ["an oversized actor", envelope([event({ actor: "u".repeat(257) })])],
  ])("rejects %s", (_, value) => {
    expect(parseEnvelope(value)).toMatchObject({ ok: false });
  });
});

describe("envelopeBytes", () => {
  it("counts the UTF-8 bytes of the JSON a queue message carries", () => {
    const value = envelope([event({ entity: null, data: { title: "ü" } })]);
    expect(envelopeBytes(value)).toBe(new TextEncoder().encode(JSON.stringify(value)).length);
    expect(envelopeBytes(value)).toBe(JSON.stringify(value).length + 1);
  });
});
