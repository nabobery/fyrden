import { ALARM_UNITS, type AlarmUnit } from "../do/user/alarm-budget.js";
import { DISCRETIONARY_RESOURCES, type ResourceVector } from "../effects/discretionary.js";
import { isLiveVector } from "./budget.js";
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

/**
 * The inline components a unit an alarm runs must reserve with it: an
 * owned unit's whole accounting (its grant and coverage, its owner's
 * admission, dispatch, observation, settlement page and release). Units
 * run elsewhere (a Worker's entry, another object) need none.
 */
export const LIVE_REQUIRED_COMPONENTS: Partial<Record<LiveManifestUnit, readonly AlarmUnit[]>> = {
  pump: [
    "pump",
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

/** An entry priced by the rule from `estimate` (an estimate of its fixtures' most, until measured). */
function estimated(
  estimate: Partial<ResourceVector>,
  entry: Omit<LiveManifestEntry, "resources" | "observed" | "components"> &
    Partial<Pick<LiveManifestEntry, "components">>,
): LiveManifestEntry {
  const observed = vector(estimate);
  return {
    components: [],
    ...entry,
    observed: { estimate: observed },
    resources: livePrice([observed], entry.requests, entry.duration, entry.maxQuantity),
  };
}

/**
 * The prices of the units wired so far (Proposed: estimated, not yet
 * measured; the manifest's literal prices are frozen from measurements
 * once every unit is wired).
 *
 * - `ticket`: the issuance's counter and transport rows, one call of the
 *   feed's object and its ticket's row, its owner's accounting; leaving
 *   the ticket's local row and the directory's rows to clean up.
 * - `upgrade_transport`: the whole upgrade attempt, owned: the transport's
 *   claim, the redemption's call of the feed's object, the admission's
 *   refusals, the check after its dependencies are indexed, and the
 *   socket's or the refusal's upgrade, over the ticket's life.
 * - `admission`: a socket admitted: its lease and dependencies, its
 *   confirmation, installation and terminal provisions (the transport's
 *   owner covers the time it is awaited: its own duration is an entry's).
 */
export const LIVE_PRICES: Partial<Record<LiveManifestUnit, LiveManifestEntry>> = {
  ticket: estimated(
    { do_rows_read: 10, do_rows_written: 4, d1_rows_read: 30, d1_rows_written: 14 },
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
    { do_rows_read: 20, do_rows_written: 6, d1_rows_read: 30, d1_rows_written: 10 },
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
    { do_rows_read: 40, do_rows_written: 20, d1_rows_read: 40, d1_rows_written: 16 },
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
};
