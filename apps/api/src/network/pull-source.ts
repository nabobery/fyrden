import type {
  CommitContext,
  JobHandler,
  RepoGitStorage,
  SliceResult,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { oidFromHex, oidToHex } from "@fyrden/git-core";
import { decodeJson, encodeJson } from "../git/maintenance/storage.js";
import { viewPacks } from "./member.js";
import type { ViewPack } from "./types.js";

/*
 * A repository whose branches are heads of pull requests into another
 * member of its fork network (their base). It records each such pull
 * request (its base, number, head branch and the base's generation of
 * it); a commit that moves or deletes a registered branch writes a notice
 * in its own transaction, and a job tells the base, which imports the
 * revision. A notice names the ref-state version it was written at, so
 * the base applies revisions in order and a delayed one never replaces a
 * later one. The base asks for a revision's packs (leased until it has
 * recorded its claims) and commit graph.
 */

/** Notices one slice of the job tells at most. Proposed. */
const NOTICES_PER_SLICE = 20;
/** When to try again after a base could not be told. Proposed. */
const NOTICE_RETRY_MS = 30_000;

const BRANCHES = "refs/heads/";

/** A revision of a head branch, as the base is told of it. */
export interface RevisionNotice {
  readonly headRepoId: string;
  readonly number: number;
  readonly generation: number;
  /** The head repository's ref-state version the branch moved at. */
  readonly refVersion: number;
  /** The branch's commit; null when it was deleted. */
  readonly sha: string | null;
  /** Who moved it last, and under which delegation grant (unknown: null). */
  readonly pusher: string | null;
  readonly pusherGrant: string | null;
  /**
   * Whether the branch was pushed since the revision the base has: false
   * for a following started (opened, reopened) on the branch as the base
   * knows it, which only tells whether it exists.
   */
  readonly pushed: boolean;
}

/** What the base made of a notice: `closed` when it no longer follows the branch. */
export type NoticeAnswer = "applied" | "queued" | "stale" | "closed";

export interface PullSourceDeps {
  readonly git: RepoGitStorage;
  readonly repoId: () => string;
  /** Tells a base of a revision (an RPC to its object). */
  readonly tell: (baseRepoId: string, notice: RevisionNotice) => Promise<NoticeAnswer>;
  readonly log: () => Logger;
  /** The restore generation this repository's object has taken. */
  readonly epoch: () => number;
  /** Other active repositories of its fork network, by id after `after`, at most `limit`. */
  readonly members: (after: string, limit: number) => Promise<string[]>;
  /**
   * Asks a member to follow again its open pull requests whose head is
   * here, those numbered after `after` (a page); answers the number to go
   * on after, or null when it has no more.
   */
  readonly followAgain: (baseRepoId: string, after: number) => Promise<number | null>;
}

/** Members one page of the job asking bases to follow again reads. Proposed. */
const MEMBERS_PER_PAGE = 50;
/** Calls to other objects (and directory reads) one slice of that job makes at most. Proposed. */
const REFOLLOW_CALLS_PER_SLICE = 20;

/** When a member that could not be asked is asked again: doubling per failure, at most an hour. */
const REFOLLOW_RETRY_MS = 30_000;
const REFOLLOW_RETRY_MAX_MS = 60 * 60_000;

/**
 * How far the job asking bases to follow again has read the directory: the
 * last member it took (ids in order), and whether it has taken them all.
 * The members taken and not asked fully yet are in `refollow_bases`.
 */
interface RefollowCursor {
  readonly last: string;
  readonly listed: boolean;
}

/** Delay before asking again a member asked `attempts` times without an answer. */
const refollowRetryMs = (attempts: number) =>
  Math.min(REFOLLOW_RETRY_MAX_MS, REFOLLOW_RETRY_MS * 2 ** Math.max(0, attempts - 1));

/**
 * Ref-state versions within one restore generation, at most (a generation's
 * versions come after). Composed as `epoch * 2^32 + version`, exact while
 * a generation commits fewer than 2^32 times and there are fewer than 2^21
 * restore generations (a JavaScript number is exact to 2^53).
 */
const VERSIONS_PER_EPOCH = 2 ** 32;

export class PullSource {
  constructor(private readonly deps: PullSourceDeps) {}

  /**
   * A pull request of `baseRepoId` now follows `headRef` (opened, or
   * reopened: a new generation). The base is told where the branch is now:
   * a push, by whoever moved it last, when it is no longer at `knownSha`
   * (what the base has); else only that it exists (or not). Answers where
   * the branch is.
   */
  register(input: {
    readonly baseRepoId: string;
    readonly number: number;
    readonly headRef: string;
    readonly generation: number;
    readonly knownSha: string | null;
    /**
     * Whether the author lets the base's maintainers write the branch, the
     * author's root identity, and the pull request's version they were
     * read at (a copy told late never replaces a newer one).
     */
    readonly consent?: {
      readonly maintainerCanModify: boolean;
      readonly authorRoot: string;
      readonly version: number;
    };
  }): { sha: string | null; refVersion: number } {
    const { git } = this.deps;
    return git.context.storage.transactionSync(() => {
      const sql = git.context.storage.sql;
      const current = sql
        .exec<{ generation: number }>(
          "SELECT generation FROM outgoing_pulls WHERE base_repo_id = ? AND pr_number = ?",
          input.baseRepoId,
          input.number,
        )
        .toArray()[0];
      // Told late: a later generation follows the branch already; nothing of this one is told.
      if (current && current.generation > input.generation) return this.tip(input.headRef);
      const consent = input.consent;
      sql.exec(
        `INSERT INTO outgoing_pulls (base_repo_id, pr_number, head_ref, generation,
           maintainer_can_modify, author_root, consent_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (base_repo_id, pr_number) DO UPDATE SET head_ref = excluded.head_ref,
           generation = excluded.generation,
           maintainer_can_modify = CASE WHEN excluded.consent_version >= outgoing_pulls.consent_version
             THEN excluded.maintainer_can_modify ELSE outgoing_pulls.maintainer_can_modify END,
           author_root = CASE WHEN excluded.consent_version >= outgoing_pulls.consent_version
             THEN excluded.author_root ELSE outgoing_pulls.author_root END,
           consent_version = max(excluded.consent_version, outgoing_pulls.consent_version)
         WHERE excluded.generation >= outgoing_pulls.generation`,
        input.baseRepoId,
        input.number,
        input.headRef,
        input.generation,
        consent?.maintainerCanModify ? 1 : 0,
        consent?.authorRoot ?? null,
        consent?.version ?? 0,
      );
      const tip = this.tip(input.headRef);
      const last = sql
        .exec<{ actor: string | null; grant_id: string | null }>(
          "SELECT actor, grant_id FROM reflog WHERE ref = ? ORDER BY seq DESC LIMIT 1",
          `${BRANCHES}${input.headRef}`,
        )
        .toArray()[0];
      const pushed = tip.sha !== null && tip.sha !== input.knownSha;
      this.#notice(
        input.baseRepoId,
        input.number,
        input.generation,
        tip.refVersion,
        tip.sha,
        pushed ? (last?.actor ?? null) : null,
        pushed ? (last?.grant_id ?? null) : null,
        pushed,
      );
      return tip;
    });
  }

  /**
   * What the fork knows of a pull request of `baseRepoId` following one of
   * its branches: its registration, if it is at `generation` for `headRef`.
   */
  registration(
    baseRepoId: string,
    number: number,
    generation: number,
    headRef: string,
  ): { readonly maintainerCanModify: boolean; readonly authorRoot: string | null } | undefined {
    const row = this.deps.git.context.storage.sql
      .exec<{ maintainer_can_modify: number; author_root: string | null }>(
        `SELECT maintainer_can_modify, author_root FROM outgoing_pulls
         WHERE base_repo_id = ? AND pr_number = ? AND generation = ? AND head_ref = ?`,
        baseRepoId,
        number,
        generation,
        headRef,
      )
      .toArray()[0];
    return (
      row && { maintainerCanModify: row.maintainer_can_modify === 1, authorRoot: row.author_root }
    );
  }

  /**
   * The pull request no longer follows its branch (closed or merged in
   * `generation`); a later generation's registration (reopened meanwhile)
   * is kept.
   */
  unregister(baseRepoId: string, number: number, generation: number): void {
    const { storage } = this.deps.git.context;
    storage.transactionSync(() => {
      storage.sql.exec(
        `DELETE FROM outgoing_pulls WHERE base_repo_id = ? AND pr_number = ?
           AND generation <= ?`,
        baseRepoId,
        number,
        generation,
      );
      storage.sql.exec(
        `DELETE FROM revision_notices WHERE base_repo_id = ? AND pr_number = ?
           AND generation <= ?`,
        baseRepoId,
        number,
        generation,
      );
      // The base's imports for it are dropped: their leases go now rather than when they expire.
      // Holders are `pull:<base>:pr:<number>:<generation>:<version>`: a reopened generation's
      // imports keep theirs.
      const prefix = `pull:${baseRepoId}:pr:${number}:`;
      storage.sql.exec(
        `DELETE FROM leases WHERE substr(holder, 1, ?1) = ?2
           AND CAST(substr(substr(holder, ?1 + 1), 1, instr(substr(holder, ?1 + 1), ':') - 1)
             AS INTEGER) <= ?3`,
        prefix.length,
        prefix,
        generation,
      );
    });
  }

  /** Where `headRef` (a branch name) is, with the ref-state version it was read at. */
  tip(headRef: string): { sha: string | null; refVersion: number } {
    const snapshot = this.deps.git.refStore.readRefsSync();
    const oid = snapshot.refs.get(`${BRANCHES}${headRef}`);
    return { sha: oid ? oidToHex(oid) : null, refVersion: this.#ordered(snapshot.version) };
  }

  /**
   * A ref-state version as bases order revisions by: after a restore (a
   * new generation) the counter starts over, but its versions still come
   * after every one before it.
   */
  #ordered(version: number): number {
    return this.deps.epoch() * VERSIONS_PER_EPOCH + version;
  }

  /** In every commit's transaction: a notice for each registered branch it moved or deleted. */
  onCommit(context: CommitContext): void {
    const { request, version } = context;
    const actor = request.actor ?? null;
    for (const update of request.refUpdates) {
      if (!update.name.startsWith(BRANCHES)) continue;
      const branch = update.name.slice(BRANCHES.length);
      const pulls = this.deps.git.context.storage.sql
        .exec<{ base_repo_id: string; pr_number: number; generation: number }>(
          "SELECT base_repo_id, pr_number, generation FROM outgoing_pulls WHERE head_ref = ?",
          branch,
        )
        .toArray();
      for (const pull of pulls)
        this.#notice(
          pull.base_repo_id,
          pull.pr_number,
          pull.generation,
          this.#ordered(version),
          update.newOid ? oidToHex(update.newOid) : null,
          actor?.principal ?? null,
          actor?.grantId ?? null,
          update.newOid !== null,
        );
    }
  }

  #notice(
    baseRepoId: string,
    number: number,
    generation: number,
    refVersion: number,
    sha: string | null,
    pusher: string | null,
    pusherGrant: string | null,
    pushed: boolean,
  ): void {
    // A notice not told yet is replaced by a later one, which keeps its push (the base has
    // neither): a push is told as one even when a later following re-reads the branch.
    this.deps.git.context.storage.sql.exec(
      `INSERT INTO revision_notices (base_repo_id, pr_number, generation, ref_version, sha, pusher,
         pusher_grant, pushed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (base_repo_id, pr_number) DO UPDATE SET generation = excluded.generation,
         ref_version = excluded.ref_version, sha = excluded.sha,
         pusher = CASE WHEN excluded.pushed = 1 THEN excluded.pusher ELSE revision_notices.pusher END,
         pusher_grant = CASE WHEN excluded.pushed = 1 THEN excluded.pusher_grant
           ELSE revision_notices.pusher_grant END,
         pushed = CASE WHEN excluded.generation > revision_notices.generation THEN excluded.pushed
           ELSE max(revision_notices.pushed, excluded.pushed) END,
         next_at = 0
       WHERE excluded.generation > revision_notices.generation
         OR (excluded.generation = revision_notices.generation
           AND excluded.ref_version >= revision_notices.ref_version)`,
      baseRepoId,
      number,
      generation,
      refVersion,
      sha,
      pusher,
      pusherGrant,
      pushed ? 1 : 0,
    );
    this.deps.git.jobs.ensure("pull_notices", PULL_NOTICES_JOB);
  }

  /** The job telling bases of revisions; a base that cannot be told is tried again later. */
  noticesHandler(): JobHandler {
    return {
      runSlice: async (): Promise<SliceResult> => {
        const sql = this.deps.git.context.storage.sql;
        const notices = sql
          .exec<{
            base_repo_id: string;
            pr_number: number;
            generation: number;
            ref_version: number;
            sha: string | null;
            pusher: string | null;
            pusher_grant: string | null;
            pushed: number;
          }>(
            `SELECT * FROM revision_notices WHERE next_at <= ?
             ORDER BY ref_version, base_repo_id, pr_number LIMIT ?`,
            this.deps.git.context.now(),
            NOTICES_PER_SLICE,
          )
          .toArray();
        for (const row of notices) {
          let answer: NoticeAnswer;
          try {
            answer = await this.deps.tell(row.base_repo_id, {
              headRepoId: this.deps.repoId(),
              number: row.pr_number,
              generation: row.generation,
              refVersion: row.ref_version,
              sha: row.sha,
              pusher: row.pusher,
              pusherGrant: row.pusher_grant,
              pushed: row.pushed === 1,
            });
          } catch (error) {
            this.deps.log().warn("telling a pull request's base failed", {
              base: row.base_repo_id,
              number: row.pr_number,
              error,
            });
            // Tried again later; the others go on meanwhile.
            sql.exec(
              `UPDATE revision_notices SET next_at = ? WHERE base_repo_id = ? AND pr_number = ?
                 AND ref_version = ? AND generation = ?`,
              this.deps.git.context.now() + NOTICE_RETRY_MS,
              row.base_repo_id,
              row.pr_number,
              row.ref_version,
              row.generation,
            );
            continue;
          }
          this.deps.git.context.storage.transactionSync(() => {
            // Told: gone unless a later revision was written meanwhile.
            sql.exec(
              `DELETE FROM revision_notices WHERE base_repo_id = ? AND pr_number = ?
                 AND ref_version = ? AND generation = ?`,
              row.base_repo_id,
              row.pr_number,
              row.ref_version,
              row.generation,
            );
            if (answer === "closed")
              sql.exec(
                `DELETE FROM outgoing_pulls WHERE base_repo_id = ? AND pr_number = ?
                   AND generation = ?`,
                row.base_repo_id,
                row.pr_number,
                row.generation,
              );
          });
        }
        const next = sql
          .exec<{ at: number | null }>("SELECT min(next_at) AS at FROM revision_notices")
          .one().at;
        if (next === null) return { done: true };
        return {
          done: false,
          cursor: null,
          runAfterMs: Math.max(0, next - this.deps.git.context.now()),
        };
      },
    };
  }

  /**
   * In the transaction taking a new restore generation: the restored
   * object may predate registrations its bases made since (their requests
   * are gone once told), so it would tell them of no push. Every other
   * member of the network is asked, by the `pull_refollow` job, to follow
   * again its open pull requests whose head is here: each registers anew
   * and is told where the branch is.
   */
  restored(): void {
    this.deps.git.context.storage.sql.exec("DELETE FROM refollow_bases");
    this.deps.git.jobs.restart("pull_refollow", PULL_REFOLLOW_JOB);
  }

  /**
   * The job asking the network's members to follow again, within a few
   * calls a slice: a page of members is taken from the directory once the
   * members taken before are asked (or waiting), and each is asked page by
   * page of its pull requests, its progress stored as it goes. A member
   * that cannot be asked waits (longer after each failure) while the
   * others go on, and is asked again from where it was until it answers; a
   * directory that cannot be read is read again later. Done once every
   * member has answered for all its pull requests.
   */
  refollowHandler(): JobHandler {
    return {
      runSlice: async (job): Promise<SliceResult> => {
        const { git } = this.deps;
        const sql = git.context.storage.sql;
        let cursor = decodeJson<RefollowCursor>(job.cursor) ?? { last: "", listed: false };
        const save = (): SliceResult => {
          const next = sql
            .exec<{ at: number | null }>("SELECT min(next_at) AS at FROM refollow_bases")
            .one().at;
          if (next === null && cursor.listed) return { done: true };
          return {
            done: false,
            cursor: encodeJson(cursor),
            runAfterMs: next === null ? 0 : Math.max(0, next - git.context.now()),
          };
        };
        for (let calls = 0; calls < REFOLLOW_CALLS_PER_SLICE; calls++) {
          const due = sql
            .exec<{ base_repo_id: string; after: number; attempts: number }>(
              `SELECT base_repo_id, after, attempts FROM refollow_bases WHERE next_at <= ?
               ORDER BY next_at, base_repo_id LIMIT 1`,
              git.context.now(),
            )
            .toArray()[0];
          if (!due) {
            if (cursor.listed) break;
            let page: string[];
            try {
              page = await this.deps.members(cursor.last, MEMBERS_PER_PAGE);
            } catch (error) {
              this.deps.log().warn("reading a network's members failed", { error });
              return { done: false, cursor: encodeJson(cursor), runAfterMs: REFOLLOW_RETRY_MS };
            }
            git.context.storage.transactionSync(() => {
              for (const id of page)
                sql.exec(
                  "INSERT INTO refollow_bases (base_repo_id) VALUES (?) ON CONFLICT DO NOTHING",
                  id,
                );
            });
            cursor = {
              last: page.at(-1) ?? cursor.last,
              listed: page.length < MEMBERS_PER_PAGE,
            };
            continue;
          }
          let next: number | null;
          try {
            next = await this.deps.followAgain(due.base_repo_id, due.after);
          } catch (error) {
            this.deps.log().warn("asking a base to follow again failed", {
              base: due.base_repo_id,
              error,
            });
            sql.exec(
              "UPDATE refollow_bases SET attempts = ?, next_at = ? WHERE base_repo_id = ?",
              due.attempts + 1,
              git.context.now() + refollowRetryMs(due.attempts + 1),
              due.base_repo_id,
            );
            continue;
          }
          if (next === null)
            sql.exec("DELETE FROM refollow_bases WHERE base_repo_id = ?", due.base_repo_id);
          else
            sql.exec(
              "UPDATE refollow_bases SET after = ?, attempts = 0 WHERE base_repo_id = ?",
              next,
              due.base_repo_id,
            );
        }
        return save();
      },
    };
  }

  /**
   * A revision a base imports: the packs that may hold it, read-leased by
   * `holder` for `ttlMs` (so none is deleted before the network records the
   * base's claims), when `sha` is a commit of its graph: the live ones, and
   * those its collection dropped but keeps (a revision force-pushed away has
   * its objects there while its graph rows are kept).
   */
  exportRevision(input: {
    readonly sha: string;
    readonly holder: string;
    readonly ttlMs: number;
  }):
    | { ok: true; packs: ViewPack[]; leaseId: string | null }
    | { ok: false; code: "unknown_commit" } {
    const { git } = this.deps;
    if (!git.commitGraph.readSync([oidFromHex(input.sha)], "verified")[0])
      return { ok: false, code: "unknown_commit" };
    const packs = viewPacks(git, ["live", "garbage"]);
    if (packs.length === 0) return { ok: false, code: "unknown_commit" };
    const grant = git.leases.grant(
      "read",
      packs.map((p) => p.packId as never),
      input.holder,
      input.ttlMs,
    );
    if (!grant.ok) throw new Error(`pack ${grant.packId} cannot be leased (${grant.reason})`);
    return { ok: true, packs, leaseId: grant.leaseId };
  }
}

/** The one job telling bases of revisions. */
export const PULL_NOTICES_JOB = "pull-notices";

/** The one job asking the network's members to follow again after a restore. */
export const PULL_REFOLLOW_JOB = "pull-refollow";
