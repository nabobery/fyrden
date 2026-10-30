import type { TokenRecord } from "@fyrden/adapters-cloudflare/auth";
import { atLeast, ownsUserAccount, type RepoRole } from "@fyrden/domain";
import { ceilingsOf, effectiveRole } from "../do/repo/authority.js";
import type { OpContext } from "../ops/execute.js";
import type { RepoEntry } from "../repos/directory.js";

/*
 * The authoritative check of a feed's reader, apart from the repository's
 * cached ACL snapshot (which a lost invalidation leaves standing until it
 * ages out): the reader's role on each repository as its account's object
 * has it now, read linearized after that object's epoch check, capped by
 * the reader's ceilings (a delegation grant's owners, or an agent's owner)
 * read from the directory's primary. The account itself, and a user
 * account's owner, administer its repositories, as the repository judges
 * them; a repository the account released to another (a transfer) is read
 * through it by no one.
 */

/**
 * A repository's fresh decision under the account asked: whether that
 * account still holds it, and the reader's role there (null for none).
 */
export type FreshDecision =
  | { readonly held: boolean; readonly role: RepoRole | null; readonly accountId: string }
  | "unknown";

export class FreshAccess {
  #ceilings: Promise<string[]> | undefined;

  constructor(
    private readonly ctx: Pick<OpContext, "env" | "metrics">,
    /** The reader's credential, as the directory's primary has it now. */
    private readonly auth: TokenRecord,
  ) {}

  /**
   * The reader's role on each of `entries`, one call to each owning
   * account's object (concurrently); `unknown` for those whose account
   * could not answer (an error, or an earlier object without the call
   * while a deploy rolls out). `live`: the accounts one at a time, each
   * through its bounded check (`confirmReadersLive`), a role it could not
   * bound read as `unknown` (an object without the call: all `unknown`,
   * never the unbounded check). `checkpoint` (live only): called after
   * each await and before each account; what it throws stops the chain
   * (never read as an account's `unknown`).
   */
  async decide(
    entries: readonly RepoEntry[],
    options: { readonly live?: boolean; readonly checkpoint?: () => void } = {},
  ): Promise<Map<string, FreshDecision>> {
    const checkpoint = options.live ? options.checkpoint : undefined;
    const decided = new Map<string, FreshDecision>();
    if (entries.length === 0) return decided;
    const byAccount = new Map<string, RepoEntry[]>();
    for (const entry of entries)
      byAccount.set(entry.ownerId, [...(byAccount.get(entry.ownerId) ?? []), entry]);
    let ceilings: string[];
    try {
      ceilings = await this.#ceilingsOf();
    } catch {
      checkpoint?.();
      for (const entry of entries) decided.set(entry.id, "unknown");
      return decided;
    }
    checkpoint?.();
    const principal = this.auth.principalId;
    const decideAccount = async ([accountId, repos]: [string, RepoEntry[]]) => {
      const ids = repos.map((r) => r.id);
      const readers = [principal, ...ceilings];
      const stub = this.ctx.env.ORG.getByName(accountId);
      this.ctx.metrics.count("do.request", {
        class: "OrgDO",
        method: options.live ? "confirmReadersLive" : "confirmReaders",
      });
      const answer = await (options.live
        ? stub.confirmReadersLive(ids, readers)
        : stub.confirmReaders(ids, readers)
      ).catch(() => undefined);
      // Outside the catch: an invalidation stops the chain.
      checkpoint?.();
      for (const entry of repos) {
        const repo = answer?.repos?.[entry.id];
        const roles = repo?.roles as
          | Readonly<Record<string, RepoRole | null | "unknown">>
          | undefined;
        if (!repo || (roles && readers.some((id) => roles[id] === "unknown"))) {
          decided.set(entry.id, "unknown");
          continue;
        }
        if (!repo.held) {
          decided.set(entry.id, { held: false, role: null, accountId });
          continue;
        }
        // As the repository judges them: the account itself, and a user account's owner, administer.
        const roleOf = (id: string): RepoRole | null =>
          id === accountId || ownsUserAccount(id, accountId)
            ? "admin"
            : ((roles?.[id] as RepoRole | null | undefined) ?? null);
        decided.set(entry.id, {
          held: true,
          role: effectiveRole((id, min) => atLeast(roleOf(id), min), principal, ceilings),
          accountId,
        });
      }
    };
    if (options.live)
      for (const account of byAccount) {
        checkpoint?.();
        await decideAccount(account);
      }
    else await Promise.all([...byAccount].map(decideAccount));
    return decided;
  }

  /** The reader's ceilings, from the directory's primary, read once. */
  #ceilingsOf(): Promise<string[]> {
    this.#ceilings ??= ceilingsOf(
      this.ctx.env,
      this.auth.principalId,
      this.auth.grantId,
      this.ctx.metrics,
    );
    return this.#ceilings;
  }
}
