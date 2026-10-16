import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  atLeast,
  type CommitIdentity,
  coAuthorTrailers,
  type GitPerson,
  rootIdentity,
} from "@fyrden/domain";
import {
  appendTrailers,
  type BlockCache,
  isAncestor,
  type Oid,
  oidFromHex,
  oidToHex,
  WalkLimitError,
} from "@fyrden/git-core";
import { reauthorizeByToken } from "../../git/push/reauthorize-token.js";
import type { RepoAcl } from "./acl.js";
import { type RepoAuthority, ZERO_ID } from "./authority.js";
import { type Browsed, fail, RepoBrowse } from "./browse.js";
import {
  CONFLICTS_POLICY,
  type ConflictsView,
  type MergedIntoHead,
  mergeIntoHead,
  parseSnapshot,
  readConflicts,
} from "./conflicts.js";
import {
  type FileWriteDeps,
  type FileWriteResult,
  writeFiles,
  refused as writeRefused,
} from "./file-writes.js";
import type { MergePolicy } from "./merge.js";
import type { PullRecord, RepoPulls } from "./pulls.js";
import type { RepoReviewComments, ReviewCommentRecord } from "./review-comments.js";
import { suggestedChanges } from "./suggestions.js";

/*
 * Writes of an open pull request's head branch made through its base
 * repository: diff comments' suggestions applied, conflicts with the base
 * branch resolved, the branch brought up to date. Each is checked here
 * (the caller's write access, the head branch's rulesets) and committed
 * only while the pull request is as the write was built for. A head
 * branch in another repository of the network is written there: the write
 * is built here and handed over (`#sendHeadWrite`), that repository
 * checking its own side in its commit.
 */

/** Why applying suggestions was refused at the commit point. */
const SUGGESTIONS_CHANGED =
  "the pull request or its comments changed while the suggestions were applied";

/** Suggestions to apply to a pull request's head, as the Worker asks for it. */
export interface ApplySuggestionsInput {
  readonly number: number;
  readonly commentIds: readonly number[];
  readonly message: string;
  readonly committer: GitPerson;
  readonly author: GitPerson;
}

/** A merge of the base branch into a pull request's head branch, as the Worker asks for it. */
export interface BaseMergeInput {
  readonly number: number;
  /** Who it is by (the caller; an agent's with its `Co-authored-by`). */
  readonly identity: CommitIdentity;
  /** The commit's message; by default `Merge branch '<base>' into <head>`. */
  readonly message?: string;
}

/** Conflicts resolved, as the Worker asks for it. */
export interface ResolveConflictsInput extends BaseMergeInput {
  /** The base tip and head the conflicts were read at (`ConflictsView.snapshot`). */
  readonly snapshot: string;
  /** The resolved contents of every file whose lines conflict. */
  readonly files: readonly { readonly path: string; readonly content: string }[];
}

/** A head branch brought up to date with its base branch, as the Worker asks for it. */
export interface UpdateBranchInput extends BaseMergeInput {
  /** The head the caller saw: refused (409) when the pull request is elsewhere. */
  readonly expectedHead?: string;
}

/** Why a merge into the head was refused at its commit: the base branch moved meanwhile. */
const BASE_MOVED_WHILE_MERGING = "the base branch moved while the merge was being made";
/** Why a merge into the head was refused at its commit: the pull request closed or was retargeted. */
const PULL_CHANGED_WHILE_MERGING = "the pull request changed while the merge was being made";

/** An open pull request's head and base tip, as a write of its head branch starts from them. */
type HeadAt = { readonly pull: PullRecord; readonly head: Oid; readonly baseTip: Oid };

export interface HeadWriteDeps {
  readonly git: RepoGitStorage;
  readonly env: Env;
  readonly acl: RepoAcl;
  readonly pulls: RepoPulls;
  readonly reviewComments: RepoReviewComments;
  readonly authority: RepoAuthority;
  readonly memoryBlocks: () => BlockCache;
  readonly repoId: () => string;
  /** Takes the directory's epoch (a commit needs it first). */
  readonly checkEpoch: () => Promise<void>;
  /** Why the repository takes no change now. */
  readonly writeRefusal: () => { status: 404 | 409; code: string; error: string } | undefined;
  /** The write deps of the current invocation. */
  readonly writeDeps: () => Promise<FileWriteDeps>;
  /** After a change: what the object does after any it makes (outbox, audit). */
  readonly committed: () => void;
  readonly mergePolicy: () => MergePolicy;
  /** For tests: runs before suggestions are written. */
  readonly suggestionHooks: () => { readonly beforeWrite?: () => Promise<void> };
  /** For tests: runs before a merge into the head is committed. */
  readonly headMergeHooks: () => { readonly beforeFinish?: () => Promise<void> };
}

export class HeadBranchWrites {
  constructor(private readonly deps: HeadWriteDeps) {}

  /**
   * Applies the suggestions of diff comments to a pull request's head
   * branch as one commit, through the file-write path (the branch moves
   * only from the head the comments are on; the writer's token is checked
   * again at the commit point), for a caller with write access; their
   * threads are resolved then.
   */
  async applySuggestions(
    input: ApplySuggestionsInput,
    actor: RefActor,
  ): Promise<Browsed<FileWriteResult & { readonly paths: readonly string[] }>> {
    const { git, pulls, reviewComments, authority } = this.deps;
    await this.deps.checkEpoch();
    const ceilings = await authority.rolesPulled(actor.principal, actor.grantId ?? null);
    const refusedWrite = this.deps.writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    const role = authority.roleNow(actor.principal, ceilings);
    if (!atLeast(role, "write"))
      return fail(403, "forbidden", "Applying suggestions takes write access.");
    const pull = pulls.get(input.number);
    if (!pull)
      return fail(404, "pull_not_found", `The repository has no pull request ${input.number}.`);
    if (pull.state !== "open")
      return fail(422, "wrong_state", `Pull request ${input.number} is not open.`);
    const ids = [...new Set(input.commentIds)];
    const comments = ids.map((id) => reviewComments.get(id));
    const browse = new RepoBrowse({ git, memoryBlocks: this.deps.memoryBlocks() });
    let changes: Awaited<ReturnType<typeof suggestedChanges>>;
    try {
      changes = await suggestedChanges(browse, pull, comments, ids);
    } finally {
      browse.close();
    }
    if (!changes.ok) return changes;
    const caller = {
      actor,
      root: rootIdentity({
        principalId: actor.principal,
        grantId: actor.grantId ?? null,
        ceilingIds: ceilings,
      }),
      role,
    };
    const applied = comments as ReviewCommentRecord[];
    // Still open, its comments reading as they were.
    const unchanged = () =>
      pulls.get(input.number)?.state === "open" &&
      applied.every((c) => reviewComments.get(c.id)?.version === c.version);
    const resolveThreads = () => {
      for (const threadId of new Set(applied.map((c) => c.threadId)))
        reviewComments.resolve(input.number, threadId, true, caller);
    };
    await this.deps.suggestionHooks().beforeWrite?.();
    const written = await writeFiles(
      await this.deps.writeDeps(),
      {
        principal: actor.principal,
        tokenId: actor.tokenId ?? "",
        grantId: actor.grantId ?? null,
        repoId: this.deps.repoId(),
        requestId: actor.requestId ?? null,
        committer: input.committer,
        author: input.author,
        branch: pull.headRef,
        expectedHead: pull.headSha,
        message: input.message,
        changes: changes.value,
      },
      {
        meta: {
          // Committed only while the pull request is open and the comments read as they were.
          fence: () => (unchanged() ? undefined : SUGGESTIONS_CHANGED),
          // With the commit: their threads are resolved, as GitHub's are.
          inCommit: resolveThreads,
        },
        // A head branch in another repository: committed there, this side checked right before.
        ...(pull.headRepoId && {
          elsewhere: {
            ref: `refs/heads/${pull.headRef}`,
            head: oidFromHex(pull.headSha),
            send: (commit: Oid, pack: Uint8Array) =>
              this.#sendHeadWrite(
                pull,
                actor,
                { old: oidFromHex(pull.headSha), commit, pack },
                () => (unchanged() ? undefined : SUGGESTIONS_CHANGED),
              ),
          },
        }),
        onRefused: (report) =>
          !report.ok && report.error.includes(SUGGESTIONS_CHANGED)
            ? fail(
                409,
                "pull_changed",
                "The pull request or its comments changed while the suggestions were applied; try again.",
              )
            : writeRefused(report),
      },
    );
    if (!written.ok) return written;
    // Committed there: the threads resolved here after, while the comments are unchanged.
    if (pull.headRepoId)
      git.context.storage.transactionSync(() => {
        if (unchanged()) resolveThreads();
      });
    this.deps.committed();
    return { ok: true, value: { ...written.value, paths: changes.value.map((c) => c.path) } };
  }

  /**
   * The conflicts of merging an open pull request's base branch into its
   * head: each conflicted file, those of lines in text files with their
   * contents and markers, and the snapshot a resolution names.
   */
  async conflicts(number: number): Promise<Browsed<ConflictsView>> {
    const at = this.#headMergeable(number);
    if (!at.ok) return at;
    return readConflicts(
      { git: this.deps.git, memoryBlocks: this.deps.memoryBlocks() },
      {
        baseTip: at.value.baseTip,
        head: at.value.head,
        baseLabel: at.value.pull.baseRef,
        headLabel: at.value.pull.headRef,
      },
      this.deps.mergePolicy(),
    );
  }

  /**
   * Resolves an open pull request's conflicts with its base branch: the
   * base tip merged into the head on the head branch, with the given
   * contents for each file whose lines conflict, made at the snapshot the
   * conflicts were read at (409 when either side moved since).
   */
  async resolveConflicts(
    input: ResolveConflictsInput,
    actor: RefActor,
  ): Promise<Browsed<MergedIntoHead>> {
    const at = await this.#headWritable(input.number, actor);
    if (!at.ok) return at;
    const snapshot = parseSnapshot(input.snapshot);
    if (!snapshot) return fail(422, "invalid_input", "The conflict snapshot is not one read here.");
    if (snapshot.headSha !== oidToHex(at.value.head))
      return fail(409, "head_moved", "The head branch moved since the conflicts were read.");
    if (snapshot.baseSha !== oidToHex(at.value.baseTip))
      return fail(409, "base_moved", "The base branch moved since the conflicts were read.");
    const resolutions = new Map<string, Uint8Array>();
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const file of input.files) {
      if (resolutions.has(file.path))
        return fail(422, "invalid_input", `The file ${file.path} is given more than once.`);
      const content = encoder.encode(file.content);
      bytes += content.length;
      if (
        content.length > this.deps.mergePolicy().maxFileBytes ||
        bytes > CONFLICTS_POLICY.maxContentBytes
      )
        return fail(
          422,
          "too_large",
          `Resolved files are ${this.deps.mergePolicy().maxFileBytes} bytes each at most, ${CONFLICTS_POLICY.maxContentBytes} in all.`,
        );
      resolutions.set(file.path, content);
    }
    return this.#mergeIntoHead(input, actor, at.value, resolutions);
  }

  /**
   * Brings an open pull request's head branch up to date: the base tip
   * merged into it (refused when that conflicts, or when the head already
   * contains the base tip).
   */
  async updateBranch(input: UpdateBranchInput, actor: RefActor): Promise<Browsed<MergedIntoHead>> {
    const at = await this.#headWritable(input.number, actor);
    if (!at.ok) return at;
    if (input.expectedHead !== undefined && input.expectedHead !== oidToHex(at.value.head))
      return fail(409, "head_moved", "The head branch was modified; review it and try again.");
    try {
      const walk = { maxCommits: this.deps.mergePolicy().maxCommits };
      if (
        await isAncestor(
          this.deps.git.commitGraph,
          "verified",
          at.value.baseTip,
          at.value.head,
          walk,
        )
      )
        return fail(
          422,
          "up_to_date",
          "The head branch already contains the base branch's latest commit.",
        );
    } catch (error) {
      if (!(error instanceof WalkLimitError)) throw error;
      return fail(422, "too_expensive", "The base branch and the head are too far apart.");
    }
    return this.#mergeIntoHead(input, actor, at.value, undefined);
  }

  /** The head and base tip of an open pull request, to merge the base tip into the head. */
  #headMergeable(number: number): Browsed<HeadAt> {
    const { pulls } = this.deps;
    const pull = pulls.get(number);
    if (!pull) return fail(404, "pull_not_found", `The repository has no pull request ${number}.`);
    if (pull.state !== "open")
      return fail(422, "wrong_state", `Pull request ${number} is not open.`);
    // A head branch in another repository: its tip as this repository last had it (that one
    // moves it only from there).
    const head = pull.headRepoId ? oidFromHex(pull.headSha) : pulls.branchTip(pull.headRef);
    if (!head || pull.headRefDeleted)
      return fail(422, "head_not_found", "The head branch does not exist.");
    if (oidToHex(head) !== pull.headSha)
      return fail(409, "head_moved", "The head branch is being updated; try again.");
    const baseTip = pulls.branchTip(pull.baseRef);
    if (!baseTip) return fail(422, "base_not_found", "The base branch does not exist.");
    return { ok: true, value: { pull, head, baseTip } };
  }

  /** `#headMergeable` for a caller who may write to the head branch (its rulesets judged now). */
  async #headWritable(number: number, actor: RefActor): Promise<Browsed<HeadAt>> {
    const { authority } = this.deps;
    await this.deps.checkEpoch();
    const ceilings = await authority.rolesPulled(actor.principal, actor.grantId ?? null);
    const refusedWrite = this.deps.writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    if (!atLeast(authority.roleNow(actor.principal, ceilings), "write"))
      return fail(403, "forbidden", "Changing the head branch takes write access.");
    const at = this.#headMergeable(number);
    if (!at.ok) return at;
    // A head branch in another repository: its rulesets are judged there, at the commit.
    if (at.value.pull.headRepoId) return at;
    const precheck = await authority.precheckUpdates(
      actor.principal,
      [{ ref: `refs/heads/${at.value.pull.headRef}`, old: oidToHex(at.value.head), new: ZERO_ID }],
      actor.grantId ?? null,
    );
    if (precheck) return fail(422, "write_refused", precheck);
    return at;
  }

  /**
   * Hands a write of an open pull request's head branch, built here, to
   * the repository the branch is in (see `pullHeadWrite`): this side is
   * checked right before (`fence`, and the writer's token against this
   * repository); that one checks its own in the commit. A close, a
   * retarget or a change of the author's consent landing during the
   * handoff does not stop a write already handed over; later ones are.
   */
  async #sendHeadWrite(
    pull: PullRecord,
    actor: RefActor,
    write: {
      readonly old: Oid;
      readonly commit: Oid;
      readonly pack: Uint8Array;
      readonly materialize?: Oid;
    },
    fence: () => string | undefined,
  ): Promise<Browsed<{ sha: string }>> {
    const { env } = this.deps;
    const writer = {
      principal: actor.principal,
      tokenId: actor.tokenId ?? "",
      grantId: actor.grantId ?? null,
      requestId: actor.requestId ?? null,
    };
    const decision = await reauthorizeByToken(
      env.DIRECTORY,
      { ...writer, repoId: this.deps.repoId() },
      (principalId) => this.deps.acl.roleOf(principalId, "write"),
    );
    if (decision.refusal) return fail(403, "forbidden", decision.refusal);
    // Not frozen (for a transfer) or deleted meanwhile.
    const refusedWrite = this.deps.writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    // Still the pull request the write was built for: open, between the same branches.
    const now = this.deps.pulls.get(pull.number);
    if (
      now?.state !== "open" ||
      now.generation !== pull.generation ||
      now.baseRef !== pull.baseRef ||
      now.headRef !== pull.headRef ||
      now.headRepoId !== pull.headRepoId
    )
      return fail(
        409,
        "pull_changed",
        "The pull request was closed, reopened or retargeted meanwhile; try again.",
      );
    const fenced = fence();
    if (fenced) return fail(409, "pull_changed", fenced);
    return env.REPO.getByName(pull.headRepoId as string).pullHeadWrite({
      baseRepoId: this.deps.repoId(),
      number: pull.number,
      generation: pull.generation,
      headRef: pull.headRef,
      old: oidToHex(write.old),
      commit: oidToHex(write.commit),
      pack: write.pack,
      ...(write.materialize && { materialize: oidToHex(write.materialize) }),
      writer,
      maintainerAllowed: now.maintainerCanModify,
      baseDecision: decision,
    });
  }

  /** The base tip merged into the head on the head branch (see `mergeIntoHead`). */
  async #mergeIntoHead(
    input: BaseMergeInput,
    actor: RefActor,
    at: HeadAt,
    /** The resolved contents of the files whose lines conflict; none to update the branch. */
    resolutions: ReadonlyMap<string, Uint8Array> | undefined,
  ): Promise<Browsed<MergedIntoHead>> {
    const { pulls } = this.deps;
    const { pull } = at;
    const given = input.message ?? `Merge branch '${pull.baseRef}' into ${pull.headRef}`;
    const text = given.endsWith("\n") ? given : `${given}\n`;
    if (text.includes("\0"))
      return fail(422, "invalid_input", "A commit message must not contain NUL.");
    // The pull request still open between the same branches, the base branch still at the tip
    // merged (the head moves with compare-and-set).
    const fence = () => {
      const now = pulls.get(input.number);
      if (
        now?.state !== "open" ||
        now.generation !== pull.generation ||
        now.baseRef !== pull.baseRef ||
        now.headRef !== pull.headRef ||
        now.headRepoId !== pull.headRepoId
      )
        return PULL_CHANGED_WHILE_MERGING;
      return pulls.branchTip(pull.baseRef)?.every((b, i) => b === at.baseTip[i]) === true
        ? undefined
        : BASE_MOVED_WHILE_MERGING;
    };
    const made = await mergeIntoHead(
      await this.deps.writeDeps(),
      {
        writer: {
          principal: actor.principal,
          tokenId: actor.tokenId ?? "",
          grantId: actor.grantId ?? null,
          repoId: this.deps.repoId(),
          requestId: actor.requestId ?? null,
        },
        headRef: `refs/heads/${pull.headRef}`,
        baseTip: at.baseTip,
        head: at.head,
        resolutions: resolutions ?? new Map(),
        resolving: resolutions !== undefined,
        author: input.identity.author,
        committer: input.identity.committer,
        message: appendTrailers(text, coAuthorTrailers(text, input.identity.coAuthors)),
        meta: { fence },
        ...(this.deps.headMergeHooks().beforeFinish && {
          beforeFinish: this.deps.headMergeHooks().beforeFinish,
        }),
        // The base tip is a parent: brought into the head's repository with its history.
        ...(pull.headRepoId && {
          send: (commit: Oid, pack: Uint8Array) =>
            this.#sendHeadWrite(
              pull,
              actor,
              { old: at.head, commit, pack, materialize: at.baseTip },
              fence,
            ),
        }),
      },
      this.deps.mergePolicy(),
    );
    this.deps.committed();
    if (!made.ok && made.error.includes(BASE_MOVED_WHILE_MERGING))
      return fail(409, "base_moved", "The base branch moved while the merge was made; try again.");
    if (!made.ok && made.error.includes(PULL_CHANGED_WHILE_MERGING))
      return fail(
        409,
        "pull_changed",
        "The pull request was closed or retargeted while the merge was made.",
      );
    return made;
  }
}
