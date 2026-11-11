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
  "maintenance_light",
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
export const LIVE_BLOCK_MS = 12 * 60 * 60_000;

/**
 * The inline components a unit an alarm runs must reserve with it: an
 * owned unit's whole accounting (its grant and coverage, its owner's
 * admission, dispatch, observation, settlement page and release). Units
 * run elsewhere (a Worker's entry, another object) need none.
 */
export const LIVE_REQUIRED_COMPONENTS: Partial<Record<LiveManifestUnit, readonly AlarmUnit[]>> = {
  pump: [
    "pump",
    // Its successor's grant (a turn's), and its account confirmation's.
    "turnGrant",
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
    "turnGrant",
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
  /**
   * A turn's composition, when the unit is a feed's turn: its rows priced
   * as its end and its costliest kind of work (`work`: alternatives, each a
   * list of steps), every step at its most as the meter checks it, and no
   * less than its measured whole turn with the margin (`measured`).
   */
  readonly turn?: LiveTurnComposition;
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
    const price = {
      ...livePrice(fixtures, entry.requests, entry.duration, entry.maxQuantity),
      ...(entry.turn && liveTurnRows(entry.turn, fixtures)),
    };
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
const MEASURED_LOCALLY = "objects' and D1's rows by the live suite's fixtures, measured locally";

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
 * them: a pump over a full page of streams each at its most causes, for a
 * credential's most sockets on a feed with its most, with a full page to
 * prune, its D1 counted too; a mark of a stream at its most causes, or one
 * of its causes changed again, on a feed with its most sockets (their
 * windows full) and at its pool's low water, the feed's own work for the
 * same change taken out), and D1's rows per invocation on Workers
 * Free (2026-11-01: an upgrade's whole D1 priced on its transport, the
 * admission's, terminal's and blocks' grants within it; a turn's on the
 * pump), and maintenance's from its pages full (`LIVE_MAINTENANCE_MEASURED`;
 * its recoveries' pages funded on their own). A recovery's rows are
 * its page's bound, its D1 an estimate. The margin and the allowances are
 * Proposed.
 *
 * - `ticket`: the issuance's counter and transport rows, one call of the
 *   feed's object and its ticket's row (with a page of expired tickets
 *   pruned), its owner's accounting; leaving
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
  // Its D1 measured locally at its worst, every statement's as D1 reports it: its two grants (its
  // own and its transport's, a minute and two) past a midnight, each reading both days' rows, the
  // feed's epoch and as many expired receipts as grants allow, after its check of the socket it
  // would open (315 read, by a feed's later opening; written 42, measured before owners' runs
  // stopped writing two indexes, 38 since). Free's 2026-11-01 measurement was 191 and 35, at noon.
  ticket: estimated(
    { do_rows_read: 48, do_rows_written: 12, d1_rows_read: 315, d1_rows_written: 42 },
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
    MEASURED_LOCALLY,
  ),
  // Its D1 measured locally, every statement's as D1 reports it, from both of its callers: a
  // feed's first opening half a minute before midnight, its admission's, terminal's, blocks' and
  // turn's grants each reading both days' rows, the feed's epoch and as many expired receipts as
  // grants allow, its turn's grant removing a full page of done turns, and 100 of the feed's turns
  // that ran still valid (passed over by its lookup of a turn the feed holds): a browser's upgrade
  // (734 read, 80 written), an MCP listen's opening, which also grants its transport (870 read, 88
  // written), an opening whose turn the feed's object grants itself (the ledger holding one it
  // lost), its blocks granted again (565, 59), and, the most, an MCP listen's first opening by an
  // agent's credential (its owner a dependency too) whose Worker's turn its object will not take
  // (a build priced lower at the same revision), so the object grants itself one too: two turns'
  // grants (1,122 read, 103 written). Free's 2026-11-01 measurement was 422 and 67.
  upgrade_transport: estimated(
    { do_rows_read: 32, do_rows_written: 7, d1_rows_read: 1_122, d1_rows_written: 103 },
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
    MEASURED_LOCALLY,
  ),
  // Its object's rows measured locally at their most, half a minute before a UTC midnight (each
  // opening provides for its end on the next day too), on an agent's feed by tokens with every
  // dependency an opening accepts (itself, the token it was minted from and that one's own, the
  // agent and its owner): the last place on a feed one short of its most sockets reads the most
  // (262: each cap's count reads every socket's row), the feed's first opening writes the most
  // (56: its pools' first blocks, its turn, its dependencies and both days' provisions).
  admission: estimated(
    { do_rows_read: 262, do_rows_written: 56 },
    {
      validity: { maxMs: 120_000, days: 2 },
      duration: "synchronous",
      maxQuantity: 1,
      requests: 2,
      directoryCleanupDebt: vector({ d1_rows_written: 6 }),
      localCleanupDebt: vector({ do_rows_written: 10 }),
      dayCleanupDebt: ZERO,
    },
    MEASURED_LOCALLY,
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
    { do_rows_read: 103, do_rows_written: 13 },
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
  if (unit === "maintenance_light") return "maintenance";
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

/** Queued renewals one turn runs at most. */
export const LIVE_TURN_RENEWALS = 2;

/**
 * What each step of a feed's turn uses at most (rows in the feed's object
 * and in D1), measured by the live suite's fixtures: the turn starts a step
 * only while what it used, the step's most and its own end fit its grant
 * (see `TurnMeter`). `end`: what a turn uses outside its meter (its claim,
 * dispatch, successor's grant and accounting, and the alarm's own reads
 * around it, which grow with the feed's sockets: an idle turn's whole at a
 * feed's most sockets, less what its meter counted); `housekeep`: its
 * sockets looked over (expired and slow ones ended on their provisions, each
 * looked for), at a feed's most sockets, the step every turn runs first;
 * `forget`: one admission
 * never confirmed, forgotten with its lease released; `renewal`: one queued
 * renewal authorized; `refill`: one refill granted and installed;
 * `delivery`: one credential's page delivered to its sockets (its
 * credential, repositories, preferences and account checked); `prune`: one
 * page pruned. A refill's D1 is measured by the live suite with the ledger's
 * clock pinned at both sides of when its block first reaches past midnight
 * (12:00 UTC, a block's length before), for a feed with an epoch and as many
 * expired receipts as grants allow (15, each read by a grant's overdue
 * check): 65 rows read in one day, 92 over two. Its pool's expired balances
 * removed on both days were measured apart (an isolated probe at 23:50 UTC:
 * 43 and 15 object rows). A delivery's D1 includes its confirmation's grant,
 * which reads those receipts too.
 */
export const LIVE_TURN_STEPS = {
  // Its D1 at its worst, measured by the live suite: half a minute before midnight (a two-day
  // successor and settlement), the successor's grant reading both days' rows, the feed's epoch, as
  // many expired receipts as grants allow, and a full page of done turns of each kind, two of
  // which it removes (305 read, 27 written; its writes' most is an earlier ledger probe's, 28).
  end: { do_rows_read: 278, do_rows_written: 7, d1_rows_read: 305, d1_rows_written: 28 },
  housekeep: { do_rows_read: 120, do_rows_written: 0, d1_rows_read: 0, d1_rows_written: 0 },
  forget: { do_rows_read: 7, do_rows_written: 6, d1_rows_read: 17, d1_rows_written: 6 },
  renewal: { do_rows_read: 23, do_rows_written: 2, d1_rows_read: 5, d1_rows_written: 2 },
  // Its D1 over a midnight (a two-day block) at its worst: see above.
  refill: { do_rows_read: 43, do_rows_written: 15, d1_rows_read: 92, d1_rows_written: 10 },
  // Its D1 at its worst: its confirmation's grant (a minute) past a midnight, reading both days'
  // rows and as many expired receipts as grants allow.
  delivery: { do_rows_read: 496, do_rows_written: 20, d1_rows_read: 1_001, d1_rows_written: 8 },
  // Its reads its bound, not one run's (they vary with what its index scans pass, 318 to 420
  // seen): about five a row it deletes (76 a page), its sockets' progress scanned (20), and more.
  prune: { do_rows_read: 440, do_rows_written: 76, d1_rows_read: 0, d1_rows_written: 0 },
} as const;

const TURN_COUNTERS = [
  "do_rows_read",
  "do_rows_written",
  "d1_rows_read",
  "d1_rows_written",
] as const;
const turnRows = (f: (r: (typeof TURN_COUNTERS)[number]) => number) =>
  Object.fromEntries(TURN_COUNTERS.map((r) => [r, f(r)])) as Record<
    (typeof TURN_COUNTERS)[number],
    number
  >;

/**
 * Each step's most as a turn's meter checks it: its measurement with the
 * manifest's margin, ceil(1.25 x most) + 2, as every price takes it.
 */
export const LIVE_TURN_STEP_MOST = Object.fromEntries(
  Object.entries(LIVE_TURN_STEPS).map(([step, rows]) => [
    step,
    turnRows((r) => (rows[r] === 0 ? 0 : Math.ceil(1.25 * rows[r]) + 2)),
  ]),
) as Record<keyof typeof LIVE_TURN_STEPS, Record<(typeof TURN_COUNTERS)[number], number>>;

/** A turn's kinds of work, each a list of steps (see `LiveManifestEntry.turn`). */
export interface LiveTurnComposition {
  readonly work: readonly (readonly (keyof typeof LIVE_TURN_STEPS)[])[];
}

/**
 * A turn's rows at most: its end, its housekeeping and its costliest kind
 * of work, each step at its most as the meter checks it (the margin taken
 * once a step), and no less than its observations (a measured whole turn)
 * by the rule.
 */
export function liveTurnRows(
  turn: LiveTurnComposition,
  observed: readonly ResourceVector[],
): Record<(typeof TURN_COUNTERS)[number], number> {
  const s = LIVE_TURN_STEP_MOST;
  const most = (r: (typeof TURN_COUNTERS)[number]) => Math.max(0, ...observed.map((o) => o[r]));
  return turnRows((r) =>
    Math.max(
      most(r) === 0 ? 0 : Math.ceil(1.25 * most(r)) + 2,
      s.end[r] +
        s.housekeep[r] +
        Math.max(...turn.work.map((steps) => steps.reduce((n, step) => n + s[step][r], 0))),
    ),
  );
}

/** A feed's turn of `turn`'s composition: its rows by `liveTurnRows`, the rest by the rule. */
function turnUnit(
  turn: LiveTurnComposition,
  measured: Partial<ResourceVector>,
  entry: Omit<LiveManifestEntry, "resources" | "observed" | "components" | "turn"> &
    Partial<Pick<LiveManifestEntry, "components">>,
): LiveManifestEntry {
  const observed = vector(measured);
  const rows = liveTurnRows(turn, [observed]);
  return {
    components: [],
    ...entry,
    turn,
    observed: { [MEASURED]: observed },
    resources: {
      ...livePrice([observed], entry.requests, entry.duration, entry.maxQuantity),
      ...rows,
    },
  };
}

/**
 * - `pump`: a feed's execution turn, one alarm's live work, owned: its
 *   housekeeping (confirmations never finished forgotten, expired and slow
 *   sockets ended), then one kind of work (up to `LIVE_TURN_RENEWALS`
 *   queued renewals, one refill's grant and installation, or one pump
 *   unit: one credential's sockets, one owning account's page, its call of
 *   that account's object paid for by a grant of its own, then a page of
 *   what every socket heard of pruned), and its successor's grant; its
 *   owner's whole accounting reserved with it.
 */
/**
 * The pump turn as measured whole (a full delivery and prune, its alarm's reads around it), its
 * D1 at its worst: half a minute before midnight, every grant of it (its successor's, its
 * confirmation's) past it, reading both days' rows, the feed's epoch, as many expired receipts
 * as grants allow, and removing a full page of done turns (1,312 read, 36 written).
 */
const PUMP_MEASURED = {
  do_rows_read: 1_199,
  do_rows_written: 88,
  d1_rows_read: 1_312,
  d1_rows_written: 36,
};

const TURN_ENTRY = {
  // A feed always on runs a turn before this lapses: past the renewal period, so it adds none.
  validity: { maxMs: 125 * 60_000, days: 2 },
  duration: "owner",
  pendingMs: 30_000,
  maxQuantity: 1,
  requests: 8,
  directoryCleanupDebt: vector({ d1_rows_written: 2 }),
  localCleanupDebt: vector({ do_rows_written: 2 }),
  dayCleanupDebt: ZERO,
} as const;

const RENEWALS = Array.from({ length: LIVE_TURN_RENEWALS }, () => "renewal" as const);

LIVE_PRICES.pump = turnUnit(
  { work: [["delivery", "prune"], ["refill"], RENEWALS] },
  PUMP_MEASURED,
  {
    ...TURN_ENTRY,
    components: LIVE_REQUIRED_COMPONENTS.pump as readonly AlarmUnit[],
  },
);

/**
 * - `renewal`: a feed's turn granted when nothing but renewals is due (no
 *   change to deliver, refill or page to prune): its end and its renewals,
 *   its meter leaving anything else (a change marked since) to a pump turn
 *   after it.
 */
LIVE_PRICES.renewal = turnUnit(
  { work: [RENEWALS] },
  {},
  {
    ...TURN_ENTRY,
    // Each of its renewals' statements reserved in the alarm.
    components: [
      ...(LIVE_REQUIRED_COMPONENTS.renewal as readonly AlarmUnit[]),
      ...RENEWALS.slice(1),
    ],
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
 *   turn's, which makes one, its receipt written to the overdue index too)
 *   and the call's entry.
 */
LIVE_PRICES.org_confirmation = estimated(
  { do_rows_read: 4_100, do_rows_written: 1, d1_rows_read: 132, d1_rows_written: 25 },
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
 *   served, a few feeds' recoveries (each funded on its own) and a page of
 *   each kind reaped (see `LIVE_MAINTENANCE`).
 * - `revocation_page`: one revocation expanded a page and one feed told,
 *   granted apart from routine maintenance only while revocations are due
 *   (a cleanup unit owned by the maintenance object; `LIVE_REVOCATION_PAGE`).
 * - `recovery`: one feed's recovery page (a cleanup unit, owned by its
 *   object while it runs).
 */
/**
 * A maintenance run with every page full, at its worst (Proposed; measured
 * locally by its fixture, D1's rows as an invocation counts them): the
 * run's own grant over a midnight, owner and checks, with an overdue
 * receipt removed (323 read, 35 written), 16 receipts each holding escrow
 * on two days of its own (3,361, 49), a day (28, 2), a day's duration debt
 * served (5, 2), 2 recovery targets of another incarnation adopted (12, 6
 * with more left; 13, 7 as the last page, which also marks none left), 2
 * recoveries coordinated, each granted its own cleanup unit half a minute
 * before a midnight (the feed's epoch, both days' rows and 15 expired
 * receipts read), their durations settled (179, 26; their pages funded on
 * their own), each kind reaped a page, leases lapsed both ways (268, 46),
 * and 2 owners settled two whole pages of days each and released (100 to
 * 102 read, 28 to 30 written): at most 4,289 read and 197 written over the
 * test orders tried, its reads rounded up and its writes as measured.
 * Revocations are a page of their own (`revocation_page`).
 */
export const LIVE_MAINTENANCE_MEASURED = { d1_rows_read: 4_300, d1_rows_written: 197 };

LIVE_PRICES.maintenance = estimated(
  LIVE_MAINTENANCE_MEASURED,
  {
    validity: { maxMs: 10 * 60_000, days: 2 },
    duration: "owner",
    pendingMs: 60_000,
    maxQuantity: 1,
    // Its own, and its 2 recoveries' calls (each also its recovery's: counted twice).
    requests: 3,
    directoryCleanupDebt: vector({ d1_rows_written: 1 }),
    localCleanupDebt: ZERO,
    dayCleanupDebt: ZERO,
  },
  MEASURED_LOCALLY,
);
/**
 * A run with only expired receipts and transports due, at its worst (Proposed;
 * measured locally by its fixture): its own grant over a midnight, owner and
 * checks, 16 receipts holding escrow on days still kept, and 16 transports (1,342 read and 58
 * written, rounded up).
 */
export const LIVE_MAINTENANCE_LIGHT_MEASURED = { d1_rows_read: 1_400, d1_rows_written: 60 };

LIVE_PRICES.maintenance_light = estimated(
  LIVE_MAINTENANCE_LIGHT_MEASURED,
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
  MEASURED_LOCALLY,
);
/**
 * A revocation page at its most (Proposed; measured locally): the run's own
 * grant, owner and checks, 8 revocations expanded a socket each (8
 * dependency rows, each socket's feed a target) and one feed told, its 20
 * sockets' leases and dependency rows released (D1: 603 rows read, the
 * maintenance fixture: its grant past a midnight reading 12 expired receipts,
 * as many as can wait with nothing routine due, and 15 transports expired
 * within their grace, its owner's admission every other owner place held,
 * and 128 old revocations still being told passed over by a window of them; 168 written, measured before owners' runs stopped
 * writing two indexes, 164 since); the feed's object closing and forgetting its 20
 * sockets with their ends' provisions (160 rows read and 103 written with
 * two dependencies a socket, the live suite's; a socket rests on five at
 * most, an agent's derived credential, each one more a row read and
 * written: 220 and 163). A feed whose principal is being deleted retires as
 * it wakes, whoever wakes it (its deferred work and email queue dropped):
 * that is the deletion's work, done once whichever call comes first, and
 * not priced here.
 */
export const LIVE_REVOCATION_PAGE_MEASURED = {
  do_rows_read: 220,
  do_rows_written: 163,
  d1_rows_read: 603,
  d1_rows_written: 168,
};

LIVE_PRICES.revocation_page = estimated(
  LIVE_REVOCATION_PAGE_MEASURED,
  {
    validity: { maxMs: 10 * 60_000, days: 2 },
    duration: "owner",
    pendingMs: 60_000,
    maxQuantity: 1,
    // The feed told, and its sockets' closes (each a callback of the feed's object).
    requests: 22,
    directoryCleanupDebt: vector({ d1_rows_written: 1 }),
    localCleanupDebt: ZERO,
    dayCleanupDebt: ZERO,
  },
  MEASURED_LOCALLY,
);
// Its object's rows its page's bound; its D1 measured locally, its object's side of a page for a
// registered principal's feed restored since it began: its coverage checked and two dispatched
// owners quarantined, an object's most at once (20 read, 2 written, whichever two of its turn and
// pending kinds they are), and at its most with a refill besides whose owner the directory no
// longer holds (24 read, 2 written).
LIVE_PRICES.recovery = estimated(
  { do_rows_read: 130, do_rows_written: 64, d1_rows_read: 24, d1_rows_written: 2 },
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
