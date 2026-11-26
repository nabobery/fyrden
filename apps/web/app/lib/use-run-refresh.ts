import { useEffect, useMemo, useRef, useState } from "react";
import { useRevalidator } from "react-router";

export const REFRESH_FIRST_MS = 5_000;
export const REFRESH_MAX_MS = 60_000;
export const REFRESH_FOR_MS = 30 * 60_000;

/**
 * When to read a page's data again after each answer: the first wait after a
 * change of `state` or of `identity` (the run or job shown), doubled up to the
 * most while nothing changes, and no more (null) once `REFRESH_FOR_MS` have
 * passed since that identity was first shown.
 */
export class RefreshSchedule {
  #identity: string | null = null;
  #state = "";
  #delay = REFRESH_FIRST_MS;
  #since = 0;

  next(identity: string, state: string, now: number): number | null {
    if (identity !== this.#identity) {
      this.#identity = identity;
      this.#since = now;
      this.#delay = REFRESH_FIRST_MS;
    } else if (state !== this.#state) this.#delay = REFRESH_FIRST_MS;
    else this.#delay = Math.min(this.#delay * 2, REFRESH_MAX_MS);
    this.#state = state;
    return this.expired(now) ? null : this.#delay;
  }

  /** Whether the bound has passed for the identity shown, without counting a look. */
  expired(now: number): boolean {
    return now - this.#since > REFRESH_FOR_MS;
  }
}

/** Reads the page's data again on `RefreshSchedule`'s pace while `active` and the tab is visible. */
export function useRunRefresh(
  identity: string,
  active: boolean,
  state: string,
  answer: unknown,
): { stopped: boolean } {
  const revalidator = useRevalidator();
  const revalidate = useRef(revalidator.revalidate);
  revalidate.current = revalidator.revalidate;
  const schedule = useMemo(() => new RefreshSchedule(), []);
  const [stopped, setStopped] = useState<string | null>(null);
  const shown = useRef(identity);
  if (shown.current !== identity) {
    shown.current = identity;
    if (stopped !== null) setStopped(null);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answer` is the trigger: one look per answer.
  useEffect(() => {
    if (!active || stopped === identity) return;
    const wait = schedule.next(identity, state, Date.now());
    if (wait === null) {
      setStopped(identity);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      if (schedule.expired(Date.now())) {
        setStopped(identity);
        return;
      }
      timer = setTimeout(() => {
        if (schedule.expired(Date.now())) setStopped(identity);
        else void revalidate.current();
      }, wait);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [identity, active, stopped, state, answer]);
  return { stopped: stopped === identity };
}
