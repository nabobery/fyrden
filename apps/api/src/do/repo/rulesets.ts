import type { RefActor } from "@fyrden/adapters-cloudflare/git";
import type { Ruleset } from "@fyrden/domain";

/** Rulesets one repository may have. Proposed. */
export const MAX_RULESETS = 50;

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
