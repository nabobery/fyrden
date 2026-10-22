/**
 * The service-binding RPC surface fyrden-api exposes to fyrden-web.
 *
 * fyrden-api deploys first and must accept the current and the previous
 * version, so changes here are additive within a version.
 */
export const API_RPC_VERSION = 1;

export interface HealthCheck {
  ok: boolean;
  ms: number;
  error?: string;
}

/**
 * Whether effects (webhook deliveries, feed entries) are on time: `ok` is
 * false when the oldest pending one has been due for longer than the
 * threshold, one failed for good lately, or the check failed. `overdueS`:
 * how long it has been due; `failed`: whether one failed for good lately.
 */
export interface EffectsCheck extends HealthCheck {
  overdueS?: number;
  failed?: boolean;
}

/**
 * Whether user deletions go on: `ok` is false while one waits on an
 * organization it solely owns (`blocked`), one's last run failed
 * (`failing`), or one has been due and not run for longer than the
 * threshold (`overdueS`: how long), or the check failed.
 */
export interface DeletionsCheck extends HealthCheck {
  blocked?: boolean;
  failing?: boolean;
  overdueS?: number;
}

/** `ok` covers the storage tiers only: late effects or deletions leave the API serving (degraded). */
export interface HealthReport {
  ok: boolean;
  checks: {
    d1: HealthCheck;
    durableObject: HealthCheck;
    r2: HealthCheck;
    effects: EffectsCheck;
    deletions: DeletionsCheck;
  };
}

/** The deep health check is rate limited; a limited call runs no checks. */
export type HealthResult = { rateLimited: true } | { rateLimited: false; report: HealthReport };

/** Every method returns a promise because calls cross a Worker boundary. */
export interface ApiRpcContract {
  rpcVersion(): Promise<number>;
  /** `requestId` ties the API's log lines to the caller's request. */
  healthz(meta?: { requestId?: string }): Promise<HealthResult>;
}
