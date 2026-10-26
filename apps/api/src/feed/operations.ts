import type { ackFeedItem, getFeed, Input, Output, syncFeed } from "@fyrden/api-contract";
import type { RepoPermission } from "@fyrden/domain";
import {
  FEED_KINDS,
  FEED_SUBJECT_KINDS,
  type FeedKind,
  type FeedSubjectKind,
  feedItemKey,
  type RepoRole,
  scopesAllow,
} from "@fyrden/domain";
import { type FeedMember, type FeedViewDenial, memberKey } from "../do/repo/feed-view.js";
import {
  FEED_POLICY,
  type FeedFilter,
  type FeedItem,
  type FeedItemId,
  type FeedPosition,
  type SyncPosition,
} from "../do/user/feed.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError, reverified } from "../ops/execute.js";
import { allowedWithRole, findReposById, type RepoEntry } from "../repos/directory.js";
import { FreshAccess, type FreshDecision } from "./access.js";

/*
 * The activity feed's operations. A feed belongs to a principal id: the
 * token's principal, which is the agent for an agent's own token and the
 * user for a delegated token (whichever agent of the chain holds it) or a
 * signed-in session. Every item is checked again when read: its
 * repository must exist and the caller (with its token's limits, a
 * delegated token's grant included, and its agents' owners' rights) must
 * read the item's kind now (its issues for an issue's thread, its pull
 * requests for a pull request's), and the thread must not be gone for
 * good (a deleted issue's, which the read makes the feed forget). Items it
 * may not read are skipped, and
 * nothing says how many: a cursor only ever names an item the caller was
 * shown (or where it started), so it tells nothing of the others, and an
 * answer changes only when what the caller may see does. Items hold ids:
 * what the member an item displays says (a comment, a review, the pull
 * request's body) is read from the repository with the check, so an edit
 * shows at once and a deletion leaves no excerpt. A check that
 * could not be made, or one past the answer's budget, ends the answer
 * there (the cursor never passes an item not checked).
 *
 * The checks are fresh: the caller's credential is verified again on the
 * directory's primary before anything of the feed is read (a revocation,
 * or a DPoP proof newly required, shows at once, whatever the feed holds),
 * and each repository the repository's own (cached) check lets the caller
 * read is confirmed by its account's object (`FreshAccess`), under the
 * ownership the repository judged under; whatever its later answers say
 * (excerpts, threads) is used only while judged under that same ownership.
 * A fresh denial hides the items; it never makes the feed forget them.
 *
 * A check that finds the feed's owner itself cannot read a repository (it
 * is gone, or the owner's own access says so by an ACL snapshot the
 * repository decided with; not a token's limits, nor a check that could
 * not be sure) makes the feed forget that repository's items, as losing
 * access does, up to when that snapshot was pulled and never past a newer
 * one (see `Feed.purge`): so however many such items come first, the next
 * answer gets past them, and no cursor ever names one. An answer that
 * stopped short on them looks like one that found nothing new: only a
 * full page asks to read on at once (`poll_after_ms` 0).
 */

/**
 * How long a caller that reached the head waits before polling again:
 * `baseMs` after an answer that showed something (or a sync), doubling
 * with each answer in a row that showed nothing, up to `maxMs`. Every poll
 * is a request to the feed's object, so a quiet feed costs about 53 a day
 * rather than 2,880 (docs/operations/limits.md). Proposed.
 */
export const FEED_POLL = { baseMs: 30_000, maxMs: 30 * 60_000 } as const;

/** Quiet answers in a row a cursor counts at most: from there on the wait is the ceiling. */
const QUIET_MAX = Math.ceil(Math.log2(FEED_POLL.maxMs / FEED_POLL.baseMs));

/** The wait after `quiet` answers in a row that showed nothing. */
const pollAfter = (quiet: number) => Math.min(FEED_POLL.baseMs * 2 ** quiet, FEED_POLL.maxMs);

/** Where a client whose cursor expired starts over. */
const RESYNC = "/api/feed/sync";

/** The permission an item's repository must grant the caller now, by what its thread is about. */
const READ = { issue: "issues:read", pull: "pull_requests:read" } as const;

/** What a thread key's thread is about (`issue/7`, `pull/12`); undefined for any other key. */
function subjectOf(threadKey: string): FeedSubjectKind | undefined {
  const kind = /^(issue|pull)\/[1-9][0-9]*$/.exec(threadKey)?.[1];
  return kind as FeedSubjectKind | undefined;
}

/**
 * The kinds of thread the caller's token may ever read (its scopes; a
 * delegated token's are its grant's), null for both: its feed is read
 * without the others, so they cost no budget and show nowhere.
 */
function readableSubjects(ctx: OpContext): FeedSubjectKind[] | null {
  const kinds = FEED_SUBJECT_KINDS.filter((kind) => scopesAllow(ctx.auth.scopes, READ[kind]));
  return kinds.length === FEED_SUBJECT_KINDS.length ? null : kinds;
}

/**
 * Repositories one answer checks with their objects at most (one call
 * each, of the 1,000 an invocation may make), calls checking issue threads
 * beyond those (a hundred threads each), items it reads from the feed at
 * most, shown or not, and how many a read takes. Proposed.
 */
const SCAN = { repoChecks: 100, threadChecks: 20, items: 1_000, page: 200 } as const;

/** Members one repository call reads at most. */
const VIEW_MEMBERS = 100;

const viewOf = (env: Env, repoId: string) => env.REPO.getByName(repoId);

/**
 * A feed cursor: `base64url({v:1,e,s,q})`, an epoch and a sequence number,
 * and how many answers in a row before it showed nothing (`q`, left out
 * for none), opaque to clients. The count makes the wait between polls
 * grow without anything stored per poll; it stops at its ceiling, so a
 * quiet feed's answer then stays the same, and its ETag with it.
 */
export function encodeFeedCursor(position: FeedPosition, quiet = 0): string {
  const cursor = { v: 1, e: position.epoch, s: position.seq, ...(quiet > 0 && { q: quiet }) };
  return encodeBytesCursor(new TextEncoder().encode(JSON.stringify(cursor)));
}

/** What a feed cursor names (null without one); any other cursor is refused. */
export function decodeFeedCursor(
  cursor: string | undefined,
): (FeedPosition & { readonly quiet: number }) | null {
  if (cursor === undefined) return null;
  const bytes = decodeBytesCursor(cursor);
  let value: unknown;
  try {
    value =
      bytes && JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw invalidCursor();
  }
  const {
    v,
    e,
    s,
    q = 0,
  } = (value ?? {}) as { v?: unknown; e?: unknown; s?: unknown; q?: unknown };
  if (
    v !== 1 ||
    typeof e !== "string" ||
    e.length > 64 ||
    typeof s !== "number" ||
    !Number.isSafeInteger(s) ||
    s < 0 ||
    typeof q !== "number" ||
    !Number.isSafeInteger(q) ||
    q < 0 ||
    q > QUIET_MAX
  )
    throw invalidCursor();
  return { epoch: e, seq: s, quiet: q };
}

type FeedItemOutput = Output<typeof getFeed>["items"][number];

/**
 * `ctx` with its credential as the directory's primary has it now, before
 * anything of the feed is read (whether activity arrived never shows to a
 * credential revoked meanwhile); a refusal answers 401.
 */
async function freshly(ctx: OpContext): Promise<OpContext> {
  const fresh = await reverified(ctx);
  if (!fresh.ok) throw new OperationError(401, fresh.code, fresh.detail);
  return {
    ...ctx,
    auth: fresh.record,
    authState: { ...ctx.authState, record: fresh.record, mode: "write" },
  };
}

/** The caller's feed: its token's principal's object. */
const feedOf = (ctx: OpContext) => ctx.env.USER.getByName(ctx.auth.principalId);

const counted = (ctx: OpContext, method: string) =>
  ctx.metrics.count("do.request", { class: "UserDO", method });

/** An item as a check needs it: its repository, its thread, and the member it displays. */
type Displayed = Pick<FeedItem, "repoId" | "threadKey" | "member" | "epoch">;

/**
 * What the caller may see of a feed's items, decided once per repository
 * within one answer, and what the members they display say.
 */
class Visibility {
  readonly #decided = new Map<
    string,
    { entry: RepoEntry; role: RepoRole | null } | "denied" | "unknown"
  >();
  /** Issue threads checked (`<repository>\n<thread>`), and those found gone for good. */
  readonly #checkedThreads = new Set<string>();
  /** Threads found gone for good, with the repository's restore generation they were found in. */
  readonly #gone = new Map<string, number>();
  readonly #excerpts = new Map<string, string | null>();
  /** Repositories the feed's owner itself cannot read: gone, or its access says so, as of when. */
  readonly #lost = new Map<string, Extract<FeedViewDenial, { kind: "lost" }>["loss"]>();
  #checks = 0;
  #threadChecks = 0;
  /** The authoritative check, beside the repositories' own (see `decide`). */
  readonly #fresh: FreshAccess;
  /**
   * The ownership each repository shown was decided under: every later
   * answer of its (excerpts, threads) must be judged under it too.
   */
  readonly #pinned = new Map<string, { readonly accountId: string; readonly ownerGen: number }>();

  constructor(private readonly ctx: OpContext) {
    this.#fresh = new FreshAccess(ctx, ctx.auth);
  }

  /**
   * Decides the repositories of `items` not decided yet, within the budget
   * of checks, reading what their members say at the same time.
   */
  async decide(items: readonly Displayed[]): Promise<void> {
    const { env, auth, metrics } = this.ctx;
    const members = new Map<string, Map<string, FeedMember>>();
    const threads = new Map<string, Set<string>>();
    for (const { repoId, threadKey, member, epoch } of items) {
      // Only an issue's thread can be gone for good: each is checked, whenever it first shows.
      if (subjectOf(threadKey) === "issue" && !this.#checkedThreads.has(key(repoId, threadKey)))
        threads.set(repoId, (threads.get(repoId) ?? new Set()).add(threadKey));
      if (this.#decided.has(repoId)) continue;
      const set = members.get(repoId) ?? new Map<string, FeedMember>();
      members.set(repoId, set);
      if (member !== null && set.size < VIEW_MEMBERS) {
        const named = { epoch, thread: threadKey, member };
        set.set(memberKey(named), named);
      }
    }
    if (members.size === 0) {
      await this.#checkThreads(threads);
      return;
    }
    const entries = new Map(
      (await findReposById(env, [...members.keys()], metrics)).map((e) => [e.id, e]),
    );
    const read = Date.now();
    const checking: RepoEntry[] = [];
    for (const id of members.keys()) {
      const entry = entries.get(id);
      // Gone, or outside the token's own limits for every kind: no call needed.
      if (
        !entry ||
        !(Object.values(READ) as RepoPermission[]).some((p) =>
          allowedWithRole(auth, entry, p, "admin"),
        )
      ) {
        this.#decided.set(id, "denied");
        if (!entry) this.#lost.set(id, { accountId: "", epochGen: 0, aclVersion: 0, until: read });
      } else if (this.#checks < SCAN.repoChecks) {
        this.#checks++;
        checking.push(entry);
      }
    }
    // The authoritative check of the same repositories, beside theirs (whose snapshots a lost
    // invalidation may have left standing): an item shows only when both allow it.
    const freshly = this.#fresh.decide(checking);
    await Promise.all(
      checking.map(async (entry) => {
        const asked = [...(threads.get(entry.id) ?? [])].slice(0, VIEW_MEMBERS);
        const view = await this.#view(
          entry.id,
          [...(members.get(entry.id)?.values() ?? [])],
          asked,
        ).catch(() => undefined);
        const fresh = (await freshly).get(entry.id) ?? "unknown";
        // A readable answer without its generation (an earlier object, while a deploy rolls out)
        // cannot place its gone threads against the items' generations: they stay unchecked.
        if (view?.readable && Number.isSafeInteger(view.epoch))
          this.#threadsChecked(entry.id, asked, view.gone, view.epoch);
        const decided =
          // No answer, or a denial the repository could not be sure of: not checked.
          view === undefined || view.denial?.kind === "unknown"
            ? "unknown"
            : view.readable
              ? both(entry, view.account?.accountId, fresh)
              : "denied";
        this.#decided.set(entry.id, decided);
        if (typeof decided === "object" && view?.account) this.#pinned.set(entry.id, view.account);
        // Lost to the owner itself; under a grant, its acting agents' owners' rights capped the
        // answer too, so it says nothing of the owner's own.
        if (view?.denial?.kind === "lost" && auth.grantId === null)
          this.#lost.set(entry.id, view.denial.loss);
      }),
    );
    await this.#checkThreads(threads);
  }

  /**
   * Checks the issue threads of readable repositories not checked yet, a
   * call per hundred, within the budget of checks; a thread left unchecked
   * stops an answer at it (see `of`).
   */
  async #checkThreads(threads: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> {
    const calls: Promise<void>[] = [];
    for (const [repoId, set] of threads) {
      if (typeof this.#decided.get(repoId) !== "object") continue;
      const unchecked = [...set].filter((t) => !this.#checkedThreads.has(key(repoId, t)));
      for (
        let i = 0;
        i < unchecked.length && this.#threadChecks < SCAN.threadChecks;
        i += VIEW_MEMBERS
      ) {
        this.#threadChecks++;
        const batch = unchecked.slice(i, i + VIEW_MEMBERS);
        calls.push(
          this.#view(repoId, [], batch).then(
            (view) => {
              // Only a readable answer checked the threads. One saying the repository cannot be
              // read now decides it, as its first check would have; one unsure leaves them
              // unchecked (an answer stops at them).
              if (view.readable) {
                // Without its generation (an earlier object): left unchecked.
                if (Number.isSafeInteger(view.epoch))
                  this.#threadsChecked(repoId, batch, view.gone, view.epoch);
              } else if (view.denial?.kind !== "unknown") {
                this.#decided.set(repoId, "denied");
                if (view.denial?.kind === "lost" && this.ctx.auth.grantId === null)
                  this.#lost.set(repoId, view.denial.loss);
              }
            },
            () => undefined,
          ),
        );
      }
    }
    await Promise.all(calls);
  }

  #threadsChecked(
    repoId: string,
    asked: readonly string[],
    gone: readonly string[],
    epoch: number,
  ): void {
    for (const thread of asked) this.#checkedThreads.add(key(repoId, thread));
    for (const thread of gone) this.#gone.set(key(repoId, thread), epoch);
  }

  /**
   * Makes the feed forget the repositories decided its owner cannot read
   * now, and the threads found gone for good (a call each, when any).
   */
  async forgetLost(): Promise<void> {
    const feed = this.ctx.env.USER.getByName(this.ctx.auth.principalId);
    if (this.#gone.size > 0) {
      this.ctx.metrics.count("do.request", { class: "UserDO", method: "forgetGoneThreads" });
      // An earlier object has no such method (while a deploy rolls out): nothing is forgotten,
      // and a later read forgets them; never through the earlier method, which has no fence.
      await feed
        .forgetGoneThreads(
          [...this.#gone].map(([k, epoch]) => {
            const [repoId, threadKey] = k.split("\n") as [string, string];
            return { repoId, threadKey, epoch };
          }),
        )
        .catch(() => undefined);
    }
    if (this.#lost.size === 0) return;
    this.ctx.metrics.count("do.request", { class: "UserDO", method: "forgetRepos" });
    await feed.forgetRepos(
      [...this.#lost].map(([repoId, loss]) => ({ ...loss, repoIds: [repoId] })),
    );
  }

  /** Reads what the members of `items` not read with their repository's check say. */
  async read(items: readonly Displayed[]): Promise<void> {
    const missing = new Map<string, Map<string, FeedMember>>();
    for (const { repoId, threadKey, member, epoch } of items) {
      if (member === null) continue;
      const named = { epoch, thread: threadKey, member };
      if (this.#excerpts.has(key(repoId, memberKey(named)))) continue;
      missing.set(
        repoId,
        (missing.get(repoId) ?? new Map<string, FeedMember>()).set(memberKey(named), named),
      );
    }
    const calls = [...missing].flatMap(([repoId, set]) => {
      const all = [...set.values()];
      return Array.from({ length: Math.ceil(all.length / VIEW_MEMBERS) }, (_, i) =>
        this.#view(repoId, all.slice(i * VIEW_MEMBERS, (i + 1) * VIEW_MEMBERS)),
      );
    });
    // Their repositories were checked already: a failed read leaves those excerpts null.
    await Promise.allSettled(calls);
  }

  async #view(repoId: string, members: readonly FeedMember[], threads: readonly string[] = []) {
    const { env, auth, metrics } = this.ctx;
    metrics.count("do.request", { class: "RepoDO", method: "feedView" });
    let view = await viewOf(env, repoId).feedView(auth.principalId, auth.grantId, members, threads);
    const pinned = this.#pinned.get(repoId);
    if (
      pinned &&
      view.readable &&
      (view.account?.accountId !== pinned.accountId || view.account.ownerGen !== pinned.ownerGen)
    ) {
      // Read under another ownership than the one decided (a transfer since): nothing of it is
      // used, and the repository is not known any more (an answer stops at its items).
      this.#decided.set(repoId, "unknown");
      view = { ...view, readable: false, excerpts: {}, gone: [], denial: { kind: "unknown" } };
    }
    for (const member of members) {
      const at = memberKey(member);
      this.#excerpts.set(key(repoId, at), view.excerpts[at] ?? null);
    }
    return view;
  }

  /**
   * The item's repository when the caller may see the item: it reads the
   * repository and the item's kind there, and the thread is not gone;
   * undefined when unknown (not checked).
   */
  of(item: Pick<Displayed, "repoId" | "threadKey" | "epoch">): RepoEntry | "hidden" | undefined {
    const decided = this.#decided.get(item.repoId);
    if (decided === undefined || decided === "unknown") return undefined;
    const subject = subjectOf(item.threadKey);
    if (decided === "denied" || subject === undefined) return "hidden";
    const thread = key(item.repoId, item.threadKey);
    // An issue's thread not checked (past the budget): not known whether it is gone.
    if (subject === "issue" && !this.#checkedThreads.has(thread)) return undefined;
    // Gone in the generation it was checked in: an item told in a later one (a restore gave its
    // number to a new conversation) is not known yet, so the scan stops before it.
    const goneIn = this.#gone.get(thread);
    if (goneIn !== undefined) return item.epoch > goneIn ? undefined : "hidden";
    return allowedWithRole(this.ctx.auth, decided.entry, READ[subject], decided.role)
      ? decided.entry
      : "hidden";
  }

  /**
   * `shown` up to its first item whose repository is no longer known to be
   * readable (reading its members found its ownership changed).
   */
  stillShown(shown: Scanned): Scanned {
    const end = shown.findIndex(({ item }) => typeof this.#decided.get(item.repoId) !== "object");
    return end === -1 ? shown : shown.slice(0, end);
  }

  /** What the item's member says; null for none, or one that is gone. */
  excerpt(item: Displayed): string | null {
    return item.member === null
      ? null
      : (this.#excerpts.get(
          key(
            item.repoId,
            memberKey({ epoch: item.epoch, thread: item.threadKey, member: item.member }),
          ),
        ) ?? null);
  }
}

const key = (repoId: string, member: string) => `${repoId}\n${member}`;

/**
 * A repository its own check let the reader read, as the authoritative one
 * decides it: unknown when that one could not answer, or answered for
 * another account than the repository judged under (a transfer between
 * them, or an earlier object naming none); denied when that account let it
 * go (a transfer), public or not; else read with the fresh role (a public
 * repository without one, as `read`: the token's limits still apply), or
 * denied (never forgotten for it: see `forgetLost`).
 */
function both(
  entry: RepoEntry,
  judgedUnder: string | undefined,
  fresh: FreshDecision,
): { entry: RepoEntry; role: RepoRole } | "denied" | "unknown" {
  if (fresh === "unknown" || judgedUnder !== fresh.accountId) return "unknown";
  if (!fresh.held) return "denied";
  if (fresh.role !== null) return { entry, role: fresh.role };
  return entry.visibility === "public" ? { entry, role: "read" } : "denied";
}

/** Items shown, in order, up to and past `limit` (one more tells that more follow). */
type Scanned = { item: FeedItem; repo: RepoEntry }[];

/**
 * Reads items with `read` until `limit` and one more are shown, the feed
 * ends, or the answer's budget does; stops at an item it could not check.
 * `more`: the feed may have more the caller can see.
 */
async function scan<P>(
  visibility: Visibility,
  limit: number,
  read: (after: P | null) => Promise<{ items: readonly FeedItem[]; more: boolean }>,
  position: (item: FeedItem) => P,
): Promise<{ shown: Scanned; more: boolean }> {
  const shown: Scanned = [];
  let after: P | null = null;
  for (let scanned = 0; scanned < SCAN.items; ) {
    const page = await read(after);
    await visibility.decide(page.items);
    for (const item of page.items) {
      const repo = visibility.of(item);
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

function itemOutput(item: FeedItem, repo: RepoEntry, excerpt: string | null): FeedItemOutput {
  return {
    item_key: feedItemKey(item.repoId, item.threadKey, item.kind),
    repo: { id: repo.id, full_name: `${repo.ownerHandle}/${repo.name}` },
    thread_key: item.threadKey,
    kind: item.kind,
    // Shown items have a thread of a known kind (`of` hides any other).
    subject: {
      kind: subjectOf(item.threadKey) as FeedSubjectKind,
      number: item.number,
      title: item.title,
    },
    epoch: item.epoch,
    version: item.version,
    state: item.state,
    priority: item.priority,
    reasons: [...item.reasons],
    silent: item.silent,
    action: item.action,
    actor: item.actor,
    actor_trust: item.actorTrust,
    excerpt,
    members: [...item.members],
    members_truncated: item.truncated,
    event_at: item.eventAt,
    acked_epoch: item.ackedEpoch,
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
  ctx = await freshly(ctx);
  const feed = feedOf(ctx);
  const since = decodeFeedCursor(input.since);
  const start = since && { epoch: since.epoch, seq: since.seq };
  const filter: FeedFilter = {
    priority: input.priority,
    kind: input.kind,
    repoIds: ctx.auth.repoIds,
    subjects: readableSubjects(ctx),
  };
  let epoch = since?.epoch;
  let lowWatermark = 0;
  const visibility = new Visibility(ctx);
  const { shown } = await scan(
    visibility,
    input.limit,
    async (after: FeedPosition | null) => {
      counted(ctx, "listFeed");
      const page = await feed.listFeed(after ?? start, SCAN.page, filter);
      if (page.expired) throw expired();
      epoch = page.head.epoch;
      lowWatermark = page.lowWatermark;
      return page;
    },
    (item) => ({ epoch: epoch as string, seq: item.seq }),
  );
  const read = shown.slice(0, input.limit);
  await Promise.all([visibility.read(read.map(({ item }) => item)), visibility.forgetLost()]);
  // Up to an item whose repository reading its members made unknown (its ownership changed).
  const page = visibility.stillShown(read);
  const cut = page.length < read.length;
  // An answer that shows nothing is one more quiet one in a row, whatever it did not show.
  const quiet = page.length > 0 ? 0 : Math.min((since?.quiet ?? 0) + 1, QUIET_MAX);
  // Positions of items shown only (where the caller started when none was), never below the
  // low watermark: what retention deleted is gone for every reader, and such a cursor would
  // only be refused.
  const at = (item: FeedItem | undefined) =>
    encodeFeedCursor(
      { epoch: epoch as string, seq: Math.max(lowWatermark, item?.seq ?? since?.seq ?? 0) },
      quiet,
    );
  return {
    items: page.map(({ item, repo }) => itemOutput(item, repo, visibility.excerpt(item))),
    next_cursor: at(page.at(-1)?.item),
    // Never past an item not shown for want of a check.
    head_cursor: at((cut ? page : shown).at(-1)?.item),
    // Read on at once only after a full page: what the caller sees says so, never what it
    // does not (see the top).
    poll_after_ms: page.length === input.limit ? 0 : pollAfter(quiet),
  };
}

/** The `feed.sync` operation. */
export async function syncFeedOperation(ctx: OpContext): Promise<Output<typeof syncFeed>> {
  ctx = await freshly(ctx);
  const feed = feedOf(ctx);
  let epoch = "";
  let lowWatermark = 0;
  const visibility = new Visibility(ctx);
  const { shown, more: scanned } = await scan(
    visibility,
    FEED_POLICY.syncItems,
    async (after: SyncPosition | null) => {
      counted(ctx, "syncFeed");
      const page = await feed.syncFeed(after, SCAN.page, {
        repoIds: ctx.auth.repoIds,
        subjects: readableSubjects(ctx),
      });
      epoch = page.epoch;
      lowWatermark = page.lowWatermark;
      return page;
    },
    (item) => ({ open: item.priority === "P0" && item.state === "open", seq: item.seq }),
  );
  const read = shown.slice(0, FEED_POLICY.syncItems);
  await Promise.all([visibility.read(read.map(({ item }) => item)), visibility.forgetLost()]);
  // Up to an item whose repository reading its members made unknown (its ownership changed): an
  // incomplete sync, as one its scan stopped.
  const items = visibility.stillShown(read);
  const more = scanned || items.length < read.length;
  // Following from the greatest item shown misses no change the caller may see; an incomplete
  // sync follows from the start. Never below the low watermark: what retention deleted is gone
  // for every reader, so such a cursor would only be refused.
  const seq = Math.max(lowWatermark, more ? 0 : Math.max(0, ...items.map(({ item }) => item.seq)));
  return {
    items: items.map(({ item, repo }) => itemOutput(item, repo, visibility.excerpt(item))),
    complete: !more,
    head_cursor: encodeFeedCursor({ epoch, seq }),
    poll_after_ms: FEED_POLL.baseMs,
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
  ctx = await freshly(ctx);
  const notFound = new OperationError(404, "feed_item_not_found", "The feed has no such item.");
  const id = parseItemKey(input.item_key);
  if (!id) throw notFound;
  const visibility = new Visibility(ctx);
  await visibility.decide([
    { repoId: id.repoId, threadKey: id.threadKey, member: null, epoch: input.epoch },
  ]);
  const repo = visibility.of({ ...id, epoch: input.epoch });
  if (repo === undefined) throw new Error("the repository's access could not be checked");
  if (repo === "hidden") throw notFound;
  counted(ctx, "ackFeed");
  const acked = await feedOf(ctx).ackFeed(id, { epoch: input.epoch, version: input.version });
  if (acked.status === "missing") throw notFound;
  if (acked.status === "ahead")
    throw new OperationError(
      409,
      "version_ahead",
      "The item has no such version yet: acknowledge a version it has.",
    );
  return {
    item_key: input.item_key,
    epoch: acked.item.epoch,
    version: acked.item.version,
    acked_epoch: acked.item.ackedEpoch,
    acked_version: acked.item.ackedVersion,
  };
}
