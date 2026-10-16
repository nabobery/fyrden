import type {
  CommitContext,
  DerivedRefUpdate,
  RefActor,
  RepoGitStorage,
} from "@fyrden/adapters-cloudflare/git";
import {
  decidePullAction,
  PULL_ACTION_RULES,
  PULL_ENTITY,
  type PullAction,
  type PullRefusal,
  type PullRequestRow,
  type PullState,
  pullHeadRef,
  type RepoRole,
} from "@fyrden/domain";
import {
  type Oid,
  oidEquals,
  oidFromBytes,
  oidFromHex,
  oidToHex,
  type RefUpdate,
} from "@fyrden/git-core";
import type { RepoEvents } from "./events.js";

const BRANCHES = "refs/heads/";
const PULL_HEAD = /^refs\/pull\/([1-9][0-9]*)\/head$/;

/** What a pull request listing pages through. */
export type ListingKind = "files" | "commits";

/** How long a listing's later pages keep its comparison. Proposed. */
export const LISTING_TTL_MS = 24 * 60 * 60 * 1000;

/** Listings a repository keeps at most (the oldest go first). Proposed. */
export const MAX_LISTINGS = 1_000;

/** A pull request as the repository keeps it. */
export interface PullRecord extends PullRequestRow {
  /** The agents that opened it for `authorId`, the current one first; empty when it acted itself. */
  readonly authorAct: readonly string[];
  /**
   * Who made the head what it is (its opener, the last push to its branch,
   * or a reopening that took a newer head), under which grant, and when;
   * null when unknown.
   */
  readonly lastPusher: string | null;
  readonly lastPusherGrant: string | null;
  readonly lastPushAt: number | null;
  /** For a head in another repository: the ref-state version there of the revision applied last. */
  readonly headRefVersion: number | null;
  /** The author lets the base's maintainers write the head branch (in another repository). */
  readonly maintainerCanModify: boolean;
  /** Bumped on every change. */
  readonly version: number;
}

type Row = {
  number: number;
  title: string;
  body: string | null;
  state: PullState;
  draft: number;
  author_id: string;
  author_root: string;
  author_act: string | null;
  base_ref: string;
  base_sha: string;
  head_ref: string;
  head_sha: string;
  head_ref_deleted: number;
  head_repo_id: string | null;
  head_ref_version: number | null;
  maintainer_can_modify: number;
  last_pusher: string | null;
  last_pusher_grant: string | null;
  last_push_at: number | null;
  merge_commit_sha: string | null;
  merged_by: string | null;
  merged_at: number | null;
  generation: number;
  version: number;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
};

/** What opening a pull request needs; the branches' tips were read at `expectedVersion`. */
export interface OpenPull {
  readonly title: string;
  readonly body: string | null;
  readonly draft: boolean;
  /** Branch names, without `refs/heads/`. */
  readonly baseRef: string;
  readonly headRef: string;
  readonly baseSha: Oid;
  readonly headSha: Oid;
  /** For a head in another repository of the network: it, and its ref-state version at `headSha`. */
  readonly headRepoId?: string;
  readonly headRefVersion?: number;
  readonly maintainerCanModify?: boolean;
}

/** A change asked of a pull request; a field left out stays as it is. */
export interface PullPatch {
  readonly title?: string;
  readonly body?: string | null;
  readonly state?: "open" | "closed";
  readonly base?: string;
  readonly draft?: boolean;
  readonly maintainerCanModify?: boolean;
}

export type PullChangeFailure =
  | PullRefusal
  | "not_found"
  | "base_not_found"
  | "same_branches"
  | "already_exists";

/** Who is acting: the actor, the root identity it counts as, and its role now. */
export interface PullCaller {
  readonly actor: RefActor;
  readonly root: string;
  readonly role: RepoRole | null;
}

/**
 * The repository's pull requests between its own branches. An open pull
 * request's `refs/pull/<number>/head` follows its head branch in the
 * transaction that moves the branch (the ref store's derived updates);
 * every change of a row emits its snapshot and writes its audit row in the
 * same transaction.
 */
export class RepoPulls {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
      readonly repoId: () => string;
      /**
       * In the transaction of a change: whether the pull request merges must
       * be worked out again (open), or no longer (closed or merged).
       */
      readonly stale?: (number: number, open: boolean) => void;
      /** In a commit's transaction: base branch `branch` moved, so its open pull requests' too. */
      readonly staleBase?: (branch: string) => void;
      /**
       * In the transaction of a change of a pull request whose head is in
       * another repository: it opened, closed or reopened, so that
       * repository must follow the branch for it, or no longer.
       */
      readonly follow?: (pull: PullRecord) => void;
    },
  ) {}

  get(number: number): PullRecord | undefined {
    const row = this.#rows("SELECT * FROM pull_requests WHERE number = ?", number)[0];
    return row && record(row);
  }

  /** Newest first, below `before` (a number) when given; `closed` includes merged ones, as GitHub's does. */
  list(state: PullState | "all", before: number | undefined, limit: number): PullRecord[] {
    const below = before ?? Number.MAX_SAFE_INTEGER;
    const rows =
      state === "all"
        ? this.#rows(
            "SELECT * FROM pull_requests WHERE number < ? ORDER BY number DESC LIMIT ?",
            below,
            limit,
          )
        : this.#rows(
            `SELECT * FROM pull_requests WHERE state IN (?, ?) AND number < ?
             ORDER BY number DESC LIMIT ?`,
            state,
            state === "closed" ? "merged" : state,
            below,
            limit,
          );
    return rows.map(record);
  }

  /** The ref store's derived updates: each open pull request's ref follows its head branch. */
  derive(updates: readonly RefUpdate[]): DerivedRefUpdate[] {
    const derived: DerivedRefUpdate[] = [];
    for (const update of updates) {
      if (update.newOid === null || !update.name.startsWith(BRANCHES)) continue;
      for (const { number } of this.#rows<{ number: number }>(
        `SELECT number FROM pull_requests
         WHERE head_ref = ? AND state = 'open' AND head_repo_id IS NULL`,
        update.name.slice(BRANCHES.length),
      ))
        derived.push({ name: pullHeadRef(number), newOid: update.newOid, follows: update.name });
    }
    return derived;
  }

  /**
   * In every commit's transaction: the new head of each pull request whose
   * ref followed its branch, and the head branches deleted or created again.
   */
  onCommit(context: CommitContext): void {
    const { request, derived, now } = context;
    const actor = request.actor ?? null;
    for (const update of request.refUpdates) {
      if (!update.name.startsWith(BRANCHES)) continue;
      const branch = update.name.slice(BRANCHES.length);
      // The base branch moved: whether its pull requests merge changes with it.
      this.deps.staleBase?.(branch);
      const deleted = update.newOid === null;
      if (!deleted && update.oldOid !== null) continue;
      for (const row of this.#rows(
        `UPDATE pull_requests SET head_ref_deleted = ?, version = version + 1, updated_at = ?
         WHERE head_ref = ? AND state != 'merged' AND head_ref_deleted = ?
           AND head_repo_id IS NULL RETURNING *`,
        deleted ? 1 : 0,
        now,
        branch,
        deleted ? 0 : 1,
      ))
        this.#emit(deleted ? "head_ref_deleted" : "head_ref_restored", record(row), actor);
    }
    for (const update of derived) {
      const number = Number(PULL_HEAD.exec(update.name)?.[1]);
      if (!number || update.newOid === null) continue;
      const [row] = this.#rows(
        `UPDATE pull_requests SET head_sha = ?, last_pusher = ?, last_pusher_grant = ?,
           last_push_at = ?, version = version + 1, updated_at = ?
         WHERE number = ? AND state = 'open' RETURNING *`,
        oidToHex(update.newOid),
        actor?.principal ?? null,
        actor?.grantId ?? null,
        now,
        now,
        number,
      );
      if (row)
        this.#emit("synchronize", record(row), actor, {
          before: update.oldOid && oidToHex(update.oldOid),
          after: row.head_sha,
        });
    }
  }

  /**
   * Whether a merge begun on `at` may commit now (its fence, in the commit
   * transaction): the pull request is still open and ready, in the
   * generation, at the head (from the same last push) and on the base the
   * merge was made for.
   */
  mergeFence(number: number, at: PullRecord): boolean {
    const now = this.get(number);
    return (
      now !== undefined &&
      now.state === "open" &&
      !now.draft &&
      now.generation === at.generation &&
      now.headSha === at.headSha &&
      now.baseRef === at.baseRef &&
      // A head moved away and back is a newer push: the approvals were judged against the old one.
      now.lastPusher === at.lastPusher &&
      now.lastPusherGrant === at.lastPusherGrant &&
      now.lastPushAt === at.lastPushAt
    );
  }

  /**
   * In a merge's commit transaction: the pull request is merged into
   * `sha` by `actor`; it emits `closed` and records the merge, with the
   * base branch's tip the merge was made on (`base`: the branch has moved
   * already) as the base the pull request is compared from from now on.
   */
  markMerged(
    number: number,
    merge: { readonly sha: Oid; readonly base: Oid; readonly method: string },
    actor: RefActor,
    now: number,
  ): void {
    const { sha, base, method } = merge;
    const rule = PULL_ACTION_RULES.merge;
    const [row] = this.#rows(
      `UPDATE pull_requests SET state = 'merged', merge_commit_sha = ?, base_sha = ?,
         merged_by = ?, merged_at = ?, closed_at = ?, version = version + 1, updated_at = ?
       WHERE number = ? AND state = 'open' RETURNING *`,
      oidToHex(sha),
      oidToHex(base),
      actor.principal,
      now,
      now,
      now,
      number,
    );
    // The fence ran in this transaction: it is open.
    if (!row) throw new Error(`pull request ${number} is not open to merge`);
    this.#emit(rule.event, record(row), actor);
    this.deps.events.auditChange(rule.audit, actor, { number, sha: oidToHex(sha), method });
  }

  /**
   * In the publishing transaction: a revision of a head in another
   * repository becomes the pull request's head (its ref moves, from where
   * it is), when the pull request is still open in `generation` and the
   * revision is later than the one applied; `inCommit` runs in the same
   * transaction first (the import's commit rows join the graph). False
   * when it no longer applies.
   */
  publishRevision(
    number: number,
    revision: {
      readonly headRepoId: string;
      readonly generation: number;
      readonly refVersion: number;
      readonly sha: string;
      readonly pusher: string | null;
      readonly pusherGrant: string | null;
    },
    inCommit: () => void,
  ): boolean {
    const current = this.get(number);
    if (
      current?.state !== "open" ||
      current.headRepoId !== revision.headRepoId ||
      current.generation !== revision.generation ||
      (current.headRefVersion ?? -1) >= revision.refVersion
    )
      return false;
    const ref = pullHeadRef(number);
    // The ref is the server's to move (the pusher pushed to the other repository, and may not
    // even read this one); the event names the pusher.
    const actor: RefActor | null = revision.pusher
      ? { principal: revision.pusher, grantId: revision.pusherGrant, via: "push" }
      : null;
    let moved = false;
    const result = this.deps.git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [{ name: ref, oldOid: this.#read(ref), newOid: oidFromHex(revision.sha) }],
      expectedVersion: this.deps.git.refStore.state().version,
      onCommitted: ({ now }) => {
        inCommit();
        const [row] = this.#rows(
          `UPDATE pull_requests SET head_sha = ?, head_ref_version = ?, head_ref_deleted = 0,
             last_pusher = ?, last_pusher_grant = ?, last_push_at = ?, version = version + 1,
             updated_at = ?
           WHERE number = ? RETURNING *`,
          revision.sha,
          revision.refVersion,
          revision.pusher,
          revision.pusherGrant,
          now,
          now,
          number,
        );
        this.#emit("synchronize", record(row as Row), actor, {
          before: current.headSha,
          after: revision.sha,
        });
        moved = true;
      },
    });
    if (!result.ok)
      throw new Error(`moving pull request ${number}'s head failed: ${result.reason}`);
    return moved;
  }

  /**
   * A revision of a head in another repository that needs no import: its
   * branch was deleted (`sha` null), or is back at the head the pull
   * request has. Records the version, and whether the branch exists.
   */
  noteRevision(
    number: number,
    revision: {
      readonly refVersion: number;
      readonly deleted: boolean;
      /** A push (moved away and back to the same commit), not a following only started. */
      readonly pushed: boolean;
    },
    actor: RefActor | null,
  ): void {
    const current = this.get(number);
    if (!current) return;
    const now = this.deps.git.context.now();
    // Back at the same commit by a push: its pusher is the last pusher now (unknown when the
    // notice names none), so earlier approvals do not answer it.
    const [row] = !revision.pushed
      ? this.#rows(
          `UPDATE pull_requests SET head_ref_version = ?, head_ref_deleted = ?,
             version = version + 1, updated_at = ?
           WHERE number = ? RETURNING *`,
          revision.refVersion,
          revision.deleted ? 1 : 0,
          now,
          number,
        )
      : this.#rows(
          `UPDATE pull_requests SET head_ref_version = ?, head_ref_deleted = 0, last_pusher = ?,
             last_pusher_grant = ?, last_push_at = ?, version = version + 1, updated_at = ?
           WHERE number = ? RETURNING *`,
          revision.refVersion,
          actor?.principal ?? null,
          actor?.grantId ?? null,
          now,
          now,
          number,
        );
    if (current.headRefDeleted !== revision.deleted)
      this.#emit(
        revision.deleted ? "head_ref_deleted" : "head_ref_restored",
        record(row as Row),
        actor,
      );
  }

  /** Whether the pull request's head has been `sha`, now or before. */
  hadHead(number: number, sha: string): boolean {
    return (
      this.#rows<{ one: number }>(
        "SELECT 1 AS one FROM pull_heads WHERE pr_number = ? AND sha = ?",
        number,
        sha,
      ).length > 0
    );
  }

  /**
   * Records the comparison a listing of a pull request's files or commits
   * started on, for its later pages, and returns the listing's id (random:
   * the only way to name it is a cursor this repository gave). Listings
   * older than {@link LISTING_TTL_MS} are dropped as new ones start.
   */
  startListing(number: number, kind: ListingKind, base: string, head: string): string {
    const now = this.deps.git.context.now();
    return this.deps.git.context.storage.transactionSync(() => {
      // The same comparison started within the day: its listing serves.
      const [same] = this.#rows<{ listing_id: string }>(
        `SELECT listing_id FROM pull_listings
         WHERE pr_number = ? AND kind = ? AND base_sha = ? AND head_sha = ? AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
        number,
        kind,
        base,
        head,
        now - LISTING_TTL_MS,
      );
      if (same) return same.listing_id;
      // A bounded amount of tidying each time: the expired, then the oldest past the cap.
      this.#rows(
        `DELETE FROM pull_listings WHERE listing_id IN (
           SELECT listing_id FROM pull_listings WHERE created_at < ? ORDER BY created_at LIMIT 100)`,
        now - LISTING_TTL_MS,
      );
      this.#rows(
        `DELETE FROM pull_listings WHERE listing_id IN (
           SELECT listing_id FROM pull_listings ORDER BY created_at
           LIMIT max(0, (SELECT count(*) FROM pull_listings) - ? + 1))`,
        MAX_LISTINGS,
      );
      const id = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      this.#rows(
        "INSERT INTO pull_listings (listing_id, pr_number, kind, base_sha, head_sha, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        number,
        kind,
        base,
        head,
        now,
      );
      return id;
    });
  }

  /** A listing's comparison, if `id` names one of this pull request's, of `kind`, still kept. */
  listing(
    number: number,
    kind: ListingKind,
    id: string,
  ): { base: string; head: string } | undefined {
    const [row] = this.#rows<{ base_sha: string; head_sha: string; created_at: number }>(
      "SELECT base_sha, head_sha, created_at FROM pull_listings WHERE listing_id = ? AND pr_number = ? AND kind = ?",
      id,
      number,
      kind,
    );
    if (!row || row.created_at < this.deps.git.context.now() - LISTING_TTL_MS) return undefined;
    return { base: row.base_sha, head: row.head_sha };
  }

  /** The open pull request from `head` (in `headRepoId`, null for this repository) into `base`, if there is one. */
  openBetween(head: string, base: string, headRepoId: string | null = null): number | undefined {
    return this.#rows<{ number: number }>(
      `SELECT number FROM pull_requests
       WHERE head_ref = ? AND base_ref = ? AND state = 'open' AND head_repo_id IS ?`,
      head,
      base,
      headRepoId,
    )[0]?.number;
  }

  /**
   * Opens a pull request: allocates its number and creates its ref at the
   * head, in one ref transaction with the row, its event and its audit
   * row. Synchronous: the caller read the tips at `expectedVersion` and
   * retries on a version conflict.
   */
  open(
    input: OpenPull,
    expectedVersion: number,
    caller: Omit<PullCaller, "role">,
    /** Runs in the ref transaction, before the row is written (an import's commit rows join the graph). */
    inCommit?: () => void,
  ):
    | { ok: true; record: PullRecord }
    | { ok: false; code: "version-conflict" }
    | { ok: false; code: "already_exists"; number: number }
    | { ok: false; code: "access_lost" } {
    const existing = this.openBetween(input.headRef, input.baseRef, input.headRepoId ?? null);
    if (existing !== undefined) return { ok: false, code: "already_exists", number: existing };
    const { storage } = this.deps.git.context;
    const number = storage.sql
      .exec<{ next_number: number }>("SELECT next_number FROM repo_meta WHERE id = 1")
      .one().next_number;
    let opened: PullRecord | undefined;
    const result = this.deps.git.refStore.commitSync({
      addPacks: [],
      removePacks: [],
      refUpdates: [{ name: pullHeadRef(number), oldOid: null, newOid: input.headSha }],
      expectedVersion,
      actor: { ...caller.actor, via: "api" },
      onCommitted: ({ now }) => {
        inCommit?.();
        storage.sql.exec("UPDATE repo_meta SET next_number = ? WHERE id = 1", number + 1);
        const [row] = this.#rows(
          `INSERT INTO pull_requests (number, title, body, state, draft, author_id, author_root,
             author_act, base_ref, base_sha, head_ref, head_sha, last_pusher, last_pusher_grant,
             last_push_at, created_at, updated_at, head_repo_id, head_ref_version,
             maintainer_can_modify)
           VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          number,
          input.title,
          input.body,
          input.draft ? 1 : 0,
          caller.actor.principal,
          caller.root,
          caller.actor.actChain?.length ? JSON.stringify(caller.actor.actChain) : null,
          input.baseRef,
          oidToHex(input.baseSha),
          input.headRef,
          oidToHex(input.headSha),
          caller.actor.principal,
          caller.actor.grantId ?? null,
          now,
          now,
          now,
          input.headRepoId ?? null,
          input.headRefVersion ?? null,
          // Only a head branch in another repository is the base's maintainers' to write.
          input.headRepoId && input.maintainerCanModify ? 1 : 0,
        );
        opened = record(row as Row);
        this.#emit("opened", opened, caller.actor);
        this.deps.events.auditChange("pull_request.open", caller.actor, {
          number,
          base: input.baseRef,
          head: input.headRef,
        });
      },
    });
    if (result.ok) return { ok: true, record: opened as PullRecord };
    if (result.reason === "version-conflict") return { ok: false, code: "version-conflict" };
    if (result.reason === "refused") return { ok: false, code: "access_lost" };
    throw new Error(`opening pull request ${number} failed: ${result.reason}`);
  }

  /**
   * Applies a patch as the matrix allows, all of it or nothing: a reopen
   * first (it starts a new generation and moves the ref to the branch's
   * tip), then the edits, then a close. Each action emits its event and
   * writes its audit row. Synchronous, like `open`.
   */
  change(
    number: number,
    patch: PullPatch,
    caller: PullCaller,
  ):
    | { ok: true; record: PullRecord }
    | { ok: false; code: "version-conflict" }
    | { ok: false; code: "already_exists"; number: number }
    | { ok: false; code: Exclude<PullChangeFailure, "already_exists"> | "access_lost" } {
    const current = this.get(number);
    if (!current) return { ok: false, code: "not_found" };
    const actions = plannedActions(current, patch);
    if (actions.length === 0) return { ok: true, record: current };
    const refs = this.deps.git.refStore;
    // A head in another repository is where its last revision left it (told of each move);
    // whether its branch exists now is that repository's to tell once it follows it again.
    const headTip = current.headRepoId
      ? oidFromHex(current.headSha)
      : this.branchTip(current.headRef);
    let state = current.state;
    for (const action of actions) {
      const decision = decidePullAction(action, {
        state,
        headRefDeleted: headTip === null,
        isAuthor: caller.root === current.authorRoot,
        role: caller.role,
      });
      if (!decision.ok) return { ok: false, code: decision.refusal };
      state = PULL_ACTION_RULES[action].to ?? state;
    }
    const base = patch.base ?? current.baseRef;
    let baseTip: Oid | null = null;
    if (actions.includes("retarget") || actions.includes("reopen")) {
      baseTip = this.branchTip(base);
      if (baseTip === null) return { ok: false, code: "base_not_found" };
      if (base === current.headRef && !current.headRepoId)
        return { ok: false, code: "same_branches" };
      const other = this.openBetween(current.headRef, base, current.headRepoId);
      if (other !== undefined && other !== number)
        return { ok: false, code: "already_exists", number: other };
    }

    let changed: PullRecord | undefined;
    const apply = (now: number) => {
      changed = current;
      for (const action of actions)
        changed = this.#apply(changed, action, patch, baseTip, now, caller.actor);
    };
    const ref = pullHeadRef(number);
    const at = this.#read(ref);
    if (
      actions.includes("reopen") &&
      headTip !== null &&
      (at === null || !oidEquals(at, headTip))
    ) {
      const result = refs.commitSync({
        addPacks: [],
        removePacks: [],
        refUpdates: [{ name: ref, oldOid: at, newOid: headTip }],
        expectedVersion: refs.state().version,
        actor: { ...caller.actor, via: "api" },
        onCommitted: ({ now }) => apply(now),
      });
      // Nothing else can move the ref meanwhile: the read and the commit run without an await.
      if (!result.ok)
        return result.reason === "refused"
          ? { ok: false, code: "access_lost" }
          : { ok: false, code: "version-conflict" };
    } else {
      this.deps.git.context.storage.transactionSync(() => apply(this.deps.git.context.now()));
    }
    return { ok: true, record: changed as PullRecord };
  }

  #apply(
    current: PullRecord,
    action: PatchAction,
    patch: PullPatch,
    baseTip: Oid | null,
    now: number,
    actor: RefActor,
  ): PullRecord {
    const rule = PULL_ACTION_RULES[action];
    let row: Row | undefined;
    let data: Record<string, unknown> | null = null;
    const set = (assignments: string, ...values: unknown[]) =>
      this.#rows(
        `UPDATE pull_requests SET ${assignments}, version = version + 1, updated_at = ?
         WHERE number = ? RETURNING *`,
        ...values,
        now,
        current.number,
      )[0];
    switch (action) {
      case "edit": {
        const title = patch.title ?? current.title;
        const body = patch.body === undefined ? current.body : patch.body;
        data = {
          changes: {
            ...(title !== current.title && { title: { from: current.title } }),
            ...(body !== current.body && { body: { from: current.body } }),
          },
        };
        row = set("title = ?, body = ?", title, body);
        break;
      }
      case "retarget":
        data = { changes: { base: { ref: { from: current.baseRef } } } };
        // Approvals given so far were for the other base: none of them counts any more.
        row = set(
          `base_ref = ?, base_sha = ?,
           approvals_after = (SELECT coalesce(max(review_id), 0) FROM reviews WHERE pr_number = ?)`,
          patch.base,
          oidToHex(baseTip as Oid),
          current.number,
        );
        break;
      case "convert_to_draft":
      case "ready_for_review":
        row = set("draft = ?", action === "convert_to_draft" ? 1 : 0);
        break;
      case "set_maintainer_edits":
        data = { changes: { maintainer_can_modify: { from: current.maintainerCanModify } } };
        row = set("maintainer_can_modify = ?", patch.maintainerCanModify ? 1 : 0);
        break;
      case "close": {
        // Compared from the base as it is now from here on (as last recorded, when it is gone).
        const base = this.branchTip(current.baseRef);
        row = set(
          "state = 'closed', closed_at = ?, base_sha = ?",
          now,
          base ? oidToHex(base) : current.baseSha,
        );
        break;
      }
      case "reopen": {
        // The base it had until then: a retarget in the same patch comes after.
        const head = (
          current.headRepoId ? oidFromHex(current.headSha) : this.branchTip(current.headRef)
        ) as Oid;
        const base = this.branchTip(current.baseRef);
        // A head pushed while it was closed is the reopener's to answer for.
        const pushed = oidToHex(head) !== current.headSha;
        row = set(
          `state = 'open', closed_at = NULL, generation = generation + 1, head_sha = ?, base_sha = ?,
           last_pusher = ?, last_pusher_grant = ?, last_push_at = ?`,
          oidToHex(head),
          base ? oidToHex(base) : current.baseSha,
          pushed ? actor.principal : current.lastPusher,
          pushed ? (actor.grantId ?? null) : current.lastPusherGrant,
          pushed ? now : current.lastPushAt,
        );
        break;
      }
    }
    const next = record(row as Row);
    this.#emit(rule.event, next, actor, data);
    this.deps.events.auditChange(rule.audit, actor, {
      number: current.number,
      ...(action === "retarget" && { base: { from: current.baseRef, to: next.baseRef } }),
    });
    return next;
  }

  /**
   * What a pull request's files and commits are compared from: an open
   * one's base branch tip (the recorded base once the branch is gone); a
   * closed or merged one's recorded base, the branch's tip when it closed
   * or merged, whatever the branch does after.
   */
  comparedBase(pull: PullRecord): Oid {
    return (
      (pull.state === "open" ? this.branchTip(pull.baseRef) : null) ?? oidFromHex(pull.baseSha)
    );
  }

  /**
   * Every recorded base, distinct: garbage collection keeps them, for what
   * `comparedBase` compares from once the branch no longer reaches them.
   * (Each head is kept by its pull request's ref.)
   */
  recordedBases(): Oid[] {
    return this.#rows<{ base_sha: string }>("SELECT DISTINCT base_sha FROM pull_requests").map(
      (row) => oidFromHex(row.base_sha),
    );
  }

  /** A branch's tip, or null when it does not exist; one row read. */
  branchTip(branch: string): Oid | null {
    return this.#read(`${BRANCHES}${branch}`);
  }

  /** A direct ref's value, or null when it does not exist; one row read. */
  #read(ref: string): Oid | null {
    const row = this.deps.git.context.storage.sql
      .exec<{ oid: ArrayBuffer | null }>(
        "SELECT oid FROM refs WHERE name = ? AND kind = 'direct'",
        ref,
      )
      .toArray()[0];
    return row?.oid ? oidFromBytes(new Uint8Array(row.oid)) : null;
  }

  #emit(
    event: string,
    pull: PullRecord,
    actor: RefActor | null,
    data: Record<string, unknown> | null = null,
  ): void {
    // Every change passes here: the head it leaves is one the pull request has had, and
    // whether it merges is worked out again (only when its base tip or head moved, in fact).
    this.#rows(
      "INSERT OR IGNORE INTO pull_heads (pr_number, sha) VALUES (?, ?)",
      pull.number,
      pull.headSha,
    );
    this.deps.stale?.(pull.number, pull.state === "open");
    // The head's repository is told what the pull request now asks of it (its consent too).
    if (
      pull.headRepoId &&
      (event === "opened" ||
        event === "closed" ||
        event === "reopened" ||
        (event === "edited" &&
          data?.changes !== undefined &&
          "maintainer_can_modify" in (data.changes as Record<string, unknown>)))
    )
      this.deps.follow?.(pull);
    const {
      authorAct: _act,
      lastPusher: _pusher,
      lastPusherGrant: _grant,
      lastPushAt: _at,
      headRefVersion: _headVersion,
      version,
      ...row
    } = pull;
    this.deps.events.emitEntity(
      `pull_request.${event}`,
      actor,
      { type: PULL_ENTITY, id: `${this.deps.repoId()}#${pull.number}`, version, row },
      data,
    );
  }

  #rows<T extends Record<string, SqlStorageValue> = Row>(
    query: string,
    ...bindings: unknown[]
  ): T[] {
    const cursor = this.deps.git.context.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "pulls.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}

/** What a patch can ask for: a merge is made through the push path. */
type PatchAction = Exclude<PullAction, "merge">;

/** The actions a patch asks for, in the order they apply: a reopen first, a close last. */
function plannedActions(current: PullRecord, patch: PullPatch): PatchAction[] {
  const actions: PatchAction[] = [];
  if (patch.state === "open" && current.state !== "open") actions.push("reopen");
  if (
    (patch.title !== undefined && patch.title !== current.title) ||
    (patch.body !== undefined && patch.body !== current.body)
  )
    actions.push("edit");
  if (patch.base !== undefined && patch.base !== current.baseRef) actions.push("retarget");
  if (patch.draft !== undefined && patch.draft !== current.draft)
    actions.push(patch.draft ? "convert_to_draft" : "ready_for_review");
  if (patch.state === "closed" && current.state === "open") actions.push("close");
  if (
    patch.maintainerCanModify !== undefined &&
    patch.maintainerCanModify !== current.maintainerCanModify &&
    // A head branch here is the base's own: nothing to allow.
    current.headRepoId !== null
  )
    actions.push("set_maintainer_edits");
  return actions;
}

function record(row: Row): PullRecord {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    draft: row.draft === 1,
    authorId: row.author_id,
    authorRoot: row.author_root,
    authorAct: row.author_act ? (JSON.parse(row.author_act) as string[]) : [],
    baseRef: row.base_ref,
    headRef: row.head_ref,
    headRepoId: row.head_repo_id,
    headRefVersion: row.head_ref_version,
    maintainerCanModify: row.maintainer_can_modify === 1,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    headRefDeleted: row.head_ref_deleted === 1,
    lastPusher: row.last_pusher,
    lastPusherGrant: row.last_pusher_grant,
    lastPushAt: row.last_push_at,
    mergeCommitSha: row.merge_commit_sha,
    mergedBy: row.merged_by,
    mergedAt: row.merged_at,
    generation: row.generation,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
