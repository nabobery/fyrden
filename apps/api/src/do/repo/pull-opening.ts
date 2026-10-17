import type { RefActor } from "@fyrden/adapters-cloudflare/git";
import { rootIdentity } from "@fyrden/domain";
import { isAncestor, oidFromHex, WalkLimitError } from "@fyrden/git-core";
import {
  ImportBusy,
  type ImportDeps,
  type ImportPolicy,
  importInForeground,
  publishStaged,
  readyToPublish,
} from "../../network/pull-import.js";
import { BROWSE_POLICY } from "./browse.js";
import type { RepoFeed } from "./feed.js";
import { OPEN_IMPORT_CALLS, OPEN_IMPORT_STEPS } from "./fork-pulls.js";
import type { PullView } from "./mergeability.js";
import type { OpenPull, PullRecord } from "./pulls.js";
import type { WriteContext } from "./write-context.js";

/*
 * Pull requests opened: between two of the repository's branches, or from
 * a branch of another repository of its fork network, whose revision is
 * imported first and published with the opening. Each is checked again
 * (the repository takes changes, the caller's role) with no await before
 * its commit, and tried again when the refs moved meanwhile.
 */

/** A pull request opened, or why not. */
export type PullOpened =
  | { ok: true; record: PullView }
  | {
      ok: false;
      code:
        | "repo_not_found"
        | "repo_transferring"
        | "access_lost"
        | "base_not_found"
        | "head_not_found"
        | "same_branches"
        | "no_commits"
        | "already_exists"
        | "busy";
      number?: number;
    };

/** A pull request from another repository opened, or why not. */
export type ForkPullOpened =
  | { ok: true; record: PullView }
  | {
      ok: false;
      code:
        | "repo_not_found"
        | "repo_transferring"
        | "access_lost"
        | "base_not_found"
        | "head_not_found"
        | "no_commits"
        | "already_exists"
        | "too_expensive"
        | "view_full"
        | "busy";
      number?: number;
    };

export interface OpeningDeps extends WriteContext {
  readonly feed: RepoFeed;
  readonly importDeps: () => ImportDeps;
  readonly importPolicy: () => ImportPolicy;
  /** Whether `root` reads the repository `headRepoId`, asked of its object. */
  readonly headReadable: (headRepoId: string, root: string) => Promise<boolean>;
  /** A pull request with whether it merges, as far as that is known now. */
  readonly viewed: (pull: PullRecord) => PullView;
  /** For tests: runs before a revision imported from another repository is published. */
  readonly forkPullHooks: () => { readonly beforePublish?: () => Promise<void> };
}

export class PullOpening {
  constructor(private readonly deps: OpeningDeps) {}

  /**
   * Opens a pull request from one of the repository's branches into
   * another, for a caller the Worker found may open one (checked again
   * here, with no await before the commit).
   */
  async open(input: Omit<OpenPull, "baseSha" | "headSha">, actor: RefActor): Promise<PullOpened> {
    const { git, pulls, feed, authority } = this.deps;
    await this.deps.checkEpoch();
    const ceilings = await authority.rolesPulled(actor.principal, actor.grantId ?? null);
    const root = rootIdentity({
      principalId: actor.principal,
      grantId: actor.grantId ?? null,
      ceilingIds: ceilings,
    });
    if (input.baseRef === input.headRef)
      return { ok: false as const, code: "same_branches" as const };
    const mentioned = await feed.prepare([input.body]);
    for (let attempt = 0; attempt < 3; attempt++) {
      const refused = this.deps.writeRefusal();
      if (refused) return { ok: false as const, code: refused.code as "repo_not_found" };
      if (authority.roleNow(actor.principal, ceilings) === null)
        return { ok: false as const, code: "access_lost" as const };
      const { version } = git.refStore.state();
      const baseSha = pulls.branchTip(input.baseRef);
      if (!baseSha) return { ok: false as const, code: "base_not_found" as const };
      const headSha = pulls.branchTip(input.headRef);
      if (!headSha) return { ok: false as const, code: "head_not_found" as const };
      let merged: boolean;
      try {
        merged = await isAncestor(git.commitGraph, "verified", headSha, baseSha, {
          maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
        });
      } catch (error) {
        // Too far apart to tell cheaply: the head has commits of its own.
        if (!(error instanceof WalkLimitError)) throw error;
        merged = false;
      }
      if (merged) return { ok: false as const, code: "no_commits" as const };
      if (git.refStore.state().version !== version) continue;
      const role = authority.roleNow(actor.principal, ceilings);
      const opened = feed.within({ root, role, mentioned }, () =>
        pulls.open({ ...input, baseSha, headSha }, version, { actor, root }),
      );
      if (!opened.ok && opened.code === "version-conflict") continue;
      this.deps.committed();
      return opened.ok ? { ok: true as const, record: this.deps.viewed(opened.record) } : opened;
    }
    return { ok: false as const, code: "busy" as const };
  }

  /**
   * Opens a pull request whose head is a branch of another repository of
   * the network (`headRepoId`, which the Worker found the caller reads):
   * the head's revision is imported first (its packs borrowed, its commit
   * graph copied), then the pull request is opened on it, its rows joining
   * the graph in the same transaction; the head's repository then tells of
   * each later revision.
   */
  async openFromFork(
    input: Omit<OpenPull, "baseSha" | "headSha" | "headRefVersion"> & {
      readonly headRepoId: string;
    },
    actor: RefActor,
  ): Promise<ForkPullOpened> {
    const { git, pulls, feed, authority } = this.deps;
    await this.deps.checkEpoch();
    const ceilings = await authority.rolesPulled(actor.principal, actor.grantId ?? null);
    const root = rootIdentity({
      principalId: actor.principal,
      grantId: actor.grantId ?? null,
      ceilingIds: ceilings,
    });
    // What can be refused without importing anything is refused first.
    const refusedEarly = this.deps.writeRefusal();
    if (refusedEarly) return { ok: false as const, code: refusedEarly.code as "repo_not_found" };
    if (authority.roleNow(actor.principal, ceilings) === null)
      return { ok: false as const, code: "access_lost" as const };
    if (!pulls.branchTip(input.baseRef))
      return { ok: false as const, code: "base_not_found" as const };
    const existing = pulls.openBetween(input.headRef, input.baseRef, input.headRepoId);
    if (existing !== undefined)
      return { ok: false as const, code: "already_exists" as const, number: existing };
    const mentioned = await feed.prepare([input.body]);
    const head = this.deps.env().REPO.getByName(input.headRepoId);
    const tip = await head.pullHeadTip(input.headRef);
    if (!tip.sha) return { ok: false as const, code: "head_not_found" as const };
    const imported = await importInForeground(
      this.deps.importDeps(),
      { importId: `open:${crypto.randomUUID()}`, headRepoId: input.headRepoId, sha: tip.sha },
      {
        policy: this.deps.importPolicy(),
        maxSteps: OPEN_IMPORT_STEPS,
        // Calls this invocation makes to other objects: within Free's 1,000, with room to spare.
        budget: { used: 2, max: OPEN_IMPORT_CALLS },
      },
      async (work) => {
        await this.deps.forkPullHooks().beforePublish?.();
        // Published, the revision becomes readable through the base: the opener must read the
        // head's repository still (the Worker checked it before the import began).
        if (!(await this.deps.headReadable(input.headRepoId, root)))
          return { ok: false as const, code: "head_not_found" as const };
        for (let attempt = 0; attempt < 3; attempt++) {
          const refused = this.deps.writeRefusal();
          if (refused) return { ok: false as const, code: refused.code as "repo_not_found" };
          if (authority.roleNow(actor.principal, ceilings) === null)
            return { ok: false as const, code: "access_lost" as const };
          const { version } = git.refStore.state();
          const baseSha = pulls.branchTip(input.baseRef);
          if (!baseSha) return { ok: false as const, code: "base_not_found" as const };
          const headSha = oidFromHex(work.sha);
          // A head the base's graph has already is in its history unless it is ahead of the base.
          if (git.commitGraph.readSync([headSha], "verified")[0]) {
            let merged: boolean;
            try {
              merged = await isAncestor(git.commitGraph, "verified", headSha, baseSha, {
                maxCommits: 3 * BROWSE_POLICY.compareMaxCommits,
              });
            } catch (error) {
              if (!(error instanceof WalkLimitError)) throw error;
              merged = false;
            }
            if (merged) return { ok: false as const, code: "no_commits" as const };
          }
          if (git.refStore.state().version !== version) continue;
          if (
            !git.context.storage.transactionSync(() => readyToPublish(this.deps.importDeps(), work))
          )
            return { ok: false as const, code: "busy" as const };
          const role = authority.roleNow(actor.principal, ceilings);
          const opened = feed.within({ root, role, mentioned }, () =>
            pulls.open(
              { ...input, baseSha, headSha, headRefVersion: tip.refVersion },
              version,
              { actor, root },
              () => {
                // Checked again in the ref transaction: the base's collection may have run.
                if (!readyToPublish(this.deps.importDeps(), work))
                  throw new ImportBusy("the import changed");
                publishStaged(git, work.importId);
              },
            ),
          );
          if (opened.ok || opened.code !== "version-conflict") return opened;
        }
        return { ok: false as const, code: "busy" as const };
      },
    );
    if (!imported.ok)
      return {
        ok: false as const,
        code: imported.code === "unknown_commit" ? "head_not_found" : imported.code,
      };
    const opened = imported.value;
    if (!opened.ok) return opened;
    this.deps.committed();
    return { ok: true as const, record: this.deps.viewed(opened.record) };
  }
}
