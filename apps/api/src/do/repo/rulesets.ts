import type { RefActor } from "@fyrden/adapters-cloudflare/git";
import type { Ruleset } from "@fyrden/domain";

/** Rulesets one repository may have. Proposed. */
export const MAX_RULESETS = 50;

/** Rule suites one repository keeps, the newest. Proposed. */
export const MAX_RULE_SUITES = 1_000;

/** What `evaluate` rulesets would have refused of one ref update of a push. */
export interface RuleSuite {
  readonly id: number;
  readonly ref: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly actorId: string;
  readonly pushedAt: number;
  /** Whether active rulesets refused the update. */
  readonly refused: boolean;
  readonly evaluations: readonly {
    readonly rulesetId: number;
    readonly ruleset: string;
    readonly rule: string;
    readonly message: string;
  }[];
}

type SuiteRow = {
  id: number;
  ref: string;
  before_sha: string | null;
  after_sha: string | null;
  actor_id: string;
  pushed_at: number;
  refused: number;
  evaluations: string;
};

/** A ruleset as it is given: everything but its id. */
export type RulesetInput = Omit<Ruleset, "id">;

export interface RulesetRecord {
  readonly ruleset: Ruleset;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type Row = { id: number; name: string; body: string; created_at: number; updated_at: number };

/**
 * The repository's rulesets, in its object's storage. Every change bumps
 * the version in the same transaction, with its audit row, so the commit
 * point can tell that the rulesets a push was checked against are still
 * the current ones.
 */
export class RepoRulesets {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly audit: (
      action: string,
      actor: RefActor | null,
      details: Record<string, unknown>,
    ) => void,
    private readonly now: () => number,
  ) {}

  /** Every ruleset (by id) and the version they are at. */
  current(): { version: number; rulesets: RulesetRecord[] } {
    return {
      version: this.version(),
      rulesets: this.#rows("SELECT * FROM rulesets ORDER BY id").map(recordOf),
    };
  }

  version(): number {
    return (
      this.storage.sql
        .exec<{ version: number }>("SELECT version FROM ruleset_version WHERE id = 1")
        .toArray()[0]?.version ?? 0
    );
  }

  get(id: number): RulesetRecord | undefined {
    const [row] = this.#rows("SELECT * FROM rulesets WHERE id = ?", id);
    return row && recordOf(row);
  }

  /** Adds a ruleset; `name_taken` when another has its name, `too_many` past the limit. */
  create(input: RulesetInput, actor: RefActor | null): RulesetRecord | "name_taken" | "too_many" {
    return this.storage.transactionSync(() => {
      if (this.#nameTaken(input.name, null)) return "name_taken";
      const count = this.storage.sql
        .exec<{ n: number }>("SELECT count(*) AS n FROM rulesets")
        .one().n;
      if (count >= MAX_RULESETS) return "too_many";
      const now = this.now();
      const id = this.storage.sql
        .exec<{ id: number }>(
          `INSERT INTO rulesets (name, body, created_at, updated_at) VALUES (?, ?, ?, ?)
           RETURNING id`,
          input.name,
          JSON.stringify(input),
          now,
          now,
        )
        .one().id;
      this.#changed("ruleset.create", actor, id, input.name);
      return { ruleset: { ...input, id }, createdAt: now, updatedAt: now };
    });
  }

  /** Replaces a ruleset; undefined when there is none, `name_taken` when another has its name. */
  update(
    id: number,
    input: RulesetInput,
    actor: RefActor | null,
  ): RulesetRecord | "name_taken" | undefined {
    return this.storage.transactionSync(() => {
      const existing = this.get(id);
      if (!existing) return undefined;
      if (this.#nameTaken(input.name, id)) return "name_taken";
      const now = this.now();
      this.storage.sql.exec(
        "UPDATE rulesets SET name = ?, body = ?, updated_at = ? WHERE id = ?",
        input.name,
        JSON.stringify(input),
        now,
        id,
      );
      this.#changed("ruleset.update", actor, id, input.name);
      return { ruleset: { ...input, id }, createdAt: existing.createdAt, updatedAt: now };
    });
  }

  /** Removes a ruleset; false when there is none. */
  delete(id: number, actor: RefActor | null): boolean {
    return this.storage.transactionSync(() => {
      const existing = this.get(id);
      if (!existing) return false;
      this.storage.sql.exec("DELETE FROM rulesets WHERE id = ?", id);
      this.#changed("ruleset.delete", actor, id, existing.ruleset.name);
      return true;
    });
  }

  /**
   * Records what `evaluate` rulesets found in upload `uploadId`'s ref
   * updates (once per upload and ref: a commit tried again records nothing
   * new), keeping the newest `MAX_RULE_SUITES`.
   */
  recordEvaluated(
    uploadId: string,
    actorId: string,
    updates: readonly {
      readonly ref: string;
      readonly before: string | null;
      readonly after: string | null;
      readonly refused: boolean;
      readonly violations: readonly {
        readonly rulesetId: number;
        readonly ruleset: string;
        readonly rule: string;
        readonly message: string;
      }[];
    }[],
  ): void {
    if (updates.length === 0) return;
    const now = this.now();
    this.storage.transactionSync(() => {
      for (const u of updates)
        this.storage.sql.exec(
          `INSERT INTO rule_suites (upload_id, ref, before_sha, after_sha, actor_id, pushed_at,
             refused, evaluations)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (upload_id, ref) DO NOTHING`,
          uploadId,
          u.ref,
          u.before,
          u.after,
          actorId,
          now,
          u.refused ? 1 : 0,
          JSON.stringify(
            u.violations.map(({ rulesetId, ruleset, rule, message }) => ({
              rulesetId,
              ruleset,
              rule,
              message,
            })),
          ),
        );
      // The newest kept by their rows, not their ids (a skipped insert still takes one).
      this.storage.sql.exec(
        `DELETE FROM rule_suites WHERE id NOT IN (
           SELECT id FROM rule_suites ORDER BY id DESC LIMIT ?)`,
        MAX_RULE_SUITES,
      );
    });
  }

  /** Rule suites, newest first: `limit` of them before id `before` (the newest when absent). */
  ruleSuites(limit: number, before?: number): RuleSuite[] {
    return this.storage.sql
      .exec<SuiteRow>(
        "SELECT * FROM rule_suites WHERE id < ? ORDER BY id DESC LIMIT ?",
        before ?? Number.MAX_SAFE_INTEGER,
        limit,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        ref: row.ref,
        before: row.before_sha,
        after: row.after_sha,
        actorId: row.actor_id,
        pushedAt: row.pushed_at,
        refused: row.refused === 1,
        evaluations: JSON.parse(row.evaluations) as RuleSuite["evaluations"],
      }));
  }

  #changed(action: string, actor: RefActor | null, id: number, name: string): void {
    this.storage.sql.exec(
      `INSERT INTO ruleset_version (id, version) VALUES (1, 1)
       ON CONFLICT (id) DO UPDATE SET version = version + 1`,
    );
    this.audit(action, actor, { ruleset_id: id, name });
  }

  #nameTaken(name: string, except: number | null): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 AS one FROM rulesets WHERE name = ? AND id IS NOT ?", name, except)
        .toArray().length > 0
    );
  }

  #rows(query: string, ...bindings: unknown[]): Row[] {
    return this.storage.sql.exec<Row>(query, ...bindings).toArray();
  }
}

function recordOf(row: Row): RulesetRecord {
  const body = JSON.parse(row.body) as RulesetInput;
  return {
    ruleset: { ...body, id: row.id },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
