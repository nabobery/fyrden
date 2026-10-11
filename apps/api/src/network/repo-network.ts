import type { JobHandler, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { Logger } from "@fyrden/adapters-cloudflare/obs";
import type { BlockCache } from "@fyrden/git-core";
import type { MaintenancePolicy } from "../git/maintenance/policy.js";
import type { RewriteOutcome } from "../git/maintenance/rewrite.js";
import { beginDetach, type DetachHooks, detachHandler } from "./detach.js";
import {
  commitPage,
  condemnShared,
  exportForFork,
  finishFork,
  importCommits,
  initFork,
  networkSnapshot,
  registeredPacks,
} from "./member.js";
import { detachNotifier } from "./repo-client.js";
import type {
  CommitPage,
  CondemnAnswer,
  ExportedRef,
  ForkExport,
  MemberPack,
  ViewPack,
} from "./types.js";
import { type CompactSliceInput, compactBorrowedSlice, swapCompactedView } from "./view-cap.js";

export interface RepoNetworkWiring {
  readonly git: RepoGitStorage;
  readonly env: Env;
  readonly repoId: () => string;
  readonly blocks: () => BlockCache;
  readonly policy: () => MaintenancePolicy;
  readonly log: () => Logger;
  readonly detachHooks: () => DetachHooks;
}

/** Most commit rows one page of a fork's graph copy carries. Proposed. */
export const MAX_COMMIT_PAGE = 5_000;

/** One step of a fork's graph copy: pages from `parentId`, from `frontier` on. */
export interface CopyStepInput {
  readonly parentId: string;
  readonly frontier: readonly string[];
  readonly pageSize: number;
  /** Most pages (calls to the parent's object) this step makes. */
  readonly maxCalls: number;
  /** Wall time after which no new page starts. */
  readonly budgetMs: number;
}

export interface CopyStep {
  /** Where the next step starts; empty when the copy is complete. */
  readonly frontier: string[];
  readonly copied: number;
  readonly pages: number;
}

/**
 * The repository object's fork-network operations, as the
 * object's RPC methods call them: a parent's export, a fork's set-up, the
 * view-cap compaction, what the network object asks of a member, detach.
 */
export class RepoNetwork {
  constructor(private readonly wiring: RepoNetworkWiring) {}

  get #git(): RepoGitStorage {
    return this.wiring.git;
  }

  exportForFork(holder: string, ttlMs: number): Promise<ForkExport> {
    return exportForFork(this.#git, this.wiring.blocks(), holder, ttlMs);
  }

  commitPage(frontier: readonly string[], limit: number): CommitPage {
    return commitPage(this.#git, frontier, Math.max(1, Math.min(limit, MAX_COMMIT_PAGE)));
  }

  initFork(input: { networkId: string; head: string | null; packs: readonly ViewPack[] }): void {
    initFork(this.#git, input);
  }

  /**
   * One bounded step of a fork's graph copy, run by the fork's object: it
   * asks the parent's object for pages of verified commit rows and stores
   * them, until the copy is complete or the step has made `maxCalls` calls
   * or used its time (at least one page per step). Each call of this method
   * is its own invocation with its own budget of calls to other objects;
   * the caller continues from the returned frontier.
   */
  async copyGraphStep(input: CopyStepInput): Promise<CopyStep> {
    const git = this.#git;
    const parent = this.wiring.env.REPO.getByName(input.parentId);
    const deadline = git.context.now() + input.budgetMs;
    let frontier = [...input.frontier];
    let copied = 0;
    let pages = 0;
    while (
      frontier.length > 0 &&
      pages < Math.max(1, input.maxCalls) &&
      (pages === 0 || git.context.now() < deadline)
    ) {
      const page = await parent.forkCommitPage(frontier, input.pageSize);
      pages++;
      if (page.rows.length > 0) importCommits(git, page.rows);
      copied += page.rows.length;
      frontier = [...page.frontier];
    }
    return { frontier, copied, pages };
  }

  finishFork(refs: readonly ExportedRef[]): void {
    finishFork(this.#git, refs);
  }

  compactSlice(input: CompactSliceInput): Promise<{ runId: string; outcome: RewriteOutcome }> {
    return compactBorrowedSlice(this.#git, this.wiring.policy(), this.wiring.blocks(), input);
  }

  swapCompacted(output: string, sources: readonly string[]): ViewPack {
    return swapCompactedView(this.#git, output, sources);
  }

  networkSnapshot(networkId: string): MemberPack[] {
    return networkSnapshot(this.#git, networkId);
  }

  condemnShared(packIds: readonly string[]): CondemnAnswer {
    return condemnShared(this.#git, packIds);
  }

  registeredPacks(packIds: readonly string[]): string[] {
    return registeredPacks(this.#git, packIds);
  }

  beginDetach(newNetworkId: string): { ok: true } | { ok: false; error: string } {
    return beginDetach(this.#git, newNetworkId);
  }

  detachHandler(): JobHandler {
    return detachHandler(this.#git, {
      policy: this.wiring.policy,
      log: this.wiring.log(),
      blocks: this.wiring.blocks,
      hooks: this.wiring.detachHooks,
      notify: detachNotifier(this.wiring.env, this.wiring.repoId),
    });
  }
}
