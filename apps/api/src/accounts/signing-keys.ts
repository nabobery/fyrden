import { issuerHolds } from "@fyrden/adapters-cloudflare/auth";
import type {
  createSshSigningKey,
  deleteSshSigningKey,
  getSshSigningKey,
  Input,
  listSshSigningKeys,
  Output,
} from "@fyrden/api-contract";
import { parseSshPublicKey, SshSignatureError, sshFingerprint } from "@fyrden/git-core";
import { decodeSeekCursor, encodeSeekCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import { issuerRefused } from "./lifecycle.js";

/** SSH signing keys one user or agent may have. Proposed. */
export const MAX_SIGNING_KEYS = 100;

type KeyRow = { id: string; title: string; key: string; fingerprint: string; created_at: number };

const output = (row: KeyRow): Output<typeof getSshSigningKey> => ({
  id: row.id,
  title: row.title,
  key: row.key,
  fingerprint: row.fingerprint,
  created_at: row.created_at,
});

const notFound = (id: string) =>
  new OperationError(404, "key_not_found", `You have no SSH signing key ${id}.`);

/**
 * Whose keys the caller manages: its own (a user's, or an agent's with its
 * own token). An agent acting for a user under a grant manages none: they
 * would be the user's.
 */
function keyOwner(ctx: OpContext): string {
  if (ctx.auth.grantId !== null)
    throw new OperationError(
      403,
      "forbidden",
      "Acting for a user, an agent manages no signing keys; with its own token it manages its own.",
    );
  return ctx.auth.principalId;
}

/** The `users.ssh_signing_keys.create` operation. */
export async function createSshSigningKeyOperation(
  ctx: OpContext,
  input: Input<typeof createSshSigningKey>,
): Promise<Output<typeof createSshSigningKey>> {
  let parsed: ReturnType<typeof parseSshPublicKey>;
  try {
    parsed = parseSshPublicKey(input.key);
  } catch (error) {
    if (!(error instanceof SshSignatureError)) throw error;
    throw new OperationError(422, "invalid_key", `Not an SSH public key: ${error.message}.`);
  }
  if (parsed.keyType !== "ssh-ed25519")
    throw new OperationError(422, "unsupported_key", "Only Ed25519 keys (ssh-ed25519) sign here.");
  const row: KeyRow = {
    id: newId("key"),
    title: input.title,
    // The comment is the client's, not part of the key.
    key: `ssh-ed25519 ${btoa(String.fromCharCode(...parsed.blob))}`,
    fingerprint: await sshFingerprint(parsed.blob),
    created_at: clock(),
  };
  const db = ctx.env.DIRECTORY;
  const principal = keyOwner(ctx);
  ctx.metrics.count("d1.query", { db: "directory", op: "signing_key_create" }, 3);
  let refused: "issuer" | "key_in_use" | "too_many_keys" | undefined;
  try {
    const [seen, insert] = await db.batch([
      // What the insert below sees, for why it held back.
      db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM ssh_signing_keys WHERE fingerprint = ?1) AS taken,
             ${issuerHolds("?2", "?3")} AS holds`,
        )
        .bind(row.fingerprint, ctx.auth.principalId, ctx.auth.lifecycleGen),
      // Only while the caller holds (see `issuerHolds`) and the user has fewer than the limit;
      // checked in the batch.
      db
        .prepare(
          `INSERT INTO ssh_signing_keys (id, principal_id, title, key, fingerprint, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6
           WHERE (SELECT count(*) FROM ssh_signing_keys WHERE principal_id = ?2) < ?7
             AND NOT EXISTS (SELECT 1 FROM ssh_signing_keys WHERE fingerprint = ?5)
             AND ${issuerHolds("?8", "?9")}`,
        )
        .bind(
          row.id,
          principal,
          row.title,
          row.key,
          row.fingerprint,
          row.created_at,
          MAX_SIGNING_KEYS,
          ctx.auth.principalId,
          ctx.auth.lifecycleGen,
        ),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
           SELECT ?1, ?2, 'ssh_signing_key.create', ?3, json_object('fingerprint', ?4), ?5
           WHERE EXISTS (SELECT 1 FROM ssh_signing_keys WHERE id = ?3)`,
        )
        .bind(row.created_at, principal, row.id, row.fingerprint, ctx.requestId ?? null),
    ]);
    const why = seen?.results[0] as { taken: number; holds: number } | undefined;
    if ((insert?.meta.changes ?? 0) === 0)
      refused = why?.holds !== 1 ? "issuer" : why.taken ? "key_in_use" : "too_many_keys";
  } catch (error) {
    // Lost a race with another add of the same key.
    if (!(error instanceof Error && /UNIQUE constraint failed/i.test(error.message))) throw error;
    refused = "key_in_use";
  }
  if (refused === "issuer") throw issuerRefused();
  if (refused === "key_in_use")
    throw new OperationError(
      422,
      "key_in_use",
      "That key is already added, by you or another user or agent.",
    );
  if (refused)
    throw new OperationError(
      422,
      "too_many_keys",
      `You have ${MAX_SIGNING_KEYS} SSH signing keys, as many as one user or agent may; delete one first.`,
    );
  return output(row);
}

/** The `users.ssh_signing_keys.list` operation: oldest first. */
export async function listSshSigningKeysOperation(
  ctx: OpContext,
  input: Input<typeof listSshSigningKeys>,
): Promise<Output<typeof listSshSigningKeys>> {
  const after = decodeSeekCursor(input.cursor, "key") ?? { at: -1, id: "" };
  ctx.metrics.count("d1.query", { db: "directory", op: "signing_keys_list" });
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id, title, key, fingerprint, created_at FROM ssh_signing_keys
       WHERE principal_id = ? AND (created_at, id) > (?, ?)
       ORDER BY created_at, id LIMIT ?`,
    )
    .bind(keyOwner(ctx), after.at, after.id, input.per_page + 1)
    .all<KeyRow>();
  const page = results.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    keys: page.map(output),
    next_cursor:
      results.length > input.per_page && last
        ? encodeSeekCursor({ at: last.created_at, id: last.id })
        : null,
  };
}

/** The `users.ssh_signing_keys.get` operation. */
export async function getSshSigningKeyOperation(
  ctx: OpContext,
  input: Input<typeof getSshSigningKey>,
): Promise<Output<typeof getSshSigningKey>> {
  ctx.metrics.count("d1.query", { db: "directory", op: "signing_key_get" });
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT id, title, key, fingerprint, created_at FROM ssh_signing_keys
       WHERE id = ? AND principal_id = ?`,
    )
    .bind(input.key_id, keyOwner(ctx))
    .first<KeyRow>();
  if (!row) throw notFound(input.key_id);
  return output(row);
}

/** The `users.ssh_signing_keys.delete` operation. */
export async function deleteSshSigningKeyOperation(
  ctx: OpContext,
  input: Input<typeof deleteSshSigningKey>,
): Promise<Output<typeof deleteSshSigningKey>> {
  const db = ctx.env.DIRECTORY;
  ctx.metrics.count("d1.query", { db: "directory", op: "signing_key_delete" }, 2);
  const [audit] = await db.batch([
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?1, ?2, 'ssh_signing_key.delete', id, json_object('fingerprint', fingerprint), ?4
         FROM ssh_signing_keys WHERE id = ?3 AND principal_id = ?2`,
      )
      .bind(clock(), keyOwner(ctx), input.key_id, ctx.requestId ?? null),
    db
      .prepare("DELETE FROM ssh_signing_keys WHERE id = ? AND principal_id = ?")
      .bind(input.key_id, keyOwner(ctx)),
  ]);
  if ((audit?.meta.changes ?? 0) === 0) throw notFound(input.key_id);
  return { id: input.key_id, state: "deleted" };
}
