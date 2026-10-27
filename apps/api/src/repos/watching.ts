import type {
  deleteRepoSubscription,
  getRepoSubscription,
  Input,
  listSubscriptions,
  Output,
  setRepoSubscription,
} from "@fyrden/api-contract";
import type { WatchLevel, WatchRow } from "../do/repo/watching.js";
import { repoFor } from "../git/chunked/operations.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { secretKeys } from "../webhooks/secrets.js";
import {
  allowedWithRole,
  defaultBranchOf,
  entryOf,
  REPO_COLUMNS,
  type RepoRow,
} from "./directory.js";
import { readModelDetails } from "./listing.js";
import { repoOutput, starCounts, visibleParents } from "./output.js";

/*
 * Watching (GitHub's repository subscriptions): the caller's level for a
 * repository it reads, kept by the repository (the authority) and copied to
 * the directory once the repository took it (`watch_preferences`, the copy a
 * restored repository takes its watchers back from, and the listing's
 * source). A command answers only after both: a copy that could not be
 * written answers 503, the repository's change kept, and the same request
 * repeated sets the same state. The copy takes a command only while the
 * repository and the principal are active, and only when it is newer, by
 * `(epoch_gen, revision)`, than what it holds, and of the repository's
 * current restore generation (an older one: the repository was restored
 * since, and is taking its watchers back: 503 too).
 */

/** Watched repositories one listing page reads at most (each confirmed with its repository). */
const LISTING_SCAN = 100;

/** How long a listing's continuation is good for. */
const LISTING_CURSOR_MS = 60 * 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Subscription = Output<typeof getRepoSubscription>;

function subscriptionOf(ctx: OpContext, owner: string, name: string, row: WatchRow): Subscription {
  const repositoryUrl = `${ctx.requestOrigin}/api/repos/${owner}/${name}`;
  return {
    subscribed: row.level === "watching",
    ignored: row.level === "ignoring",
    reason: null,
    created_at: new Date(row.at).toISOString(),
    url: `${repositoryUrl}/subscription`,
    repository_url: repositoryUrl,
  };
}

const recovering = () =>
  new OperationError(
    503,
    "preferences_recovering",
    "The repository is taking its watchers back after a restore: try again shortly.",
  );

const unavailable = () =>
  new OperationError(
    503,
    "preferences_unavailable",
    "The level was set but could not be recorded yet: repeat the request.",
  );

const notWatched = () =>
  new OperationError(404, "subscription_not_found", "Not watching or ignoring this repository.");

/** The `watching.get` operation: 404 while participating (GitHub's). */
export async function getRepoSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof getRepoSubscription>,
): Promise<Output<typeof getRepoSubscription>> {
  const entry = await repoFor(ctx, input.owner, input.repo, "metadata:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "watchLevel" });
  const answer = await ctx.env.REPO.getByName(entry.id).watchLevel(ctx.auth.principalId);
  if (answer.status === "recovering") throw recovering();
  if (answer.status !== "ok" || !answer.row || answer.row.level === "participating")
    throw notWatched();
  return subscriptionOf(ctx, entry.ownerHandle, entry.name, answer.row as WatchRow);
}

/** The `watching.put` operation: `ignored` wins; neither, participating. */
export async function setRepoSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof setRepoSubscription>,
): Promise<Output<typeof setRepoSubscription>> {
  const level: WatchLevel = input.ignored
    ? "ignoring"
    : input.subscribed
      ? "watching"
      : "participating";
  const { row, entry } = await setLevel(ctx, input.owner, input.repo, level);
  return subscriptionOf(ctx, entry.ownerHandle, entry.name, row);
}

/** The `watching.delete` operation: back to participating. */
export async function deleteRepoSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof deleteRepoSubscription>,
): Promise<Output<typeof deleteRepoSubscription>> {
  await setLevel(ctx, input.owner, input.repo, "participating");
  return {};
}

/** Sets the caller's level in the repository, then its copy in the directory. */
async function setLevel(ctx: OpContext, owner: string, repo: string, level: WatchLevel) {
  const entry = await repoFor(ctx, owner, repo, "metadata:read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "setWatch" });
  const answer = await ctx.env.REPO.getByName(entry.id).setWatch(
    ctx.auth.principalId,
    ctx.auth.grantId,
    level,
  );
  if (answer.status === "gone") throw notWatched();
  if (answer.status === "recovering") throw recovering();
  if (answer.status === "full")
    throw new OperationError(
      409,
      "watchers_full",
      "This repository has as many watchers as it takes for now (100).",
    );
  const row = answer.row as WatchRow;
  await copyWatch(ctx, entry.id, row);
  return { row, entry };
}

/**
 * Writes the command to the directory's copy: only while the repository and
 * the principal are active, of the repository's current restore generation,
 * and newer than what the copy holds. Not written for the generation: 503.
 */
export async function copyWatch(ctx: OpContext, repoId: string, row: WatchRow): Promise<void> {
  try {
    await copyOnce(ctx, repoId, row);
  } catch (error) {
    if (error instanceof OperationError) throw error;
    // The directory could not take it: the repository's change is kept; the request repeated
    // sets the same state and copies it.
    throw unavailable();
  }
}

async function copyOnce(ctx: OpContext, repoId: string, row: WatchRow): Promise<void> {
  ctx.metrics.count("d1.query", { db: "directory", op: "watch_copy_put" });
  const written = await ctx.env.DIRECTORY.prepare(
    `INSERT INTO watch_preferences (principal_id, repo_id, root_id, level, revision, epoch_gen, at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE ?6 >= coalesce((SELECT epoch_gen FROM source_epochs WHERE source_id = ?2), 0)
       AND EXISTS (SELECT 1 FROM repos WHERE id = ?2 AND state = 'active')
       AND EXISTS (SELECT 1 FROM principals WHERE id = ?1 AND lifecycle = 'active')
     ON CONFLICT (principal_id, repo_id) DO UPDATE SET root_id = excluded.root_id,
       level = excluded.level, revision = excluded.revision, epoch_gen = excluded.epoch_gen,
       at = excluded.at
     WHERE (excluded.epoch_gen, excluded.revision)
       > (watch_preferences.epoch_gen, watch_preferences.revision)`,
  )
    .bind(row.principal, repoId, row.root, row.level, row.revision, row.epochGen, row.at)
    .run();
  if (written.meta.changes > 0) return;
  // Nothing written: copied already (this command or a newer one: done), a restore since (the
  // repository is taking its watchers back), or the repository or the principal not active now
  // (not recorded: answered as unavailable, never as done).
  ctx.metrics.count("d1.query", { db: "directory", op: "watch_copy_check" });
  const state = await ctx.env.DIRECTORY.prepare(
    `SELECT (SELECT epoch_gen FROM source_epochs WHERE source_id = ?2) AS epoch_gen,
       (SELECT epoch_gen FROM watch_preferences WHERE principal_id = ?1 AND repo_id = ?2)
         AS copied_epoch,
       (SELECT revision FROM watch_preferences WHERE principal_id = ?1 AND repo_id = ?2)
         AS copied_revision`,
  )
    .bind(row.principal, repoId)
    .first<{
      epoch_gen: number | null;
      copied_epoch: number | null;
      copied_revision: number | null;
    }>();
  if (state?.epoch_gen != null && state.epoch_gen > row.epochGen) throw recovering();
  const copied =
    state?.copied_epoch != null &&
    state.copied_revision != null &&
    (state.copied_epoch > row.epochGen ||
      (state.copied_epoch === row.epochGen && state.copied_revision >= row.revision));
  if (!copied) throw unavailable();
}

/** A listing's continuation: sealed, bound to its listing, principal, credential and page size. */
interface ListingPosition {
  readonly after: string;
  readonly expires: number;
}

const listingData = (ctx: OpContext, perPage: number, keyId: string) =>
  encoder.encode(
    `fyrden-subscriptions:v1:${ctx.auth.principalId}:${ctx.auth.id}:${perPage}:${keyId}`,
  );

async function sealPosition(
  ctx: OpContext,
  perPage: number,
  position: ListingPosition,
): Promise<string> {
  const keys = await secretKeys(ctx.env);
  const key = keys.current;
  if (!key)
    throw new OperationError(503, "keys_unavailable", "The deployment's sealing key is not set.");
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: listingData(ctx, perPage, key.id) },
      key.key,
      encoder.encode(JSON.stringify(position)),
    ),
  );
  const id = encoder.encode(key.id);
  // Key id length, key id, nonce, sealed position.
  const bytes = new Uint8Array(1 + id.length + nonce.length + sealed.length);
  bytes.set([id.length], 0);
  bytes.set(id, 1);
  bytes.set(nonce, 1 + id.length);
  bytes.set(sealed, 1 + id.length + nonce.length);
  return encodeBytesCursor(bytes);
}

async function openPosition(
  ctx: OpContext,
  perPage: number,
  cursor: string,
): Promise<ListingPosition> {
  const bytes = decodeBytesCursor(cursor);
  const length = bytes?.[0];
  if (!bytes || length === undefined || bytes.length < 1 + length + 12 + 16) throw invalidCursor();
  const keyId = decoder.decode(bytes.subarray(1, 1 + length));
  const key = (await secretKeys(ctx.env)).byId.get(keyId);
  if (!key) throw invalidCursor();
  let position: ListingPosition;
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(1 + length, 1 + length + 12),
        additionalData: listingData(ctx, perPage, keyId),
      },
      key.key,
      bytes.subarray(1 + length + 12),
    );
    position = JSON.parse(decoder.decode(opened)) as ListingPosition;
  } catch {
    throw invalidCursor();
  }
  if (typeof position.after !== "string" || !(position.expires > Date.now())) throw invalidCursor();
  return position;
}

/**
 * The `watching.list` operation: the repositories the caller watches and
 * reads now, by repository id, for the principal's own credentials. A page
 * reads at most `LISTING_SCAN` watched repositories, each confirmed with its
 * repository; the continuation names the last one read, sealed (never one
 * left out), so a page can be short, even empty, and the listing still
 * moves on.
 */
export async function listSubscriptionsOperation(
  ctx: OpContext,
  input: Input<typeof listSubscriptions>,
): Promise<Output<typeof listSubscriptions>> {
  const { env, auth, metrics } = ctx;
  // A delegated token sees what its user and its agents' owners may read at once, which no
  // query restricts: its pages would depend on what it may not read.
  if (auth.grantId !== null)
    throw new OperationError(
      403,
      "delegated_listing",
      "List watched repositories with the user's own credentials.",
    );
  const after = input.cursor ? (await openPosition(ctx, input.per_page, input.cursor)).after : "";
  const scan = Math.min(LISTING_SCAN, Math.max(input.per_page, 1) * 4);
  metrics.count("d1.query", { db: "directory", op: "watch_list" });
  const { results } = await env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${REPO_COLUMNS}
       FROM watch_preferences w INDEXED BY watch_preferences_listed
         JOIN repos r ON r.id = w.repo_id JOIN principals p ON p.id = r.owner_id
       WHERE w.principal_id = ?1 AND w.level = 'watching' AND w.repo_id > ?2
         AND r.state = 'active' AND p.lifecycle IN ('active', 'suspended')
         AND (?3 IS NULL OR w.repo_id IN (SELECT value FROM json_each(?3)))
       ORDER BY w.repo_id LIMIT ?4`,
    )
    .bind(auth.principalId, after, auth.repoIds ? JSON.stringify(auth.repoIds) : null, scan + 1)
    .all<RepoRow>();
  const read = results.slice(0, scan);
  const candidates = read.map((row) => entryOf(row));
  // Each confirmed by its repository, the authority, in one call: the caller reads it now and
  // watches it (a copy that missed an unwatch is not listed); one taking its watchers back
  // after a restore answers 503, the continuation not moved past it.
  const allowed = await Promise.all(
    candidates.map(async (entry) => {
      if (!allowedWithRole(auth, entry, "metadata:read", "admin")) return false;
      metrics.count("do.request", { class: "RepoDO", method: "watchedBy" });
      const answer = await env.REPO.getByName(entry.id).watchedBy(auth.principalId);
      if (answer.status === "recovering") throw recovering();
      return answer.status === "ok" && answer.watching;
    }),
  );
  const visible = candidates.filter((_, i) => allowed[i]).slice(0, input.per_page);
  // The last read, or, when the page filled first, the last shown: never past one not looked at.
  const filled = candidates.filter((_, i) => allowed[i]).length > input.per_page;
  const last = filled ? visible.at(-1) : candidates.at(-1);
  const more = filled || results.length > scan;
  const ids = visible.map((entry) => entry.id);
  const [details, stars, parents] = await Promise.all([
    readModelDetails(env, ids, metrics),
    starCounts(env, ids, metrics),
    visibleParents(env, auth, visible, metrics),
  ]);
  return {
    repos: visible.map((entry) =>
      repoOutput(entry, {
        defaultBranch: defaultBranchOf(details.get(entry.id)?.default_branch ?? null),
        description: details.get(entry.id)?.description ?? null,
        parentVisible: parents.has(entry.parentId ?? ""),
        stars: stars.get(entry.id) ?? 0,
      }),
    ),
    next_cursor:
      more && last
        ? await sealPosition(ctx, input.per_page, {
            after: last.id,
            expires: Date.now() + LISTING_CURSOR_MS,
          })
        : null,
  };
}
