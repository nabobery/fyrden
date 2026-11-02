import { ALARM_UNITS, type AlarmUnit } from "../do/user/alarm-budget.js";
import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../effects/discretionary.js";
import { isLiveVector, type LiveUnit } from "./budget.js";
import { LIVE_PENDING_MS } from "./duration.js";

/*
 * Live work's prices: what one admission of each funded unit may use at
 * most, a counter each, from what it was measured to use. A unit's rows
 * are its largest observation across its fixtures (a callee's own unit
 * apart: it pays for itself) with a margin, ceil(1.25 × observed) + 2, a
 * counter it never uses priced 0; its Durable Object requests the entries,
 * callbacks and child calls it may make, counted, not measured; queues
 * none. Duration is paid apart: an owner's reserved and settled, or a
 * synchronous entry's fixed allowance. Each entry names the inline
 * components its execution reserves in an alarm, and the cleanup it may
 * leave owed. The margin and the allowance are Proposed engineering
 * choices, not measured platform bounds.
 */

const R = DISCRETIONARY_RESOURCES;

/** The units live work is priced in, each admitted whole. */
export const LIVE_MANIFEST_UNITS = [
  "ticket",
  "upgrade_transport",
  "admission",
  "terminal",
  "control",
  "control_block",
  "renewal",
  "pump",
  "org_confirmation",
  "mark",
  "mark_block",
  "refill",
  "maintenance",
  "reap",
  "revocation_page",
  "recovery",
  "settlement",
] as const;
export type LiveManifestUnit = (typeof LIVE_MANIFEST_UNITS)[number];

/** A synchronous entry's duration allowance (object-ms an entry; Proposed). */
export const LIVE_SYNCHRONOUS_MS = 1_000;

const DAY = 86_400_000;

/** How long a pool's block may be spent from (Proposed). */
export const LIVE_BLOCK_MS = 6 * 60 * 60_000;

/**
 * The inline components a unit an alarm runs must reserve with it: an
 * owned unit's whole accounting (its grant and coverage, its owner's
 * admission, dispatch, observation, settlement page and release). Units
 * run elsewhere (a Worker's entry, another object) need none.
 */
export const LIVE_REQUIRED_COMPONENTS: Partial<Record<LiveManifestUnit, readonly AlarmUnit[]>> = {
  pump: [
    "pump",
    // Its successor's grant, and its account confirmation's.
    "grant",
    "grant",
    "coverage",
    "admitOwner",
    "dispatchOwner",
    "acceptObservation",
    "settle",
    "releaseOwner",
  ],
  renewal: [
    "renewal",
    "grant",
    "coverage",
    "admitOwner",
    "dispatchOwner",
    "acceptObservation",
    "settle",
    "releaseOwner",
  ],
  refill: [
    "grant",
    "coverage",
    "admitOwner",
    "dispatchOwner",
    "acceptObservation",
    "settle",
    "releaseOwner",
  ],
};

/** How long a unit's funding may be valid, and over how many UTC days (one, or across a midnight). */
export interface LiveValidity {
  readonly maxMs: number;
  readonly days: 1 | 2;
}

export interface LiveManifestEntry {
  /** What one admission may use at most: exactly its price by the rule, from its fixtures. */
  readonly resources: ResourceVector;
  readonly validity: LiveValidity;
  /** An owner's duration reserved and settled, or a synchronous entry's allowance. */
  readonly duration: "owner" | "synchronous";
  /** The most one admission covers (32 controls of a block, say); 1 for a single unit. */
  readonly maxQuantity: number;
  readonly directoryCleanupDebt: ResourceVector;
  readonly localCleanupDebt: ResourceVector;
  readonly dayCleanupDebt: ResourceVector;
  /** The inline components its execution reserves in an alarm (none for work outside one). */
  readonly components: readonly AlarmUnit[];
  /** The fixtures it was measured on, each with the most it was observed to use. */
  readonly observed: Readonly<Record<string, ResourceVector>>;
  /** The Durable Object requests one admission may make (entries, callbacks, child calls). */
  readonly requests: number;
  /**
   * An owned unit's pending bound: the longest its caller waits for it (and
   * stops waiting, the owner left for recovery), its holds covering a run of
   * it and its tail; `LIVE_PENDING_MS` unless shorter.
   */
  readonly pendingMs?: number;
}

const ROWS = ["do_rows_read", "do_rows_written", "d1_rows_read", "d1_rows_written"] as const;

/**
 * A unit's price from its fixtures' observations (`observed`, the most of
 * each counter taken), the requests it may make, its duration mode and the
 * most one admission covers.
 */
export function livePrice(
  observed: readonly ResourceVector[],
  requests: number,
  duration: LiveManifestEntry["duration"],
  maxQuantity = 1,
): ResourceVector {
  const most = (counter: (typeof R)[number]) => Math.max(0, ...observed.map((o) => o[counter]));
  const price = Object.fromEntries(R.map((r) => [r, 0])) as Record<(typeof R)[number], number>;
  for (const counter of ROWS) {
    const m = most(counter);
    price[counter] = m === 0 ? 0 : Math.ceil(1.25 * m) + 2;
  }
  price.do_requests = requests;
  price.do_duration_ms = duration === "synchronous" ? LIVE_SYNCHRONOUS_MS * maxQuantity : 0;
  return price as ResourceVector;
}

/**
 * Why `manifest` cannot price live work, or null: a unit missing, or one
 * whose vectors are not live vectors, whose price is not exactly its
 * fixtures' by the rule, whose duration mode, quantity, requests or
 * validity is not one supported, which names a component an alarm does not
 * know, or which lacks a component its unit requires.
 */
export function liveManifestError(
  manifest: Partial<Record<string, LiveManifestEntry>>,
): string | null {
  for (const unit of Object.keys(manifest))
    if (!(LIVE_MANIFEST_UNITS as readonly string[]).includes(unit)) return `unknown unit ${unit}`;
  for (const unit of LIVE_MANIFEST_UNITS) {
    const entry = manifest[unit];
    if (!entry) return `${unit}: no price`;
    for (const [name, v] of [
      ["resources", entry.resources],
      ["directoryCleanupDebt", entry.directoryCleanupDebt],
      ["localCleanupDebt", entry.localCleanupDebt],
      ["dayCleanupDebt", entry.dayCleanupDebt],
    ] as const)
      if (!isLiveVector(v)) return `${unit}: ${name} is not a live vector`;
    if (entry.duration !== "owner" && entry.duration !== "synchronous")
      return `${unit}: unknown duration mode`;
    if (!Number.isSafeInteger(entry.maxQuantity) || entry.maxQuantity < 1)
      return `${unit}: its quantity must be a positive count`;
    if (!Number.isSafeInteger(entry.requests) || entry.requests < 1)
      return `${unit}: its requests must be a positive count`;
    if (
      entry.pendingMs !== undefined &&
      (!Number.isSafeInteger(entry.pendingMs) ||
        entry.pendingMs < 1 ||
        entry.pendingMs > LIVE_PENDING_MS ||
        entry.duration !== "owner")
    )
      return `${unit}: its pending bound must be an owned unit's, at most ${LIVE_PENDING_MS} ms`;
    const { maxMs, days } = entry.validity ?? {};
    if (
      !Number.isSafeInteger(maxMs) ||
      (maxMs as number) < 1 ||
      (maxMs as number) > DAY ||
      (days !== 1 && days !== 2)
    )
      return `${unit}: its validity must be at most a day, over one or two days`;
    for (const component of entry.components)
      if (!Object.hasOwn(ALARM_UNITS, component)) return `${unit}: unknown component ${component}`;
    // Each required component as often as it is required.
    const left = [...entry.components];
    for (const component of LIVE_REQUIRED_COMPONENTS[unit] ?? []) {
      const at = left.indexOf(component);
      if (at < 0) return `${unit}: lacks its ${component} component`;
      left.splice(at, 1);
    }
    const fixtures = Object.values(entry.observed);
    if (fixtures.length === 0) return `${unit}: no fixture observed`;
    if (!fixtures.every(isLiveVector)) return `${unit}: an observation is not a live vector`;
    const price = livePrice(fixtures, entry.requests, entry.duration, entry.maxQuantity);
    for (const counter of R)
      if (entry.resources[counter] !== price[counter])
        return `${unit}: ${counter} is ${entry.resources[counter]}, its price by the rule ${price[counter]}`;
  }
  return null;
}

const ZERO = Object.fromEntries(R.map((r) => [r, 0])) as ResourceVector;
const vector = (parts: Partial<ResourceVector>): ResourceVector => ({ ...ZERO, ...parts });

/** Where an entry's observation was made: the feed's rows locally, D1's on Free. */
const MEASURED = "objects' rows by the live suite's fixtures; D1's on Workers Free, 2026-11-01";

/** An entry priced by the rule from `observed` (its fixtures' most), named by where it was measured. */
function estimated(
  observedRows: Partial<ResourceVector>,
  entry: Omit<LiveManifestEntry, "resources" | "observed" | "components"> &
    Partial<Pick<LiveManifestEntry, "components">>,
  fixture: string = MEASURED,
): LiveManifestEntry {
  const observed = vector(observedRows);
  return {
    components: [],
    ...entry,
    observed: { [fixture]: observed },
    resources: livePrice([observed], entry.requests, entry.duration, entry.maxQuantity),
  };
}

/**
 * The prices of live work's units, from measurements: each unit's rows in
 * the feed's object by the live suite's fixtures (its most cases among
 * them: a pump over a full page with a credential's most sockets, a mark
 * of a stream at its most causes), and D1's rows per invocation on Workers
 * Free (2026-11-01: an upgrade's whole D1 priced on its transport, the
 * admission's, terminal's and blocks' grants within it; a turn's on the
 * pump; maintenance's, its recoveries' within it). A recovery's rows are
 * its page's bound, its D1 an estimate. The margin and the allowances are
 * Proposed.
 *
 * - `ticket`: the issuance's counter and transport rows, one call of the
 *   feed's object and its ticket's row, its owner's accounting; leaving
 *   the ticket's local row and the directory's rows to clean up.
 * - `upgrade_transport`: the whole upgrade attempt, owned: the transport's
 *   claim, the redemption's call of the feed's object, the admission's
 *   refusals, the check after its dependencies are indexed, and the
 *   socket's or the refusal's upgrade, over the ticket's life.
 * - `admission`: a socket admitted: its lease and dependencies, its
 *   confirmation and installation, its terminal provisions' and its feed's
 *   first blocks' installation (the transport's owner covers the time it is
 *   awaited: its own duration is an entry's).
 * - `terminal`: one socket's end on a day it may live on: the event that
 *   detects it, the provision consumed and the socket forgotten, its close
 *   and the callbacks that follow it (no directory call). Granted with the
 *   admission over the socket's life, so each day it may live on pays its
 *   own.
 * - `control` / `mark`: one control message (its counters and its
 *   acknowledgement or renewal request), or one stream marked changed, as
 *   spent from the feed's pool; `control_block` / `mark_block` a block of
 *   them, installed into the pool whole.
 */
export const LIVE_PRICES: Partial<Record<LiveManifestUnit, LiveManifestEntry>> = {
  ticket: estimated(
    { do_rows_read: 26, do_rows_written: 4, d1_rows_read: 191, d1_rows_written: 35 },
    {
      validity: { maxMs: 60_000, days: 2 },
      duration: "owner",
      pendingMs: 30_000,
      maxQuantity: 1,
      requests: 1,
      directoryCleanupDebt: vector({ d1_rows_written: 2 }),
      localCleanupDebt: vector({ do_rows_written: 2 }),
      dayCleanupDebt: ZERO,
    },
  ),
  upgrade_transport: estimated(
    { do_rows_read: 32, do_rows_written: 7, d1_rows_read: 422, d1_rows_written: 67 },
    {
      validity: { maxMs: 120_000, days: 2 },
      duration: "owner",
      pendingMs: 30_000,
      maxQuantity: 1,
      requests: 2,
      directoryCleanupDebt: vector({ d1_rows_written: 1 }),
      localCleanupDebt: ZERO,
      dayCleanupDebt: ZERO,
    },
  ),
  admission: estimated(
    { do_rows_read: 105, do_rows_written: 44 },
    {
      validity: { maxMs: 120_000, days: 2 },
      duration: "synchronous",
      maxQuantity: 1,
      requests: 2,
      directoryCleanupDebt: vector({ d1_rows_written: 6 }),
      localCleanupDebt: vector({ do_rows_written: 10 }),
      dayCleanupDebt: ZERO,
    },
  ),
  terminal: estimated(
    { do_rows_read: 10, do_rows_written: 5 },
    {
      validity: { maxMs: DAY, days: 2 },
      duration: "synchronous",
      maxQuantity: 1,
      requests: 2,
      directoryCleanupDebt: vector({ d1_rows_written: 1 }),
      localCleanupDebt: vector({ do_rows_written: 2 }),
      dayCleanupDebt: ZERO,
    },
  ),
  control: estimated(
    { do_rows_read: 13, do_rows_written: 3 },
    {
      validity: { maxMs: LIVE_BLOCK_MS, days: 2 },
      duration: "synchronous",
      maxQuantity: 1,
      requests: 1,
      directoryCleanupDebt: ZERO,
      localCleanupDebt: ZERO,
      dayCleanupDebt: ZERO,
    },
  ),
  mark: estimated(
    { do_rows_read: 25, do_rows_written: 20 },
    {
      validity: { maxMs: LIVE_BLOCK_MS, days: 2 },
      duration: "synchronous",
      maxQuantity: 1,
      requests: 1,
      directoryCleanupDebt: ZERO,
      localCleanupDebt: ZERO,
      dayCleanupDebt: ZERO,
    },
  ),
};

/** The ledger's kind a unit is granted as: a block as the unit it holds. */
export function liveKindOf(
  unit: "ticket" | "upgrade_transport" | "admission" | "terminal",
): LiveUnit;
export function liveKindOf(unit: "control_block" | "mark_block"): "control" | "mark";
export function liveKindOf(unit: LiveManifestUnit): LiveUnit;
export function liveKindOf(unit: LiveManifestUnit): LiveUnit {
  if (unit === "control_block") return "control";
  if (unit === "mark_block") return "mark";
  return unit as LiveUnit;
}

/** Units a block holds, and how few left of a pool asks for its refill. */
export const LIVE_BLOCK_UNITS = 32;
export const LIVE_LOW_WATER = 8;

/**
 * A block of `unit`'s: `LIVE_BLOCK_UNITS` of it, priced by the rule from
 * that many of the unit's observations (its margin taken once, on the
 * block), each of its requests and allowances counted. A unit is spent
 * from it at an equal share of its price (`liveBlockUnit`).
 */
function blockOf(unit: LiveManifestEntry): LiveManifestEntry {
  const most = (r: (typeof R)[number]) =>
    Math.max(0, ...Object.values(unit.observed).map((o) => o[r]));
  const rows = Object.fromEntries(
    ["do_rows_read", "do_rows_written", "d1_rows_read", "d1_rows_written"].map((r) => [
      r,
      most(r as (typeof R)[number]) * LIVE_BLOCK_UNITS,
    ]),
  );
  return estimated(rows, {
    validity: unit.validity,
    duration: "synchronous",
    maxQuantity: LIVE_BLOCK_UNITS,
    requests: unit.requests * LIVE_BLOCK_UNITS,
    directoryCleanupDebt: vector({ d1_rows_written: 1 }),
    localCleanupDebt: vector({ do_rows_written: 2 }),
    dayCleanupDebt: ZERO,
  });
}

/**
 * - `pump`: a feed's execution turn, one alarm's live work, owned: its
 *   housekeeping (confirmations never finished forgotten, expired and slow
 *   sockets ended), then one kind of work (up to `LIVE_TURN_RENEWALS`
 *   queued renewals, one refill's grant and installation, or one pump
 *   unit: one credential's sockets, one owning account's page, its call of
 *   that account's object paid for by a grant of its own), and its
 *   successor's grant; its owner's whole accounting reserved with it.
 */
LIVE_PRICES.pump = estimated(
  { do_rows_read: 429, do_rows_written: 51, d1_rows_read: 132, d1_rows_written: 24 },
  {
    validity: { maxMs: 30 * 60_000, days: 2 },
    duration: "owner",
    pendingMs: 30_000,
    maxQuantity: 1,
    requests: 8,
    directoryCleanupDebt: vector({ d1_rows_written: 2 }),
    localCleanupDebt: vector({ do_rows_written: 2 }),
    dayCleanupDebt: ZERO,
    components: LIVE_REQUIRED_COMPONENTS.pump as readonly AlarmUnit[],
  },
);

/**
 * - `org_confirmation`: a pump unit's call of its owning account's object
 *   (`confirmReadersLive`), granted by the turn just before it, only when it
 *   has an account to ask: what that object reads at most (a full page of
 *   repositories, each granted to the most teams it reads through, every
 *   one probed, for a credential's readers) and writes (the restore
 *   generation it takes first in an instance of a restored account), both
 *   measured by the live suite's fixtures; the grant's own D1 (at most a
 *   turn's, which makes one) and the call's entry.
 */
LIVE_PRICES.org_confirmation = estimated(
  { do_rows_read: 4_100, do_rows_written: 1, d1_rows_read: 132, d1_rows_written: 24 },
  {
    validity: { maxMs: 60_000, days: 2 },
    duration: "synchronous",
    maxQuantity: 1,
    requests: 1,
    directoryCleanupDebt: vector({ d1_rows_written: 1 }),
    localCleanupDebt: ZERO,
    dayCleanupDebt: ZERO,
  },
);

/**
 * - `maintenance`: one funded run of live maintenance (a cleanup unit):
 *   a page of expired receipts and of old days, a day's duration debt
 *   served, a few feeds' recoveries (each funded on its own), a page of
 *   leases reaped and a page of revocations told (see `LIVE_MAINTENANCE`).
 * - `recovery`: one feed's recovery page (a cleanup unit, owned by its
 *   object while it runs).
 */
LIVE_PRICES.maintenance = estimated(
  { d1_rows_read: 262, d1_rows_written: 49 },
  {
    validity: { maxMs: 10 * 60_000, days: 2 },
    duration: "owner",
    pendingMs: 60_000,
    maxQuantity: 1,
    requests: 20,
    directoryCleanupDebt: vector({ d1_rows_written: 1 }),
    localCleanupDebt: ZERO,
    dayCleanupDebt: ZERO,
  },
);
LIVE_PRICES.recovery = estimated(
  { do_rows_read: 130, do_rows_written: 64, d1_rows_read: 10, d1_rows_written: 4 },
  {
    validity: { maxMs: 10 * 60_000, days: 2 },
    duration: "owner",
    pendingMs: 60_000,
    maxQuantity: 1,
    requests: 1,
    directoryCleanupDebt: vector({ d1_rows_written: 1 }),
    localCleanupDebt: ZERO,
    dayCleanupDebt: ZERO,
  },
);

/** Queued renewals one turn runs at most. */
export const LIVE_TURN_RENEWALS = 2;

LIVE_PRICES.control_block = blockOf(LIVE_PRICES.control as LiveManifestEntry);

/**
 * What one control or mark is spent at from its pool: an equal share of
 * its block's price (rounded down, so a block's units never cost more than
 * it), at least the unit's observation.
 */
export function liveBlockUnit(unit: "control" | "mark"): ResourceVector {
  const block = LIVE_PRICES[`${unit}_block`] as LiveManifestEntry;
  return Object.fromEntries(
    R.map((r) => [r, Math.floor(block.resources[r] / LIVE_BLOCK_UNITS)]),
  ) as ResourceVector;
}
LIVE_PRICES.mark_block = blockOf(LIVE_PRICES.mark as LiveManifestEntry);
