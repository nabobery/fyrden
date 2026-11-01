import type { SubrequestTally } from "@fyrden/adapters-cloudflare/obs";

/*
 * What a feed's alarm may still start: whole units of work, each admitted
 * only if what the invocation has made so far (its tally, counted at the
 * bindings), the full ceilings of the units still running, and the whole of
 * the unit asked for all fit the alarm's ceilings, each counter on its own.
 * A unit keeps its reservation until its physical work ends (not when its
 * result is given up on), then gives it back; what it made stays counted.
 * Reservations belong to the invocation that made them.
 */

/** An invocation's calls: D1 statements, internal calls (D1, Durable Objects, R2) and external fetches. */
export interface InvocationCost {
  readonly d1: number;
  readonly internal: number;
  readonly external: number;
}

/**
 * The alarm's ceilings: application limits within the platform's (1,000
 * internal calls and 50 external on Free, measured 2026-10-29; D1's
 * statements as the directory's work is bounded). Proposed.
 */
export const ALARM_LIMITS: InvocationCost = { d1: 40, internal: 800, external: 40 };

/**
 * Each unit's ceiling (Proposed; each pinned against its real statements by
 * the tests of the unit): the mandatory steps with their checkpoint and
 * finish, one renewal's execution, one pump unit (a credential and its
 * sockets, one account), one email candidate (its access, fence, provider
 * call and settlement), and an ordinary grant or refill batch.
 */
export const ALARM_UNITS = {
  mandatory: { d1: 4, internal: 4, external: 0 },
  renewal: { d1: 3, internal: 3, external: 0 },
  pump: { d1: 8, internal: 8, external: 0 },
  email: { d1: 16, internal: 12, external: 1 },
  grant: { d1: 6, internal: 1, external: 0 },
} as const satisfies Record<string, InvocationCost>;

export type AlarmUnit = keyof typeof ALARM_UNITS;

export interface AlarmReservation {
  /** The unit's physical work ended: its reservation goes (once; again changes nothing). */
  physicalComplete(): void;
}

const COUNTERS = ["d1", "internal", "external"] as const;

const sum = (costs: readonly InvocationCost[]): InvocationCost => ({
  d1: costs.reduce((n, c) => n + c.d1, 0),
  internal: costs.reduce((n, c) => n + c.internal, 0),
  external: costs.reduce((n, c) => n + c.external, 0),
});

export class AlarmBudget {
  readonly #tally: SubrequestTally;
  readonly #limits: InvocationCost;
  readonly #outstanding = new Set<InvocationCost>();

  constructor(tally: SubrequestTally, limits: InvocationCost = ALARM_LIMITS) {
    this.#tally = tally;
    this.#limits = limits;
  }

  /**
   * Admits `units` together (a unit and the grant it needs, say), or none:
   * null when any counter would pass its ceiling, nothing changed.
   */
  reserve(...units: readonly AlarmUnit[]): AlarmReservation | null {
    if (units.length === 0) throw new Error("no unit to reserve");
    const asked = sum(units.map((unit) => ALARM_UNITS[unit]));
    const held = sum([...this.#outstanding]);
    for (const counter of COUNTERS)
      if (this.#tally[counter] + held[counter] + asked[counter] > this.#limits[counter])
        return null;
    // Its own object: two equal reservations are two.
    const reservation = { ...asked };
    this.#outstanding.add(reservation);
    return { physicalComplete: () => this.#outstanding.delete(reservation) };
  }
}
