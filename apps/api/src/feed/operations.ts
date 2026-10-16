import type { ackFeedItem, getFeed, Input, Output, syncFeed } from "@fyrden/api-contract";
import { FEED_KINDS, type FeedKind, feedItemKey } from "@fyrden/domain";
import {
  FEED_POLICY,
  type FeedFilter,
  type FeedItem,
  type FeedItemId,
  type FeedPosition,
  type SyncPosition,
} from "../do/user/feed.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import {
  allowedWithRole,
  authorizeAtOnce,
  findReposById,
  type RepoEntry,
} from "../repos/directory.js";

/*
 * The activity feed's operations. A feed belongs to a principal id: the
 * token's principal, which is the agent for an agent's own token and the
 * user for a delegated token (whichever agent of the chain holds it) or a
 * signed-in session. Every item is checked again when read: its
 * repository must exist and the caller (with its token's limits, a
 * delegated token's grant included, and its agents' owners' rights) must
 * read its pull requests now. Items it may not read are skipped, and
 * nothing says how many: a cursor only ever names an item the caller was
 * shown (or where it started), so it tells nothing of the others, and an
 * answer changes only when what the caller may see does. A check that
 * could not be made, or one past the answer's budget, ends the answer
 * there (the cursor never passes an item not checked).
 */

/** How long a caller that reached the head waits before polling again. Proposed. */
export const FEED_POLL_AFTER_MS = 30_000;

/** Where a client whose cursor expired starts over. */
const RESYNC = "/api/feed/sync";

/** The permission an item's repository must grant the caller now. */
const READ = "pull_requests:read";

/**
 * Repositories one answer checks with their objects at most (one call
 * each, of the 1,000 an invocation may make), items it reads from the
 * feed at most, shown or not, and how many a read takes. Proposed.
 */
const SCAN = { repoChecks: 100, items: 1_000, page: 200 } as const;

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
const feedOf = (ctx: OpContext) => ctx.env.USER.getByName(ctx.auth.principalId);

const counted = (ctx: OpContext, method: string) =>
  ctx.metrics.count("do.request", { class: "UserDO", method });

/** What the caller may see of a feed's items, decided once per repository within one answer. */
class Visibility {
  readonly #decided = new Map<string, RepoEntry | "denied" | "unknown">();
  #checks = 0;

  constructor(private readonly ctx: OpContext) {}

  /** Decides the repositories among `repoIds` not decided yet, within the budget of checks. */
  async decide(repoIds: readonly string[]): Promise<void> {
    const { env, auth, metrics } = this.ctx;
    const ids = [...new Set(repoIds)].filter((id) => !this.#decided.has(id));
    if (ids.length === 0) return;
    const entries = new Map((await findReposById(env, ids, metrics)).map((e) => [e.id, e]));
    const checking: RepoEntry[] = [];
    for (const id of ids) {
      const entry = entries.get(id);
      // Gone, or outside the token's own limits: no call needed.
      if (!entry || !allowedWithRole(auth, entry, READ, "admin")) this.#decided.set(id, "denied");
      else if (this.#checks < SCAN.repoChecks) {
        this.#checks++;
        checking.push(entry);
      }
    }
    const decisions = await Promise.all(
      checking.map((entry) => authorizeAtOnce(env, auth, entry, READ, metrics)),
    );
    checking.forEach((entry, i) => {
      const decision = decisions[i];
      this.#decided.set(entry.id, decision === "allowed" ? entry : (decision ?? "unknown"));
    });
  }

  /** The repository when the caller may see it; undefined when unknown (not checked). */
  of(repoId: string): RepoEntry | "hidden" | undefined {
    const decided = this.#decided.get(repoId);
    return decided === "denied" ? "hidden" : decided === "unknown" ? undefined : decided;
  }
}

/** Items shown, in order, up to and past `limit` (one more tells that more follow). */
type Scanned = { item: FeedItem; repo: RepoEntry }[];

/**
 * Reads items with `read` until `limit` and one more are shown, the feed
 * ends, or the answer's budget does; stops at an item it could not check.
 * `more`: the feed may have more the caller can see.
 */
async function scan<P>(
  ctx: OpContext,
  limit: number,
  read: (after: P | null) => Promise<{ items: readonly FeedItem[]; more: boolean }>,
  position: (item: FeedItem) => P,
): Promise<{ shown: Scanned; more: boolean }> {
  const visibility = new Visibility(ctx);
  const shown: Scanned = [];
  let after: P | null = null;
  for (let scanned = 0; scanned < SCAN.items; ) {
    const page = await read(after);
    await visibility.decide(page.items.map((item) => item.repoId));
    for (const item of page.items) {
      const repo = visibility.of(item.repoId);
      if (repo === undefined) return { shown, more: true };
      if (repo !== "hidden") shown.push({ item, repo });
      if (shown.length > limit) return { shown, more: true };
    }
    const last = page.items.at(-1);
    if (!page.more || !last) return { shown, more: false };
    scanned += page.items.length;
    after = position(last);
  }
  return { shown, more: true };
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

const expired = () =>
  new OperationError(
    410,
    "cursor_expired",
    "The cursor is older than the feed keeps, or of another epoch: start over from the feed's sync.",
    RESYNC,
  );

/** The `feed.list` operation. */
export async function getFeedOperation(
  ctx: OpContext,
  input: Input<typeof getFeed>,
): Promise<Output<typeof getFeed>> {
  const feed = feedOf(ctx);
  const since = decodeFeedCursor(input.since);
  const filter: FeedFilter = {
    priority: input.priority,
    kind: input.kind,
    repoIds: ctx.auth.repoIds,
  };
  let epoch = since?.epoch;
  const { shown, more } = await scan(
    ctx,
    input.limit,
    async (after: FeedPosition | null) => {
      counted(ctx, "listFeed");
      const page = await feed.listFeed(after ?? since, SCAN.page, filter);
      if (page.expired) throw expired();
      epoch = page.head.epoch;
      return page;
    },
    (item) => ({ epoch: epoch as string, seq: item.seq }),
  );
  // Positions of items shown only: where the caller started when none was.
  const at = (item: FeedItem | undefined) =>
    encodeFeedCursor(
      item
        ? { epoch: epoch as string, seq: item.seq }
        : (since ?? { epoch: epoch as string, seq: 0 }),
    );
  const page = shown.slice(0, input.limit);
  return {
    items: page.map(({ item, repo }) => itemOutput(item, repo)),
    next_cursor: at(page.at(-1)?.item),
    head_cursor: at(shown.at(-1)?.item),
    poll_after_ms: more ? 0 : FEED_POLL_AFTER_MS,
  };
}

/** The `feed.sync` operation. */
export async function syncFeedOperation(ctx: OpContext): Promise<Output<typeof syncFeed>> {
  const feed = feedOf(ctx);
  let epoch = "";
  const { shown, more } = await scan(
    ctx,
    FEED_POLICY.syncItems,
    async (after: SyncPosition | null) => {
      counted(ctx, "syncFeed");
      const page = await feed.syncFeed(after, SCAN.page, ctx.auth.repoIds);
      epoch = page.epoch;
      return page;
    },
    (item) => ({ open: item.priority === "P0" && item.state === "open", seq: item.seq }),
  );
  const items = shown.slice(0, FEED_POLICY.syncItems);
  // Following from the greatest item shown misses no change the caller may see; an incomplete
  // sync follows from the start.
  const seq = more ? 0 : Math.max(0, ...items.map(({ item }) => item.seq));
  return {
    items: items.map(({ item, repo }) => itemOutput(item, repo)),
    complete: !more,
    head_cursor: encodeFeedCursor({ epoch, seq }),
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
  if (!id) throw notFound;
  const visibility = new Visibility(ctx);
  await visibility.decide([id.repoId]);
  const repo = visibility.of(id.repoId);
  if (repo === undefined) throw new Error("the repository's access could not be checked");
  if (repo === "hidden") throw notFound;
  counted(ctx, "ackFeed");
  const acked = await feedOf(ctx).ackFeed(id, input.version);
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
