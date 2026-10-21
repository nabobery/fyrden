import { issuerHolds } from "@fyrden/adapters-cloudflare/auth";
import type {
  createGrant,
  getAgent,
  Input,
  listGrants,
  Output,
  revokeGrant,
} from "@fyrden/api-contract";
import { isPermission, scopesAllow } from "@fyrden/domain";
import { decodeSeekCursor, encodeSeekCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { authorize, resolveRepo } from "../repos/directory.js";
import { clock, newId } from "../services.js";
import { issuerRefused } from "./lifecycle.js";

/**
 * Delegation grants: a user lets an agent act for it (RFC 8693 token
 * exchange, `oauth/token.ts`), and an agent holding a grant may pass a
 * narrower one to another agent of its owner. A grant never exceeds the
 * token that makes it, nor (for a sub-grant) its parent; it is immutable
 * but for its revocation, which takes its sub-grants with it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type GrantRow = {
  id: string;
  grantor_id: string;
  grantor: string;
  agent_id: string;
  agent: string;
  parent_id: string | null;
  root_id: string;
  depth: number;
  scopes: string;
  repo_ids: string | null;
  expires_at: number;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
};

export const GRANT_COLUMNS = `g.id, g.grantor_id, u.handle AS grantor, g.agent_id, a.handle AS agent,
  g.parent_id, g.root_id, g.depth, g.scopes, g.repo_ids, g.expires_at, g.created_by,
  g.created_at, g.revoked_at`;

export const GRANT_JOINS = `grants g JOIN principals u ON u.id = g.grantor_id
  JOIN principals a ON a.id = g.agent_id`;

const list = (json: string | null): string[] | null =>
  json === null ? null : (JSON.parse(json) as string[]);

const output = (row: GrantRow): Output<typeof revokeGrant> => ({
  id: row.id,
  grantor: row.grantor,
  grantor_id: row.grantor_id,
  agent: row.agent,
  agent_id: row.agent_id,
  parent_id: row.parent_id,
  root_id: row.root_id,
  depth: row.depth,
  scopes: list(row.scopes) ?? [],
  repositories: list(row.repo_ids),
  expires_at: row.expires_at,
  created_at: row.created_at,
  revoked_at: row.revoked_at,
});

const notFound = (id: string) =>
  new OperationError(404, "grant_not_found", `No grant ${id} of yours was found.`);

/** A delegated token manages no grants: only a user, or an agent with its own token. */
function refuseDelegated(ctx: OpContext): void {
  if (ctx.auth.act.length > 0)
    throw new OperationError(
      403,
      "delegated_token",
      "A token issued under a delegation grant cannot make or revoke grants.",
    );
}

export async function grantById(env: Env, id: string): Promise<GrantRow | undefined> {
  const row = await env.DIRECTORY.withSession("first-primary")
    .prepare(`SELECT ${GRANT_COLUMNS} FROM ${GRANT_JOINS} WHERE g.id = ?`)
    .bind(id)
    .first<GrantRow>();
  return row ?? undefined;
}

type AgentRef = Pick<Output<typeof getAgent>, "id" | "handle" | "owner_id">;

async function enabledAgent(ctx: OpContext, handle: string): Promise<AgentRef> {
  ctx.metrics.count("d1.query", { db: "directory", op: "agent_find" });
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT a.id, a.handle, a.owner_id FROM principals a JOIN principals o ON o.id = a.owner_id
       WHERE a.handle = ? COLLATE NOCASE AND a.type = 'agent'
         AND a.disabled_at IS NULL AND o.disabled_at IS NULL`,
    )
    .bind(handle)
    .first<AgentRef>();
  if (!row)
    throw new OperationError(404, "agent_not_found", `No enabled agent ${handle} was found.`);
  return row;
}

/** The ids of `repositories` (`owner/name`), each one `grantor` (a user) may read; 404 for any other. */
async function repoIdsOf(
  ctx: OpContext,
  grantor: string,
  repositories: readonly string[],
): Promise<string[]> {
  const caller = {
    principalId: grantor,
    principalType: "user" as const,
    scopes: [],
    repoIds: null,
  };
  const ids: string[] = [];
  for (const path of repositories) {
    const [owner = "", name = ""] = path.split("/");
    const entry = await resolveRepo(ctx.env, owner, name, { metrics: ctx.metrics });
    if (!entry || !(await authorize(ctx.env, caller, entry, "metadata:read", ctx.metrics)))
      throw new OperationError(404, "repo_not_found", `No repository ${path} was found.`);
    if (!ids.includes(entry.id)) ids.push(entry.id);
  }
  return ids;
}

/**
 * Whether `scopes` stay within `limit` (each one is in it or implied by
 * one); an empty `limit` (a token's full rights) bounds nothing.
 */
function within(scopes: readonly string[], limit: readonly string[]): boolean {
  return scopes.every((s) => isPermission(s) && scopesAllow(limit, s));
}

/** Whether `repoIds` (null: every one) stay within `limit` (null: every one). */
function withinRepos(repoIds: readonly string[] | null, limit: readonly string[] | null): boolean {
  if (limit === null) return true;
  return repoIds?.every((id) => limit.includes(id)) ?? false;
}

/** The `grants.create` operation. */
export async function createGrantOperation(
  ctx: OpContext,
  input: Input<typeof createGrant>,
): Promise<Output<typeof createGrant>> {
  refuseDelegated(ctx);
  const { auth } = ctx;
  const now = clock();
  const agent = await enabledAgent(ctx, input.agent);
  let grantor: string;
  let parent: GrantRow | undefined;
  let expiresAt = now + input.expires_in_days * DAY_MS;
  if (input.parent === undefined) {
    if (auth.principalType !== "user")
      throw new OperationError(
        422,
        "parent_required",
        "An agent passes down a grant it holds: name it as `parent`.",
      );
    grantor = auth.principalId;
  } else {
    if (auth.principalType !== "agent")
      throw new OperationError(
        422,
        "invalid_parent",
        "Only an agent passes down a grant it holds.",
      );
    parent = await grantById(ctx.env, input.parent);
    if (!parent || parent.agent_id !== auth.principalId) throw notFound(input.parent);
    if (parent.revoked_at !== null || parent.expires_at <= now)
      throw new OperationError(
        409,
        "grant_inactive",
        `The grant ${parent.id} is revoked or expired.`,
      );
    if (parent.depth >= 2)
      throw new OperationError(
        422,
        "too_deep",
        "A grant passed down once is not passed down again (two hops at most).",
      );
    if (agent.id === auth.principalId || agent.owner_id !== (await ownerOf(ctx, auth.principalId)))
      throw new OperationError(
        422,
        "invalid_agent",
        "A grant is passed down only to another agent of the same owner.",
      );
    if (!within(input.scopes, list(parent.scopes) ?? []))
      throw new OperationError(
        422,
        "scope_exceeds_parent",
        "The scopes exceed the parent grant's.",
      );
    expiresAt = Math.min(expiresAt, parent.expires_at);
    grantor = parent.grantor_id;
  }
  // Named by the user's rights; a sub-grant inherits its parent's when it names none.
  const parentRepos = parent ? list(parent.repo_ids) : null;
  const repoIds = input.repositories
    ? await repoIdsOf(ctx, grantor, input.repositories)
    : parentRepos;
  if (!withinRepos(repoIds, parentRepos))
    throw new OperationError(
      422,
      "repositories_exceed_parent",
      "The repositories exceed the parent grant's.",
    );
  // Never longer (a signed-in session aside: it is the user itself), nor wider, than the token
  // making it: a narrow token cannot hand out more than it holds.
  if (auth.type !== "ses") expiresAt = Math.min(expiresAt, auth.expiresAt);
  if (expiresAt <= clock())
    throw new OperationError(409, "grant_inactive", "Your token or the parent grant has expired.");
  if (!within(input.scopes, auth.scopes))
    throw new OperationError(403, "scope_exceeds_token", "The scopes exceed your token's.");
  if (!withinRepos(repoIds, auth.repoIds))
    throw new OperationError(
      403,
      "repositories_exceed_token",
      "The repositories exceed your token's.",
    );
  const id = newId("grt");
  const db = ctx.env.DIRECTORY;
  ctx.metrics.count("d1.query", { db: "directory", op: "grant_create" }, 3);
  const [held] = await db.batch([
    // What the insert below sees, for why it held back.
    db
      .prepare(
        `SELECT ${issuerHolds("?1", "?2")} AS holds,
           EXISTS (SELECT 1 FROM principals WHERE id = ?3 AND disabled_at IS NULL) AS grantor`,
      )
      .bind(auth.principalId, auth.lifecycleGen, grantor),
    // Only while the caller holds (see `issuerHolds`) and the grantor is enabled (a suspended
    // user's grants are kept, but none is passed down), and a sub-grant only while its parent
    // still holds (checked in the batch).
    db
      .prepare(
        `INSERT INTO grants (id, grantor_id, agent_id, parent_id, root_id, depth, scopes, repo_ids,
           expires_at, created_by, created_at)
         SELECT ?1, ?2, ?3, ?4, coalesce(?5, ?1), ?6, ?7, ?8, ?9, ?10, ?11
         WHERE (?4 IS NULL OR EXISTS (SELECT 1 FROM grants WHERE id = ?4 AND revoked_at IS NULL
           AND expires_at > ?11)) AND ${issuerHolds("?10", "?12")}
           AND EXISTS (SELECT 1 FROM principals WHERE id = ?2 AND disabled_at IS NULL)`,
      )
      .bind(
        id,
        grantor,
        agent.id,
        parent?.id ?? null,
        parent?.root_id ?? null,
        parent ? 2 : 1,
        JSON.stringify(input.scopes),
        repoIds === null ? null : JSON.stringify(repoIds),
        expiresAt,
        auth.principalId,
        now,
        auth.lifecycleGen,
      ),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         SELECT ?1, ?2, 'grant.create', ?3,
           json_object('grantor', ?4, 'agent', ?5, 'parent', ?6, 'scopes', json(?7)), ?8
         WHERE EXISTS (SELECT 1 FROM grants WHERE id = ?3)`,
      )
      .bind(
        now,
        auth.principalId,
        id,
        grantor,
        agent.id,
        parent?.id ?? null,
        JSON.stringify(input.scopes),
        ctx.requestId ?? null,
      ),
  ]);
  const seen = held?.results[0] as { holds: number; grantor: number } | undefined;
  if (seen?.holds !== 1) throw issuerRefused();
  const made = await grantById(ctx.env, id);
  if (!made && seen.grantor !== 1)
    throw new OperationError(409, "grant_inactive", "The grant's user is suspended or disabled.");
  if (!made)
    throw new OperationError(
      409,
      "grant_inactive",
      `The grant ${input.parent} was revoked meanwhile.`,
    );
  return output(made);
}

async function ownerOf(ctx: OpContext, principalId: string): Promise<string | null> {
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare("SELECT owner_id FROM principals WHERE id = ?")
    .bind(principalId)
    .first<{ owner_id: string | null }>();
  return row?.owner_id ?? null;
}

/** The `grants.list` operation: newest first. */
export async function listGrantsOperation(
  ctx: OpContext,
  input: Input<typeof listGrants>,
): Promise<Output<typeof listGrants>> {
  refuseDelegated(ctx);
  const before = decodeSeekCursor(input.cursor, "grt") ?? {
    at: Number.MAX_SAFE_INTEGER,
    id: "",
  };
  ctx.metrics.count("d1.query", { db: "directory", op: "grants_list" });
  const me = ctx.auth.principalId;
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${GRANT_COLUMNS} FROM ${GRANT_JOINS}
       WHERE (g.grantor_id = ?1 OR g.agent_id = ?1 OR g.created_by = ?1)
         AND (g.created_at < ?2 OR (g.created_at = ?2 AND g.id < ?3))
       ORDER BY g.created_at DESC, g.id DESC LIMIT ?4`,
    )
    .bind(me, before.at, before.id, input.per_page + 1)
    .all<GrantRow>();
  const page = results.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    grants: page.map(output),
    next_cursor:
      results.length > input.per_page && last
        ? encodeSeekCursor({ at: last.created_at, id: last.id })
        : null,
  };
}

/** The `grants.revoke` operation: the grant and those passed down from it. Again, nothing changes. */
export async function revokeGrantOperation(
  ctx: OpContext,
  input: Input<typeof revokeGrant>,
): Promise<Output<typeof revokeGrant>> {
  refuseDelegated(ctx);
  const me = ctx.auth.principalId;
  const grant = await grantById(ctx.env, input.grant_id);
  if (!grant || (grant.grantor_id !== me && grant.created_by !== me))
    throw notFound(input.grant_id);
  if (grant.revoked_at !== null) return output(grant);
  const now = clock();
  const db = ctx.env.DIRECTORY;
  ctx.metrics.count("d1.query", { db: "directory", op: "grant_revoke" }, 2);
  await db.batch([
    db
      .prepare(
        `UPDATE grants SET revoked_at = ?1 WHERE (id = ?2 OR parent_id = ?2) AND revoked_at IS NULL`,
      )
      .bind(now, grant.id),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         VALUES (?, ?, 'grant.revoke', ?, NULL, ?)`,
      )
      .bind(now, me, grant.id, ctx.requestId ?? null),
  ]);
  return output({ ...grant, revoked_at: now });
}
