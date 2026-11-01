// Live work's prices: a unit's rows its fixtures' most with a margin
// (ceil(1.25 × observed) + 2; a counter never used, 0), its requests
// counted, its duration a synchronous entry's allowance or none (an
// owner's is reserved apart), queues none; and a manifest refused unless
// it prices every unit, each with live vectors, a known duration mode, a
// positive quantity, known components and at least its observed price.

import { describe, expect, it } from "vitest";
import {
  LIVE_MANIFEST_UNITS,
  LIVE_REQUIRED_COMPONENTS,
  LIVE_SYNCHRONOUS_MS,
  type LiveManifestEntry,
  liveManifestError,
  livePrice,
} from "../src/live/manifest.js";
import { vector, ZERO } from "./helpers/live-budget.js";

describe("a unit's price", () => {
  it("is its fixtures' most rows with a margin, its requests and its duration allowance", () => {
    const observed = [
      vector({ do_rows_read: 100, do_rows_written: 3 }),
      vector({ do_rows_read: 40, d1_rows_read: 7 }),
    ];
    expect(livePrice(observed, 2, "synchronous")).toEqual(
      vector({
        do_requests: 2,
        do_rows_read: 127,
        do_rows_written: 6,
        do_duration_ms: LIVE_SYNCHRONOUS_MS,
        d1_rows_read: 11,
        d1_rows_written: 0,
      }),
    );
    // An owner's duration is reserved apart; a block's allowance is an entry's each.
    expect(livePrice(observed, 1, "owner").do_duration_ms).toBe(0);
    expect(livePrice(observed, 32, "synchronous", 32).do_duration_ms).toBe(
      32 * LIVE_SYNCHRONOUS_MS,
    );
    // A counter never used is free; queues always.
    expect(livePrice([ZERO], 1, "owner")).toEqual(vector({ do_requests: 1 }));
  });
});

/** A manifest pricing every unit at what one fixture observed. */
function complete(): Record<string, LiveManifestEntry> {
  const observed = vector({ do_rows_read: 10, d1_rows_written: 2 });
  return Object.fromEntries(
    LIVE_MANIFEST_UNITS.map((unit) => [
      unit,
      {
        resources: livePrice([observed], 1, "owner"),
        validity: { maxMs: 60_000, days: 2 },
        duration: "owner",
        maxQuantity: 1,
        requests: 1,
        directoryCleanupDebt: ZERO,
        localCleanupDebt: ZERO,
        dayCleanupDebt: ZERO,
        components: [...(LIVE_REQUIRED_COMPONENTS[unit] ?? [])],
        observed: { only: observed },
      } satisfies LiveManifestEntry,
    ]),
  );
}

describe("a manifest", () => {
  it("prices every unit, or is refused saying which and why", () => {
    expect(liveManifestError(complete())).toBeNull();
    const broken = (change: (m: Record<string, LiveManifestEntry>) => void) => {
      const m = complete();
      change(m);
      return liveManifestError(m);
    };
    expect(broken((m) => delete m.pump)).toBe("pump: no price");
    expect(broken((m) => (m.extra = m.pump as LiveManifestEntry))).toBe("unknown unit extra");
    const ticket =
      (patch: Partial<LiveManifestEntry>) => (m: Record<string, LiveManifestEntry>) => {
        m.ticket = { ...(m.ticket as LiveManifestEntry), ...patch };
      };
    // A counter missing, or queues used.
    const { queue_ops: _, ...short } = ZERO;
    expect(broken(ticket({ localCleanupDebt: short as typeof ZERO }))).toBe(
      "ticket: localCleanupDebt is not a live vector",
    );
    expect(
      broken(
        ticket({ resources: { ...complete().ticket?.resources, queue_ops: 1 } as typeof ZERO }),
      ),
    ).toBe("ticket: resources is not a live vector");
    // Below its observed price.
    expect(
      broken(
        ticket({
          resources: { ...(complete().ticket as LiveManifestEntry).resources, do_rows_read: 13 },
        }),
      ),
    ).toBe("ticket: do_rows_read is 13, its price by the rule 15");
    // Above it too, requests other than counted, a duration an owner pays apart, an unused counter.
    const priced = (complete().ticket as LiveManifestEntry).resources;
    for (const [counter, value] of [
      ["do_rows_read", 999_999],
      ["do_requests", 500],
      ["do_duration_ms", 5],
      ["do_rows_written", 3],
    ] as const)
      expect(broken(ticket({ resources: { ...priced, [counter]: value } })), counter).toMatch(
        new RegExp(`^ticket: ${counter} is ${value}, its price by the rule`),
      );
    expect(broken(ticket({ validity: { maxMs: 0, days: 1 } }))).toBe(
      "ticket: its validity must be at most a day, over one or two days",
    );
    expect(broken(ticket({ validity: { maxMs: 60_000, days: 3 as 2 } }))).toBe(
      "ticket: its validity must be at most a day, over one or two days",
    );
    // An inherited name is no component.
    expect(broken(ticket({ components: ["toString" as "settle"] }))).toBe(
      "ticket: unknown component toString",
    );
    // An owned unit's accounting, whole.
    const pump = (m: Record<string, LiveManifestEntry>) => m.pump as LiveManifestEntry;
    expect(
      broken((m) => {
        m.pump = { ...pump(m), components: [] };
      }),
    ).toBe("pump: lacks its pump component");
    expect(
      broken((m) => {
        m.pump = { ...pump(m), components: pump(m).components.filter((c) => c !== "settle") };
      }),
    ).toBe("pump: lacks its settle component");
    expect(broken(ticket({ duration: "lazy" as "owner" }))).toBe("ticket: unknown duration mode");
    expect(broken(ticket({ maxQuantity: 0 }))).toBe(
      "ticket: its quantity must be a positive count",
    );
    expect(broken(ticket({ requests: 0 }))).toBe("ticket: its requests must be a positive count");
    expect(broken(ticket({ components: ["admitOwner", "teleport" as "settle"] }))).toBe(
      "ticket: unknown component teleport",
    );
    expect(broken(ticket({ observed: {} }))).toBe("ticket: no fixture observed");
  });
});
