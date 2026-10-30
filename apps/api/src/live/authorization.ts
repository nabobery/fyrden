import type { LiveDurationGuard } from "./duration.js";
import type { LiveOwnerRef } from "./owners.js";

/*
 * One authorization at a time an object: the chain of awaits that decides
 * whether live work may apply (a grant, a credential, an account's
 * confirmation). Its owner is taken synchronously, before any of its
 * awaits, and held for as long as its physical work runs, which is not the
 * same as how long its result is waited for: at the result's deadline the
 * attempt is given up on (its result `unanswered`, never applied
 * afterwards) while its work, which the platform does not cut, still holds
 * the owner, and no other attempt starts until it ends. Every await is
 * followed by a checkpoint that stops the chain once its result can no
 * longer apply (the deadline passed, the attempt invalidated, or what it
 * was decided for changed). Its duration stays accounted whatever its
 * result: application and expenditure are separate decisions.
 */

/** How long an authorization's result is waited for (not how long its work may run). */
export const LIVE_AUTHORIZATION_RESULT_MS = 10_000;

/** What an authorization was decided for: its grant, the object's epoch and incarnation, its generation. */
export interface AuthorizationStamp {
  readonly identity: string;
  readonly epoch: number;
  readonly incarnation: string;
  readonly authorizationGen: number;
  readonly grantSeq: number;
}

export interface AuthorizationDeadline {
  cancel(): void;
}

export interface AuthorizationCheckpoint {
  /** Throws `AuthorizationInvalidated` once the attempt's result can no longer apply. */
  check(): void;
}

export type AuthorizationResult<T> =
  | { readonly status: "answered"; readonly value: T }
  | { readonly status: "unanswered" }
  | { readonly status: "invalidated" };

export interface PhysicalAuthorization<T> {
  /** Its result, settled at the latest by its deadline. */
  readonly result: Promise<AuthorizationResult<T>>;
  /** Its physical work's end (whatever its result), after its covered finish. */
  readonly physical: Promise<void>;
}

/** Thrown by a checkpoint: the chain stops, and nothing it was deciding applies. */
export class AuthorizationInvalidated extends Error {
  constructor() {
    super("the authorization's result can no longer apply");
    this.name = "AuthorizationInvalidated";
  }
}

/** The platform's timer as a deadline (production); tests pass their own. */
export function timerDeadline(now: () => number) {
  return (at: number, invalidate: () => void): AuthorizationDeadline => {
    const timer = setTimeout(invalidate, Math.max(0, at - now()));
    return { cancel: () => clearTimeout(timer) };
  };
}

interface Attempt {
  readonly stamp: AuthorizationStamp;
  readonly owner: LiveOwnerRef;
  readonly current: () => boolean;
  /** Its result may no longer apply (the deadline, an invalidation): never undone. */
  over: boolean;
  expired: boolean;
  /** Settles its result (once). */
  answer: (result: AuthorizationResult<never>) => void;
}

export class LiveAuthorizationOwner {
  readonly #now: () => number;
  readonly #deadline: (at: number, invalidate: () => void) => AuthorizationDeadline;
  /** The attempt whose physical work is under way, if any. */
  #attempt: Attempt | null = null;

  constructor(options: {
    readonly now: () => number;
    readonly deadline: (at: number, invalidate: () => void) => AuthorizationDeadline;
  }) {
    this.#now = options.now;
    this.#deadline = options.deadline;
  }

  /** Whether an attempt's physical work is under way (its result given up on or not). */
  pending(): boolean {
    return this.#attempt !== null;
  }

  /** Gives up the attempt under way: its result is `invalidated`; its work still holds the owner. */
  invalidate(): void {
    const attempt = this.#attempt;
    if (!attempt) return;
    attempt.over = true;
    attempt.answer({ status: "invalidated" });
  }

  /**
   * Starts an attempt: null while another's work is under way, when its
   * guard does not cover now, or when what it is decided for is not current
   * (nothing started). Its owner is taken before `work` runs; at the
   * deadline its result is `unanswered`; its owner is released only once
   * `work` has physically ended (after `finish`, already covered,
   * synchronous).
   */
  start<T>(
    input: {
      readonly stamp: AuthorizationStamp;
      readonly owner: LiveOwnerRef;
      readonly guard: LiveDurationGuard;
      readonly current: () => boolean;
      readonly finish: () => void;
    },
    work: (checkpoint: AuthorizationCheckpoint) => Promise<T>,
  ): PhysicalAuthorization<T> | null {
    if (this.#attempt !== null) return null;
    const now = this.#now();
    const { guard, owner, stamp } = input;
    if (
      now < guard.startedAt ||
      now >= guard.startedAt + guard.pendingMs ||
      owner.operationId !== stamp.identity ||
      owner.epoch !== stamp.epoch ||
      owner.incarnation !== stamp.incarnation ||
      !input.current()
    )
      return null;
    let settle!: (result: AuthorizationResult<T>) => void;
    const result = new Promise<AuthorizationResult<T>>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const answer = (r: AuthorizationResult<T>) => {
      if (settled) return;
      settled = true;
      settle(r);
    };
    const attempt: Attempt = {
      stamp,
      owner,
      current: input.current,
      over: false,
      expired: false,
      answer,
    };
    // Taken synchronously: no await of the attempt runs without it.
    this.#attempt = attempt;
    const deadline = this.#deadline(now + LIVE_AUTHORIZATION_RESULT_MS, () => {
      attempt.over = true;
      attempt.expired = true;
      answer({ status: "unanswered" });
    });
    const checkpoint: AuthorizationCheckpoint = {
      check: () => {
        if (attempt.over || this.#attempt !== attempt || !attempt.current())
          throw new AuthorizationInvalidated();
      },
    };
    const physical = (async () => {
      try {
        const value = await work(checkpoint);
        // Applied only if still current at its very end.
        if (attempt.over || !attempt.current())
          answer(attempt.expired ? { status: "unanswered" } : { status: "invalidated" });
        else answer({ status: "answered", value });
      } catch {
        // A late rejection, or the chain stopped: never thrown at anyone.
        answer(attempt.expired ? { status: "unanswered" } : { status: "invalidated" });
      } finally {
        deadline.cancel();
        try {
          input.finish();
        } finally {
          // Its work has ended: the owner is free (its directory place is its accounting's).
          if (this.#attempt === attempt) this.#attempt = null;
        }
      }
    })();
    return { result, physical };
  }
}
