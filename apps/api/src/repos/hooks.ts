import { checkOutboundUrl, dohResolver } from "@fyrden/adapters-cloudflare/net";
import type {
  createHook,
  deleteHook,
  dropPreviousHookSecret,
  getHook,
  getHookDelivery,
  Hook,
  Input,
  listHookDeliveries,
  listHooks,
  Output,
  pingHook,
  redeliverHookDelivery,
  resealHookSecrets,
  rotateHookSecret,
  updateHook,
} from "@fyrden/api-contract";
import type { z } from "zod";
import type { HookEvent, HookView } from "../do/repo/hooks.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { repoFor } from "../git/chunked/operations.js";
import { ownHostsOf } from "../git/import/network.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { secretKeys } from "../webhooks/secrets.js";
import { DELIVERY_POLICY, type DeliveryMessage } from "../webhooks/sink.js";
import type { RepoEntry } from "./directory.js";
import { actorOf } from "./pulls.js";

/*
 * Repository webhooks over the API: their configuration lives in the
 * repository object (which checks the caller administers it again), their
 * deliveries in the read model, beside the effects that made them.
 */

type HookOut = z.infer<typeof Hook>;
type Browsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly error: string };

function unwrap<T>(result: Browsed<T>): T {
  if (!result.ok) throw new OperationError(result.status as 404, result.code, result.error);
  return result.value;
}

/**
 * A hook URL the server may post to, as of now (checked again on every
 * attempt), as the URL parser writes it (a lowercase scheme, no spaces).
 */
async function checkUrl(ctx: OpContext, url: string, entry: RepoEntry): Promise<string> {
  const checked = await checkOutboundUrl(url, {
    ownHosts: ownHostsOf(ctx.env, ctx.requestHost),
    resolve: dohResolver(),
    allowHttp: entry.visibility === "public",
  });
  if (!checked.ok)
    throw new OperationError(
      422,
      "invalid_url",
      checked.reason === "scheme"
        ? "A webhook URL must be https (http only for a public repository)."
        : `The webhook URL cannot be used (${checked.reason.replaceAll("_", " ")}).`,
    );
  return checked.url.href;
}

/** Each hook's newest finished delivery, as GitHub's `last_response`. */
async function lastResponses(
  ctx: OpContext,
  repoId: string,
  hookIds: readonly number[],
): Promise<Map<number, HookOut["last_response"]>> {
  const out = new Map<number, HookOut["last_response"]>();
  if (hookIds.length === 0) return out;
  ctx.metrics.count("d1.query", { db: "org", op: "hooks_last_response" });
  const { results } = await readModelFor(ctx.env, DEFAULT_ORG_SHARD)
    .prepare(
      // Each hook's newest finished delivery, found through its index (one probe a hook).
      `SELECT d.hook_id, d.state, d.last_status, d.reason
       FROM json_each(?2) h
       JOIN webhook_deliveries d ON d.delivery_id = (
         SELECT delivery_id FROM webhook_deliveries
         WHERE repo_id = ?1 AND hook_id = h.value AND state IN ('done', 'failed')
         ORDER BY updated_at DESC, delivery_id DESC LIMIT 1)`,
    )
    .bind(repoId, JSON.stringify(hookIds))
    .all<{ hook_id: number; state: string; last_status: number | null; reason: string | null }>();
  for (const row of results)
    out.set(row.hook_id, {
      code: row.last_status,
      status: row.state === "done" ? "active" : "failed",
      message: row.reason,
    });
  return out;
}

const NEVER = { code: null, status: "unused", message: null } as const;

function hookOut(hook: HookView, last: HookOut["last_response"] | undefined): HookOut {
  return {
    id: hook.id,
    name: "web",
    active: hook.active,
    events: [...hook.events],
    config: { url: hook.url, content_type: "json" },
    created_at: new Date(hook.createdAt).toISOString(),
    updated_at: new Date(hook.updatedAt).toISOString(),
    last_response: last ?? NEVER,
    disabled_reason: hook.disabledReason,
    secrets: hook.secrets,
  };
}

const stub = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

/** The events a hook takes, `*` alone standing for all. */
const eventsOf = (events: readonly string[]) =>
  (events.includes("*") ? ["*"] : [...new Set(events)]) as HookEvent[];

export async function listHooksOperation(
  ctx: OpContext,
  input: Input<typeof listHooks>,
): Promise<Output<typeof listHooks>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:read");
  const hooks = unwrap(await stub(ctx, entry, "listHooks").listHooks());
  const last = await lastResponses(
    ctx,
    entry.id,
    hooks.map((h) => h.id),
  );
  return hooks.map((h) => hookOut(h, last.get(h.id)));
}

export async function getHookOperation(
  ctx: OpContext,
  input: Input<typeof getHook>,
): Promise<Output<typeof getHook>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:read");
  const hook = unwrap(await stub(ctx, entry, "getHook").getHook(input.hook_id));
  return hookOut(hook, (await lastResponses(ctx, entry.id, [hook.id])).get(hook.id));
}

export async function createHookOperation(
  ctx: OpContext,
  input: Input<typeof createHook>,
): Promise<Output<typeof createHook>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  const url = await checkUrl(ctx, input.config.url, entry);
  const made = unwrap(
    await stub(ctx, entry, "createHook").createHook(
      {
        url,
        events: eventsOf(input.events),
        active: input.active,
        apiHost: ctx.requestHost,
      },
      actorOf(ctx),
    ),
  );
  return { ...hookOut(made.hook, undefined), secret: made.secret };
}

export async function updateHookOperation(
  ctx: OpContext,
  input: Input<typeof updateHook>,
): Promise<Output<typeof updateHook>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  const url =
    input.config?.url === undefined ? undefined : await checkUrl(ctx, input.config.url, entry);
  const hook = unwrap(
    await stub(ctx, entry, "updateHook").updateHook(
      input.hook_id,
      {
        ...(url !== undefined && { url }),
        ...(input.events && { events: eventsOf(input.events) }),
        ...(input.add_events && { addEvents: input.add_events as HookEvent[] }),
        ...(input.remove_events && { removeEvents: input.remove_events as HookEvent[] }),
        ...(input.active !== undefined && { active: input.active }),
        apiHost: ctx.requestHost,
      },
      actorOf(ctx),
    ),
  );
  return hookOut(hook, (await lastResponses(ctx, entry.id, [hook.id])).get(hook.id));
}

export async function deleteHookOperation(
  ctx: OpContext,
  input: Input<typeof deleteHook>,
): Promise<Output<typeof deleteHook>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  unwrap(await stub(ctx, entry, "deleteHook").deleteHook(input.hook_id, actorOf(ctx)));
  // Its waiting deliveries now (an attempt would find the hook gone anyway).
  ctx.metrics.count("d1.query", { db: "org", op: "hooks_cancel" });
  await readModelFor(ctx.env, DEFAULT_ORG_SHARD)
    .prepare(
      // Their claims cleared too: an attempt under way records nothing over this.
      `UPDATE webhook_deliveries SET state = 'cancelled', reason = 'hook_deleted',
         lease_token = NULL, lease_until = NULL, updated_at = ?
       WHERE repo_id = ? AND hook_id = ? AND state = 'pending'`,
    )
    .bind(Date.now(), entry.id, input.hook_id)
    .run();
  return { id: input.hook_id, state: "deleted" };
}

export async function pingHookOperation(
  ctx: OpContext,
  input: Input<typeof pingHook>,
): Promise<Output<typeof pingHook>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  unwrap(await stub(ctx, entry, "pingHook").pingHook(input.hook_id, actorOf(ctx)));
  return { id: input.hook_id, state: "pinged" };
}

export async function rotateHookSecretOperation(
  ctx: OpContext,
  input: Input<typeof rotateHookSecret>,
): Promise<Output<typeof rotateHookSecret>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  const made = unwrap(
    await stub(ctx, entry, "rotateHookSecret").rotateHookSecret(input.hook_id, actorOf(ctx)),
  );
  return { id: input.hook_id, secret: made.secret };
}

export async function dropPreviousHookSecretOperation(
  ctx: OpContext,
  input: Input<typeof dropPreviousHookSecret>,
): Promise<Output<typeof dropPreviousHookSecret>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  const repo = stub(ctx, entry, "dropPreviousHookSecret");
  unwrap(await repo.dropPreviousHookSecret(input.hook_id, actorOf(ctx)));
  return { id: input.hook_id, secrets: unwrap(await repo.getHook(input.hook_id)).secrets };
}

type DeliveryRow = {
  delivery_id: string;
  event: string;
  action: string | null;
  state: "pending" | "done" | "failed" | "cancelled" | "dropped";
  reason: string | null;
  last_status: number | null;
  attempts: number;
  created_at: number;
  next_attempt_at: number;
  payload_key: string;
};

const deliveryOut = (row: DeliveryRow) => ({
  id: row.delivery_id,
  event: row.event,
  action: row.action,
  state: row.state,
  reason: row.reason,
  status_code: row.last_status,
  attempts: row.attempts,
  delivered_at: new Date(row.created_at).toISOString(),
  next_attempt_at: row.state === "pending" ? new Date(row.next_attempt_at).toISOString() : null,
});

export async function listHookDeliveriesOperation(
  ctx: OpContext,
  input: Input<typeof listHookDeliveries>,
): Promise<Output<typeof listHookDeliveries>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:read");
  unwrap(await stub(ctx, entry, "getHook").getHook(input.hook_id));
  const [before, beforeId] = decodeCursor(input.cursor);
  ctx.metrics.count("d1.query", { db: "org", op: "hooks_deliveries" });
  const { results } = await readModelFor(ctx.env, DEFAULT_ORG_SHARD)
    .prepare(
      `SELECT delivery_id, event, action, state, reason, last_status, attempts, created_at,
         next_attempt_at, payload_key
       FROM webhook_deliveries
       WHERE repo_id = ? AND hook_id = ? AND (created_at, delivery_id) < (?, ?)
       ORDER BY created_at DESC, delivery_id DESC LIMIT ?`,
    )
    .bind(entry.id, input.hook_id, before, beforeId, input.per_page + 1)
    .all<DeliveryRow>();
  const page = results.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    deliveries: page.map(deliveryOut),
    next_cursor:
      results.length > input.per_page && last ? `${last.created_at}.${last.delivery_id}` : null,
  };
}

function decodeCursor(cursor: string | undefined): [number, string] {
  if (cursor === undefined) return [Number.MAX_SAFE_INTEGER, "~"];
  const match = /^(\d{1,16})\.(msg_[0-9a-f]{32})$/.exec(cursor);
  if (!match)
    throw new OperationError(422, "invalid_cursor", "The cursor is not one this API returned.");
  return [Number(match[1]), match[2] as string];
}

export async function getHookDeliveryOperation(
  ctx: OpContext,
  input: Input<typeof getHookDelivery>,
): Promise<Output<typeof getHookDelivery>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:read");
  unwrap(await stub(ctx, entry, "getHook").getHook(input.hook_id));
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  ctx.metrics.count("d1.query", { db: "org", op: "hooks_delivery" }, 2);
  const [delivery, attempts] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT delivery_id, event, action, state, reason, last_status, attempts, created_at,
           next_attempt_at, payload_key
         FROM webhook_deliveries WHERE delivery_id = ? AND repo_id = ? AND hook_id = ?`,
      )
      .bind(input.delivery_id, entry.id, input.hook_id),
    db
      .prepare(
        `SELECT n, at, url, status, duration_ms, response_excerpt, error FROM webhook_attempts
         WHERE delivery_id = ? ORDER BY n`,
      )
      .bind(input.delivery_id),
  ]);
  const row = delivery?.results[0] as DeliveryRow | undefined;
  if (!row)
    throw new OperationError(
      404,
      "delivery_not_found",
      `No delivery ${input.delivery_id} was found.`,
    );
  const object = await ctx.env.ASSETS.get(row.payload_key);
  return {
    ...deliveryOut(row),
    request: { payload: object ? ((await object.json()) as Record<string, unknown>) : null },
    attempts_made: (
      (attempts?.results ?? []) as {
        n: number;
        at: number;
        url: string | null;
        status: number | null;
        duration_ms: number | null;
        response_excerpt: string | null;
        error: string | null;
      }[]
    ).map((a) => ({
      n: a.n,
      at: new Date(a.at).toISOString(),
      url: a.url,
      status_code: a.status,
      duration_ms: a.duration_ms,
      response: a.response_excerpt,
      error: a.error,
    })),
  };
}

/**
 * Sends a finished delivery once more: one attempt past those it had (its
 * automatic retries are not run again), from its stored body. A claim of
 * an earlier attempt still running cannot record anything for it: only a
 * pending delivery's current claim holder records an attempt.
 */
export async function redeliverHookDeliveryOperation(
  ctx: OpContext,
  input: Input<typeof redeliverHookDelivery>,
): Promise<Output<typeof redeliverHookDelivery>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "repository_hooks:write");
  const hook = unwrap(await stub(ctx, entry, "getHook").getHook(input.hook_id));
  if (!hook.active)
    throw new OperationError(422, "hook_inactive", "The hook is not active: turn it on first.");
  const db = readModelFor(ctx.env, DEFAULT_ORG_SHARD);
  ctx.metrics.count("d1.query", { db: "org", op: "hooks_redeliver_read" });
  const found = await db
    .prepare(
      `SELECT delivery_id, event, action, state, reason, last_status, attempts, created_at,
         next_attempt_at, payload_key, expires_at, disable_hook_version
       FROM webhook_deliveries WHERE delivery_id = ? AND repo_id = ? AND hook_id = ?`,
    )
    .bind(input.delivery_id, entry.id, input.hook_id)
    .first<DeliveryRow & { expires_at: number; disable_hook_version: number | null }>();
  if (!found)
    throw new OperationError(
      404,
      "delivery_not_found",
      `No delivery ${input.delivery_id} was found.`,
    );
  if (found.state === "pending")
    throw new OperationError(409, "delivery_pending", "The delivery is still being made.");
  if (found.state !== "done" && found.state !== "failed")
    throw new OperationError(
      422,
      "not_redeliverable",
      `A ${found.state} delivery was never sent and cannot be sent again.`,
    );
  // Its receiver answered 410: the hook is being turned off (a later change of it settles that).
  if (found.disable_hook_version !== null)
    throw new OperationError(
      409,
      "hook_being_disabled",
      "The receiver answered 410 Gone: the hook is being turned off. Change or turn it on again first.",
    );
  if (found.expires_at <= Date.now())
    throw new OperationError(422, "payload_gone", "The delivery's body is no longer kept.");
  ctx.metrics.count("r2.class_b", { bucket: "fyrden-assets", op: "head_webhook_body" });
  if (!(await ctx.env.ASSETS.head(found.payload_key)))
    throw new OperationError(422, "payload_gone", "The delivery's body is no longer kept.");
  const now = Date.now();
  ctx.metrics.count("d1.query", { db: "org", op: "hooks_redeliver" });
  // Only from a finished state (no claim holds it), within the hook's cap of waiting deliveries.
  const moved = await db
    .prepare(
      `UPDATE webhook_deliveries SET state = 'pending', reason = NULL, attempt_limit = attempts + 1,
         next_attempt_at = ?1, enqueued_at = ?1, lease_token = NULL, lease_until = NULL,
         updated_at = ?1
       WHERE delivery_id = ?2 AND repo_id = ?3 AND hook_id = ?4 AND state IN ('done', 'failed')
         AND expires_at > ?1 AND disable_hook_version IS NULL
         AND (SELECT count(*) FROM webhook_deliveries
              WHERE repo_id = ?3 AND hook_id = ?4 AND state = 'pending') < ?5
       RETURNING delivery_id, event, action, state, reason, last_status, attempts, created_at,
         next_attempt_at, payload_key`,
    )
    .bind(now, input.delivery_id, entry.id, input.hook_id, DELIVERY_POLICY.maxOutstanding)
    .first<DeliveryRow>();
  if (!moved)
    throw new OperationError(
      409,
      "too_many_outstanding",
      "The hook has too many deliveries waiting, or the delivery changed meanwhile; try again later.",
    );
  // A message lost here is sent again by the cron (its enqueued time is set).
  await ctx.env.WEBHOOKS.send({ delivery: moved.delivery_id } satisfies DeliveryMessage);
  return deliveryOut(moved);
}

/** Repositories one call of the operator's reseal goes through. */
const RESEAL_REPOS = 25;

export async function resealHookSecretsOperation(
  ctx: OpContext,
  input: Input<typeof resealHookSecrets>,
): Promise<Output<typeof resealHookSecrets>> {
  const keys = await secretKeys(ctx.env);
  if (!keys.current)
    throw new OperationError(
      422,
      "webhooks_unavailable",
      keys.misconfigured
        ? `${keys.misconfigured}: secrets cannot be sealed again until it is fixed.`
        : "WEBHOOKS_KEY is not set: secrets cannot be sealed again.",
    );
  const after = input.cursor ?? "";
  ctx.metrics.count("d1.query", { db: "directory", op: "hooks_reseal_repos" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    "SELECT id FROM repos WHERE id > ? AND state = 'active' ORDER BY id LIMIT ?",
  )
    .bind(after, RESEAL_REPOS)
    .all<{ id: string }>();
  let resealed = 0;
  let remaining = 0;
  let unreadable = 0;
  for (const { id } of results) {
    ctx.metrics.count("do.request", { class: "RepoDO", method: "resealHookSecrets" });
    const done = await ctx.env.REPO.getByName(id).resealHookSecrets(50);
    resealed += done.resealed;
    remaining += done.remaining;
    unreadable += done.unreadable;
  }
  return {
    resealed,
    remaining,
    unreadable,
    next_cursor: results.length === RESEAL_REPOS ? (results.at(-1)?.id ?? null) : null,
  };
}
