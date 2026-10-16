import {
  DERIVED_REF_PREFIX,
  type JobHandler,
  type MaintainerFor,
  type RefActor,
  type RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { atLeast } from "@fyrden/domain";
import { oidFromHex, oidToHex } from "@fyrden/git-core";
import type { PushReportSummary } from "../../git/chunked/head.js";
import type { PushDecision } from "../../git/push/commit.js";
import {
  type ImportDeps,
  type ImportPolicy,
  importInForeground,
  type PullImports,
  publishStaged,
  readyToPublish,
  releaseLease,
} from "../../network/pull-import.js";
import type { NoticeAnswer, PullSource, RevisionNotice } from "../../network/pull-source.js";
import type { RepoAcl } from "./acl.js";
import type { RepoAuthority } from "./authority.js";
import { type Browsed, fail } from "./browse.js";
import {
  BUSY,
  type FileWriteDeps,
  finishUpload,
  storeUpload,
  refused as writeRefused,
} from "./file-writes.js";
import type { PullRecord, RepoPulls } from "./pulls.js";

/*
 * Pull requests between repositories of a fork network. On the base's
 * side: which branches the heads' repositories must follow (recorded with
 * each change and told by the `pull_follow` job, with the author's consent
 * to maintainer edits), and the revisions they tell of in return, applied
 * or queued for import. On the head's side: a write of the head branch the
 * base built (a merge of the base into it, suggestions applied), committed
 * here for one who writes here, or for the base's maintainer while the
 * pull request's author allows it.
 */

/** Heads' repositories told per slice of the `pull_follow` job. Proposed. */
const FOLLOWS_PER_SLICE = 20;
/** When to try again after a head's repository could not be told. Proposed. */
const FOLLOW_RETRY_MS = 30_000;
/** The one job telling heads' repositories which branches to follow. */
const PULL_FOLLOW_JOB = "pull-follow";

/** Calls to other objects opening a pull request from another repository may make. Proposed. */
export const OPEN_IMPORT_CALLS = 600;

/** Import steps opening a pull request from another repository may take before it gives up. */
export const OPEN_IMPORT_STEPS = 40;

/** Why an import into a repository whose view of borrowed packs is full is refused. */
const VIEW_FULL_DETAIL =
  "The repository borrows as many packs from its fork network as it can hold, and they are too large to merge.";

/** A write of a pull request's head branch, as its base hands it to the head's repository. */
export interface PullHeadWrite {
  readonly baseRepoId: string;
  readonly number: number;
  readonly generation: number;
  readonly headRef: string;
  /** The head the write was built on, and the commit it makes (hex). */
  readonly old: string;
  readonly commit: string;
  /** The write's objects (one pack). */
  readonly pack: Uint8Array;
  /** A commit of the base the write has as a parent, to import first. */
  readonly materialize?: string;
  readonly writer: {
    readonly principal: string;
    readonly tokenId: string;
    readonly grantId: string | null;
    readonly requestId: string | null;
  };
  /** Whether the pull request lets maintainers write the branch, as the base has it now. */
  readonly maintainerAllowed: boolean;
  /** The base's check of the writer's token against the base, right before the call. */
  readonly baseDecision: PushDecision | null;
}

/** Why a maintainer's write of a pull request's head branch was refused. */
const MAINTAINER_EDITS_OFF =
  "the pull request's author does not let the base's maintainers write this branch";
/** Why a write of a pull request's head branch was refused at its commit: no longer its branch. */
const PULL_CHANGED_HERE = "the pull request no longer follows this branch";
const MAINTAINER_EDITS_OFF_DETAIL =
  "The head branch is in another repository, and its pull request's author does not let the base's maintainers write it.";

/** A write of a pull request's head branch refused at its commit, as the base answers it. */
function headWriteRefused(report: PushReportSummary): Browsed<never> {
  if (!report.ok && report.error.includes(MAINTAINER_EDITS_OFF))
    return fail(403, "maintainer_edits_off", MAINTAINER_EDITS_OFF_DETAIL);
  if (!report.ok && report.error.includes(PULL_CHANGED_HERE))
    return fail(409, "pull_changed", "The pull request no longer follows this branch.");
  return writeRefused(report);
}

export interface ForkPullDeps {
  readonly git: RepoGitStorage;
  readonly env: Env;
  readonly acl: RepoAcl;
  readonly pulls: RepoPulls;
  readonly pullSource: PullSource;
  readonly pullImports: PullImports;
  readonly authority: RepoAuthority;
  readonly importDeps: () => ImportDeps;
  readonly importPolicy: () => ImportPolicy;
  readonly repoId: () => string;
  readonly log: () => Logger;
  /** Takes the directory's epoch (a commit needs it first). */
  readonly checkEpoch: () => Promise<void>;
  /** Why the repository takes no change now. */
  readonly writeRefusal: () => { status: 404 | 409; code: string; error: string } | undefined;
  /** The write deps of the current invocation. */
  readonly writeDeps: () => Promise<FileWriteDeps>;
  /** After a change: what the object does after any it makes (outbox, audit). */
  readonly committed: () => void;
  /** For tests: runs before a write handed over by the base is finished. */
  readonly headWriteHooks: () => { readonly beforeFinish?: () => Promise<void> };
}

export class ForkPulls {
  constructor(private readonly deps: ForkPullDeps) {}

  /**
   * In the transaction of a change of a pull request whose head is in
   * another repository (opened, closed, reopened, merged): that repository
   * must follow the branch for it, or no longer. Recorded here and told by
   * the `pull_follow` job until it is told; closed, its import is dropped.
   */
  follow(pull: PullRecord): void {
    const { git } = this.deps;
    const follow = pull.state === "open";
    if (!follow) this.deps.pullImports.drop(pull.number);
    git.context.storage.sql.exec(
      `INSERT INTO head_follows (pr_number, head_repo_id, head_ref, generation, follow, known_sha,
         requested_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET head_repo_id = excluded.head_repo_id,
         head_ref = excluded.head_ref, generation = excluded.generation, follow = excluded.follow,
         known_sha = excluded.known_sha, requested_at = excluded.requested_at, next_at = 0,
         revision = excluded.revision`,
      pull.number,
      pull.headRepoId as string,
      pull.headRef,
      pull.generation,
      follow ? 1 : 0,
      pull.headSha,
      git.context.now(),
      // The pull request's version: a request replacing this one (even after it was told and
      // deleted) has a later one, so an answer to this one never takes that one away.
      pull.version,
    );
    git.jobs.ensure("pull_follow", PULL_FOLLOW_JOB);
  }

  /**
   * The head's repository `headRepoId` was restored and may have lost what
   * it was told: its open pull requests here numbered after `after` (a
   * page) are followed again, as when opened. Answers the number to go on
   * after, or null when there are no more.
   */
  followAgain(headRepoId: string, after: number): number | null {
    const pulls = this.deps.pulls.openFrom(headRepoId, after, FOLLOWS_PER_SLICE);
    this.deps.git.context.storage.transactionSync(() => {
      for (const pull of pulls) this.follow(pull);
    });
    return pulls.length < FOLLOWS_PER_SLICE ? null : (pulls.at(-1)?.number ?? null);
  }

  /** The author's consent to maintainer edits, as the pull request has it now (its version with it). */
  #consentOf(number: number) {
    const pull = this.deps.pulls.get(number);
    return (
      pull && {
        maintainerCanModify: pull.maintainerCanModify,
        authorRoot: pull.authorRoot,
        version: pull.version,
      }
    );
  }

  /** The job telling heads' repositories which branches to follow; one not reached is tried later. */
  followHandler(): JobHandler {
    const { git, env } = this.deps;
    return {
      runSlice: async () => {
        const sql = git.context.storage.sql;
        const rows = sql
          .exec<{
            pr_number: number;
            head_repo_id: string;
            head_ref: string;
            generation: number;
            follow: number;
            known_sha: string | null;
            requested_at: number;
            revision: number;
          }>(
            "SELECT * FROM head_follows WHERE next_at <= ? ORDER BY requested_at LIMIT ?",
            git.context.now(),
            FOLLOWS_PER_SLICE,
          )
          .toArray();
        for (const row of rows) {
          const head = env.REPO.getByName(row.head_repo_id);
          // Counted before it is made (a failure too): the job queue stops near the call budget.
          git.context.metrics.count("do.request", {
            class: "RepoDO",
            method: row.follow === 1 ? "registerOutgoingPull" : "unregisterOutgoingPull",
          });
          try {
            if (row.follow === 1) {
              const consent = this.#consentOf(row.pr_number);
              await head.registerOutgoingPull({
                baseRepoId: this.deps.repoId(),
                number: row.pr_number,
                headRef: row.head_ref,
                generation: row.generation,
                knownSha: row.known_sha,
                ...(consent && { consent }),
              });
            } else
              await head.unregisterOutgoingPull(this.deps.repoId(), row.pr_number, row.generation);
          } catch (error) {
            this.deps.log().warn("telling a pull request's head repository failed", {
              number: row.pr_number,
              error,
            });
            // Tried again later; the others go on meanwhile.
            sql.exec(
              "UPDATE head_follows SET next_at = ? WHERE pr_number = ? AND revision = ?",
              git.context.now() + FOLLOW_RETRY_MS,
              row.pr_number,
              row.revision,
            );
            continue;
          }
          // Told: gone unless the pull request changed again meanwhile.
          sql.exec(
            "DELETE FROM head_follows WHERE pr_number = ? AND revision = ?",
            row.pr_number,
            row.revision,
          );
        }
        const next = sql
          .exec<{ at: number | null }>("SELECT min(next_at) AS at FROM head_follows")
          .one().at;
        if (next === null) return { done: true };
        return {
          done: false,
          cursor: null,
          runAfterMs: Math.max(0, next - git.context.now()),
        };
      },
    };
  }

  /**
   * A revision of a pull request's head in another repository of the
   * network (told by that repository's object): applied when it needs no
   * import, else queued for import. `closed` when the pull request no
   * longer follows that repository's branch.
   */
  async receiveRevision(notice: RevisionNotice): Promise<NoticeAnswer> {
    const { pulls, pullImports } = this.deps;
    await this.deps.checkEpoch();
    // Taking no changes now (a transfer): the head's repository tells it again later.
    if (this.deps.writeRefusal()) throw new Error("the repository takes no changes now");
    const pull = pulls.get(notice.number);
    if (pull?.state !== "open" || pull.headRepoId !== notice.headRepoId) return "closed";
    if (notice.generation !== pull.generation) return "stale";
    // Later than the revision applied, and than any queued: an older one never replaces them.
    const queued = pullImports.get(notice.number);
    const latest = Math.max(
      pull.headRefVersion ?? -1,
      queued?.generation === pull.generation ? queued.refVersion : -1,
    );
    if (latest >= notice.refVersion) return "stale";
    const actor: RefActor | null = notice.pusher
      ? { principal: notice.pusher, grantId: notice.pusherGrant, via: "push" }
      : null;
    const outcome = this.deps.git.context.storage.transactionSync(() => {
      if (notice.sha === null || notice.sha === pull.headSha) {
        // Deleted, or back where it was: nothing to import, and no older import applies.
        const dropped = pullImports.drop(notice.number);
        pulls.noteRevision(
          notice.number,
          {
            refVersion: notice.refVersion,
            deleted: notice.sha === null,
            pushed: notice.pushed && notice.sha !== null,
          },
          actor,
        );
        return { answer: "applied" as const, release: dropped };
      }
      const { replaced } = pullImports.queue({
        number: notice.number,
        headRepoId: notice.headRepoId,
        generation: notice.generation,
        refVersion: notice.refVersion,
        sha: notice.sha,
        pusher: notice.pusher,
        pusherGrant: notice.pusherGrant,
      });
      return { answer: "queued" as const, release: replaced };
    });
    if (outcome.release) await releaseLease(this.deps.importDeps(), outcome.release);
    this.deps.committed();
    return outcome.answer;
  }

  /**
   * Commits a write a pull request's base made of its head branch here
   * (a merge of the base into it, suggestions applied): the pack the base
   * built, finished through this repository's push path, from `old` only.
   * The writer needs write access here, or the pull request's author lets
   * the base's maintainers write the branch (`maintainerAllowed`, as the
   * base has it, and this repository's own copy), the author still writes
   * here, and the base's check of the writer's token (`baseDecision`) let
   * it through; that consent is checked again in the commit's transaction.
   * With `materialize`, the base commit the write has as a parent is
   * imported first (its history published here before the pack is indexed).
   */
  async receiveHeadWrite(input: PullHeadWrite): Promise<Browsed<{ sha: string }>> {
    const { pullSource, authority } = this.deps;
    await this.deps.checkEpoch();
    const refusedWrite = this.deps.writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    const maintainerFor = {
      baseRepoId: input.baseRepoId,
      number: input.number,
      generation: input.generation,
    };
    const registration = pullSource.registration(
      input.baseRepoId,
      input.number,
      input.generation,
      input.headRef,
    );
    if (!registration)
      return fail(409, "pull_changed", "The pull request no longer follows this branch.");
    const { writer } = input;
    // As a maintainer when the author allows it (the writer's token checked against the base,
    // which it may be limited to); else as one who writes here (its token checked against
    // this repository at the commit).
    if (registration.authorRoot) await this.deps.acl.roleOf(registration.authorRoot, "write");
    const maintainer =
      input.maintainerAllowed &&
      registration.authorRoot !== null &&
      (await authority.principalActive(registration.authorRoot)) &&
      input.baseDecision !== null &&
      input.baseDecision.refusal === undefined &&
      this.maintainerRefusal(maintainerFor, [{ name: `refs/heads/${input.headRef}` }]) ===
        undefined;
    if (!maintainer) {
      const ceilings = await authority.rolesPulled(writer.principal, writer.grantId ?? null);
      if (!atLeast(authority.roleNow(writer.principal, ceilings), "write"))
        return fail(403, "maintainer_edits_off", MAINTAINER_EDITS_OFF_DETAIL);
    }
    const ref = `refs/heads/${input.headRef}`;
    const tip = this.deps.git.refStore.readRefsSync().refs.get(ref);
    if (!tip || oidToHex(tip) !== input.old)
      return fail(409, "head_moved", "The head branch moved; try again.");
    if (input.materialize) {
      const imported = await this.#importFrom(input.baseRepoId, input.materialize);
      if (!imported.ok) return imported;
    }
    const deps = await this.deps.writeDeps();
    const author = { ...writer, repoId: this.deps.repoId() };
    const upload = await storeUpload(deps, author, {
      ref,
      head: tip,
      commit: oidFromHex(input.commit),
      pack: input.pack,
    });
    if (!upload.ok) return upload;
    await this.deps.headWriteHooks().beforeFinish?.();
    const decision = input.baseDecision;
    const committed = await finishUpload(
      deps,
      author,
      upload.value,
      {
        via: "api",
        // Still the pull request's branch, as the base asked.
        fence: () =>
          pullSource.registration(input.baseRepoId, input.number, input.generation, input.headRef)
            ? undefined
            : PULL_CHANGED_HERE,
        ...(maintainer && {
          maintainerFor,
          authority: () => this.maintainerRefusal(maintainerFor, [{ name: ref }]),
        }),
      },
      headWriteRefused,
      maintainer && decision ? async () => decision : undefined,
    );
    if (!committed.ok) return committed;
    return { ok: true, value: { sha: input.commit } };
  }

  /**
   * Why a base's maintainer may not write `refUpdates` here now (undefined
   * when it may): exactly the registered head branch, at the pull
   * request's generation, its author allowing it and writing here still.
   */
  maintainerRefusal(
    maintainerFor: MaintainerFor,
    refUpdates: readonly { readonly name: string }[],
  ): string | undefined {
    const own = refUpdates.filter((u) => !u.name.startsWith(DERIVED_REF_PREFIX));
    const [update] = own;
    if (own.length !== 1 || !update?.name.startsWith("refs/heads/")) return MAINTAINER_EDITS_OFF;
    const registration = this.deps.pullSource.registration(
      maintainerFor.baseRepoId,
      maintainerFor.number,
      maintainerFor.generation,
      update.name.slice("refs/heads/".length),
    );
    if (!registration?.maintainerCanModify || !registration.authorRoot) return MAINTAINER_EDITS_OFF;
    return this.deps.acl.allows(registration.authorRoot, "write")
      ? undefined
      : MAINTAINER_EDITS_OFF;
  }

  /**
   * Imports the commit `sha` of `sourceRepoId` (another member of the
   * network) with its history: its packs borrowed, its commit rows copied
   * and published at once, so a write naming it as a parent is indexed.
   */
  async #importFrom(sourceRepoId: string, sha: string): Promise<Browsed<true>> {
    const { git } = this.deps;
    // Even with its commit rows here, its objects may be in packs collected since: always
    // borrowed again (the graph step copies only the commits missing).
    const imported = await importInForeground(
      this.deps.importDeps(),
      { importId: `head-write:${crypto.randomUUID()}`, headRepoId: sourceRepoId, sha },
      {
        policy: this.deps.importPolicy(),
        maxSteps: OPEN_IMPORT_STEPS,
        budget: { used: 0, max: OPEN_IMPORT_CALLS },
      },
      async (work) =>
        git.context.storage.transactionSync(() => {
          if (!readyToPublish(this.deps.importDeps(), work)) return false;
          publishStaged(git, work.importId);
          return true;
        }),
    );
    if (!imported.ok)
      return imported.code === "too_expensive"
        ? fail(422, "too_expensive", "The base branch is too far ahead to bring here now.")
        : imported.code === "view_full"
          ? fail(422, "view_full", VIEW_FULL_DETAIL)
          : BUSY;
    return imported.value ? { ok: true, value: true } : BUSY;
  }
}
