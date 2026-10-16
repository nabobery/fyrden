import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import type { RepoAcl } from "./acl.js";
import type { RepoAuthority } from "./authority.js";
import { type Browsed, fail } from "./browse.js";
import type { RepoEvents, RepoUpdate } from "./events.js";
import type { RepoRulesets, RulesetInput, RulesetRecord } from "./rulesets.js";
import type { WriteRefusal } from "./write-context.js";

/*
 * Changes only an administrator of the repository may make: its settings,
 * its rulesets, its webhooks. The Worker checks the caller before the
 * call; the caller's role (capped by the owners of an agent acting) is
 * pulled again here and checked with no await before the change.
 */

/** What a repository object knows of the repository's details. */
export interface RepoDetails {
  readonly headTarget: string | null;
  readonly description: string | null;
}

/** A ruleset created, replaced or deleted. */
export type RulesetChange =
  | { readonly op: "create"; readonly input: RulesetInput }
  | { readonly op: "update"; readonly id: number; readonly input: RulesetInput }
  | { readonly op: "delete"; readonly id: number };

/** Whether a hook URL is plain http (as its parser reads it). */
function isHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return true;
  }
}

export interface AdministrationDeps {
  readonly git: RepoGitStorage;
  readonly acl: RepoAcl;
  readonly authority: RepoAuthority;
  readonly events: RepoEvents;
  readonly rulesets: () => RepoRulesets;
  /** The repository's details now. */
  readonly details: () => RepoDetails;
  /** Takes the directory's epoch (a change needs it first). */
  readonly checkEpoch: () => Promise<void>;
  /** Whether the object is erasing its storage, or has. */
  readonly closed: () => boolean;
  /** Why the repository takes no change now. */
  readonly writeRefusal: () => WriteRefusal | undefined;
  /** Arms the alarm for the outbox's next drain. */
  readonly armOutbox: () => void;
  /** Queues the audit archiver while audit rows wait to be archived. */
  readonly ensureAuditArchive: () => void;
}

export class RepoAdministration {
  constructor(private readonly deps: AdministrationDeps) {}

  /**
   * Updates the repository's settings: a rename the directory has made,
   * the description, the default branch (which must exist). Returns the
   * details after the update.
   */
  async updateSettings(input: {
    name?: RepoUpdate["name"];
    description?: string | null;
    defaultBranch?: string;
    actor: RefActor | null;
  }): Promise<
    | { ok: true; details: RepoDetails }
    | {
        ok: false;
        code: "branch_not_found" | "repo_deleted" | "repo_transferring" | "access_lost";
      }
  > {
    const { events, acl } = this.deps;
    await this.deps.checkEpoch();
    // The actor administers the repository now: the Worker checked it
    // before this call; access may have been revoked since. Pulled for a
    // write, then checked with no await before the change.
    const principal = input.actor?.principal;
    // With the owners capping an agent acting (they may have lost access meanwhile too).
    const ceilings = principal
      ? await this.deps.authority.rolesPulled(principal, input.actor?.grantId ?? null)
      : [];
    // Its deletion started after the caller found it.
    if (events.isDeleted()) return { ok: false as const, code: "repo_deleted" as const };
    // The directory refuses a rename while a transfer moves it: no name to record.
    if (events.isTransferring()) return { ok: false as const, code: "repo_transferring" as const };
    if (principal && ![principal, ...ceilings].every((p) => acl.allows(p, "admin"))) {
      // The directory's name is recorded even so: a rename already happened there.
      if (input.name) events.update({ name: input.name, actor: input.actor });
      this.deps.armOutbox();
      this.deps.ensureAuditArchive();
      return { ok: false as const, code: "access_lost" as const };
    }
    const head =
      input.defaultBranch === undefined ? undefined : `refs/heads/${input.defaultBranch}`;
    if (head !== undefined && !this.deps.git.refStore.hasRef(head)) {
      // The directory's name is recorded even so: it is already in use.
      if (input.name) events.update({ name: input.name, actor: input.actor });
      this.deps.armOutbox();
      this.deps.ensureAuditArchive();
      return { ok: false as const, code: "branch_not_found" as const };
    }
    events.update({
      ...(input.name && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(head !== undefined && { head }),
      actor: input.actor,
    });
    this.deps.armOutbox();
    this.deps.ensureAuditArchive();
    return { ok: true as const, details: this.deps.details() };
  }

  /**
   * Creates, replaces or deletes a ruleset for an administrator (the
   * Worker checked it; checked again here, with no await before the change).
   */
  async changeRuleset(
    change: RulesetChange,
    actor: RefActor,
  ): Promise<
    | { ok: true; record: RulesetRecord | null }
    | {
        ok: false;
        code:
          | "repo_deleted"
          | "repo_transferring"
          | "access_lost"
          | "not_found"
          | "name_taken"
          | "too_many";
      }
  > {
    const { events } = this.deps;
    await this.deps.checkEpoch();
    // With the owners capping an agent acting (they may have lost access meanwhile too).
    const ceilings = await this.deps.authority.rolesPulled(actor.principal, actor.grantId ?? null);
    if (this.deps.closed() || events.isDeleted())
      return { ok: false as const, code: "repo_deleted" as const };
    if (events.isTransferring()) return { ok: false as const, code: "repo_transferring" as const };
    if (![actor.principal, ...ceilings].every((p) => this.deps.acl.allows(p, "admin")))
      return { ok: false as const, code: "access_lost" as const };
    const store = this.deps.rulesets();
    const done =
      change.op === "create"
        ? store.create(change.input, actor)
        : change.op === "update"
          ? (store.update(change.id, change.input, actor) ?? ("not_found" as const))
          : store.delete(change.id, actor)
            ? null
            : ("not_found" as const);
    if (typeof done === "string") return { ok: false as const, code: done };
    this.deps.ensureAuditArchive();
    return { ok: true as const, record: done };
  }

  /**
   * Runs `change` for an administrator of a writable repository: what it
   * needs made first (`prepare`, which may wait), then the checks and the
   * change with no wait between them.
   */
  async asHookAdmin<P, T>(
    actor: RefActor,
    prepare: (() => Promise<Browsed<P>>) | undefined,
    change: (prepared: P) => Browsed<T>,
  ): Promise<Browsed<T>> {
    await this.deps.checkEpoch();
    const ceilings = await this.deps.authority.rolesPulled(actor.principal, actor.grantId ?? null);
    const prepared = prepare ? await prepare() : ({ ok: true, value: undefined as P } as const);
    if (!prepared.ok) return prepared;
    const refusedWrite = this.deps.writeRefusal();
    if (refusedWrite) return fail(refusedWrite.status, refusedWrite.code, refusedWrite.error);
    if (![actor.principal, ...ceilings].every((p) => this.deps.acl.allows(p, "admin")))
      return fail(404, "repo_not_found", "You no longer administer this repository.");
    const done = change(prepared.value);
    this.deps.armOutbox();
    this.deps.ensureAuditArchive();
    return done;
  }

  /** The refusal of a webhook URL a private repository may not use (plain http). */
  insecureHookUrl(url: string | undefined): Browsed<never> | undefined {
    return url !== undefined && isHttp(url) && this.deps.events.visibility() !== "public"
      ? fail(422, "insecure_url", "A private repository's webhooks need an https URL.")
      : undefined;
  }
}
