import type { JobHandler, RepoGitStorage, SliceResult } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import { oidFromBytes, oidFromHex, oidToHex } from "@fyrden/git-core";
import { GC_JOB_ID, inProgress, scheduleGc } from "../git/maintenance/schedule.js";
import type { ClaimReleases } from "./claim-releases.js";
import { liveViewPacks } from "./member.js";
import type { CommitRowData, ViewPack } from "./types.js";
import {
  admission,
  compactionLimits,
  isDetaching,
  mergedInto,
  runUnderWay,
  scheduleViewCompaction,
} from "./view-cap.js";

/*
 * A pull request's base importing a revision of its head from another
 * member of the fork network. No pack byte is copied, as for a fork:
 *
 * 1. snapshot: the head's repository leases the packs that may hold the
 *    revision and names them; all are borrowed (one live in the base's view
 *    already too, so the import checks it is still there when it publishes).
 * 2. share: the network records them as shared, claimed by the base (once
 *    no release of the base's claim on one is still to land).
 * 3. adopt: they join the base's view as borrowed packs (one the base's
 *    collection dropped is taken back); a view over its cap gets a
 *    compaction of its oldest borrowed packs, on its own job. One the base
 *    retired since the share (its claim released after it) is shared again
 *    first.
 * 4. graph: the head's verified commit rows the base lacks are copied page
 *    by page, kept apart under the revision's own key until it publishes:
 *    the base's commit graph only ever holds whole histories, so a page
 *    stops at commits the base has.
 * 5. publish: in one transaction, the borrowed packs are checked live
 *    (taken back from the collection if it dropped them meanwhile), the
 *    copied history is checked whole, its rows join the graph and the
 *    caller points the pull request at the revision. A failed check starts
 *    the import again.
 *
 * Each step is idempotent and its progress is stored, so an import evicted
 * at any point goes on from its step; rows of an import that was replaced
 * or abandoned are reaped. The lease is released once published or given
 * up (else it expires).
 */

export const IMPORT_POLICY = {
  /** How long the head's packs stay leased for an import. Proposed. */
  leaseMs: 10 * 60_000,
  /** Commit rows per page of the graph copy. Proposed. */
  pageSize: 2_000,
  /** Pages (calls to the head's object) one slice makes. Proposed, within Free's 1,000 calls. */
  pagesPerSlice: 100,
  /** Commit rows one import copies at most; more is too far apart to import. Proposed. */
  maxCommits: 50_000,
  /** Attempts before the import is given up. Proposed. */
  maxAttempts: 5,
  /** Delay before a failed step is tried again; doubles per attempt. Proposed. */
  retryMs: 10_000,
  /** Age after which staged rows no import owns are reaped. Proposed. */
  reapStagedMs: 60 * 60_000,
} as const;
export type ImportPolicy = { readonly [K in keyof typeof IMPORT_POLICY]: number };

export type ImportStep = "snapshot" | "share" | "adopt" | "graph" | "publish";

/** What an import has done so far: stored between slices. */
export interface ImportState {
  /** The packs it borrows (kept until it publishes, to check them live then). */
  readonly packs?: readonly ViewPack[];
  /** When the head's lease on them ends: past it they may be gone, so the import starts again. */
  readonly leaseUntil?: number;
  /** The base's network when it began: a detach since leaves the head's packs behind. */
  readonly networkId?: string;
  /**
   * Of its packs, those the base's registry had a row of when they were
   * shared: one gone by adoption was retired meanwhile, its claim released
   * maybe after the share.
   */
  readonly held?: readonly string[];
  readonly frontier?: readonly string[];
  readonly staged?: number;
}

/** One import's progress. */
export interface ImportWork {
  /** Its staged commit rows' key: one per revision. */
  readonly importId: string;
  readonly headRepoId: string;
  readonly sha: string;
  readonly step: ImportStep;
  readonly leaseId: string | null;
  readonly state: ImportState;
}

/** An import that cannot go on (it is given up; the pull request keeps its revision). */
export class ImportFailed extends Error {
  constructor(
    readonly code: "unknown_commit" | "too_large" | "packs_gone" | "not_member" | "view_full",
    message: string,
  ) {
    super(message);
    this.name = "ImportFailed";
  }
}

/** A step that cannot go on now but will later (the network or the base's collection is busy). */
export class ImportBusy extends Error {
  override name = "ImportBusy";
}

export interface ImportDeps {
  readonly git: RepoGitStorage;
  readonly env: Env;
  readonly repoId: () => string;
  /** Own packs a view may have (the pack-count cap). */
  readonly ownCap: () => number;
  /** Objects one compaction of the view may rewrite (the maintenance policy's budget). */
  readonly rewriteObjects: () => number;
  readonly log: () => Logger;
  /** The base's claims its retire job gave up: told to the network before it claims packs again. */
  readonly releases: Pick<ClaimReleases, "claimAgain">;
}

/** What judging the base's view of borrowed packs needs. */
export type ViewDeps = Pick<ImportDeps, "git" | "ownCap" | "rewriteObjects">;

/** Calls to other objects an invocation may make for imports, and how many it has made. */
export interface CallBudget {
  used: number;
  readonly max: number;
}

/**
 * Runs one step of `work` (not `publish`, which is the caller's) and
 * answers the next; with `budget`, its calls to other objects count
 * against it (a graph step stops when it is spent).
 */
export async function runImportStep(
  deps: ImportDeps,
  work: ImportWork,
  policy: ImportPolicy = IMPORT_POLICY,
  budget: CallBudget = { used: 0, max: Number.POSITIVE_INFINITY },
): Promise<ImportWork> {
  const { git, env } = deps;
  const head = env.REPO.getByName(work.headRepoId);
  switch (work.step) {
    case "snapshot": {
      if (isDetaching(git))
        throw new ImportFailed("not_member", "the base is leaving its fork network");
      budget.used++;
      const exported = await head.exportRevision({
        sha: work.sha,
        holder: `pull:${deps.repoId()}:${work.importId}`,
        ttlMs: policy.leaseMs,
      });
      if (!exported.ok)
        throw new ImportFailed("unknown_commit", "the head's revision is no longer stored");
      return {
        ...work,
        leaseId: exported.leaseId,
        step: "share",
        // Its own clock may differ from the head's: a margin of half the lease.
        state: {
          packs: exported.packs,
          leaseUntil: git.context.now() + policy.leaseMs / 2,
          networkId: git.networkId(),
        },
      };
    }
    case "share": {
      // The lease may have ended (the import waited out a freeze or an outage): the head may have
      // retired packs since, so they are leased again from the start.
      if ((work.state.leaseUntil ?? 0) <= git.context.now())
        return { ...work, step: "snapshot", leaseId: null, state: {} };
      const packs = work.state.packs ?? [];
      let held: string[] = [];
      // With no release of the base's claims on them still to land after it.
      const shared = await deps.releases.claimAgain(
        packs.map((p) => p.packId),
        budget,
        async () => {
          // The base's rows of them now: one gone by adoption was retired after this share.
          held = [...packStates(git, packs).keys()];
          budget.used++;
          return await env.NETWORK.getByName(git.networkId()).sharePacks({
            networkId: git.networkId(),
            writerRepoId: work.headRepoId,
            claimantRepoId: deps.repoId(),
            packs,
          });
        },
      );
      if (!shared.ok) {
        if (shared.code === "network_busy") throw new ImportBusy(shared.error);
        throw new ImportFailed("not_member", shared.error);
      }
      if (shared.gone.length > 0)
        throw new ImportFailed("packs_gone", "packs of the head were deleted meanwhile");
      return { ...work, step: "adopt", state: { ...work.state, held } };
    }
    case "adopt": {
      if (leftNetwork(git, work))
        throw new ImportFailed("not_member", "the base left its fork network meanwhile");
      // Past the lease (paused after sharing), a pack may have been deleted since: from the start.
      if ((work.state.leaseUntil ?? 0) <= git.context.now())
        return { ...work, step: "snapshot", leaseId: null, state: {} };
      const packs = work.state.packs ?? [];
      const adopted = borrowedWith(git, packs);
      const current = borrowedLive(git);
      // Packs it reads already add nothing: a view over its cap all the same takes them.
      if (adopted.length > current.length) admit(deps, adopted, current);
      // Retired since the share: its claim may be gone, so it is claimed again first.
      if (!adoptPacks(git, packs, work.state.held ?? [])) return { ...work, step: "share" };
      // Over the cap: compacted on the view's own job; the import goes on meanwhile.
      if (adopted.length > compactionLimits(deps.ownCap(), deps.rewriteObjects()).limit)
        scheduleViewCompaction(git);
      return { ...work, step: "graph" };
    }
    case "graph": {
      // The base's graph holds whole histories: a commit it has needs no more copying.
      let frontier = (work.state.frontier ?? [work.sha]).filter((hex) => !hasCommit(git, hex));
      let staged = work.state.staged ?? 0;
      for (
        let pages = 0;
        frontier.length > 0 && pages < policy.pagesPerSlice && budget.used < budget.max;
        pages++
      ) {
        budget.used++;
        const page = await head.forkCommitPage(frontier, policy.pageSize);
        stage(git, work.importId, page.rows);
        // Counted from what is stored: a page staged before a retry counts once.
        staged = stagedCount(git, work.importId);
        if (staged > policy.maxCommits)
          throw new ImportFailed(
            "too_large",
            `the head is more than ${policy.maxCommits} commits away from the base's history`,
          );
        frontier = page.frontier.filter((hex) => !hasCommit(git, hex));
      }
      return frontier.length > 0
        ? { ...work, state: { ...work.state, frontier, staged } }
        : { ...work, step: "publish", state: { ...work.state, frontier: [], staged } };
    }
    case "publish":
      return work;
  }
}

/** Why an import run within one invocation gave up (its caller answers in its own terms). */
export type ForegroundRefusal = "too_expensive" | "unknown_commit" | "view_full" | "busy";

/**
 * Imports `sha` of `headRepoId` within the caller's invocation: its steps
 * until it can publish, at most `maxSteps` and within `budget` (calls to
 * other objects, counting those the caller made already), then `publish`,
 * the caller's own publication (its transaction checks `readyToPublish`
 * and publishes the staged rows). A step's failure, or one `publish`
 * throws (`ImportBusy`, `ImportFailed`), is answered as a refusal.
 * Published or not, the import's staged rows go (none are left once
 * published) and its lease is released; packs it borrowed are left to a
 * later collection.
 */
export async function importInForeground<T>(
  deps: ImportDeps,
  start: Pick<ImportWork, "importId" | "headRepoId" | "sha">,
  limits: { readonly policy: ImportPolicy; readonly maxSteps: number; readonly budget: CallBudget },
  publish: (work: ImportWork) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: ForegroundRefusal }> {
  const { budget } = limits;
  let work: ImportWork = { ...start, step: "snapshot", leaseId: null, state: {} };
  try {
    for (let steps = 0; work.step !== "publish"; steps++) {
      if (steps >= limits.maxSteps || budget.used >= budget.max)
        return { ok: false, code: "too_expensive" };
      work = await runImportStep(deps, work, limits.policy, budget);
    }
    return { ok: true, value: await publish(work) };
  } catch (error) {
    if (error instanceof ImportFailed)
      return {
        ok: false,
        code:
          error.code === "too_large"
            ? "too_expensive"
            : error.code === "unknown_commit" || error.code === "view_full"
              ? error.code
              : "busy",
      };
    if (error instanceof ImportBusy) {
      waitOn(deps.git, error);
      return { ok: false, code: "busy" };
    }
    throw error;
  } finally {
    await discardImport(deps, work);
  }
}

/** The rows staged for an import. */
function stagedCount(git: RepoGitStorage, importId: string): number {
  return git.context.storage.sql
    .exec<{ n: number }>("SELECT count(*) AS n FROM import_commits WHERE import_id = ?", importId)
    .one().n;
}

/** Whether the base left (or is leaving) the network the import began in. */
function leftNetwork(git: RepoGitStorage, work: ImportWork): boolean {
  return (
    isDetaching(git) ||
    (work.state.networkId !== undefined && work.state.networkId !== git.networkId())
  );
}

/** Whether the base's commit graph has `hex` (and so, its whole history). */
function hasCommit(git: RepoGitStorage, hex: string): boolean {
  return git.commitGraph.readSync([oidFromHex(hex)], "verified")[0] !== undefined;
}

/** The registry states of those of `packs` the base has a row of. */
function packStates(git: RepoGitStorage, packs: readonly ViewPack[]): Map<string, string> {
  const rows = git.context.storage.sql
    .exec<{ pack_id: string; state: string }>(
      "SELECT pack_id, state FROM packs WHERE pack_id IN (SELECT value FROM json_each(?))",
      JSON.stringify(packs.map((p) => p.packId)),
    )
    .toArray();
  return new Map(rows.map((r) => [r.pack_id, r.state]));
}

/** The live borrowed packs of the base's view, oldest first. */
function borrowedLive(git: RepoGitStorage): ViewPack[] {
  return liveViewPacks(git).filter((p) => p.origin === "borrowed");
}

/**
 * Of `packs`, those the base's view compaction merged into a pack it reads:
 * the view has their objects already.
 */
function readThroughMerge(git: RepoGitStorage, packs: readonly ViewPack[]): Set<string> {
  const merged = mergedInto(
    git,
    packs.map((p) => p.packId),
  );
  return new Set([...merged].filter(([, into]) => into.state === "live").map(([id]) => id));
}

/**
 * The base's borrowed packs once `packs` are adopted (as `adoptPacks`
 * does), oldest first: those it reads already (or through a pack its view
 * compaction merged them into) count once, and its own taken back count
 * against the own-pack cap instead.
 */
function borrowedWith(git: RepoGitStorage, packs: readonly ViewPack[]): ViewPack[] {
  const sql = git.context.storage.sql;
  const covered = readThroughMerge(git, packs);
  const added = packs.filter((pack) => {
    if (covered.has(pack.packId)) return false;
    const row = sql
      .exec<{ state: string; origin: string }>(
        "SELECT state, origin FROM packs WHERE pack_id = ?",
        pack.packId,
      )
      .toArray()[0];
    if (!row) return true;
    if (row.state === "live") return false;
    return !((HELD as readonly string[]).includes(row.state) && row.origin === "own");
  });
  return [...borrowedLive(git), ...added].sort(
    (a, b) => a.createdAt - b.createdAt || (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0),
  );
}

/**
 * Takes the base's borrowed view to `view` (oldest first) from `current`
 * only when the compaction is sure to bring it within its cap (see
 * `admission`): refused for good when it cannot, else the import waits
 * (`ViewCompacting`) until the compaction has told the merged packs' real
 * sizes.
 */
function admit(deps: ViewDeps, view: readonly ViewPack[], current: readonly ViewPack[]): void {
  const limits = compactionLimits(deps.ownCap(), deps.rewriteObjects());
  const decision = admission(view, current, limits, runUnderWay(deps.git));
  if (decision === "admit") return;
  if (decision === "full")
    throw new ImportFailed(
      "view_full",
      "the base's view cannot hold more borrowed packs: they are too large to compact",
    );
  throw new ViewCompacting("the base's view is being compacted; the import goes on after");
}

/**
 * An import waiting for the base's view compaction (see `admit`). Whoever
 * catches it asks for the compaction outside any transaction it was thrown
 * in (`waitOn`), so the request is not undone with it.
 */
export class ViewCompacting extends ImportBusy {
  override name = "ViewCompacting";
}

/** After an import step or publication failed: the compaction it waits for is asked for. */
export function waitOn(git: RepoGitStorage, error: unknown): void {
  if (error instanceof ViewCompacting) scheduleViewCompaction(git);
}

/** Registry states of a pack not finished yet: waited out. */
const SETTLING = new Set(["pending", "indexing", "indexed"]);
/**
 * Registry states of a pack the base no longer reads but still holds:
 * taken back live. While the row is here, so is the base's claim on the
 * network (the retire job deletes the row in the transaction that records
 * the claim's release, which it tells the network after), so the network
 * deletes nothing taken back. A pack whose row is gone has its claim
 * released maybe, or about to be: it is claimed again (shared, once that
 * release has landed) before it is borrowed.
 */
const HELD = ["garbage", "superseded", "condemned"] as const;

/**
 * The packs join the base's view, borrowed (no byte is copied): a pack the
 * base held but no longer read (dropped by its collection, or replaced by
 * its own repack while the head's repository still reads it) is taken
 * back, one it is done with (deleted, discarded) is registered again; one
 * not finished yet is waited for. One the view compaction merged into a
 * pack the view reads is read there; one merged into a pack gone from the
 * view is borrowed again. False, adopting none, when one `held` when
 * shared is gone: retired since, its claim may have been released after
 * the share, so it is to be shared again. Safe to repeat.
 */
function adoptPacks(
  git: RepoGitStorage,
  packs: readonly ViewPack[],
  held: readonly string[],
): boolean {
  const { storage } = git.context;
  const now = git.context.now();
  return storage.transactionSync((): boolean => {
    const covered = readThroughMerge(git, packs);
    const rows = packStates(git, packs);
    const retired = (id: string) => !rows.has(id) && held.includes(id);
    if (packs.some((p) => !covered.has(p.packId) && retired(p.packId))) return false;
    // With the packs: their collection, should the import never end (an interrupted opening).
    if (packs.length > 0) collectLater(git);
    for (const pack of packs) {
      if (covered.has(pack.packId)) continue;
      // Read through no merge any more: its own row stands for it.
      storage.sql.exec("DELETE FROM view_merged WHERE pack_id = ?", pack.packId);
      const state = storage.sql
        .exec<{ state: string }>("SELECT state FROM packs WHERE pack_id = ?", pack.packId)
        .toArray()[0]?.state;
      if (state === "live") continue;
      if (state !== undefined && (HELD as readonly string[]).includes(state)) {
        git.registry.transition(pack.packId as never, HELD, "live");
        continue;
      }
      if (state !== undefined && SETTLING.has(state))
        throw new ImportBusy(`pack ${pack.packId} is being retired; try again later`);
      if (state !== undefined) storage.sql.exec("DELETE FROM packs WHERE pack_id = ?", pack.packId);
      storage.sql.exec(
        `INSERT INTO packs (pack_id, network_id, r2_key, origin, kind, state, object_count,
           bytes, all_reachable, unit_id, created_at, last_touched_at)
         VALUES (?, ?, ?, 'borrowed', ?, 'live', ?, ?, 0, ?, ?, ?)`,
        pack.packId,
        pack.networkId,
        pack.r2Key,
        pack.kind,
        pack.objectCount,
        pack.bytes,
        pack.unitId,
        pack.createdAt,
        now,
      );
    }
    return true;
  });
}

/**
 * Keeps the rows the base's graph lacks for the import; answers how many it
 * kept. In the same transaction, the import job is due when they would be
 * reaped, so rows of an import that never ends are reaped all the same.
 */
function stage(git: RepoGitStorage, importId: string, rows: readonly CommitRowData[]): number {
  const { storage } = git.context;
  const now = git.context.now();
  return storage.transactionSync(() => {
    git.jobs.ensure("revision_import", REVISION_IMPORT_JOB, {
      runAt: now + IMPORT_POLICY.reapStagedMs,
    });
    let kept = 0;
    for (const row of rows) {
      const oid = oidFromBytes(new Uint8Array(row.oid));
      if (git.commitGraph.readSync([oid], "verified")[0]) continue;
      const cursor = storage.sql.exec(
        `INSERT INTO import_commits (import_id, oid, tree, parents, commit_time, generation,
           level, signature, staged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (import_id, oid) DO NOTHING`,
        importId,
        new Uint8Array(row.oid).buffer,
        new Uint8Array(row.tree).buffer,
        new Uint8Array(row.parents).buffer,
        row.commitTime,
        row.generation,
        row.level,
        row.signature,
        now,
      );
      cursor.toArray();
      kept += cursor.rowsWritten;
    }
    return kept;
  });
}

/**
 * In the publishing transaction: whether the import may publish, taking
 * back borrowed packs the base's collection dropped meanwhile. False when a
 * pack is gone from the view, one its view compaction merged is not read
 * through a live pack any more, or the copied history is not whole (the
 * head's graph changed under the copy): the import starts again.
 */
export function readyToPublish(deps: ViewDeps, work: ImportWork): boolean {
  const { git } = deps;
  // Left (or leaving) the network: the head's packs are not the base's to read any more.
  if (leftNetwork(git, work)) throw new ImportFailed("not_member", "the base left its network");
  const sql = git.context.storage.sql;
  const current = borrowedLive(git);
  const packs = work.state.packs ?? [];
  const merged = mergedInto(
    git,
    packs.map((p) => p.packId),
  );
  let tookBack: "none" | "own" | "borrowed" = "none";
  for (const pack of packs) {
    // Merged by the view compaction: read through the pack it went into while the view reads that
    // one. Dropped from the view, that pack (and this one, which the import did not adopt) may
    // have had its claim released and its deletion acknowledged meanwhile: neither is taken back
    // unclaimed, the import starts again and shares and adopts this one anew.
    const into = merged.get(pack.packId);
    if (into?.state === "live") continue;
    if (into) return false;
    const row = sql
      .exec<{ state: string; origin: string }>(
        "SELECT state, origin FROM packs WHERE pack_id = ?",
        pack.packId,
      )
      .toArray()[0];
    if (row && (HELD as readonly string[]).includes(row.state)) {
      git.registry.transition(pack.packId as never, HELD, "live");
      if (tookBack !== "borrowed") tookBack = row.origin === "borrowed" ? "borrowed" : "own";
    } else if (row?.state !== "live") return false;
  }
  // Packs taken back may put the view over its cap again (a compaction replaced them meanwhile):
  // borrowed ones are admitted as when they were adopted.
  if (tookBack === "borrowed") admit(deps, borrowedLive(git), current);
  if (tookBack !== "none") scheduleViewCompaction(git);
  // Every staged commit's parents are staged or in the graph, and the revision is one of them.
  const staged = sql
    .exec<{ oid: ArrayBuffer; parents: ArrayBuffer }>(
      "SELECT oid, parents FROM import_commits WHERE import_id = ?",
      work.importId,
    )
    .toArray();
  const have = new Set(staged.map((r) => oidToHex(oidFromBytes(new Uint8Array(r.oid)))));
  const known = (hex: string) => have.has(hex) || hasCommit(git, hex);
  if (!known(work.sha)) return false;
  for (const row of staged) {
    const parents = new Uint8Array(row.parents);
    for (let at = 0; at < parents.length; at += 20)
      if (!known(oidToHex(oidFromBytes(parents, at)))) return false;
  }
  return true;
}

/** In the publishing transaction: the import's rows join the commit graph. */
export function publishStaged(git: RepoGitStorage, importId: string): void {
  const sql = git.context.storage.sql;
  sql.exec(
    `INSERT INTO commits (oid, tree, parents, commit_time, generation, level, signature)
     SELECT oid, tree, parents, commit_time, generation, level, signature FROM import_commits
     WHERE import_id = ? ON CONFLICT (oid) DO NOTHING`,
    importId,
  );
  sql.exec("DELETE FROM import_commits WHERE import_id = ?", importId);
}

/**
 * An import given up or replaced: its rows go, and its lease is released
 * (best effort). Packs it borrowed that nothing reaches are left to the
 * base's collection, which is asked for (it drops them from the view, and
 * the network's claims with them).
 */
export async function discardImport(
  deps: Pick<ImportDeps, "git" | "env" | "log">,
  work: Pick<ImportWork, "importId" | "headRepoId" | "leaseId" | "state">,
): Promise<void> {
  const { git } = deps;
  git.context.storage.sql.exec("DELETE FROM import_commits WHERE import_id = ?", work.importId);
  if ((work.state.packs?.length ?? 0) > 0) collectLater(git);
  await releaseLease(deps, work);
}

/** Delay before the base's collection drops borrowed packs no ref reaches. Proposed. */
export const COLLECT_AFTER_IMPORT_MS = 60 * 60_000;

/**
 * In the caller's transaction: an import borrowed packs that may hold more
 * than any ref reaches (all the head's packs are borrowed), so the base's
 * collection must drop those, and the network's claims with them, a while
 * later (one run for many imports). Recorded, and turned into a run of the
 * collection by the import job once none is under way (a run that started
 * before the packs were borrowed would not see them).
 */
export function collectLater(git: RepoGitStorage): void {
  const due = git.context.now() + COLLECT_AFTER_IMPORT_MS;
  git.context.storage.sql.exec(
    `INSERT INTO collect_requests (id, due_at) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET due_at = min(due_at, excluded.due_at)`,
    due,
  );
  git.jobs.ensure("revision_import", REVISION_IMPORT_JOB, { runAt: due });
}

/** When to look again at a due collection request while a run of the collection is under way. */
const COLLECT_RECHECK_MS = 10 * 60_000;

/**
 * A due collection request becomes a run of the collection, unless one is
 * under way (then later); answers when to look again (null: no request).
 */
function collectDue(git: RepoGitStorage): number | null {
  const sql = git.context.storage.sql;
  const due = sql
    .exec<{ due_at: number }>("SELECT due_at FROM collect_requests")
    .toArray()[0]?.due_at;
  if (due === undefined) return null;
  const now = git.context.now();
  if (due > now) return due;
  if (inProgress(git, GC_JOB_ID)) return now + COLLECT_RECHECK_MS;
  scheduleGc(git, now);
  sql.exec("DELETE FROM collect_requests");
  return null;
}

/** Releases an import's lease on the head's packs (best effort: it expires anyway). */
export async function releaseLease(
  deps: Pick<ImportDeps, "env" | "log">,
  work: Pick<ImportWork, "headRepoId" | "leaseId">,
): Promise<void> {
  if (!work.leaseId) return;
  await deps.env.REPO.getByName(work.headRepoId)
    .releaseFetchLease(work.leaseId)
    .catch((error: unknown) => deps.log().warn("releasing an import's lease failed", { error }));
}

/** The base's queue of imports: one per pull request, the latest revision. */
export class PullImports {
  constructor(
    private readonly deps: ImportDeps & {
      /** Publishes a checked import (moves the pull request's head); false when it no longer applies. */
      readonly publish: (number: number, work: ImportWork, row: ImportRow) => boolean;
      /** Whether the pull request's author still reads the head's repository (else nothing is imported). */
      readonly authorReads: (row: ImportRow) => Promise<boolean>;
      /** Whether the repository takes changes now (a transfer freezes it: imports wait). */
      readonly writable: () => boolean;
      readonly policy: () => ImportPolicy;
    },
  ) {}

  /** The import of a pull request's head, if one is waiting. */
  get(number: number): ImportRow | undefined {
    return this.deps.git.context.storage.sql
      .exec<RawImport>("SELECT * FROM revision_imports WHERE pr_number = ?", number)
      .toArray()
      .map(importRow)[0];
  }

  /**
   * Queues the import of `sha` for pull request `number` (a revision later
   * than any queued for it replaces it). Answers the replaced import, to
   * release its lease.
   */
  queue(input: {
    readonly number: number;
    readonly headRepoId: string;
    readonly generation: number;
    readonly refVersion: number;
    readonly sha: string;
    readonly pusher: string | null;
    readonly pusherGrant: string | null;
  }): { replaced: ImportRow | undefined } {
    const { git } = this.deps;
    const sql = git.context.storage.sql;
    const replaced = this.get(input.number);
    if (
      replaced &&
      replaced.generation === input.generation &&
      replaced.refVersion >= input.refVersion
    )
      return { replaced: undefined };
    const now = git.context.now();
    if (replaced) sql.exec("DELETE FROM import_commits WHERE import_id = ?", importIdOf(replaced));
    sql.exec(
      `INSERT INTO revision_imports (pr_number, head_repo_id, generation, ref_version, sha, pusher,
         pusher_grant, step, lease_id, state, attempts, requested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'snapshot', NULL, NULL, 0, ?, ?)
       ON CONFLICT (pr_number) DO UPDATE SET head_repo_id = excluded.head_repo_id,
         generation = excluded.generation, ref_version = excluded.ref_version, sha = excluded.sha,
         pusher = excluded.pusher, pusher_grant = excluded.pusher_grant, step = 'snapshot',
         lease_id = NULL, state = NULL, attempts = 0, updated_at = excluded.updated_at`,
      input.number,
      input.headRepoId,
      input.generation,
      input.refVersion,
      input.sha,
      input.pusher,
      input.pusherGrant,
      now,
      now,
    );
    git.jobs.ensure("revision_import", REVISION_IMPORT_JOB);
    return { replaced };
  }

  /**
   * In the caller's transaction: drops a pull request's import (closed,
   * merged, replaced by a revision that needs none); answers it, to release
   * its lease. Packs it borrowed are left to the base's collection.
   */
  drop(number: number): ImportRow | undefined {
    const row = this.get(number);
    if (!row) return undefined;
    const sql = this.deps.git.context.storage.sql;
    sql.exec("DELETE FROM revision_imports WHERE pr_number = ?", number);
    sql.exec("DELETE FROM import_commits WHERE import_id = ?", importIdOf(row));
    if ((row.state.packs?.length ?? 0) > 0) collectLater(this.deps.git);
    return row;
  }

  /** The job: one step of the longest-waiting import per slice, and the reaping of orphan rows. */
  handler(): JobHandler {
    return {
      runSlice: async (): Promise<SliceResult> => {
        const { git } = this.deps;
        const sql = git.context.storage.sql;
        this.#reap();
        // Longest waiting first; one tried again waits out its delay.
        const row = sql
          .exec<RawImport>(
            `SELECT * FROM revision_imports WHERE requested_at <= ?
             ORDER BY requested_at, pr_number LIMIT 1`,
            git.context.now(),
          )
          .toArray()
          .map(importRow)[0];
        if (row) await this.#advance(row);
        // Read after the step: an opening may have borrowed packs (and asked for this) meanwhile.
        const collectAt = collectDue(git);
        // Judged with no wait before the answer: an import queued meanwhile found this job
        // running and left it to this one.
        const imports = sql
          .exec<{ at: number | null }>("SELECT min(requested_at) AS at FROM revision_imports")
          .one().at;
        // Rows no queued import owns (an opening under way, or one abandoned) are reaped once old.
        const staged = sql
          .exec<{ at: number | null }>(
            `SELECT min(staged_at) AS at FROM import_commits
             WHERE import_id NOT IN (SELECT value FROM json_each(?))`,
            JSON.stringify(this.#owned()),
          )
          .one().at;
        const times = [
          imports,
          staged === null ? null : staged + this.deps.policy().reapStagedMs,
          collectAt,
        ].filter((t): t is number => t !== null);
        if (times.length === 0) return { done: true };
        return {
          done: false,
          cursor: null,
          runAfterMs: Math.max(0, Math.min(...times) - git.context.now()),
        };
      },
    };
  }

  /** The staging keys of the queued imports. */
  #owned(): string[] {
    return this.deps.git.context.storage.sql
      .exec<RawImport>("SELECT * FROM revision_imports")
      .toArray()
      .map((raw) => importIdOf(importRow(raw)));
  }

  /** Staged rows no queued import owns, old: an import replaced meanwhile, or an opening abandoned. */
  #reap(): void {
    const { git } = this.deps;
    git.context.storage.sql.exec(
      `DELETE FROM import_commits WHERE staged_at < ?
         AND import_id NOT IN (SELECT value FROM json_each(?))`,
      git.context.now() - this.deps.policy().reapStagedMs,
      JSON.stringify(this.#owned()),
    );
  }

  async #advance(row: ImportRow): Promise<void> {
    const { git } = this.deps;
    const sql = git.context.storage.sql;
    const work: ImportWork = {
      importId: importIdOf(row),
      headRepoId: row.headRepoId,
      sha: row.sha,
      step: row.step,
      leaseId: row.leaseId,
      state: row.state,
    };
    // Frozen (a transfer): the import waits, its attempts unspent.
    if (!this.deps.writable()) {
      this.#save(row, work, { requestedAt: git.context.now() + this.deps.policy().retryMs });
      return;
    }
    let next: ImportWork;
    try {
      if (row.step === "snapshot" && !(await this.deps.authorReads(row)))
        throw new ImportFailed("not_member", "the pull request's author no longer reads its head");
      next =
        row.step === "publish" ? work : await runImportStep(this.deps, work, this.deps.policy());
    } catch (error) {
      if (!this.#unchanged(row)) return void (await discardImport(this.deps, work));
      const busy = error instanceof ImportBusy;
      waitOn(git, error);
      const attempts = row.attempts + (busy ? 0 : 1);
      if (error instanceof ImportFailed || attempts >= this.deps.policy().maxAttempts) {
        this.deps.log().warn("a pull request's head could not be imported", {
          number: row.number,
          error,
        });
        this.drop(row.number);
        await discardImport(this.deps, work);
        return;
      }
      // Tried again later, behind the others.
      this.#save(row, work, {
        attempts,
        requestedAt: git.context.now() + this.deps.policy().retryMs * 2 ** attempts,
      });
      return;
    }
    if (next.step !== "publish") {
      // Replaced meanwhile: this one's rows and lease go.
      if (!this.#save(row, next)) await discardImport(this.deps, next);
      return;
    }
    // Published, the revision becomes readable through the base: its author must read the head
    // still (asked again now; a failure to ask is tried again later, a refusal ends the import).
    let reads: boolean;
    try {
      reads = await this.deps.authorReads(row);
    } catch (error) {
      this.deps.log().warn("asking for a head's access failed", { number: row.number, error });
      const attempts = row.attempts + 1;
      const saved =
        attempts < this.deps.policy().maxAttempts &&
        this.#save(row, next, {
          attempts,
          requestedAt: git.context.now() + this.deps.policy().retryMs * 2 ** attempts,
        });
      if (!saved) {
        if (this.#unchanged(row)) this.drop(row.number);
        await discardImport(this.deps, next);
      }
      return;
    }
    if (!reads) {
      if (this.#unchanged(row)) this.drop(row.number);
      await discardImport(this.deps, next);
      return;
    }
    let outcome: "published" | "stale" | "restart";
    try {
      outcome = git.context.storage.transactionSync((): typeof outcome => {
        if (!this.#unchanged(row)) return "stale";
        if (!readyToPublish(this.deps, next)) return "restart";
        const done = this.deps.publish(row.number, next, row);
        sql.exec("DELETE FROM revision_imports WHERE pr_number = ?", row.number);
        sql.exec("DELETE FROM import_commits WHERE import_id = ?", next.importId);
        return done ? "published" : "stale";
      });
    } catch (error) {
      // Left its network meanwhile: nothing of the head can be published any more.
      if (error instanceof ImportFailed) {
        this.deps.log().warn("a pull request's head could not be imported", {
          number: row.number,
          error,
        });
        this.drop(row.number);
        await discardImport(this.deps, next);
        return;
      }
      // Frozen meanwhile, or waiting for the view's compaction: it waits, unspent.
      if (!this.deps.writable() || error instanceof ImportBusy) {
        waitOn(git, error);
        this.#save(row, next, { requestedAt: git.context.now() + this.deps.policy().retryMs });
        return;
      }
      // Its ref transaction refused (the repository changed under it): from the start, counted.
      this.deps
        .log()
        .warn("publishing a pull request's head failed", { number: row.number, error });
      outcome = "restart";
    }
    if (outcome === "restart") {
      // A pack left the view, or the head's graph changed under the copy: from the start.
      sql.exec("DELETE FROM import_commits WHERE import_id = ?", next.importId);
      if (!this.#unchanged(row)) return void (await discardImport(this.deps, next));
      if (row.attempts + 1 >= this.deps.policy().maxAttempts) {
        this.drop(row.number);
        if ((next.state.packs?.length ?? 0) > 0) collectLater(git);
        this.deps.log().warn("a pull request's head could not be imported", {
          number: row.number,
          error: "its packs or history kept changing",
        });
      } else
        this.#save(
          row,
          { ...next, step: "snapshot", leaseId: null, state: {} },
          {
            attempts: row.attempts + 1,
          },
        );
      await releaseLease(this.deps, next);
      return;
    }
    if (outcome === "stale") await discardImport(this.deps, next);
    else {
      if ((next.state.packs?.length ?? 0) > 0) collectLater(git);
      await releaseLease(this.deps, next);
    }
  }

  /** Stores the import's progress, if it is still the one `row` read; false when it was replaced. */
  #save(
    row: ImportRow,
    work: ImportWork,
    extra: { readonly attempts?: number; readonly requestedAt?: number } = {},
  ): boolean {
    const { git } = this.deps;
    const cursor = git.context.storage.sql.exec(
      `UPDATE revision_imports SET step = ?, lease_id = ?, state = ?, attempts = ?,
         requested_at = ?, updated_at = ?
       WHERE pr_number = ? AND ref_version = ? AND generation = ?`,
      work.step,
      work.leaseId,
      JSON.stringify(work.state),
      extra.attempts ?? row.attempts,
      extra.requestedAt ?? row.requestedAt,
      git.context.now(),
      row.number,
      row.refVersion,
      row.generation,
    );
    cursor.toArray();
    return cursor.rowsWritten > 0;
  }

  /** Whether the queued import is still the one `row` read. */
  #unchanged(row: ImportRow): boolean {
    const now = this.get(row.number);
    return (
      now !== undefined && now.refVersion === row.refVersion && now.generation === row.generation
    );
  }
}

/** The one job running imports. */
export const REVISION_IMPORT_JOB = "revision-import";

/** The staged rows' key of an import: one per revision of a pull request. */
export const importIdOf = (row: Pick<ImportRow, "number" | "generation" | "refVersion">) =>
  `pr:${row.number}:${row.generation}:${row.refVersion}`;

type RawImport = {
  pr_number: number;
  head_repo_id: string;
  generation: number;
  ref_version: number;
  sha: string;
  pusher: string | null;
  pusher_grant: string | null;
  step: ImportStep;
  lease_id: string | null;
  state: string | null;
  attempts: number;
  requested_at: number;
};

export interface ImportRow {
  readonly number: number;
  readonly headRepoId: string;
  readonly generation: number;
  readonly refVersion: number;
  readonly sha: string;
  readonly pusher: string | null;
  readonly pusherGrant: string | null;
  readonly step: ImportStep;
  readonly leaseId: string | null;
  readonly state: ImportState;
  readonly attempts: number;
  readonly requestedAt: number;
}

function importRow(raw: RawImport): ImportRow {
  return {
    number: raw.pr_number,
    headRepoId: raw.head_repo_id,
    generation: raw.generation,
    refVersion: raw.ref_version,
    sha: raw.sha,
    pusher: raw.pusher,
    pusherGrant: raw.pusher_grant,
    step: raw.step,
    leaseId: raw.lease_id,
    state: raw.state ? (JSON.parse(raw.state) as ImportState) : {},
    attempts: raw.attempts,
    requestedAt: raw.requested_at,
  };
}
