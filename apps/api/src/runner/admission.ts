// Where a deployment's limits on runners will plug in: a cap on an account's
// runners at registration, and a meter on each runner's polling. Neither
// limits anything yet, so both admit everything.

import type { AuthenticatedRunner } from "./registry.js";

export interface RunnerAdmission {
  /** Called once a runner is registered for `accountId`. */
  onRegister(accountId: string): Promise<"ok">;
  /** Called on every FetchTask after the runner is authenticated, at `now` (milliseconds). */
  onFetch(runner: AuthenticatedRunner, now: number): Promise<"ok">;
}

export const admitEveryRunner: RunnerAdmission = {
  onRegister: async () => "ok",
  onFetch: async () => "ok",
};
