import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { atLeast, type CodeOwnerFact, type CodeOwnersInput } from "@fyrden/domain";
import type { CodeOwnerTeams } from "../OrgDO.js";
import type { RepoAccount, RepoAcl } from "./acl.js";
import type { RepoAuthority } from "./authority.js";
import type { RepoCodeOwners } from "./code-owners.js";
import type { PullRecord } from "./pulls.js";

/*
 * What a merge knows of its code owners: the rules its evaluation found
 * deciding changed paths, each owner resolved and qualified now (a user or
 * agent from the directory's primary, active, with write access by the
 * ACL snapshot, an agent capped by its owner; a team of the repository's
 * own organization with a write grant, from the organization's object),
 * and the memberships of the reviewers who may satisfy them. Gathered
 * before anything is stored; the commit confirms what the decision used.
 */

/** Proposed. */
export const CODE_OWNER_MERGE_POLICY = {
  /** Users' and agents' handles one merge resolves at most (one directory query a hundred). */
  maxHandles: 1_000,
  /** Teams one merge resolves at most. */
  maxTeams: 128,
  /** Team memberships one merge reads at most (teams × reviewers who may satisfy them). */
  maxPairs: 4_096,
};

export type CodeOwnerMergePolicy = typeof CODE_OWNER_MERGE_POLICY;

/** Handles one directory query looks up (D1 binds at most 100 parameters). */
const HANDLE_BATCH = 90;

export interface CodeOwnerFactsDeps {
  readonly codeOwners: RepoCodeOwners;
  readonly env: () => Env;
  readonly account: () => RepoAccount | undefined;
  readonly acl: () => RepoAcl;
  readonly authority: RepoAuthority;
  readonly teams: (
    accountId: string,
    slugs: readonly string[],
    principals: readonly string[],
  ) => Promise<CodeOwnerTeams>;
  readonly policy: () => CodeOwnerMergePolicy;
  readonly metrics: Metrics;
}

/** A merge's code owners as prepared: the rules' input, the stamp its fence compares, or why it is refused. */
export interface PreparedCodeOwners {
  /** Absent: they could not be worked out (an `evaluate` rule leaves them unevaluated). */
  readonly input?: CodeOwnersInput;
  /** The evaluation the decision read, for the fence. */
  readonly stamp: string;
  /** Agent owners → the owner capping each, for the confirmation. */
  readonly ownerCeilings: ReadonlyMap<string, readonly string[]>;
  /** Why an enforced requirement refuses the merge before anything is stored. */
  readonly refusal?: { readonly status: 409 | 422; readonly code: string; readonly error: string };
}

type DirectoryRow = {
  id: string;
  type: "user" | "org" | "agent" | "installation";
  handle: string;
  owner_id: string | null;
  disabled_at: number | null;
  lifecycle: string;
  owner_disabled_at: number | null;
  owner_lifecycle: string | null;
};

class TooLarge extends Error {}

export class CodeOwnerFacts {
  constructor(private readonly deps: CodeOwnerFactsDeps) {}

  /**
   * The code owners a merge of `pull` is judged by, for a merger whose
   * rules `demand` them; `candidates`: the reviewers (and their root users)
   * whose approvals may satisfy owner teams, those its deciding rules need
   * (`required`, within the bounds or refused) and those only evaluated
   * rules would (`optional`, read when they fit).
   */
  async prepare(
    pull: PullRecord,
    demand: "enforced" | "evaluated",
    candidates: { readonly required: readonly string[]; readonly optional: readonly string[] },
  ): Promise<PreparedCodeOwners> {
    const view = this.deps.codeOwners.forMerge(pull);
    const none = new Map<string, string[]>();
    if (view.state === "none")
      return { input: { state: "none" }, stamp: view.stamp, ownerCeilings: none };
    if (view.state === "refused")
      return {
        input: { state: "refused", reason: view.reason },
        stamp: view.stamp,
        ownerCeilings: none,
      };
    try {
      const { facts, memberships, asked, ownerCeilings } = await this.#resolve(
        view.rules,
        candidates,
      );
      return {
        input: {
          state: "complete",
          requirements: view.rules.map((rule) => ({
            line: rule.line,
            example: rule.example,
            owners: rule.owners.map((token) => facts.get(token.toLowerCase()) as CodeOwnerFact),
          })),
          memberships,
          asked,
        },
        stamp: view.stamp,
        ownerCeilings,
      };
    } catch (error) {
      const tooLarge = error instanceof TooLarge;
      if (demand === "evaluated") return { stamp: view.stamp, ownerCeilings: none };
      return {
        stamp: view.stamp,
        ownerCeilings: none,
        refusal: tooLarge
          ? {
              status: 422,
              code: "code_owners_too_large",
              error: `The pull request's code owners are more than a merge here resolves (${(error as Error).message}).`,
            }
          : {
              status: 409,
              code: "authorization_unavailable",
              error: "The code owners' access could not be read; try the merge again.",
            },
      };
    }
  }

  /** Every owner token of `rules` resolved and qualified (keyed lowercased), and the memberships asked for. */
  async #resolve(
    rules: readonly { readonly owners: readonly string[] }[],
    candidates: { readonly required: readonly string[]; readonly optional: readonly string[] },
  ): Promise<{
    facts: Map<string, CodeOwnerFact>;
    memberships: Set<string>;
    asked: Set<string>;
    ownerCeilings: Map<string, string[]>;
  }> {
    const policy = this.deps.policy();
    const handles = new Map<string, string>();
    const teams = new Map<string, { org: string; slug: string }>();
    for (const rule of rules)
      for (const token of rule.owners) {
        const name = token.slice(1);
        const slash = name.indexOf("/");
        if (slash < 0) handles.set(token.toLowerCase(), name);
        else
          teams.set(token.toLowerCase(), {
            org: name.slice(0, slash),
            slug: name.slice(slash + 1),
          });
      }
    if (handles.size > policy.maxHandles) throw new TooLarge(`${handles.size} users and agents`);
    if (teams.size > policy.maxTeams) throw new TooLarge(`${teams.size} teams`);

    const account = this.deps.account();
    const rows = await this.#directory([...handles.values()], account?.accountId);
    const byHandle = new Map(
      rows.filter((r) => r.handle).map((r) => [r.handle.toLowerCase(), r] as const),
    );
    const accountHandle = rows.find((r) => r.id === account?.accountId)?.handle.toLowerCase();

    const facts = new Map<string, CodeOwnerFact>();
    const ownerCeilings = new Map<string, string[]>();
    for (const [key, handle] of handles) {
      const token = `@${handle}`;
      const row = byHandle.get(handle.toLowerCase());
      const reason = await this.#unqualified(row);
      if (!row || reason !== undefined) {
        facts.set(key, {
          kind: row?.type === "agent" ? "agent" : row?.type === "user" ? "user" : "unknown",
          token,
          qualified: false,
          reason: reason ?? "no such user",
        });
        continue;
      }
      const kind = row.type as "user" | "agent";
      if (kind === "agent" && row.owner_id) ownerCeilings.set(row.id, [row.owner_id]);
      facts.set(key, { kind, token, principal: row.id, qualified: true });
    }

    // Teams of the repository's own organization, from its object.
    const ours = [...teams].filter(
      ([, t]) => account && accountHandle !== undefined && t.org.toLowerCase() === accountHandle,
    );
    const slugs = [...new Set(ours.map(([, t]) => t.slug.toLowerCase()))];
    const required = new Set(candidates.required);
    if (slugs.length * required.size > policy.maxPairs)
      throw new TooLarge(`${slugs.length * required.size} team memberships`);
    // Those only evaluated rules would need, when they fit too.
    const all = new Set([...required, ...candidates.optional]);
    const asked = slugs.length * all.size <= policy.maxPairs ? all : required;
    let found: CodeOwnerTeams = { teams: {}, members: [] };
    if (account && slugs.length > 0) {
      this.deps.metrics.count("do.request", { class: "OrgDO", method: "codeOwnerTeams" });
      found = await this.deps.teams(account.accountId, slugs, [...asked]);
    }
    for (const [key, t] of teams) {
      const token = `@${t.org}/${t.slug}`;
      const team = found.teams[t.slug.toLowerCase()];
      const reason = !ours.some(([k]) => k === key)
        ? "not this repository's organization"
        : !team
          ? "no such team"
          : !atLeast(team.role, "write")
            ? "no write access"
            : undefined;
      facts.set(
        key,
        reason !== undefined || !team
          ? { kind: "team", token, qualified: false, reason: reason ?? "no such team" }
          : { kind: "team", token, teamId: team.teamId, qualified: true },
      );
    }
    return {
      facts,
      memberships: new Set(found.members),
      asked,
      ownerCeilings,
    };
  }

  /** Why a user or agent owner does not qualify now, or undefined when it does. */
  async #unqualified(row: DirectoryRow | undefined): Promise<string | undefined> {
    if (!row) return "no such user";
    if (row.type !== "user" && row.type !== "agent") return "not a user or an agent";
    if (row.lifecycle === "deleting" || row.lifecycle === "deleted") return "deleted";
    if (row.lifecycle === "suspended") return "suspended";
    if (row.disabled_at !== null) return "disabled";
    if (
      row.type === "agent" &&
      (row.owner_disabled_at !== null || row.owner_lifecycle !== "active")
    )
      return "its owner is not active";
    const ceilings = row.type === "agent" && row.owner_id ? [row.owner_id] : [];
    for (const id of [row.id, ...ceilings]) await this.deps.acl().roleOf(id, "write");
    return atLeast(this.deps.authority.roleNow(row.id, ceilings), "write")
      ? undefined
      : "no write access";
  }

  /** The directory's rows (from its primary) for `handles`, and for the account `accountId`. */
  async #directory(handles: readonly string[], accountId?: string): Promise<DirectoryRow[]> {
    const db = this.deps.env().DIRECTORY.withSession("first-primary");
    const select = `SELECT p.id, p.type, p.handle, p.owner_id, p.disabled_at, p.lifecycle,
        o.disabled_at AS owner_disabled_at, o.lifecycle AS owner_lifecycle
      FROM principals p LEFT JOIN principals o ON o.id = p.owner_id`;
    const rows: DirectoryRow[] = [];
    for (let at = 0; at < handles.length; at += HANDLE_BATCH) {
      const batch = handles.slice(at, at + HANDLE_BATCH);
      this.deps.metrics.count("d1.query", { db: "directory", op: "code_owner_handles" });
      const { results } = await db
        .prepare(`${select} WHERE p.handle COLLATE NOCASE IN (${batch.map(() => "?").join(", ")})`)
        .bind(...batch)
        .all<DirectoryRow>();
      rows.push(...results);
    }
    if (accountId) {
      this.deps.metrics.count("d1.query", { db: "directory", op: "code_owner_account" });
      const row = await db
        .prepare(`${select} WHERE p.id = ?`)
        .bind(accountId)
        .first<DirectoryRow>();
      if (row) rows.push(row);
    }
    return rows;
  }
}
