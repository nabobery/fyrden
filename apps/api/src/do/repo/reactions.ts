import type { RefActor, RepoGitStorage } from "@fyrden/adapters-cloudflare/git";
import {
  decideReaction,
  REACTION_CONTENTS,
  type ReactionContent,
  type ReactionTarget,
} from "@fyrden/domain";
import type { RepoEvents } from "./events.js";
import type { PullCaller } from "./pulls.js";

/*
 * Reactions to issues and pull requests (by number), conversation comments
 * and diff comments: one per principal, content and target. Ids come from
 * `repo_meta.next_reaction_id` and are never reused; the counts each target
 * answers with are kept by triggers (schema v35). A target's reactions go
 * with it (`forget`).
 */

export interface ReactionRecord {
  readonly id: number;
  readonly content: ReactionContent;
  readonly principal: string;
  /** The agents acting for `principal`, the current one first. */
  readonly actChain: readonly string[];
  readonly createdAt: number;
}

/** A target's reactions counted by content, as they stand. */
export type ReactionCounts = Readonly<Record<ReactionContent, number>>;

/** A record as the API answers it: with its reactions counted. */
export type Reacted<T> = T & { readonly reactions: ReactionCounts };

/** What a reaction is on, resolved by the object: its conversation's number and lock. */
export interface ReactionSubject {
  readonly target: ReactionTarget;
  readonly targetId: number;
  /** The issue or pull request the target is, or is on. */
  readonly number: number;
  readonly locked: boolean;
}

export type ReactionFailure = "forbidden" | "locked" | "reaction_not_found";

type Row = {
  id: number;
  content: ReactionContent;
  principal: string;
  act_chain: string | null;
  created_at: number;
};

export const NO_REACTIONS: ReactionCounts = Object.fromEntries(
  REACTION_CONTENTS.map((c) => [c, 0]),
) as Record<ReactionContent, number>;

export class RepoReactions {
  constructor(
    private readonly deps: {
      readonly git: RepoGitStorage;
      readonly events: RepoEvents;
    },
  ) {}

  /** The counts of `target`'s reactions for each of `ids`, in one query. */
  countsOf(target: ReactionTarget, ids: readonly number[]): Map<number, ReactionCounts> {
    const counts = new Map<number, Record<ReactionContent, number>>(
      ids.map((id) => [id, { ...NO_REACTIONS }]),
    );
    if (ids.length === 0) return counts;
    for (const row of this.#exec<{ target_id: number; content: ReactionContent; count: number }>(
      `SELECT target_id, content, count FROM reaction_counts
       WHERE target = ? AND target_id IN (SELECT value FROM json_each(?))`,
      target,
      JSON.stringify([...new Set(ids)]),
    )) {
      const of = counts.get(row.target_id);
      if (of) of[row.content] = row.count;
    }
    return counts;
  }

  /** Records of `target` with their reactions counted, in one query (for what the API answers). */
  attach<T extends { readonly id: number }>(
    target: ReactionTarget,
    records: readonly T[],
  ): Reacted<T>[] {
    const counts = this.countsOf(
      target,
      records.map((r) => r.id),
    );
    return records.map((r) => ({ ...r, reactions: counts.get(r.id) as ReactionCounts }));
  }

  /** A page of a target's reactions, oldest first, after reaction `after`, of one content if given. */
  list(
    target: ReactionTarget,
    targetId: number,
    content: ReactionContent | null,
    after: number,
    limit: number,
  ): ReactionRecord[] {
    return (
      content === null
        ? this.#exec<Row>(
            `SELECT * FROM reactions WHERE target = ? AND target_id = ? AND id > ?
             ORDER BY id LIMIT ?`,
            target,
            targetId,
            after,
            limit,
          )
        : this.#exec<Row>(
            `SELECT * FROM reactions WHERE target = ? AND target_id = ? AND id > ? AND content = ?
             ORDER BY id LIMIT ?`,
            target,
            targetId,
            after,
            content,
            limit,
          )
    ).map(record);
  }

  /**
   * Reacts as the caller (read access; write while the conversation is
   * locked). Reacting again with the same content answers the reaction it
   * already has (`created` false), changing nothing.
   */
  react(
    on: ReactionSubject,
    content: ReactionContent,
    caller: PullCaller,
  ):
    | { ok: true; reaction: ReactionRecord; created: boolean }
    | { ok: false; code: ReactionFailure } {
    const decision = decideReaction({ role: caller.role, locked: on.locked });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    const [existing] = this.#exec<Row>(
      `SELECT * FROM reactions
       WHERE target = ? AND target_id = ? AND principal = ? AND content = ?`,
      on.target,
      on.targetId,
      caller.actor.principal,
      content,
    );
    if (existing) return { ok: true, reaction: record(existing), created: false };
    const reaction = this.deps.git.context.storage.transactionSync(() => {
      const id = this.#exec<{ id: number }>(
        "UPDATE repo_meta SET next_reaction_id = next_reaction_id + 1 WHERE id = 1 RETURNING next_reaction_id - 1 AS id",
      )[0]?.id as number;
      const [row] = this.#exec<Row>(
        `INSERT INTO reactions (id, target, target_id, content, principal, act_chain, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        id,
        on.target,
        on.targetId,
        content,
        caller.actor.principal,
        caller.actor.actChain?.length ? JSON.stringify(caller.actor.actChain) : null,
        this.deps.git.context.now(),
      );
      const created = record(row as Row);
      this.#emit("created", on, created, caller.actor);
      return created;
    });
    return { ok: true, reaction, created: true };
  }

  /**
   * Takes a reaction back: its principal's own only (others answer as not
   * found), on that target; write access while the conversation is locked.
   */
  delete(
    on: ReactionSubject,
    id: number,
    caller: PullCaller,
  ): { ok: true } | { ok: false; code: ReactionFailure } {
    const [row] = this.#exec<Row>(
      "SELECT * FROM reactions WHERE id = ? AND target = ? AND target_id = ?",
      id,
      on.target,
      on.targetId,
    );
    if (!row || row.principal !== caller.actor.principal)
      return { ok: false, code: "reaction_not_found" };
    const decision = decideReaction({ role: caller.role, locked: on.locked });
    if (!decision.ok) return { ok: false, code: decision.refusal };
    this.deps.git.context.storage.transactionSync(() => {
      this.#exec("DELETE FROM reactions WHERE id = ?", id);
      this.#emit("deleted", on, record(row), caller.actor);
    });
    return { ok: true };
  }

  /** In a target's deletion: its reactions and their counts go with it. */
  forget(target: ReactionTarget, targetId: number): void {
    this.#exec("DELETE FROM reactions WHERE target = ? AND target_id = ?", target, targetId);
    this.#exec("DELETE FROM reaction_counts WHERE target = ? AND target_id = ?", target, targetId);
  }

  /** In an issue's deletion: the reactions to it and to its comments go with it. */
  forgetSubject(number: number): void {
    this.forget("subject", number);
    for (const table of ["reactions", "reaction_counts"])
      this.#exec(
        `DELETE FROM ${table} WHERE target = 'comment'
           AND target_id IN (SELECT comment_id FROM comments WHERE number = ?)`,
        number,
      );
  }

  /** An activity event: the reaction, and its target's counts as they now stand (absolute). */
  #emit(event: string, on: ReactionSubject, reaction: ReactionRecord, actor: RefActor): void {
    this.deps.events.emitActivity(`reaction.${event}`, actor, {
      target: on.target,
      target_id: on.targetId,
      number: on.number,
      reaction: { id: reaction.id, content: reaction.content, principal: reaction.principal },
      counts: this.countsOf(on.target, [on.targetId]).get(on.targetId),
    });
  }

  #exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    const cursor = this.deps.git.context.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    if (cursor.rowsWritten > 0)
      this.deps.git.context.metrics.count(
        "do.rows_written",
        { class: this.deps.git.context.doClass, op: "reactions.write" },
        cursor.rowsWritten,
      );
    return rows;
  }
}

function record(row: Row): ReactionRecord {
  return {
    id: row.id,
    content: row.content,
    principal: row.principal,
    actChain: row.act_chain ? (JSON.parse(row.act_chain) as string[]) : [],
    createdAt: row.created_at,
  };
}
