import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import type { OperationDef, Problem } from "@fyrden/api-contract";

/*
 * Idempotent writes: a request with an `Idempotency-Key` runs once per
 * token and key. A retry of the same request gets the first answer again;
 * a different request with that key is refused; one still running, or one
 * whose outcome was never learnt (it failed unexpectedly, or ran too long),
 * is refused rather than run again, since it may have taken effect.
 * Answers that carry a secret are not kept: a retry names the resource made.
 */

/** Proposed. */
export const IDEMPOTENCY_POLICY = {
  /** How long a key's answer is kept. */
  ttlMs: 24 * 60 * 60 * 1000,
  /** A request marked running longer than this has an unknown outcome. */
  runningMaxMs: 10 * 60 * 1000,
  /** Largest answer kept; a larger one is not replayed (the retry is refused). */
  maxResponseBytes: 256 * 1024,
  /** Rows the cron deletes per run. */
  reapPerRun: 1_000,
} as const;

/** What a key may be: 1-255 printable ASCII characters. */
export const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;

export interface Claim {
  readonly tokenId: string;
  readonly key: string;
  readonly claimId: string;
}

type Row = {
  op_id: string;
  request_hash: string;
  state: "running" | "done";
  status: number | null;
  response: string | null;
  resource_id: string | null;
  started_at: number;
};

export type IdempotentStart =
  | { readonly kind: "run"; readonly claim: Claim }
  | { readonly kind: "replay"; readonly status: number; readonly body: unknown }
  | {
      readonly kind: "refuse";
      readonly status: 409 | 422;
      readonly code: string;
      readonly detail: string;
    };

/**
 * The hash of what a request asks: its operation and its validated input
 * (path parameters and body, unknown fields dropped), keys sorted.
 */
export async function requestHash(opId: string, input: unknown): Promise<string> {
  const text = `${opId}\n${canonicalJson(input)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Claims `key` for this request, or says how to answer it instead. */
export async function startIdempotent(
  env: Env,
  request: {
    readonly tokenId: string;
    readonly key: string;
    readonly opId: string;
    readonly hash: string;
    readonly now: number;
  },
  metrics?: Metrics,
): Promise<IdempotentStart> {
  const db = env.DIRECTORY;
  const { tokenId, key, opId, hash, now } = request;
  const claimId = crypto.randomUUID();
  metrics?.count("d1.query", { db: "directory", op: "idempotency_claim" });
  // A new key, or one whose record expired.
  const claimed = await db
    .prepare(
      `INSERT INTO idempotency_keys (token_id, key, claim_id, op_id, request_hash, state,
         started_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7)
       ON CONFLICT (token_id, key) DO UPDATE SET claim_id = excluded.claim_id,
         op_id = excluded.op_id, request_hash = excluded.request_hash, state = 'running',
         status = NULL, response = NULL, resource_id = NULL,
         started_at = excluded.started_at, expires_at = excluded.expires_at
       WHERE idempotency_keys.expires_at <= ?6`,
    )
    .bind(tokenId, key, claimId, opId, hash, now, now + IDEMPOTENCY_POLICY.ttlMs)
    .run();
  if ((claimed.meta.changes ?? 0) > 0) return { kind: "run", claim: { tokenId, key, claimId } };
  metrics?.count("d1.query", { db: "directory", op: "idempotency_read" });
  const row = await db
    .withSession("first-primary")
    .prepare(
      `SELECT op_id, request_hash, state, status, response, resource_id, started_at
       FROM idempotency_keys WHERE token_id = ? AND key = ?`,
    )
    .bind(tokenId, key)
    .first<Row>();
  // Deleted in between (it expired): the retry claims it.
  if (!row) return refuse(409, "idempotency_key_in_use", IN_USE);
  if (row.op_id !== opId || row.request_hash !== hash)
    return refuse(
      422,
      "idempotency_key_reused",
      "This Idempotency-Key was used for a different request; use a new key.",
    );
  if (row.state === "running")
    return row.started_at <= now - IDEMPOTENCY_POLICY.runningMaxMs
      ? refuse(409, "idempotent_outcome_unknown", UNKNOWN)
      : refuse(409, "idempotency_key_in_use", IN_USE);
  if (row.status === null) return refuse(409, "idempotent_outcome_unknown", UNKNOWN);
  if (row.resource_id !== null)
    return refuse(
      409,
      "secret_already_disclosed",
      `This request already made ${row.resource_id}; its secret is not shown again. Revoke it and make a new one if it was lost.`,
    );
  if (row.response === null)
    return refuse(
      409,
      "idempotent_replay_unavailable",
      "This request already ran; its answer was too large to keep.",
    );
  return { kind: "replay", status: row.status, body: JSON.parse(row.response) };
}

const IN_USE = "A request with this Idempotency-Key is still running; retry in a few seconds.";
const UNKNOWN =
  "A request with this Idempotency-Key may or may not have taken effect; check, then use a new key.";

function refuse(status: 409 | 422, code: string, detail: string): IdempotentStart {
  return { kind: "refuse", status, code, detail };
}

export type IdempotentOutcome =
  | { readonly kind: "answer"; readonly status: number; readonly body: unknown }
  | { readonly kind: "secret"; readonly status: number; readonly resourceId: string }
  /** It may have taken effect: retries are refused until the key expires. */
  | { readonly kind: "unknown" }
  /** It did not take effect and may run again: the key is free. */
  | { readonly kind: "forget" };

/** Records what the claimed execution answered; a claim taken over or expired records nothing. */
export async function finishIdempotent(
  env: Env,
  claim: Claim,
  outcome: IdempotentOutcome,
  metrics?: Metrics,
): Promise<void> {
  const db = env.DIRECTORY;
  metrics?.count("d1.query", { db: "directory", op: "idempotency_finish" });
  if (outcome.kind === "forget") {
    await db
      .prepare(
        "DELETE FROM idempotency_keys WHERE token_id = ? AND key = ? AND claim_id = ? AND state = 'running'",
      )
      .bind(claim.tokenId, claim.key, claim.claimId)
      .run();
    return;
  }
  let response: string | null = null;
  if (outcome.kind === "answer") {
    const text = JSON.stringify(outcome.body);
    if (new TextEncoder().encode(text).length <= IDEMPOTENCY_POLICY.maxResponseBytes)
      response = text;
  }
  await db
    .prepare(
      `UPDATE idempotency_keys SET state = 'done', status = ?4, response = ?5, resource_id = ?6
       WHERE token_id = ?1 AND key = ?2 AND claim_id = ?3 AND state = 'running'`,
    )
    .bind(
      claim.tokenId,
      claim.key,
      claim.claimId,
      outcome.kind === "unknown" ? null : outcome.status,
      response,
      outcome.kind === "secret" ? outcome.resourceId : null,
    )
    .run();
}

/**
 * Problems a retry may get differently and that are known to come before
 * any change: the caller's token or rights, rate limits, and a repository
 * too busy to start. Their keys are freed.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 403, 408, 429]);
// `merge_in_progress`: a rebase going on in the background; sent again, the request answers its outcome.
const RETRYABLE_CODES: ReadonlySet<string> = new Set(["busy", "network_busy", "merge_in_progress"]);

/** Answers that are not final: the same request has more to do when it is sent again. */
const NOT_FINAL: Readonly<Record<string, (output: unknown) => boolean>> = {
  "uploads.complete": (output) => (output as { state?: unknown }).state === "indexing",
};

/** What a key keeps of a request's result. */
export function outcomeOf(
  op: OperationDef,
  result: { ok: true; output: unknown } | { ok: false; problem: Problem },
): IdempotentOutcome {
  if (!result.ok) {
    const { status, code } = result.problem;
    if (RETRYABLE_STATUSES.has(status) || RETRYABLE_CODES.has(code)) return { kind: "forget" };
    if (status >= 500) return { kind: "unknown" };
    return { kind: "answer", status, body: result.problem };
  }
  if (NOT_FINAL[op.id]?.(result.output)) return { kind: "forget" };
  const status = op.successStatus ?? 200;
  if (op.secretResponse) {
    const id = (result.output as { id?: unknown }).id;
    return { kind: "secret", status, resourceId: typeof id === "string" ? id : "a resource" };
  }
  return { kind: "answer", status, body: result.output };
}

/** Deletes expired keys (the cron's share). Returns how many. */
export async function reapIdempotencyKeys(
  env: Env,
  options: { now: number; metrics?: Metrics },
): Promise<number> {
  options.metrics?.count("d1.query", { db: "directory", op: "idempotency_reap" });
  const result = await env.DIRECTORY.prepare(
    `DELETE FROM idempotency_keys WHERE rowid IN (
       SELECT rowid FROM idempotency_keys WHERE expires_at <= ? LIMIT ?)`,
  )
    .bind(options.now, IDEMPOTENCY_POLICY.reapPerRun)
    .run();
  return result.meta.changes ?? 0;
}
