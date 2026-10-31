import { readModelFor } from "../events/read-model.js";
import { admitted } from "./maintenance.js";

/*
 * The read model's restore token: a value the read model holds and the
 * directory records, so that a read model restored behind the directory's
 * back (to before the last handshake) is told apart from the one it knew.
 * A handshake replaces it in three steps, each its own write: the directory
 * records its intent (the token held, and the next), the read model writes
 * the next (only over the one held), and the directory records it completed.
 * A handshake interrupted between them is finished by the next from what the
 * read model holds; a read model holding neither is not the one the
 * directory knew. Best effort: a restore to after the last handshake keeps
 * its token, and goes unseen.
 */

/**
 * Where the token stands: none written yet (`uninitialized`), the read
 * model's the one the directory completed (`matched`), a handshake under
 * way (`intent`, the read model holding its previous or next token), or
 * neither (`mismatch`: restored, or changed, since).
 */
export type RestoreTokenState = "uninitialized" | "matched" | "intent" | "mismatch";

interface Tokens {
  readonly phase: string;
  readonly generation: number;
  readonly previous: string | null;
  readonly next: string | null;
  readonly completed: string | null;
  /** The read model's: none written (null), or no table for it (a read model from before it). */
  readonly held: string | null | typeof NO_TABLE;
}

/** A read model without the token's table: restored to before its migration. */
const NO_TABLE = Symbol("no restore token table");

/** Hooks between a handshake's steps, and between a look's two reads. For tests. */
export const handshakeHooks: {
  afterIntent?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
  betweenReads?: () => Promise<void>;
} = {};

type DirectoryTokens = Omit<Tokens, "held">;

async function directoryTokens(
  env: Pick<Env, "DIRECTORY">,
  shard: string,
): Promise<DirectoryTokens> {
  const barrier = await env.DIRECTORY.prepare(
    `SELECT phase, generation, token_previous AS previous, token_next AS next,
       token_completed AS completed
     FROM read_model_barriers WHERE shard = ?`,
  )
    .bind(shard)
    .first<DirectoryTokens>();
  if (!barrier) throw new Error(`the read model's shard ${shard} has no barrier`);
  return barrier;
}

async function heldToken(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
): Promise<Tokens["held"]> {
  try {
    // A read: to the database itself.
    const row = await readModelFor(env, shard)
      .prepare("SELECT token FROM read_model_restore_token WHERE id = 1")
      .first<{ token: string }>();
    return row?.token ?? null;
  } catch (error) {
    if (/no such table: read_model_restore_token/.test(String(error))) return NO_TABLE;
    throw error;
  }
}

/**
 * Both sides' tokens, as one look: the directory's read again after the
 * read model's, and the look made again when it moved between (a
 * handshake that came between would otherwise look like a restore).
 */
async function tokens(env: Pick<Env, "DIRECTORY" | "ORG_READ">, shard: string): Promise<Tokens> {
  for (let look = 0; look < 3; look++) {
    const before = await directoryTokens(env, shard);
    await handshakeHooks.betweenReads?.();
    const held = await heldToken(env, shard);
    const after = await directoryTokens(env, shard);
    if (
      after.previous === before.previous &&
      after.next === before.next &&
      after.completed === before.completed
    )
      return { ...after, held };
  }
  throw new Error("the read model's restore token kept moving while it was looked at");
}

function stateOf(t: Tokens): RestoreTokenState {
  // Without its table, a read model the directory knew a token of was restored; otherwise none was
  // ever written.
  if (t.held === NO_TABLE)
    return t.next === null && t.completed === null ? "uninitialized" : "mismatch";
  if (t.next !== null) return t.held === t.previous || t.held === t.next ? "intent" : "mismatch";
  if (t.completed === null) return t.held === null ? "uninitialized" : "mismatch";
  return t.held === t.completed ? "matched" : "mismatch";
}

/** Where the shard's restore token stands (the directory's and the read model's, as one look). */
export async function restoreTokenState(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
): Promise<RestoreTokenState> {
  return stateOf(await tokens(env, shard));
}

/**
 * Writes `next` as the read model's token over `previous` (none held, when
 * null), as the barrier lets a writer: an ordinary one while it runs, a
 * maintenance one at its generation otherwise. Nothing when it holds
 * another.
 */
async function write(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
  at: Tokens,
  previous: string | null,
  next: string,
): Promise<void> {
  const statement = (org: D1Database) =>
    org
      .prepare(
        `INSERT INTO read_model_restore_token (id, token)
         SELECT 1, ?2 WHERE ?1 IS NULL OR EXISTS (SELECT 1 FROM read_model_restore_token)
         ON CONFLICT (id) DO UPDATE SET token = excluded.token
           WHERE read_model_restore_token.token = ?1`,
      )
      .bind(previous, next);
  if (at.phase === "running") {
    const db = readModelFor(env, shard);
    await db.batch([statement(db)]);
  } else if (!(await admitted(env, shard, at.generation, statement)))
    throw new Error("the read model's barrier moved during a handshake");
}

/** A handshake's steps at most, its own and those of others it finishes. */
const HANDSHAKE_STEPS = 8;

/**
 * Replaces the shard's restore token (a handshake): `matched` once one
 * completed since it began (its own, or another's under way, which it
 * finishes), or `mismatch` (nothing changed) when the read model holds a
 * token the directory does not know. Each step is taken from where the
 * tokens stand, so handshakes at once, or one interrupted, settle.
 */
export async function handshake(
  env: Pick<Env, "DIRECTORY" | "ORG_READ">,
  shard: string,
): Promise<"matched" | "mismatch"> {
  const began = await tokens(env, shard);
  for (let step = 0, at = began; step < HANDSHAKE_STEPS; step++, at = await tokens(env, shard)) {
    const state = stateOf(at);
    if (state === "mismatch") return "mismatch";
    if (state === "matched" && at.completed !== began.completed) return "matched";
    if (at.held === NO_TABLE) throw new Error("the read model has no restore token table");
    if (at.next === null) {
      // Its intent, from the token completed (none, the first): the next to be written.
      await env.DIRECTORY.prepare(
        `UPDATE read_model_barriers SET token_previous = token_completed, token_next = ?2
         WHERE shard = ?1 AND token_next IS NULL AND token_completed IS ?3`,
      )
        .bind(shard, crypto.randomUUID(), at.completed)
        .run();
      await handshakeHooks.afterIntent?.();
      continue;
    }
    if (at.held !== at.next) {
      await write(env, shard, at, at.previous, at.next);
      await handshakeHooks.afterWrite?.();
      continue;
    }
    // Completed: the directory records the token the read model holds.
    await env.DIRECTORY.prepare(
      `UPDATE read_model_barriers SET token_completed = token_next, token_next = NULL,
         token_previous = NULL
       WHERE shard = ?1 AND token_next = ?2`,
    )
      .bind(shard, at.next)
      .run();
  }
  throw new Error("a handshake did not settle");
}
