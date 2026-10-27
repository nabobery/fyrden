import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { RepoRole } from "@fyrden/domain";
import type { FeedPurge } from "../user/feed.js";
import type { RepoAccount, RepoAcl } from "./acl.js";
import type { RepoAuthority } from "./authority.js";
import type { RepoComments } from "./comments.js";
import { excerpt, type FeedPrincipal } from "./feed.js";
import type { RepoIssues } from "./issues.js";
import type { RepoPulls } from "./pulls.js";
import type { RepoReviewComments } from "./review-comments.js";

/*
 * The repository as activity feeds read it: whether a feed's reader reads
 * it now (and, when not, how sure that is), the excerpts of what its items
 * name, read at once so an edit or a deletion shows, and the principals
 * the texts of a change mention.
 */

/**
 * Why a feed's reader may not read the repository (`feedView`): `lost`,
 * certainly, as `loss` says (the repository gone: no account, and the time
 * it was found so; or the account's ACL at `(epochGen, aclVersion)`, as
 * pulled at `until`), so the reader's feed may forget it up to then;
 * `denied`, but on nothing a feed may forget it by (an object without an
 * account); `unknown`, not known (no usable ACL snapshot: a pull failed;
 * or a transfer moves it, its old account rid of those who go with it).
 */
export type FeedViewDenial =
  | { readonly kind: "lost"; readonly loss: Omit<FeedPurge, "repoIds"> }
  | { readonly kind: "denied" }
  | { readonly kind: "unknown" };

/** What a feed's reader gets of the repository (see `RepoFeedView.view`). */
export interface FeedViewAnswer {
  readonly readable: boolean;
  readonly role: RepoRole | null;
  readonly excerpts: Record<string, string | null>;
  /** Of the threads asked about, those gone for good (a deleted issue's). */
  readonly gone: readonly string[];
  /**
   * The conversation each thread asked about names now (null: none) and
   * its title, when asked to identify them (absent from an earlier
   * object's answer).
   */
  readonly conversations?: Readonly<
    Record<string, { readonly conversation: string; readonly title: string } | null>
  >;
  /**
   * The repository's restore generation `gone` was found in: a restore can
   * give a gone thread's number to a new conversation, which a feed must
   * not forget for the old one's sake.
   */
  readonly epoch: number;
  readonly denial: FeedViewDenial | null;
  /**
   * The account the repository judged the reader under, and its ownership
   * generation (null for an object without an identity): a reader checking
   * the account itself must have asked this one.
   */
  readonly account: { readonly accountId: string; readonly ownerGen: number } | null;
}

/** What a feed item names of the repository, with the thread the item is on and when. */
export interface FeedMember {
  /** The repository's restore generation the item was told in. */
  readonly epoch: number;
  /** The item's thread: `issue/<n>` or `pull/<n>`. */
  readonly thread: string;
  /** `comment/<id>`, `review_comment/<id>`, `review/<id>`, or the thread's own `pull/<n>` or `issue/<n>`. */
  readonly member: string;
}

/** The key of `member`'s excerpt in an answer. */
export const memberKey = (m: FeedMember): string => `${m.epoch} ${m.thread} ${m.member}`;

export interface FeedViewDeps {
  readonly git: RepoGitStorage;
  /** The Worker's bindings, read at each use (tests may replace them). */
  readonly env: () => Env;
  readonly acl: RepoAcl;
  readonly authority: RepoAuthority;
  readonly pulls: RepoPulls;
  readonly issues: RepoIssues;
  readonly comments: RepoComments;
  readonly reviewComments: RepoReviewComments;
  /** Whether the repository is public now. */
  readonly isPublic: () => boolean;
  /** No read: the repository is gone or going. */
  readonly refusesReads: () => boolean;
  /** Whether a transfer is moving the repository now. */
  readonly isTransferring: () => boolean;
  /** The repository's restore generation now (checked against the directory before any read). */
  readonly epoch: () => number;
  /** The account the repository belongs to now (undefined for an object without an identity). */
  readonly account: () => RepoAccount | undefined;
  /** The identity of the conversation `number` of `kind` names now (undefined: none). */
  readonly conversationOf: (kind: "issue" | "pull", number: number) => string | undefined;
}

export class RepoFeedView {
  constructor(private readonly deps: FeedViewDeps) {}

  /**
   * For a reader of an activity feed: whether `principal` (capped by its
   * grant's owners) reads the repository now, its role, and, if it reads
   * it, the excerpts of `members` (at most 100, keyed by `memberKey`):
   * what feed items name of the repository, read now so an edit or
   * deletion shows at once (null for one gone or empty, or one that is not
   * on the item's thread, or was told before the repository's last
   * restore: ids and numbers can be used again after a restore, so a
   * member is shown only while it belongs to that issue or pull request,
   * in the restore generation the item was told in), and which of
   * `threads` (at most 100) are gone for good, and (with `identify`) the
   * conversation each names now. When it does not read it, `denial` says
   * how sure that is (see `FeedViewDenial`).
   */
  async view(
    principal: string,
    grantId: string | null,
    members: readonly FeedMember[],
    threads: readonly string[] = [],
    identify = false,
  ): Promise<FeedViewAnswer> {
    const { authority } = this.deps;
    const gone = () => ({
      readable: false,
      role: null,
      excerpts: {},
      gone: [],
      epoch: 0,
      account: null,
      denial: {
        kind: "lost" as const,
        loss: { accountId: "", epochGen: 0, aclVersion: 0, until: Date.now() },
      },
    });
    if (this.deps.refusesReads()) return gone();
    const ceilings = await authority.rolesPulled(principal, grantId);
    // Deleted meanwhile (its rows not erased yet): nothing of it is read.
    if (this.deps.refusesReads()) return gone();
    const role = authority.roleNow(principal, ceilings);
    const readable = role !== null || this.deps.isPublic();
    // Read with the role, no await between them.
    const owner = this.deps.account();
    const account = owner ? { accountId: owner.accountId, ownerGen: owner.ownerGen } : null;
    if (!readable) {
      // The snapshot the decision used: a denial without one (a pull failed) is no answer, nor
      // one while a transfer moves it (read after the pull: its collaborators may be between
      // the old account, which let go of them, and the new one).
      const basis = this.deps.acl.basis();
      const denial: FeedViewDenial =
        basis === "unknown" || this.deps.isTransferring()
          ? { kind: "unknown" }
          : basis === "none"
            ? { kind: "denied" }
            : {
                kind: "lost",
                loss: {
                  accountId: basis.accountId,
                  epochGen: basis.epochGen,
                  aclVersion: basis.version,
                  until: basis.pulledAt,
                },
              };
      return { readable, role, excerpts: {}, gone: [], epoch: this.deps.epoch(), denial, account };
    }
    const excerpts: Record<string, string | null> = {};
    const subjects = new Map<string, { kind: "issue" | "pull"; number: number } | null>();
    /** The thread's subject, when it is one this repository has now. */
    const subjectOf = (thread: string) => {
      if (!subjects.has(thread)) {
        const [kind, id] = thread.split("/");
        const n = Number(id);
        const live =
          Number.isSafeInteger(n) &&
          n > 0 &&
          ((kind === "issue" && this.deps.issues.get(n) !== undefined) ||
            (kind === "pull" && this.deps.pulls.get(n) !== undefined));
        subjects.set(thread, live ? { kind: kind as "issue" | "pull", number: n } : null);
      }
      return subjects.get(thread) ?? null;
    };
    for (const m of members.slice(0, 100)) {
      // A caller of the earlier shape (a member alone, while a deploy rolls out): nothing shown.
      if (typeof m !== "object" || m === null || typeof m.member !== "string") continue;
      const [kind, id] = m.member.split("/") as [string, string | undefined];
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      const subject = m.epoch === this.deps.epoch() ? subjectOf(m.thread) : null;
      let body: string | null | undefined;
      if (subject)
        if (kind === "comment") {
          const comment = this.deps.comments.get(n);
          if (comment?.number === subject.number) body = comment.body;
        } else if (kind === "review_comment" && subject.kind === "pull") {
          const comment = this.deps.reviewComments.get(n);
          if (comment?.number === subject.number) body = comment.body;
        } else if (kind === "review" && subject.kind === "pull") {
          body = this.deps.git.context.storage.sql
            .exec<{ body: string | null }>(
              "SELECT body FROM reviews WHERE review_id = ? AND pr_number = ?",
              n,
              subject.number,
            )
            .toArray()[0]?.body;
        } else if (m.member === m.thread)
          // The thread's own description.
          body = kind === "pull" ? this.deps.pulls.get(n)?.body : this.deps.issues.get(n)?.body;
      excerpts[memberKey(m)] = excerpt(body);
    }
    // A deleted issue's thread: its number is never used again.
    const goneThreads = threads.slice(0, 100).filter((thread) => {
      const [kind, id] = thread.split("/");
      const n = Number(id);
      return kind === "issue" && Number.isSafeInteger(n) && this.deps.issues.deleted(n);
    });
    // The conversation each thread names now, and its title, when asked.
    const conversations: Record<string, { conversation: string; title: string } | null> = {};
    if (identify)
      for (const thread of threads.slice(0, 100)) {
        const [kind, id] = thread.split("/");
        const n = Number(id);
        const conversation =
          Number.isSafeInteger(n) && n > 0 && (kind === "issue" || kind === "pull")
            ? this.deps.conversationOf(kind, n)
            : undefined;
        const title =
          conversation === undefined
            ? undefined
            : kind === "pull"
              ? this.deps.pulls.get(n)?.title
              : this.deps.issues.get(n)?.title;
        conversations[thread] =
          conversation === undefined ? null : { conversation, title: String(title ?? "") };
      }
    return {
      readable,
      role,
      excerpts,
      gone: goneThreads,
      ...(identify && { conversations }),
      epoch: this.deps.epoch(),
      denial: null,
      account,
    };
  }

  /**
   * Active users and agents with the (lower-cased) handles, from the
   * directory, each with the root identity it counts as (a user's agent:
   * that user).
   */
  async resolveHandles(handles: readonly string[]): Promise<Map<string, FeedPrincipal>> {
    this.deps.git.context.metrics.count("d1.query", { db: "directory", op: "feed_mentions" });
    const { results } = await this.deps
      .env()
      .DIRECTORY.prepare(
        `SELECT p.id, p.handle,
         CASE WHEN p.type = 'agent' AND o.type = 'user' THEN o.id ELSE p.id END AS root
       FROM principals p LEFT JOIN principals o ON o.id = p.owner_id
       WHERE p.handle COLLATE NOCASE IN (SELECT value FROM json_each(?))
         AND p.type IN ('user', 'agent') AND p.disabled_at IS NULL`,
      )
      .bind(JSON.stringify(handles))
      .all<{ id: string; handle: string; root: string }>();
    return new Map(results.map((r) => [r.handle.toLowerCase(), { id: r.id, root: r.root }]));
  }
}
