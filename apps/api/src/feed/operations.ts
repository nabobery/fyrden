import type {
  ackFeedItem,
  getFeed,
  getFeedDigest,
  Input,
  Output,
  syncFeed,
} from "@fyrden/api-contract";
import type { RepoPermission } from "@fyrden/domain";
import {
  digestThreadKey,
  FEED_KINDS,
  FEED_SUBJECT_KINDS,
  type FeedKind,
  type FeedSubjectKind,
  type FeedThread,
  feedItemKey,
  parseThreadKey,
  type RepoRole,
  scopesAllow,
} from "@fyrden/domain";
import { GHOST_LOGIN, SHOWN_HANDLE } from "../accounts/handles.js";
import { DIGEST_POLICY } from "../do/repo/digests.js";
import { type FeedMember, type FeedViewDenial, memberKey } from "../do/repo/feed-view.js";
import {
  type CursorRef,
  FEED_POLICY,
  type FeedFilter,
  type FeedItem,
  type FeedItemId,
  MAX_GONE_THREADS,
  PURGE_REPOS,
  type SnapshotState,
  type StreamKey,
  type StreamPosition,
} from "../do/user/feed.js";
import { deliveryState } from "../effects/discretionary.js";
import { DEFAULT_ORG_SHARD, readModelFor } from "../events/read-model.js";
import { decodeBytesCursor, encodeBytesCursor, invalidCursor } from "../ops/cursor.js";
import { type OpContext, OperationError, reverified } from "../ops/execute.js";
import { allowedWithRole, findReposById, type RepoEntry } from "../repos/directory.js";
import { recovering } from "../repos/watching.js";
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
 * A cursor names a snapshot the feed keeps for the credential: its
 * positions in the streams (a repository's issue threads, or its pull
 * requests') it was given items of, each moved only by what an answer
 * gave. So nothing the caller may not read moves, expires or evicts
 * anything of its cursor, and an answer that gives nothing names the same
 * snapshot (its ETag stays). A cursor whose position in a stream the
 * caller may read is behind what retention or the stream's cap deleted
 * is expired; one behind only in streams it may not read is not.
 * Hidden items are read again by every answer until they go (an answer
 * checks 100 repositories at most): many of them ahead of the caller's
 * can delay those, a residual left for the inbox.
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

/**
 * What a thread key's thread is about (`issue/7`, `pull/12`, a kind's
 * digest); undefined for any other key.
 */
function subjectOf(threadKey: string): FeedSubjectKind | undefined {
  return parseThreadKey(threadKey)?.subject;
}

/** Whether a thread key names a digest. */
function isDigest(threadKey: string): boolean {
  const named = parseThreadKey(threadKey);
  return named !== undefined && "digest" in named;
}

/**
 * Whether a thread can be gone for good, so its repository checks it when
 * it shows: an issue's (deleted), or a digest's (its conversations all
 * deleted, another generation's, or expired).
 */
function checked(threadKey: string): boolean {
  const named = parseThreadKey(threadKey);
  return named !== undefined && ("digest" in named || named.subject === "issue");
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
 * A feed cursor: `base64url({v:2,e,i,q})`, the feed's epoch and its
 * snapshot's id, and how many answers in a row before it showed nothing
 * (`q`, left out for none), opaque to clients. The count makes the wait
 * between polls grow without anything stored per poll; it stops at its
 * ceiling, so a quiet feed's answer then stays the same, and its ETag with
 * it. A cursor of before streams, `{v:1,e,s,q}`, named a sequence number
 * of the whole feed: still read, as every stream at it.
 */
export function encodeFeedCursor(epoch: string, id: string, quiet = 0): string {
  const cursor = { v: 2, e: epoch, i: id, ...(quiet > 0 && { q: quiet }) };
  return encodeBytesCursor(new TextEncoder().encode(JSON.stringify(cursor)));
}

/** What a feed cursor names (null without one); any other cursor is refused. */
export function decodeFeedCursor(
  cursor: string | undefined,
): (CursorRef & { readonly quiet: number }) | null {
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
    i,
    s,
    q = 0,
  } = (value ?? {}) as { v?: unknown; e?: unknown; i?: unknown; s?: unknown; q?: unknown };
  if (
    typeof e !== "string" ||
    e.length > 64 ||
    typeof q !== "number" ||
    !Number.isSafeInteger(q) ||
    q < 0 ||
    q > QUIET_MAX
  )
    throw invalidCursor();
  if (v === 2 && typeof i === "string" && /^[0-9a-f]{32}$/.test(i))
    return { epoch: e, id: i, quiet: q };
  if (v === 1 && typeof s === "number" && Number.isSafeInteger(s) && s >= 0)
    return { epoch: e, base: s, quiet: q };
  throw invalidCursor();
}

type FeedItemOutput = Output<typeof getFeed>["items"][number];

/**
 * `ctx` with its credential as the directory's primary has it now, before
 * anything of the feed is read (whether activity arrived never shows to a
 * credential revoked meanwhile); a refusal answers 401.
 */
export async function freshly(ctx: OpContext): Promise<OpContext> {
  const fresh = await reverified(ctx);
  if (!fresh.ok) throw new OperationError(401, fresh.code, fresh.detail);
  return {
    ...ctx,
    auth: fresh.record,
    authState: { ...ctx.authState, record: fresh.record, mode: "write" },
  };
}

/** The caller's feed: its token's principal's object. */
/** Whether watched activity may be missing (deployment-wide, see `deliveryState`). */
export const deliveryOf = (ctx: OpContext) =>
  deliveryState(readModelFor(ctx.env, DEFAULT_ORG_SHARD), Date.now(), ctx.metrics);

const feedOf = (ctx: OpContext) => ctx.env.USER.getByName(ctx.auth.principalId);

const counted = (ctx: OpContext, method: string) =>
  ctx.metrics.count("do.request", { class: "UserDO", method });

/**
 * An item as a check needs it: its repository, its thread, the member it
 * displays, and (an inbox thread's) the conversation it is about.
 */
export type Displayed = Pick<FeedItem, "repoId" | "threadKey" | "member" | "epoch"> & {
  readonly conversation?: string;
};

/**
 * What the caller may see of a feed's items, decided once per repository
 * within one answer, and what the members they display say.
 */
export class Visibility {
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
  /** Repositories whose threads are asked about by conversation (an inbox's). */
  readonly #identify = new Set<string>();
  /**
   * The conversation each thread asked about names now (null: none) and its
   * title, with the generation then.
   */
  readonly #identities = new Map<
    string,
    { conversation: string | null; title: string; epoch: number }
  >();

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
    for (const { repoId, threadKey, member, epoch, conversation } of items) {
      // Only an issue's thread or a digest can be gone for good: each is checked, whenever it first
      // shows; an inbox thread's, of either kind, is also identified (the conversation its number
      // names).
      if (conversation !== undefined) this.#identify.add(repoId);
      const k = key(repoId, threadKey);
      if (
        (checked(threadKey) && !this.#checkedThreads.has(k)) ||
        (conversation !== undefined && !this.#identities.has(k))
      )
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
      const unchecked = [...set].filter(
        (t) =>
          !this.#checkedThreads.has(key(repoId, t)) ||
          (this.#identify.has(repoId) && !this.#identities.has(key(repoId, t))),
      );
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
    const gone = [...this.#gone].map(([k, epoch]) => {
      const [repoId, threadKey] = k.split("\n") as [string, string];
      return { repoId, threadKey, epoch };
    });
    // In calls the feed takes (`MAX_GONE_THREADS` each, so each deletes a bounded number).
    for (let i = 0; i < gone.length; i += MAX_GONE_THREADS) {
      this.ctx.metrics.count("do.request", { class: "UserDO", method: "forgetGoneThreads" });
      // An earlier object has no such method (while a deploy rolls out): nothing is forgotten,
      // and a later read forgets them; never through the earlier method, which has no fence.
      await feed.forgetGoneThreads(gone.slice(i, i + MAX_GONE_THREADS)).catch(() => undefined);
    }
    // In calls the feed takes (`PURGE_REPOS` repositories each).
    const lost = [...this.#lost].map(([repoId, loss]) => ({ ...loss, repoIds: [repoId] }));
    for (let i = 0; i < lost.length; i += PURGE_REPOS) {
      this.ctx.metrics.count("do.request", { class: "UserDO", method: "forgetRepos" });
      await feed.forgetRepos(lost.slice(i, i + PURGE_REPOS));
    }
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
    let view = await viewOf(env, repoId).feedView(
      auth.principalId,
      auth.grantId,
      members,
      threads,
      this.#identify.has(repoId),
    );
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
    // Only a readable answer with its generation identifies threads (an earlier object's, without
    // them, leaves them unidentified: an answer stops at them).
    if (view.readable && view.conversations && Number.isSafeInteger(view.epoch))
      for (const thread of threads)
        this.#identities.set(key(repoId, thread), {
          conversation: view.conversations[thread]?.conversation ?? null,
          title: view.conversations[thread]?.title ?? "",
          epoch: view.epoch,
        });
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
    // An issue's thread or a digest not checked (past the budget): not known whether it is gone.
    if (checked(item.threadKey) && !this.#checkedThreads.has(thread)) return undefined;
    // Gone in the generation it was checked in: an item told in a later one (a restore gave its
    // number to a new conversation) is not known yet, so the scan stops before it. A digest's key
    // names its generation: gone is final.
    const goneIn = this.#gone.get(thread);
    if (goneIn !== undefined)
      return item.epoch > goneIn && !isDigest(item.threadKey) ? undefined : "hidden";
    return allowedWithRole(this.ctx.auth, decided.entry, READ[subject], decided.role)
      ? decided.entry
      : "hidden";
  }

  /**
   * The account and ownership generation a repository shown was decided
   * under (a later call of its must be judged under them); undefined when
   * not decided readable.
   */
  ownership(repoId: string): { readonly accountId: string; readonly ownerGen: number } | undefined {
    return this.#pinned.get(repoId);
  }

  /**
   * Whether the caller may read the repository, as decided: its entry,
   * false when denied, undefined when not decided or not known.
   */
  repository(repoId: string): RepoEntry | false | undefined {
    const decided = this.#decided.get(repoId);
    if (decided === undefined || decided === "unknown") return undefined;
    return decided === "denied" ? false : decided.entry;
  }

  /**
   * The conversation an inbox thread's number names now, its title, and
   * the repository's generation then; undefined when not identified yet.
   */
  identity(
    repoId: string,
    threadKey: string,
  ):
    | { readonly conversation: string | null; readonly title: string; readonly epoch: number }
    | undefined {
    return this.#identities.get(key(repoId, threadKey));
  }

  /**
   * Whether the caller may read the stream (its repository, and its
   * threads' kind there): undefined when that is not known (not checked).
   */
  readable({ repoId, subject }: StreamKey): boolean | undefined {
    const decided = this.#decided.get(repoId);
    if (decided === undefined || decided === "unknown") return undefined;
    if (decided === "denied" || !Object.hasOwn(READ, subject)) return false;
    return allowedWithRole(
      this.ctx.auth,
      decided.entry,
      READ[subject as FeedSubjectKind],
      decided.role,
    );
  }

  /** Decides the repositories of `streams` not decided yet, within the budget of checks. */
  decideStreams(streams: readonly StreamKey[]): Promise<void> {
    return this.decide(
      streams.map(({ repoId }) => ({ repoId, threadKey: "", member: null, epoch: 0 })),
    );
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
 * An item `admits` refuses is left out, as one hidden is.
 * `more`: the feed may have more the caller can see.
 */
async function scan<P>(
  visibility: Visibility,
  limit: number,
  read: (after: P | null) => Promise<{ items: readonly FeedItem[]; more: boolean }>,
  position: (item: FeedItem) => P,
  admits: (item: FeedItem) => boolean = () => true,
): Promise<{ shown: Scanned; more: boolean }> {
  const shown: Scanned = [];
  let after: P | null = null;
  for (let scanned = 0; scanned < SCAN.items; ) {
    const page = await read(after);
    await visibility.decide(page.items);
    for (const item of page.items) {
      const repo = visibility.of(item);
      if (repo === undefined) return { shown, more: true };
      if (repo !== "hidden" && admits(item)) shown.push({ item, repo });
      if (shown.length > limit) return { shown, more: true };
    }
    const last = page.items.at(-1);
    if (!page.more || !last) return { shown, more: false };
    scanned += page.items.length;
    after = position(last);
  }
  return { shown, more: true };
}

function itemOutput(
  ctx: OpContext,
  item: FeedItem,
  repo: RepoEntry,
  excerpt: string | null,
): FeedItemOutput {
  // Shown items have a thread of a known kind (`of` hides any other).
  const named = parseThreadKey(item.threadKey) as FeedThread;
  return {
    item_key: feedItemKey(item.repoId, item.threadKey, item.kind),
    repo: { id: repo.id, full_name: `${repo.ownerHandle}/${repo.name}` },
    thread_key: item.threadKey,
    kind: item.kind,
    subject: {
      kind: named.subject,
      ...("number" in named && { number: named.number }),
      title: item.title,
    },
    ...("digest" in named && {
      digest: {
        window: named.digest.window,
        starts_at: named.digest.window * DIGEST_POLICY.windowMs,
        ends_at: (named.digest.window + 1) * DIGEST_POLICY.windowMs,
        url: `${ctx.requestOrigin}/api/feed/digests/${item.repoId}/${named.subject}/${named.digest.window}/${named.digest.epoch}`,
      },
    }),
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

/** A snapshot as a read found it. */
type ReadSnapshot = SnapshotState & { readonly id: string | null; readonly createdAt: number };

/** A stream's key in a snapshot's positions. */
const streamKey = (repoId: string, subject: string) => `${repoId}\n${subject}`;

/** Positions as a snapshot keeps them, sorted by stream. */
function positionsOf(map: ReadonlyMap<string, number>): StreamPosition[] {
  return [...map]
    .map(([key, seq]) => {
      const [repoId, subject] = key.split("\n") as [string, string];
      return [repoId, subject, seq] as const;
    })
    .sort(([ra, sa], [rb, sb]) => (ra < rb ? -1 : ra > rb ? 1 : sa < sb ? -1 : sa > sb ? 1 : 0));
}

/**
 * The cursor of a snapshot: the one read when an answer changed nothing of
 * it and it is not past half its lifetime (no write), else one the feed
 * keeps now (an equal live one when it has it).
 */
async function cursorOf(
  ctx: OpContext,
  epoch: string,
  state: SnapshotState,
  read: { id: string | null; createdAt: number; unchanged: boolean },
  quiet: number,
): Promise<string> {
  const fresh = Date.now() - read.createdAt < FEED_POLICY.cursorTtlMs / 2;
  if (read.id !== null && read.unchanged && fresh) return encodeFeedCursor(epoch, read.id, quiet);
  counted(ctx, "saveCursor");
  const { id } = await feedOf(ctx).saveCursor(ctx.auth.id, state);
  return encodeFeedCursor(epoch, id, quiet);
}

/** The `feed.list` operation. */
export async function getFeedOperation(
  ctx: OpContext,
  input: Input<typeof getFeed>,
): Promise<Output<typeof getFeed>> {
  ctx = await freshly(ctx);
  const feed = feedOf(ctx);
  const since = decodeFeedCursor(input.since);
  const cursor: CursorRef | null =
    since &&
    ("id" in since
      ? { epoch: since.epoch, id: since.id }
      : { epoch: since.epoch, base: since.base });
  const filter: FeedFilter = {
    priority: input.priority,
    kind: input.kind,
    repoIds: ctx.auth.repoIds,
    subjects: readableSubjects(ctx),
  };
  let epoch = "";
  let cutoff = 0;
  let snapshot: ReadSnapshot | undefined;
  /** Positions by stream: the snapshot's, then each moved by what the answer gives. */
  const positions = new Map<string, number>();
  /** The greatest sequence number the answer's pages read in each stream. */
  const read = new Map<string, number>();
  /** Streams without a position an answer may still give items of (its coverage's room). */
  const joining = new Set<string>();
  let partial = false;
  /** A stream behind what was deleted could not be checked: the answer ends there. */
  let unsure = false;
  const visibility = new Visibility(ctx);
  const { shown } = await scan(
    visibility,
    input.limit,
    async (after: number | null) => {
      if (unsure) return { items: [], more: false };
      counted(ctx, "listStreams");
      const page = await feed.listStreams(
        { credential: ctx.auth.id, cursor, after: after === null ? null : { seq: after, cutoff } },
        SCAN.page,
        filter,
      );
      if (page.expired) throw expired();
      if (snapshot === undefined) {
        epoch = page.epoch;
        cutoff = page.cutoff;
        // Tuples, as the feed sent them (RPC types widen them).
        const first = page.snapshot as ReadSnapshot;
        snapshot = first;
        for (const [repoId, subject, seq] of first.positions)
          positions.set(streamKey(repoId, subject), seq);
      }
      // Behind what was deleted in a stream: where the snapshot is (the first page says), or past
      // where the answer read in it (deleted between its pages; never passed silently).
      const behind = new Map(page.expiredStreams.map((s) => [streamKey(s.repoId, s.subject), s]));
      for (const [repoId, subject, watermark] of page.watermarks as readonly StreamPosition[]) {
        const key = streamKey(repoId, subject);
        // Only a stream the answer follows: one with a position or a base, or one it admitted
        // (a stream refused for want of room gives nothing, so passes nothing).
        const follows = positions.has(key) || joining.has(key) || snapshot.base !== null;
        const at = read.get(key) ?? positions.get(key) ?? snapshot.base ?? 0;
        if (follows && watermark > at) behind.set(key, { repoId, subject });
      }
      // Expired when the caller may read such a stream, nothing when not (never moved by what it
      // may not read); not known, the answer ends before this page.
      if (behind.size > 0) {
        const streams = [...behind.values()];
        await visibility.decideStreams(streams);
        const judged = streams.map((stream) => visibility.readable(stream));
        if (judged.includes(true)) throw expired();
        if (judged.includes(undefined)) {
          unsure = true;
          return { items: [], more: false };
        }
      }
      for (const item of page.items) {
        const key = streamKey(item.repoId, item.subject);
        read.set(key, Math.max(read.get(key) ?? 0, item.seq));
      }
      return page;
    },
    (item) => item.seq,
    (item) => {
      // A stream joins the snapshot only while it has room for it: past that, its items are
      // left out (the same ones each answer), and the answer says its coverage is partial.
      const key = streamKey(item.repoId, item.subject);
      if (positions.has(key) || joining.has(key)) return true;
      if (positions.size + joining.size >= FEED_POLICY.coverage) {
        partial = true;
        return false;
      }
      joining.add(key);
      return true;
    },
  );
  const page = shown.slice(0, input.limit);
  await Promise.all([visibility.read(page.map(({ item }) => item)), visibility.forgetLost()]);
  // Up to an item whose repository reading its members made unknown (its ownership changed).
  const given = visibility.stillShown(page);
  // Positions move by what the answer gives only: never by what it read and did not give.
  for (const { item } of given) {
    const key = streamKey(item.repoId, item.subject);
    positions.set(key, Math.max(positions.get(key) ?? 0, item.seq));
  }
  const state = { positions: positionsOf(positions), base: snapshot?.base ?? null };
  // An answer that shows nothing is one more quiet one in a row, whatever it did not show.
  const quiet = given.length > 0 ? 0 : Math.min((since?.quiet ?? 0) + 1, QUIET_MAX);
  const next = await cursorOf(
    ctx,
    epoch,
    state,
    {
      id: snapshot?.id ?? null,
      createdAt: snapshot?.createdAt ?? 0,
      unchanged: given.length === 0,
    },
    quiet,
  );
  return {
    items: given.map(({ item, repo }) => itemOutput(ctx, item, repo, visibility.excerpt(item))),
    next_cursor: next,
    head_cursor: next,
    coverage: partial || state.positions.length >= FEED_POLICY.coverage ? "partial" : "full",
    delivery: await deliveryOf(ctx),
    // Read on at once only after a full page: what the caller sees says so, never what it
    // does not (see the top).
    poll_after_ms: given.length === input.limit ? 0 : pollAfter(quiet),
  };
}

/** The `feed.sync` operation. */
export async function syncFeedOperation(ctx: OpContext): Promise<Output<typeof syncFeed>> {
  ctx = await freshly(ctx);
  const feed = feedOf(ctx);
  let epoch = "";
  let bound = 0;
  /** More than its one page could hold. */
  let truncated = false;
  const visibility = new Visibility(ctx);
  const { shown, more: scanned } = await scan(
    visibility,
    FEED_POLICY.syncItems,
    // One page (one sort of the feed, as a sync orders it): past it, the sync is incomplete.
    async () => {
      counted(ctx, "syncStreams");
      const page = await feed.syncStreams(null, FEED_POLICY.syncItems + 1, {
        repoIds: ctx.auth.repoIds,
        subjects: readableSubjects(ctx),
      });
      epoch = page.epoch;
      bound = page.bound;
      truncated = page.more;
      return { items: page.items, more: false };
    },
    (item) => item.seq,
  );
  const read = shown.slice(0, FEED_POLICY.syncItems);
  await Promise.all([visibility.read(read.map(({ item }) => item)), visibility.forgetLost()]);
  // Up to an item whose repository reading its members made unknown (its ownership changed): an
  // incomplete sync, as one its scan stopped.
  const items = visibility.stillShown(read);
  const more = scanned || truncated || items.length < read.length;
  // A complete sync gave everything of each stream it gave items of that it would show now: the
  // snapshot has those streams at their heads as of its start (only what it gave decides which,
  // so nothing hidden does). An incomplete one has none: `GET /feed` reads each stream from what
  // the feed keeps of it.
  const streams = new Map(
    items.map(({ item }) => [
      streamKey(item.repoId, item.subject),
      { repoId: item.repoId, subject: item.subject },
    ]),
  );
  counted(ctx, more ? "saveCursor" : "syncCursor");
  const { id } = more
    ? await feed.saveCursor(ctx.auth.id, { positions: [], base: null })
    : await feed.syncCursor(ctx.auth.id, [...streams.values()], bound);
  return {
    items: items.map(({ item, repo }) => itemOutput(ctx, item, repo, visibility.excerpt(item))),
    complete: !more,
    head_cursor: encodeFeedCursor(epoch, id),
    coverage: "full",
    delivery: await deliveryOf(ctx),
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
  if (acked.status === "inexact")
    throw new OperationError(
      422,
      "digest_version_inexact",
      "A digest is acknowledged at its own epoch and version only.",
    );
  return {
    item_key: input.item_key,
    epoch: acked.item.epoch,
    version: acked.item.version,
    acked_epoch: acked.item.ackedEpoch,
    acked_version: acked.item.ackedVersion,
  };
}

/** Threads a digest's answer gives at most. */
const DIGEST_THREADS = 50;

/**
 * The `feed.digest` operation: decided as its feed item is (the caller
 * reads the repository and the kind now, and the digest still shows), then
 * resolved by the repository for the caller (see `RepoDigests.resolve`).
 */
export async function getFeedDigestOperation(
  ctx: OpContext,
  input: Input<typeof getFeedDigest>,
): Promise<Output<typeof getFeedDigest>> {
  ctx = await freshly(ctx);
  const notFound = new OperationError(404, "feed_digest_not_found", "The feed has no such digest.");
  const named = {
    repoId: input.repository_id,
    threadKey: digestThreadKey(input.subject, input.window, input.epoch),
    epoch: input.epoch,
  };
  const visibility = new Visibility(ctx);
  await visibility.decide([{ ...named, member: null }]);
  const repo = visibility.of(named);
  if (repo === undefined)
    throw new OperationError(503, "unavailable", "The digest's repository could not be checked.");
  if (repo === "hidden") throw notFound;
  const owner = visibility.ownership(repo.id);
  if (!owner)
    throw new OperationError(503, "unavailable", "The digest's repository could not be checked.");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "feedDigest" });
  const answer = await viewOf(ctx.env, repo.id).feedDigest(
    ctx.auth.principalId,
    ctx.auth.grantId,
    owner,
    { subject: input.subject, window: input.window, epoch: input.epoch },
    DIGEST_THREADS,
  );
  if (answer.status === "gone") throw notFound;
  if (answer.status === "recovering") throw recovering();
  const logins = await loginsOf(ctx, [...new Set(answer.threads.flatMap((t) => t.actors))]);
  return {
    repo: { id: repo.id, full_name: `${repo.ownerHandle}/${repo.name}` },
    subject: input.subject,
    window: input.window,
    starts_at: input.window * DIGEST_POLICY.windowMs,
    ends_at: (input.window + 1) * DIGEST_POLICY.windowMs,
    threads: answer.threads.map((t) => ({
      number: t.number,
      title: t.title,
      last_activity_at: t.lastAt,
      actors: t.actors.map((id) => logins.get(id) ?? GHOST_LOGIN),
      more_actors: t.many,
    })),
    complete: answer.complete,
  };
}

/** Logins of principals (`ghost` for one being deleted, deleted or unknown). */
async function loginsOf(ctx: OpContext, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  ctx.metrics.count("d1.query", { db: "directory", op: "digest_actors" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    `SELECT p.id, ${SHOWN_HANDLE} AS handle FROM principals p
     WHERE p.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ id: string; handle: string }>();
  return new Map(results.map((r) => [r.id, r.handle]));
}
