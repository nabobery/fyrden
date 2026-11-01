// One live authorization at a time an object: its owner taken before any of
// its awaits; its result given up on at its deadline while its physical
// work still holds the owner (no replacement starts); a late answer never
// applied; a late rejection never thrown; its finish run once, when its
// work ends; checkpoints stopping its chain, inside FreshAccess's
// confirmation chain too.

import { describe, expect, it } from "vitest";
import { FreshAccess } from "../src/feed/access.js";
import {
  type AuthorizationDeadline,
  AuthorizationInvalidated,
  type AuthorizationStamp,
  LIVE_AUTHORIZATION_RESULT_MS,
  LiveAuthorizationOwner,
} from "../src/live/authorization.js";
import type { LiveEnvelope } from "../src/live/budget.js";
import type { LiveDurationGuard } from "../src/live/duration.js";
import type { LiveOwnerRef } from "../src/live/owners.js";

const NOW = 1_000_000;

/** A deadline the test fires itself (`expire`), and whether it was cancelled. */
function deadlines() {
  const set: { at: number; fire: () => void; cancelled: boolean }[] = [];
  return {
    set,
    deadline: (at: number, invalidate: () => void): AuthorizationDeadline => {
      const entry = { at, fire: invalidate, cancelled: false };
      set.push(entry);
      return { cancel: () => (entry.cancelled = true) };
    },
    expire: () => {
      for (const entry of set) if (!entry.cancelled) entry.fire();
    },
  };
}

/** A promise the test settles. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const stamp: AuthorizationStamp = {
  identity: "v1.op",
  epoch: 1,
  incarnation: "a".repeat(32),
  authorizationGen: 1,
  grantSeq: 7,
};
const owner: LiveOwnerRef = {
  ownerId: "v1.op/feed",
  operationId: "v1.op",
  objectType: "UserDO",
  objectId: "usr_x",
  incarnation: "a".repeat(32),
  epoch: 1,
};
const guard: LiveDurationGuard = {
  grant: {} as LiveEnvelope,
  startedAt: NOW,
  pendingMs: 900_000,
  tailMs: 0,
};

function attempt(options: { current?: () => boolean } = {}) {
  const timers = deadlines();
  const live = new LiveAuthorizationOwner({ now: () => NOW, deadline: timers.deadline });
  const finished: number[] = [];
  const input = {
    stamp,
    owner,
    guard,
    current: options.current ?? (() => true),
    finish: () => finished.push(NOW),
  };
  return { live, timers, finished, input };
}

describe("a live authorization", () => {
  it("takes its owner before its work begins, and refuses a second while the first runs", async () => {
    const { live, input } = attempt();
    const boundary = held<string>();
    let ownedAtStart = false;
    const first = live.start(input, async () => {
      ownedAtStart = live.pending();
      return boundary.promise;
    });
    expect(first).not.toBeNull();
    expect(ownedAtStart).toBe(true);
    expect(live.start(input, async () => "second")).toBeNull();
    boundary.resolve("granted");
    expect(await first?.result).toEqual({ status: "answered", value: "granted" });
    await first?.physical;
    expect(live.pending()).toBe(false);
  });

  it("gives up its result at the deadline, its work still holding the owner, and never applies a late answer", async () => {
    const { live, timers, finished, input } = attempt();
    const boundary = held<string>();
    let checked: unknown;
    const run = live.start(input, async (checkpoint) => {
      const answer = await boundary.promise;
      try {
        checkpoint.check();
      } catch (error) {
        checked = error;
        throw error;
      }
      return answer;
    });
    expect(timers.set.map((t) => t.at)).toEqual([NOW + LIVE_AUTHORIZATION_RESULT_MS]);
    timers.expire();
    expect(await run?.result).toEqual({ status: "unanswered" });
    // Its work still runs: the owner is held, no replacement starts.
    expect(live.pending()).toBe(true);
    expect(live.start(input, async () => "replacement")).toBeNull();
    expect(finished).toEqual([]);
    // The late answer stops at its checkpoint; the finish runs once, then the owner is free.
    boundary.resolve("late");
    await run?.physical;
    expect(checked).toBeInstanceOf(AuthorizationInvalidated);
    expect(await run?.result).toEqual({ status: "unanswered" });
    expect(finished).toHaveLength(1);
    expect(live.pending()).toBe(false);
  });

  it("swallows a late rejection, finishing once", async () => {
    const { live, timers, finished, input } = attempt();
    const boundary = held<string>();
    const run = live.start(input, () => boundary.promise);
    timers.expire();
    boundary.reject(new Error("the call failed late"));
    await run?.physical;
    expect(await run?.result).toEqual({ status: "unanswered" });
    expect(finished).toHaveLength(1);
  });

  it("is invalidated when what it was decided for changes, or when given up on", async () => {
    let current = true;
    const { live, input } = attempt({ current: () => current });
    const boundary = held<string>();
    const run = live.start(input, async (checkpoint) => {
      await boundary.promise;
      checkpoint.check();
      return "applied";
    });
    current = false;
    boundary.resolve("answer");
    expect(await run?.result).toEqual({ status: "invalidated" });
    await run?.physical;
    // Given up on explicitly: its result settles at once, its work still holds the owner.
    current = true;
    const other = held<string>();
    const second = live.start(input, () => other.promise);
    live.invalidate();
    expect(await second?.result).toEqual({ status: "invalidated" });
    expect(live.pending()).toBe(true);
    other.resolve("late");
    await second?.physical;
    expect(live.pending()).toBe(false);
  });

  it("applies no answer whose authority changed while it ran, even with no checkpoint of its own", async () => {
    let current = true;
    const { live, finished, input } = attempt({ current: () => current });
    const boundary = held<string>();
    const run = live.start(input, () => boundary.promise);
    current = false;
    boundary.resolve("stale");
    expect(await run?.result).toEqual({ status: "invalidated" });
    await run?.physical;
    expect(finished).toHaveLength(1);
    expect(live.pending()).toBe(false);
  });

  it("starts nothing when what it is decided for is not current, or its guard does not cover now", () => {
    const stale = attempt({ current: () => false });
    expect(stale.live.start(stale.input, async () => 1)).toBeNull();
    const late = attempt();
    expect(
      late.live.start(
        { ...late.input, guard: { ...guard, startedAt: NOW - 900_000 } },
        async () => 1,
      ),
    ).toBeNull();
    const mismatched = attempt();
    expect(
      mismatched.live.start({ ...mismatched.input, owner: { ...owner, epoch: 2 } }, async () => 1),
    ).toBeNull();
  });
});

describe("FreshAccess's live chain", () => {
  /** FreshAccess over accounts whose confirmations the test holds (or fails). */
  function chain(options: { ceilingsFail?: boolean } = {}) {
    const asked: string[] = [];
    const answers = new Map<string, ReturnType<typeof held<unknown>>>();
    const env = {
      // A user reading without a grant has no ceilings: the directory is only opened.
      DIRECTORY: {
        withSession: () => {
          if (options.ceilingsFail) throw new Error("directory unavailable");
          return {};
        },
      },
      ORG: {
        getByName: (account: string) => ({
          confirmReadersLive: (ids: string[]) => {
            asked.push(account);
            const answer = held<unknown>();
            answers.set(account, answer);
            void ids;
            return answer.promise;
          },
        }),
      },
    } as unknown as Env;
    const metrics = { count() {} } as unknown as ConstructorParameters<
      typeof FreshAccess
    >[0]["metrics"];
    const access = new FreshAccess({ env, metrics }, {
      principalId: "usr_reader",
      grantId: null,
    } as never);
    return { access, asked, answers };
  }
  const entries = (...accounts: string[]) =>
    accounts.map((ownerId, i) => ({ id: `rep_${i}`, ownerId })) as never;
  const confirmation = (ids: string[]) => ({
    accountId: "org",
    epochGen: 1,
    version: 1,
    repos: Object.fromEntries(ids.map((id) => [id, { held: true, roles: {} }])),
  });

  it("lets an invalidation during a confirmation escape, whether it answered or failed", async () => {
    for (const outcome of ["answers", "fails"] as const) {
      const { access, answers } = chain();
      let valid = true;
      const decided = access.decide(entries("org_1"), {
        live: true,
        checkpoint: () => {
          if (!valid) throw new AuthorizationInvalidated();
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      valid = false;
      const answer = answers.get("org_1");
      if (outcome === "answers") answer?.resolve(confirmation(["rep_0"]));
      else answer?.reject(new Error("the account failed"));
      await expect(decided, outcome).rejects.toBeInstanceOf(AuthorizationInvalidated);
    }
  });

  it("lets an invalidation after a failed ceilings read escape", async () => {
    const { access, asked } = chain({ ceilingsFail: true });
    await expect(
      access.decide(entries("org_1"), {
        live: true,
        checkpoint: () => {
          throw new AuthorizationInvalidated();
        },
      }),
    ).rejects.toBeInstanceOf(AuthorizationInvalidated);
    expect(asked).toEqual([]);
  });

  it("stops between accounts: no later account is asked", async () => {
    const { access, asked, answers } = chain();
    let calls = 0;
    const decided = access.decide(entries("org_1", "org_2"), {
      live: true,
      // Valid for the ceilings, the first account and its answer; then invalidated.
      checkpoint: () => {
        if (++calls > 3) throw new AuthorizationInvalidated();
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    answers.get("org_1")?.resolve(confirmation(["rep_0"]));
    await expect(decided).rejects.toBeInstanceOf(AuthorizationInvalidated);
    expect(asked).toEqual(["org_1"]);
  });
});
