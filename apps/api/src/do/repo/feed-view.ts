import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { RepoRole } from "@fyrden/domain";
import type { FeedPurge } from "../user/feed.js";
import type { RepoAcl } from "./acl.js";
import type { RepoAuthority } from "./authority.js";
import type { RepoComments } from "./comments.js";
import { excerpt, type FeedPrincipal } from "./feed.js";
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
  readonly denial: FeedViewDenial | null;
}

export interface FeedViewDeps {
  readonly git: RepoGitStorage;
  /** The Worker's bindings, read at each use (tests may replace them). */
  readonly env: () => Env;
  readonly acl: RepoAcl;
  readonly authority: RepoAuthority;
  readonly pulls: RepoPulls;
  readonly comments: RepoComments;
  readonly reviewComments: RepoReviewComments;
  /** Whether the repository is public now. */
  readonly isPublic: () => boolean;
  /** No read: the repository is gone or going. */
  readonly refusesReads: () => boolean;
  /** Whether a transfer is moving the repository now. */
  readonly isTransferring: () => boolean;
}

export class RepoFeedView {
  constructor(private readonly deps: FeedViewDeps) {}

  /**
   * For a reader of an activity feed: whether `principal` (capped by its
   * grant's owners) reads the repository now, its role, and, if it reads
   * it, the excerpts of `members` (at most 100): what feed items name of
   * the repository (`comment/<id>`, `review_comment/<id>`, `review/<id>`,
   * `pull/<n>` for a pull request's description), read now so an edit or
   * deletion shows at once (null for one gone or empty). When it does not
   * read it, `denial` says how sure that is (see `FeedViewDenial`).
   */
  async view(
    principal: string,
    grantId: string | null,
    members: readonly string[],
  ): Promise<FeedViewAnswer> {
    const { authority } = this.deps;
    const gone = () => ({
      readable: false,
      role: null,
      excerpts: {},
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
      return { readable, role, excerpts: {}, denial };
    }
    const excerpts: Record<string, string | null> = {};
    for (const member of members.slice(0, 100)) {
      const [kind, id] = member.split("/") as [string, string | undefined];
      const n = Number(id);
      if (!Number.isSafeInteger(n) || n <= 0) continue;
      const body =
        kind === "comment"
          ? this.deps.comments.get(n)?.body
          : kind === "review_comment"
            ? this.deps.reviewComments.get(n)?.body
            : kind === "pull"
              ? this.deps.pulls.get(n)?.body
              : kind === "review"
                ? this.deps.git.context.storage.sql
                    .exec<{ body: string | null }>(
                      "SELECT body FROM reviews WHERE review_id = ?",
                      n,
                    )
                    .toArray()[0]?.body
                : undefined;
      excerpts[member] = excerpt(body);
    }
    return { readable, role, excerpts, denial: null };
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
