import type { ackFeedItem, getFeed, Input, Output, syncFeed } from "@fyrden/api-contract";
import { FEED_KINDS, type FeedKind, feedItemKey } from "@fyrden/domain";
import type { FeedItem, FeedItemId, FeedPosition } from "../do/user/feed.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { authorize, findReposById, type RepoEntry } from "../repos/directory.js";

/*
 * The activity feed's operations. A feed belongs to a principal id: the
 * token's principal, which is the agent for an agent's own token and the
 * user for a delegated token (whichever agent of the chain holds it) or a
 * signed-in session. Every item is checked again when read: its
 * repository must exist and the caller (with its token's limits, a
 * delegated token's grant included, and its agents' owners' rights) must
 * read its pull requests now. Items it may not read are skipped, and
 * nothing says how many.
 */

/** How long a caller that reached the head waits before polling again. Proposed. */
export const FEED_POLL_AFTER_MS = 30_000;

/** Where a client whose cursor expired starts over. */
const RESYNC = "/api/feed/sync";

/** The permission an item's repository must grant the caller now. */
const READ = "pull_requests:read";

/** A feed cursor: `base64url({v:1,e,s})`, an epoch and a sequence number, opaque to clients. */
export function encodeFeedCursor(position: FeedPosition): string {
  return encodeBytesCursor(
    new TextEncoder().encode(JSON.stringify({ v: 1, e: position.epoch, s: position.seq })),
  );
}

/** The position a feed cursor names (null without one); any other cursor is refused. */
export function decodeFeedCursor(cursor: string | undefined): FeedPosition | null {
  if (cursor === undefined) return null;
  const bytes = decodeBytesCursor(cursor);
  let value: unknown;
  try {
    value =
      bytes && JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw invalidCursor();
  }
  const { v, e, s } = (value ?? {}) as { v?: unknown; e?: unknown; s?: unknown };
  if (
    v !== 1 ||
    typeof e !== "string" ||
    e.length > 64 ||
    !Number.isSafeInteger(s) ||
    (s as number) < 0
  )
    throw invalidCursor();
  return { epoch: e, seq: s as number };
}

type FeedItemOutput = Output<typeof getFeed>["items"][number];

/** The caller's feed: its token's principal's object. */
const feedOf = (ctx: OpContext, method: string) => {
  ctx.metrics.count("do.request", { class: "UserDO", method });
  return ctx.env.USER.getByName(ctx.auth.principalId);
};

/** The repositories among `ids` the caller may read pull requests of now, by id. */
async function readableRepos(
  ctx: OpContext,
  ids: readonly string[],
): Promise<Map<string, RepoEntry>> {
  const { env, auth, metrics } = ctx;
  const entries = await findReposById(env, ids, metrics);
  const allowed = await Promise.all(
    entries.map((entry) => authorize(env, auth, entry, READ, metrics)),
  );
  return new Map(entries.filter((_, i) => allowed[i]).map((entry) => [entry.id, entry]));
}

/** The items the caller may read now, in their order, as the API shows them. */
async function visible(ctx: OpContext, items: readonly FeedItem[]): Promise<FeedItemOutput[]> {
  const repos = await readableRepos(ctx, [...new Set(items.map((item) => item.repoId))]);
  return items.flatMap((item) => {
    const repo = repos.get(item.repoId);
    return repo ? [itemOutput(item, repo)] : [];
  });
}

function itemOutput(item: FeedItem, repo: RepoEntry): FeedItemOutput {
  return {
    item_key: feedItemKey(item.repoId, item.threadKey, item.kind),
    repo: { id: repo.id, full_name: `${repo.ownerHandle}/${repo.name}` },
    thread_key: item.threadKey,
    kind: item.kind,
    subject: { kind: "pull", number: item.number, title: item.title },
    version: item.version,
    state: item.state,
    priority: item.priority,
    reasons: [...item.reasons],
    silent: item.silent,
    action: item.action,
    actor: item.actor,
    actor_trust: item.actorTrust,
    excerpt: item.excerpt,
    members: [...item.members],
    members_truncated: item.truncated,
    event_at: item.eventAt,
    acked_version: item.ackedVersion,
  };
}

/** The `feed.list` operation. */
export async function getFeedOperation(
  ctx: OpContext,
  input: Input<typeof getFeed>,
): Promise<Output<typeof getFeed>> {
  const page = await feedOf(ctx, "listFeed").listFeed(decodeFeedCursor(input.since), input.limit, {
    priority: input.priority,
    kind: input.kind,
  });
  if (page.expired)
    throw new OperationError(
      410,
      "cursor_expired",
      "The cursor is older than the feed keeps, or of another epoch: start over from the feed's sync.",
      RESYNC,
    );
  const last = page.items.at(-1);
  const head = encodeFeedCursor(page.head);
  return {
    items: await visible(ctx, page.items),
    // Past every item read, shown or not: a page of hidden items still moves on.
    next_cursor:
      page.more && last ? encodeFeedCursor({ epoch: page.head.epoch, seq: last.seq }) : head,
    head_cursor: head,
    poll_after_ms: page.more ? 0 : FEED_POLL_AFTER_MS,
  };
}

/** The `feed.sync` operation. */
export async function syncFeedOperation(ctx: OpContext): Promise<Output<typeof syncFeed>> {
  const synced = await feedOf(ctx, "syncFeed").syncFeed();
  return {
    items: await visible(ctx, synced.items),
    complete: synced.complete,
    head_cursor: encodeFeedCursor(synced.head),
    poll_after_ms: FEED_POLL_AFTER_MS,
  };
}

/** An item key's parts (`<repository>:<thread>:<kind>`), or undefined for no key an item can have. */
function parseItemKey(key: string): FeedItemId | undefined {
  const first = key.indexOf(":");
  const last = key.lastIndexOf(":");
  if (first <= 0 || last <= first + 1) return undefined;
  const kind = key.slice(last + 1);
  if (!(FEED_KINDS as readonly string[]).includes(kind)) return undefined;
  return {
    repoId: key.slice(0, first),
    threadKey: key.slice(first + 1, last),
    kind: kind as FeedKind,
  };
}

/** The `feed.ack` operation. An item of a repository the caller cannot read now is not found. */
export async function ackFeedItemOperation(
  ctx: OpContext,
  input: Input<typeof ackFeedItem>,
): Promise<Output<typeof ackFeedItem>> {
  const notFound = new OperationError(404, "feed_item_not_found", "The feed has no such item.");
  const id = parseItemKey(input.item_key);
  if (!id || !(await readableRepos(ctx, [id.repoId])).has(id.repoId)) throw notFound;
  const acked = await feedOf(ctx, "ackFeed").ackFeed(id, input.version);
  if (acked.status === "missing") throw notFound;
  if (acked.status === "ahead")
    throw new OperationError(
      409,
      "version_ahead",
      "The item has no such version yet: acknowledge a version it has.",
    );
  return {
    item_key: input.item_key,
    version: acked.item.version,
    acked_version: acked.item.ackedVersion,
  };
}
