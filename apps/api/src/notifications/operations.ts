import type {
  deleteNotificationThreadSubscription,
  getNotificationThread,
  getNotificationThreadSubscription,
  Input,
  listNotifications,
  listRepoNotifications,
  markNotificationsRead,
  markNotificationThreadDone,
  markNotificationThreadRead,
  markRepoNotificationsRead,
  Output,
  setNotificationThreadSubscription,
} from "@fyrden/api-contract";
import { scopesAllow } from "@fyrden/domain";
import type { ThreadRow, ThreadState } from "../do/repo/thread-preferences.js";
import { type InboxThread, parseThreadId, type SubjectKind } from "../do/user/inbox.js";
import { deliveryOf, freshly, Visibility } from "../feed/operations.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { authorize, type RepoEntry, resolveRepo } from "../repos/directory.js";
import { copyThread } from "../repos/thread-subscriptions.js";
import { recovering } from "../repos/watching.js";

/*
 * GitHub's notifications API over the principal's thread inbox (its
 * `UserDO`). Every list, get and mutation decides each repository freshly,
 * as feed reads do (`Visibility`): the credential verified again on the
 * directory's primary, each repository confirmed by its account's object,
 * the thread's kind readable by the token, and the thread's number still
 * naming its conversation (a restore can give it to another: that thread
 * is hidden and forgotten). Nothing of a thread the caller may not read
 * shows or changes; a hidden thread answers 404, as one that is not there.
 *
 * A list reads threads newest first and stops at the first one it may not
 * show or could not check: its cursor names the last readable thread it
 * passed, never one past a thread it may not read, so what a page says
 * never depends on threads the caller cannot read; threads of
 * repositories the principal itself cannot read are forgotten by the read
 * (as feed reads forget them), so they hold a list back only until then.
 * The token's repositories and kinds are applied in the query. Lists and
 * marking all read answer the principal's own credentials only: a
 * delegated token reads its user's inbox under its agents' owners' rights
 * too, which no query expresses (403 `delegated_listing`).
 */

/**
 * Rows one answer reads of the inbox at most (besides a few a stream when
 * a token names many repositories), and threads a read consumes at most.
 * Proposed.
 */
const SCAN = { threads: 1_000, page: 200 } as const;

/** Threads one bulk mark-read marks at most, and the streams it decides. Proposed. */
const MARK = { threads: 500, streams: 100 } as const;

/** Hooks into marking read, as its handler starts (after the request arrived). For tests. */
export const notificationHooks: { atHandler?: () => Promise<void> } = {};

/** What `participating` keeps: threads that name the caller. */
const PARTICIPATING = new Set([
  "review_requested",
  "mention",
  "team_mention",
  "assign",
  "author",
  "comment",
  "state_change",
]);

const READ = { issue: "issues:read", pull: "pull_requests:read" } as const;

const MARK_MESSAGE =
  "Marked up to 500 notifications read; repeat the request (with the same last_read_at, and a new Idempotency-Key or none) to mark more, until a list with all=false shows none left.";

type Thread = Output<typeof getNotificationThread>;

const inboxOf = (ctx: OpContext) => {
  ctx.metrics.count("do.request", { class: "UserDO", method: "inbox" });
  return ctx.env.USER.getByName(ctx.auth.principalId);
};

/** The kinds the token may read (its scopes; a delegated token's are its grant's). */
const kindsOf = (ctx: OpContext): SubjectKind[] =>
  (["issue", "pull"] as const).filter((kind) => scopesAllow(ctx.auth.scopes, READ[kind]));

/** A delegated token cannot list or mark all: see the top. */
function ownCredential(ctx: OpContext): void {
  if (ctx.auth.grantId !== null)
    throw new OperationError(
      403,
      "delegated_listing",
      "List and mark notifications with the user's own credentials.",
    );
}

const threadNotFound = () =>
  new OperationError(404, "thread_not_found", "No such notification thread.");

const time = (at: number | null) => (at === null ? null : new Date(at).toISOString());

function threadOutput(ctx: OpContext, thread: InboxThread, repo: RepoEntry): Thread {
  const repoUrl = `${ctx.requestOrigin}/api/repos/${repo.ownerHandle}/${repo.name}`;
  const url = `${ctx.requestOrigin}/api/notifications/threads/${thread.id}`;
  return {
    id: thread.id,
    repository: {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.ownerHandle}/${repo.name}`,
      private: repo.visibility !== "public",
      owner: { login: repo.ownerHandle },
    },
    subject: {
      title: thread.title,
      url: `${repoUrl}/${thread.subject === "pull" ? "pulls" : "issues"}/${thread.number}`,
      latest_comment_url: null,
      type: thread.subject === "pull" ? "PullRequest" : "Issue",
    },
    reason: thread.reason,
    unread: thread.unread,
    updated_at: new Date(thread.updatedAt).toISOString(),
    last_read_at: time(thread.lastReadAt),
    url,
    subscription_url: `${url}/subscription`,
  };
}

/** A thread as a check needs it (its conversation identified with its repository's check). */
const displayed = (thread: InboxThread) => ({
  repoId: thread.repoId,
  threadKey: `${thread.subject}/${thread.number}`,
  member: null,
  epoch: thread.epoch,
  conversation: thread.conversation,
});

/**
 * What `visibility` decided of `thread`: its repository when the caller may
 * see it, "hidden" (and, when its number names another conversation now,
 * noted to be forgotten), or undefined when not known.
 */
function judge(
  visibility: Visibility,
  thread: InboxThread,
  replaced: Map<string, number>,
): RepoEntry | "hidden" | undefined {
  const item = displayed(thread);
  const repo = visibility.of(item);
  if (repo === undefined || repo === "hidden") return repo;
  const now = visibility.identity(item.repoId, item.threadKey);
  if (now === undefined) return undefined;
  if (now.conversation !== thread.conversation) {
    replaced.set(thread.id, now.epoch);
    return "hidden";
  }
  return repo;
}

/** `thread` with its conversation's title as the repository answered it now. */
function titled(visibility: Visibility, thread: InboxThread): InboxThread {
  const now = visibility.identity(thread.repoId, `${thread.subject}/${thread.number}`);
  return now?.conversation === thread.conversation ? { ...thread, title: now.title } : thread;
}

/** Forgets what a read found the principal cannot read, and the threads found replaced. */
async function forget(
  ctx: OpContext,
  visibility: Visibility,
  replaced: Map<string, number>,
): Promise<void> {
  await visibility.forgetLost();
  const threads = [...replaced].map(([id, epoch]) => ({ id, epoch }));
  for (let i = 0; i < threads.length; i += 100)
    await inboxOf(ctx)
      .forgetInboxThreads(threads.slice(i, i + 100))
      .catch(() => undefined);
}

const decodeAfter = (cursor: string | undefined) => {
  if (cursor === undefined) return null;
  const name = decodeCursor(cursor, (n) => /^\d{1,16}:[A-Za-z0-9_-]{1,400}$/.test(n));
  const at = name.indexOf(":");
  return { updatedAt: Number(name.slice(0, at)), id: name.slice(at + 1) };
};

const parseTime = (at: string | undefined) => (at === undefined ? null : Date.parse(at));

/**
 * A page of the caller's threads (of `repo` alone when given, decided by
 * `visibility`), stopping at the first it may not show or could not check
 * (see the top).
 */
async function list(
  ctx: OpContext,
  input: Input<typeof listNotifications>,
  repo: RepoEntry | null,
  visibility = new Visibility(ctx),
): Promise<Output<typeof listNotifications>> {
  const replaced = new Map<string, number>();
  const subjects = kindsOf(ctx);
  const repoIds = repo ? [repo.id] : ctx.auth.repoIds;
  /** The readable threads passed, in order, with whether each is shown. */
  const passedThreads: { thread: InboxThread; shown: boolean }[] = [];
  let shownCount = 0;
  let after = decodeAfter(input.cursor);
  let ended = false;
  let read = 0;
  scan: while (read < SCAN.threads && shownCount < input.per_page) {
    const page = await inboxOf(ctx).inboxPage(
      {
        unreadOnly: !input.all,
        subjects,
        repoIds: repoIds === null ? null : [...repoIds].slice(0, 100),
        since: parseTime(input.since),
        before: parseTime(input.before),
        after,
        limit: SCAN.page,
      },
      SCAN.threads - read,
    );
    read += page.read;
    await visibility.decide(page.threads.map(displayed));
    for (const thread of page.threads) {
      const decided = judge(visibility, thread, replaced);
      if (decided === undefined || decided === "hidden") break scan;
      // Readable: the cursor may pass it, shown or left out by the request's own filters.
      const shown = thread.matches && (!input.participating || PARTICIPATING.has(thread.reason));
      passedThreads.push({ thread, shown });
      if (shown) shownCount++;
      if (shownCount >= input.per_page) break scan;
    }
    const last = page.threads.at(-1);
    if (page.ended) {
      ended = true;
      break;
    }
    if (!last) break;
    after = { updatedAt: last.updatedAt, id: last.id };
  }
  await forget(ctx, visibility, replaced);
  // Up to the first thread whose repository a later check of the answer no longer finds readable
  // (its ownership changed meanwhile, or its decision did): nothing past it is used.
  const cut = passedThreads.findIndex(
    ({ thread }) => typeof visibility.repository(thread.repoId) !== "object",
  );
  const kept = cut === -1 ? passedThreads : passedThreads.slice(0, cut);
  if (cut !== -1) ended = false;
  const last = kept.at(-1)?.thread;
  const passed = last ? { updatedAt: last.updatedAt, id: last.id } : null;
  return {
    notifications: kept
      .filter(({ shown }) => shown)
      .map(({ thread }) =>
        threadOutput(
          ctx,
          titled(visibility, thread),
          visibility.repository(thread.repoId) as RepoEntry,
        ),
      ),
    // None at the end, or when nothing readable was passed (see the top).
    next_cursor: ended || passed === null ? null : encodeCursor(`${passed.updatedAt}:${passed.id}`),
    delivery: await deliveryOf(ctx),
  };
}

/** The `notifications.list` operation. */
export async function listNotificationsOperation(
  ctx: OpContext,
  input: Input<typeof listNotifications>,
): Promise<Output<typeof listNotifications>> {
  ownCredential(ctx);
  return list(await freshly(ctx), input, null);
}

/**
 * A repository the caller names, decided freshly as every thread's is
 * (whatever the inbox holds of it): 404 when it is not there or the
 * caller cannot read it now; with the decision, for the rest of the call.
 */
async function namedRepo(
  ctx: OpContext,
  owner: string,
  name: string,
): Promise<{ repo: RepoEntry; visibility: Visibility }> {
  const notFound = new OperationError(
    404,
    "repo_not_found",
    `No repository ${owner}/${name} was found.`,
  );
  const entry = await resolveRepo(ctx.env, owner, name, { metrics: ctx.metrics });
  // The repository's own check first (one it already refuses is not there), then the fresh one.
  if (!entry || !(await authorize(ctx.env, ctx.auth, entry, "metadata:read", ctx.metrics)))
    throw notFound;
  const visibility = new Visibility(ctx);
  await visibility.decideStreams([{ repoId: entry.id, subject: "issue" }]);
  const decided = visibility.repository(entry.id);
  if (decided === undefined)
    throw new OperationError(503, "unavailable", "The repository could not be checked.");
  if (decided === false) {
    await visibility.forgetLost();
    throw notFound;
  }
  return { repo: decided, visibility };
}

/** The `notifications.repo_list` operation. */
export async function listRepoNotificationsOperation(
  ctx: OpContext,
  input: Input<typeof listRepoNotifications>,
): Promise<Output<typeof listRepoNotifications>> {
  ownCredential(ctx);
  ctx = await freshly(ctx);
  const { repo, visibility } = await namedRepo(ctx, input.owner, input.repo);
  return list(ctx, input, repo, visibility);
}

/** The caller's thread `id` and its repository, decided now; 404 when hidden or not there. */
async function visibleThread(
  ctx: OpContext,
  id: string,
): Promise<{ thread: InboxThread; repo: RepoEntry }> {
  if (!parseThreadId(id)) throw threadNotFound();
  const thread = await inboxOf(ctx).inboxThread(id);
  if (!thread || !kindsOf(ctx).includes(thread.subject)) throw threadNotFound();
  const visibility = new Visibility(ctx);
  const replaced = new Map<string, number>();
  await visibility.decide([displayed(thread)]);
  const decided = judge(visibility, thread, replaced);
  await forget(ctx, visibility, replaced);
  if (decided === undefined)
    throw new OperationError(503, "unavailable", "The thread's repository could not be checked.");
  if (decided === "hidden") throw threadNotFound();
  return { thread: titled(visibility, thread), repo: decided };
}

/** The `notifications.thread_get` operation. */
export async function getNotificationThreadOperation(
  ctx: OpContext,
  input: Input<typeof getNotificationThread>,
): Promise<Output<typeof getNotificationThread>> {
  ctx = await freshly(ctx);
  const { thread, repo } = await visibleThread(ctx, input.thread_id);
  return threadOutput(ctx, thread, repo);
}

/** The `notifications.thread_read` operation. */
export async function markNotificationThreadReadOperation(
  ctx: OpContext,
  input: Input<typeof markNotificationThreadRead>,
): Promise<Output<typeof markNotificationThreadRead>> {
  ctx = await freshly(ctx);
  await visibleThread(ctx, input.thread_id);
  if (!(await inboxOf(ctx).markInboxThread(input.thread_id, false))) throw threadNotFound();
  return null;
}

/** The `notifications.thread_done` operation. */
export async function markNotificationThreadDoneOperation(
  ctx: OpContext,
  input: Input<typeof markNotificationThreadDone>,
): Promise<Output<typeof markNotificationThreadDone>> {
  ctx = await freshly(ctx);
  await visibleThread(ctx, input.thread_id);
  if (!(await inboxOf(ctx).markInboxThread(input.thread_id, true))) throw threadNotFound();
  return null;
}

/**
 * Marks read the threads of the streams (of `repo` alone when given) the
 * caller may read, decided now, up to the cutoff (see `MARK`).
 */
async function markRead(
  ctx: OpContext,
  lastReadAt: string | undefined,
  /** When the request arrived: nothing updated after it is marked. */
  started: number,
  repo: RepoEntry | null,
  visibility = new Visibility(ctx),
): Promise<{ message: string }> {
  const cutoff = Math.min(parseTime(lastReadAt) ?? started, started);
  const inbox = inboxOf(ctx);
  const repoIds = repo ? [repo.id] : ctx.auth.repoIds;
  const streams = await inbox.inboxUnreadStreams(
    cutoff,
    kindsOf(ctx),
    repoIds === null ? null : [...repoIds],
    MARK.streams,
  );
  await visibility.decideStreams(streams);
  const readable = streams.filter((stream) => visibility.readable(stream) === true);
  if (readable.length > 0) await inbox.markInboxReadBefore(readable, cutoff, MARK.threads);
  await visibility.forgetLost();
  return { message: MARK_MESSAGE };
}

/** The `notifications.mark` operation. */
export async function markNotificationsReadOperation(
  ctx: OpContext,
  input: Input<typeof markNotificationsRead>,
): Promise<Output<typeof markNotificationsRead>> {
  await notificationHooks.atHandler?.();
  const started = ctx.receivedAt ?? Date.now();
  ownCredential(ctx);
  if (input.read === false)
    throw new OperationError(422, "unsupported", "Marking notifications unread is not supported.");
  return markRead(await freshly(ctx), input.last_read_at, started, null);
}

/** The `notifications.repo_mark` operation. */
export async function markRepoNotificationsReadOperation(
  ctx: OpContext,
  input: Input<typeof markRepoNotificationsRead>,
): Promise<Output<typeof markRepoNotificationsRead>> {
  await notificationHooks.atHandler?.();
  const started = ctx.receivedAt ?? Date.now();
  ownCredential(ctx);
  ctx = await freshly(ctx);
  const { repo, visibility } = await namedRepo(ctx, input.owner, input.repo);
  return markRead(ctx, input.last_read_at, started, repo, visibility);
}

type ThreadSubscription = Output<typeof getNotificationThreadSubscription>;

function subscriptionOutput(
  ctx: OpContext,
  thread: InboxThread,
  repo: RepoEntry,
  row: ThreadRow | null,
): ThreadSubscription {
  const url = `${ctx.requestOrigin}/api/notifications/threads/${thread.id}`;
  return {
    subscribed: row?.state === "subscribed",
    ignored: row?.state === "unsubscribed",
    reason: null,
    created_at: row ? new Date(row.at).toISOString() : null,
    url: `${url}/subscription`,
    thread_url: url,
    repository_url: `${ctx.requestOrigin}/api/repos/${repo.ownerHandle}/${repo.name}`,
  };
}

/** The `notifications.subscription_get` operation. */
export async function getNotificationThreadSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof getNotificationThreadSubscription>,
): Promise<Output<typeof getNotificationThreadSubscription>> {
  ctx = await freshly(ctx);
  const { thread, repo } = await visibleThread(ctx, input.thread_id);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "threadPreference" });
  const answer = await ctx.env.REPO.getByName(repo.id).threadPreference(
    ctx.auth.principalId,
    thread.number,
    [thread.subject],
    thread.conversation,
  );
  if (answer.status === "recovering") throw recovering();
  if (answer.status !== "ok") throw threadNotFound();
  return subscriptionOutput(ctx, thread, repo, (answer.row as ThreadRow | null) ?? null);
}

/** Sets the caller's preference for the thread's conversation, then its copy. */
async function setPreference(
  ctx: OpContext,
  id: string,
  state: ThreadState | null,
): Promise<{ thread: InboxThread; repo: RepoEntry; row: ThreadRow }> {
  ctx = await freshly(ctx);
  const { thread, repo } = await visibleThread(ctx, id);
  ctx.metrics.count("do.request", { class: "RepoDO", method: "setThreadPreference" });
  const answer = await ctx.env.REPO.getByName(repo.id).setThreadPreference(
    ctx.auth.principalId,
    ctx.auth.grantId,
    thread.number,
    [thread.subject],
    state,
    thread.conversation,
  );
  if (answer.status === "recovering") throw recovering();
  if (answer.status === "full")
    throw new OperationError(
      409,
      answer.cap === "kind" ? "thread_subscriptions_full" : "thread_subscribers_full",
      "This conversation, or your preferences of its kind, are at their cap (1,000).",
    );
  if (answer.status !== "set") throw threadNotFound();
  const row = answer.row as ThreadRow;
  await copyThread(ctx, repo.id, row);
  return { thread, repo, row };
}

/** The `notifications.subscription_put` operation. */
export async function setNotificationThreadSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof setNotificationThreadSubscription>,
): Promise<Output<typeof setNotificationThreadSubscription>> {
  const { thread, repo, row } = await setPreference(
    ctx,
    input.thread_id,
    input.ignored ? "unsubscribed" : "subscribed",
  );
  return subscriptionOutput(ctx, thread, repo, row);
}

/** The `notifications.subscription_delete` operation. */
export async function deleteNotificationThreadSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof deleteNotificationThreadSubscription>,
): Promise<Output<typeof deleteNotificationThreadSubscription>> {
  await setPreference(ctx, input.thread_id, null);
  return null;
}
