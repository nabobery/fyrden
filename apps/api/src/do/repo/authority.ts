import { readGrantLinks } from "@fyrden/adapters-cloudflare/auth";
import type { RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import { type MergeContext, principalTypeOf, REPO_ROLES, type RepoRole } from "@fyrden/domain";
import {
  type BlockCache,
  bytesBody,
  encodePushResponse,
  failAtomically,
  liveCommands,
  type Oid,
  oidToHex,
  type PackId,
  planPush,
  readPushBody,
} from "@fyrden/git-core";
import { openLiveReader, ReadBudgetError } from "../../git/live-reader.js";
import type { RepoPush } from "../../git/push/repo-push.js";
import { type SignedFact, verdicts } from "../../signing/verification.js";
import type { RepoAcl } from "./acl.js";
import { BROWSE_POLICY } from "./browse.js";
import {
  checkPushRules,
  hasPrecheckRules,
  precheckPushRules,
  type RuleSnapshot,
} from "./push-rules.js";
import type { RepoRulesets } from "./rulesets.js";
import { factOf } from "./signature.js";

/*
 * Who may write what, decided from the repository's ACL snapshot and its
 * rulesets: a principal's effective role (the weakest of its own and its
 * ceilings', the owners capping an agent or a delegation grant), and the
 * rulesets' judgement of the ref updates a write asks for, before anything
 * is stored and again at the commit point.
 */

/** Principals one directory query looks up (D1 binds at most 100 parameters). */
const OWNER_BATCH = 50;

/** Stands for a commit not made yet in a ruleset precheck (only the update's kind matters there). */
export const ZERO_ID = "0".repeat(40);

export interface AuthorityDeps {
  readonly git: RepoGitStorage;
  /** The Worker's bindings, read at each use (tests may replace them). */
  readonly env: () => Env;
  readonly acl: RepoAcl;
  readonly rulesets: () => RepoRulesets;
  readonly memoryBlocks: () => BlockCache;
}

export class RepoAuthority {
  constructor(private readonly deps: AuthorityDeps) {}

  /** The strongest role the current ACL snapshot allows (an owner's: admin). */
  #ruleRoleNow(principal: string): RepoRole | null {
    for (const role of [...REPO_ROLES].reverse())
      if (this.deps.acl.allows(principal, role)) return role;
    return null;
  }

  /** The principal's effective role now: the weakest of its own and its `ceilings`'. */
  roleNow(principal: string, ceilings: readonly string[]): RepoRole | null {
    let role = this.#ruleRoleNow(principal);
    for (const id of ceilings) {
      const cap = this.#ruleRoleNow(id);
      if (cap === null || (role !== null && REPO_ROLES.indexOf(cap) < REPO_ROLES.indexOf(role)))
        role = cap;
    }
    return role;
  }

  /**
   * Owners whose roles cap a write's: the agents' owners of its delegation
   * grant's chain, or an agent's own owner; none for a user's own token.
   * From the directory's primary (a grant or an owner may change at any time).
   */
  async ceilingsOf(principal: string, grantId: string | null): Promise<string[]> {
    const db = this.deps.env().DIRECTORY.withSession("first-primary");
    const metrics = this.deps.git.context.metrics;
    if (grantId !== null) {
      metrics.count("d1.query", { db: "directory", op: "token_grants" });
      return [...new Set((await readGrantLinks(db, grantId)).map((l) => l.owner_id))];
    }
    if (principalTypeOf(principal) !== "agent") return [];
    metrics.count("d1.query", { db: "directory", op: "agent_owner" });
    const row = await db
      .prepare("SELECT owner_id FROM principals WHERE id = ?")
      .bind(principal)
      .first<{ owner_id: string | null }>();
    return row?.owner_id ? [row.owner_id] : [];
  }

  /**
   * Which of `principals` are active (not disabled, nor, for an agent, its
   * owner: a suspended user's approvals stop counting at once), each with
   * the owners capping it (an agent's own owner; none for a user), from the
   * directory's primary in batches, with all their roles pulled fresh: a
   * few queries however many principals there are.
   */
  async activeOwnersPulled(principals: readonly string[]): Promise<Map<string, string[]>> {
    const owners = new Map<string, string[]>();
    const unique = [...new Set(principals)];
    const db = this.deps.env().DIRECTORY.withSession("first-primary");
    for (let at = 0; at < unique.length; at += OWNER_BATCH) {
      const batch = unique.slice(at, at + OWNER_BATCH);
      this.deps.git.context.metrics.count("d1.query", { db: "directory", op: "active_owners" });
      const { results } = await db
        .prepare(
          `SELECT p.id, p.owner_id FROM principals p LEFT JOIN principals o ON o.id = p.owner_id
           WHERE p.id IN (${batch.map(() => "?").join(", ")}) AND p.disabled_at IS NULL
             AND o.disabled_at IS NULL`,
        )
        .bind(...batch)
        .all<{ id: string; owner_id: string | null }>();
      for (const row of results)
        owners.set(
          row.id,
          principalTypeOf(row.id) === "agent" && row.owner_id ? [row.owner_id] : [],
        );
    }
    for (const id of new Set([...owners.keys(), ...[...owners.values()].flat()]))
      await this.deps.acl.roleOf(id, "write");
    return owners;
  }

  /**
   * Of `principals`, those being deleted or deleted (a review requested of
   * one holds a place no one can take back by name: their handle is gone),
   * from the directory's primary in batches.
   */
  async deletedOf(principals: readonly string[]): Promise<Set<string>> {
    const deleted = new Set<string>();
    const unique = [...new Set(principals)];
    const db = this.deps.env().DIRECTORY.withSession("first-primary");
    for (let at = 0; at < unique.length; at += OWNER_BATCH) {
      const batch = unique.slice(at, at + OWNER_BATCH);
      this.deps.git.context.metrics.count("d1.query", {
        db: "directory",
        op: "deleted_principals",
      });
      const { results } = await db
        .prepare(
          `SELECT id FROM principals WHERE id IN (${batch.map(() => "?").join(", ")})
             AND lifecycle IN ('deleting', 'deleted')`,
        )
        .bind(...batch)
        .all<{ id: string }>();
      for (const row of results) deleted.add(row.id);
    }
    return deleted;
  }

  /** A write's ceilings, with the principal's and their roles pulled fresh (one snapshot serves all). */
  async rolesPulled(principal: string, grantId: string | null): Promise<string[]> {
    const ceilings = await this.ceilingsOf(principal, grantId);
    for (const id of [principal, ...ceilings]) await this.deps.acl.roleOf(id, "write");
    return ceilings;
  }

  /**
   * Whether `principalId` is still active (it and, for an agent, its
   * owner not disabled), read from the directory's primary: a role it was
   * granted outlives its disabling.
   */
  async principalActive(principalId: string): Promise<boolean> {
    const row = await this.deps
      .env()
      .DIRECTORY.withSession("first-primary")
      .prepare(
        `SELECT p.disabled_at, o.disabled_at AS owner_disabled_at FROM principals p
         LEFT JOIN principals o ON o.id = p.owner_id WHERE p.id = ?`,
      )
      .bind(principalId)
      .first<{ disabled_at: number | null; owner_disabled_at: number | null }>();
    return row !== null && row.disabled_at === null && row.owner_disabled_at === null;
  }

  /**
   * What a push's rules read, taken at once: the rulesets (with their
   * version), HEAD and the pusher's effective role (the weakest of its own
   * and its `ceilings`', so an agent's bypass is never its owner's above),
   * and a stamp of them that the commit's transaction compares.
   */
  #ruleSnapshot(
    principal: string,
    ceilings: readonly string[] = [],
  ): { snapshot: RuleSnapshot; stamp: string } {
    const { version, rulesets } = this.deps.rulesets().current();
    const head = this.deps.git.refStore.head();
    const role = this.roleNow(principal, ceilings);
    return {
      snapshot: { rulesets: rulesets.map((r) => r.ruleset), head, role },
      stamp: JSON.stringify([version, head, role]),
    };
  }

  /** The rulesets' refusal of ref updates a write or upload session asks for, before anything is stored. */
  async precheckUpdates(
    principal: string,
    updates: readonly {
      readonly ref: string;
      readonly old: string | null;
      readonly new: string | null;
    }[],
    /** The delegation grant the write is made under (an agent acts for `principal`); null for none. */
    grantId: string | null,
    /** A default branch the write sets as it commits (an import's). */
    head?: string,
    /** The pull request the write merges, for its `pull_request` rules. */
    merge?: MergeContext,
  ): Promise<string | undefined> {
    if (!hasPrecheckRules(this.deps.rulesets())) return undefined;
    const ceilings = await this.rolesPulled(principal, grantId);
    const delegated = grantId !== null;
    const refusals = precheckPushRules(
      this.#ruleSnapshot(principal, ceilings).snapshot,
      principal,
      updates.map((u, index) => ({
        index,
        name: u.ref,
        kind: u.old === null ? "create" : u.new === null ? "delete" : "update",
      })),
      delegated,
      head,
      merge,
    );
    return refusals.size === 0 ? undefined : [...refusals.values()].join("; ");
  }

  /**
   * The rulesets' check of a push's commands before its body is stored
   * (`head` is the start of the body): the git response refusing it when no
   * command may go on; otherwise the push goes on, and its refused commands
   * are refused again at its commit. A head that does not hold the whole
   * command section is not checked here.
   */
  async precheckPush(
    uploadId: string,
    head: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; response: Uint8Array }> {
    const { git } = this.deps;
    const upload = git.uploads.get(uploadId);
    if (!upload) return { ok: true };
    let plan: ReturnType<typeof planPush>;
    try {
      const { request } = await readPushBody(bytesBody(head), { pushOptionsAdvertised: true });
      plan = planPush(request, git.refStore.readRefsSync());
    } catch {
      return { ok: true };
    }
    const live = liveCommands(plan);
    const ceilings = await this.rolesPulled(upload.principal, upload.grantId);
    const refusals = precheckPushRules(
      this.#ruleSnapshot(upload.principal, ceilings).snapshot,
      upload.principal,
      live.map((cmd) => ({ index: cmd.index, name: cmd.name as string, kind: cmd.kind })),
      upload.grantId !== null,
    );
    const messages: string[] = [];
    for (const cmd of live) {
      const refusal = refusals.get(cmd.index);
      if (refusal === undefined) continue;
      cmd.error = refusal;
      messages.push(`error: ${refusal}`);
    }
    failAtomically(plan);
    if (liveCommands(plan).length > 0) return { ok: true };
    return {
      ok: false,
      response: encodePushResponse(
        { unpackError: undefined, commands: plan.commands },
        plan.capabilities,
        messages,
      ),
    };
  }

  /** The rulesets at a push's commit point (see `RepoPush.rules`). */
  pushRules(): NonNullable<RepoPush["rules"]> {
    const { git } = this.deps;
    return {
      check: async (input) => {
        // The pusher's effective role pulled fresh; then everything the
        // check reads, and its stamp, taken together with no await between them.
        const ceilings = await this.rolesPulled(input.principal, input.grantId);
        const { snapshot, stamp } = this.#ruleSnapshot(input.principal, ceilings);
        const signatures = this.#signatureReader(input.packs);
        let checked: Awaited<ReturnType<typeof checkPushRules>>;
        try {
          checked = await checkPushRules(
            {
              git,
              signatures: (oids) => signatures.facts(oids),
              verdicts: (facts) =>
                verdicts({ env: this.deps.env(), metrics: git.context.metrics }, facts),
            },
            snapshot,
            { ...input, delegated: input.grantId !== null },
          );
        } finally {
          signatures.release();
        }
        this.deps.rulesets().recordEvaluated(input.uploadId, input.principal, checked.evaluated);
        const { refusals } = checked;
        return {
          stamp,
          restamp: () => this.#ruleSnapshot(input.principal, ceilings).stamp,
          writable:
            snapshot.role !== null &&
            REPO_ROLES.indexOf(snapshot.role) >= REPO_ROLES.indexOf("write"),
          refusals,
        };
      },
    };
  }

  /**
   * Reads the signature facts of commits from the live packs and a push's
   * own `packs`: one reader for a whole check, opened on its first use,
   * within one request's read budget (once it is spent, a commit not read
   * yet is left out, so refused). The caller releases it.
   */
  #signatureReader(packs: readonly PackId[]): {
    facts: (oids: readonly Oid[]) => Promise<Map<string, SignedFact>>;
    release: () => void;
  } {
    let opened: Promise<Awaited<ReturnType<typeof openLiveReader>>> | undefined;
    let spent = false;
    const open = () => {
      opened ??= openLiveReader(
        { git: this.deps.git, memoryBlocks: this.deps.memoryBlocks() },
        {
          deltaBaseCacheBytes: 4 * 1024 * 1024,
          maxCacheCalls: BROWSE_POLICY.cacheCalls,
          maxReads: BROWSE_POLICY.maxReads,
          extraPacks: packs,
        },
      );
      return opened;
    };
    return {
      facts: async (oids) => {
        const facts = new Map<string, SignedFact>();
        if (spent) return facts;
        try {
          const reader = await open();
          if (!reader) return facts;
          await reader.prefetch(oids);
          for (const oid of oids) {
            const object = await reader.readObject(oid);
            if (object?.type === "commit") facts.set(oidToHex(oid), await factOf(object.bytes));
          }
        } catch (error) {
          // Out of reads: what was read counts; the rest is unreadable, so refused.
          if (!(error instanceof ReadBudgetError)) throw error;
          spent = true;
        }
        return facts;
      },
      release: () => {
        void opened?.then((reader) => reader?.release()).catch(() => {});
      },
    };
  }
}
