/**
 * Push limits and timings. Each can be overridden with an optional Worker
 * variable of the same name (operators and tests); the defaults apply when
 * it is absent or not a positive integer.
 */
export interface PushTuning {
  /**
   * Largest request body the Worker accepts. Cloudflare itself refuses a
   * body above 104,857,600 bytes (100 MiB) on Free and Pro before the Worker
   * runs (measured on Workers Free, 2026-10-10); the Worker's own check
   * covers smaller configured limits and bodies whose length it learns only
   * while reading.
   */
  readonly maxBodyBytes: number;
  /**
   * Largest inflated size of a gzip request body (JGit compresses every
   * push). Its length is unknown until it is all inflated, so the Worker
   * holds it before storing it, inside an isolate's 128 MiB; the effective
   * limit is the smaller of this and `maxBodyBytes`. Proposed 32 MiB. A
   * larger push goes uncompressed (as git sends it) or in parts
   * (`fyrden push --chunked`).
   */
  readonly maxGzipBodyBytes: number;
  /**
   * Wall time the Durable Object spends indexing inside one request before
   * it hands the rest to its alarm. Proposed 10 s: a Durable Object request
   * or alarm gets 30 s of CPU (measured on Workers Free, 2026-10-10).
   */
  readonly indexBudgetMs: number;
  /**
   * How soon the Worker first asks the Durable Object whether indexing is
   * done. Proposed 1 s; the wait doubles after each answer up to
   * `maxPollMs`. Each call counts against the Worker's budget of calls to
   * internal services (1,000 per invocation on Free, measured 2026-10-10)
   * and costs a little CPU, so a long wait must not poll at a fixed pace.
   */
  readonly pollMs: number;
  /** Longest wait between two calls. Proposed 5 s. */
  readonly maxPollMs: number;
  /** Longest the Worker waits for indexing before it gives up. Proposed 15 min. */
  readonly maxWaitMs: number;
}

export const PUSH_TUNING_DEFAULTS: PushTuning = Object.freeze({
  maxBodyBytes: 104_857_600,
  maxGzipBodyBytes: 33_554_432,
  indexBudgetMs: 10_000,
  pollMs: 1_000,
  maxPollMs: 5_000,
  maxWaitMs: 15 * 60 * 1000,
});

const VARIABLES: Record<keyof PushTuning, string> = {
  maxBodyBytes: "GIT_PUSH_MAX_BODY_BYTES",
  maxGzipBodyBytes: "GIT_PUSH_MAX_GZIP_BODY_BYTES",
  indexBudgetMs: "GIT_PUSH_INDEX_BUDGET_MS",
  pollMs: "GIT_PUSH_POLL_MS",
  maxPollMs: "GIT_PUSH_MAX_POLL_MS",
  maxWaitMs: "GIT_PUSH_MAX_WAIT_MS",
};

/** The tuning for this Worker: defaults, overridden by any variables set. */
export function pushTuning(env: object): PushTuning {
  const vars = env as Partial<Record<string, unknown>>;
  const out: Record<string, number> = { ...PUSH_TUNING_DEFAULTS };
  for (const [key, name] of Object.entries(VARIABLES)) {
    const raw = vars[name];
    const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(value) && value >= 0) out[key] = value;
  }
  return out as unknown as PushTuning;
}
