import type {
  createAgent,
  createAgentToken,
  disableAgent,
  getAgent,
  Input,
  listAgents,
  listAgentTokens,
  Output,
  revokeAgentToken,
} from "@fyrden/api-contract";
import { isPermission, scopesAllow } from "@fyrden/domain";
import { decodeSeekCursor, encodeSeekCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId, tokenStore } from "../services.js";
import { type Account, canUseAccount, orgFor } from "./account.js";
import { listTokensOf, revokeTokenOf } from "./tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;

type AgentRow = {
  id: string;
  handle: string;
  display_name: string | null;
  owner_id: string;
  owner: string;
  created_at: number;
  disabled_at: number | null;
};

const AGENT_COLUMNS = `a.id, a.handle, a.display_name, a.owner_id, o.handle AS owner,
  a.created_at, a.disabled_at`;

const output = (row: AgentRow): Output<typeof getAgent> => ({
  id: row.id,
  handle: row.handle,
  display_name: row.display_name,
  owner: row.owner,
  owner_id: row.owner_id,
  created_at: row.created_at,
  disabled: row.disabled_at !== null,
});

const notFound = (handle: string) =>
  new OperationError(404, "agent_not_found", `No agent ${handle} of yours was found.`);

/**
 * The account whose agents the caller manages with `permission`: its own,
 * or an organization it owns (`org`).
 */
async function ownerFor(
  ctx: OpContext,
  org: string | undefined,
  permission: "agents:read" | "agents:write",
): Promise<Account> {
  if (org !== undefined) return orgFor(ctx, org, permission);
  if (!canUseAccount(ctx.auth, "owner", permission))
    throw new OperationError(403, "forbidden", `You may not use ${permission}.`);
  return { id: ctx.auth.principalId, type: "user", handle: ctx.auth.principalHandle ?? "" };
}

/**
 * The agent `handle`, if the caller may use `permission` on it: an agent
 * of its own, or of an organization it owns. Any other answers 404.
 */
async function agentFor(
  ctx: OpContext,
  handle: string,
  permission: "agents:read" | "agents:write",
): Promise<AgentRow> {
  ctx.metrics.count("d1.query", { db: "directory", op: "agent_find" });
  const row = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM principals a JOIN principals o ON o.id = a.owner_id
       WHERE a.handle = ? COLLATE NOCASE AND a.type = 'agent'`,
    )
    .bind(handle)
    .first<AgentRow>();
  if (!row) throw notFound(handle);
  if (row.owner_id === ctx.auth.principalId) {
    if (!canUseAccount(ctx.auth, "owner", permission))
      throw new OperationError(403, "forbidden", `You may not use ${permission}.`);
    return row;
  }
  // An organization's agent, for its owners; anyone else learns nothing of it.
  const org = await orgFor(ctx, row.owner, permission).catch(() => undefined);
  if (org?.id !== row.owner_id) throw notFound(handle);
  return row;
}

/** The `agents.create` operation. */
export async function createAgentOperation(
  ctx: OpContext,
  input: Input<typeof createAgent>,
): Promise<Output<typeof createAgent>> {
  const owner = await ownerFor(ctx, input.org, "agents:write");
  const row: AgentRow = {
    id: newId("agt"),
    handle: input.handle,
    display_name: input.display_name ?? null,
    owner_id: owner.id,
    owner: owner.handle,
    created_at: clock(),
    disabled_at: null,
  };
  const db = ctx.env.DIRECTORY;
  ctx.metrics.count("d1.query", { db: "directory", op: "agent_create" }, 2);
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO principals (id, type, handle, display_name, owner_id, created_at)
           VALUES (?, 'agent', ?, ?, ?, ?)`,
        )
        .bind(row.id, row.handle, row.display_name, row.owner_id, row.created_at),
      db
        .prepare(
          `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
           VALUES (?, ?, 'agent.create', ?, json_object('handle', ?, 'owner', ?), ?)`,
        )
        .bind(
          row.created_at,
          ctx.auth.principalId,
          row.id,
          row.handle,
          row.owner_id,
          ctx.requestId ?? null,
        ),
    ]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
      throw new OperationError(409, "handle_taken", `The handle ${input.handle} is taken.`);
    throw error;
  }
  return output(row);
}

/** The `agents.list` operation: oldest first. */
export async function listAgentsOperation(
  ctx: OpContext,
  input: Input<typeof listAgents>,
): Promise<Output<typeof listAgents>> {
  const owner = await ownerFor(ctx, input.org, "agents:read");
  const after = decodeSeekCursor(input.cursor, "agt") ?? { at: -1, id: "" };
  ctx.metrics.count("d1.query", { db: "directory", op: "agents_list" });
  const { results } = await ctx.env.DIRECTORY.withSession("first-primary")
    .prepare(
      `SELECT ${AGENT_COLUMNS} FROM principals a JOIN principals o ON o.id = a.owner_id
       WHERE a.owner_id = ? AND a.type = 'agent' AND (a.created_at, a.id) > (?, ?)
       ORDER BY a.created_at, a.id LIMIT ?`,
    )
    .bind(owner.id, after.at, after.id, input.per_page + 1)
    .all<AgentRow>();
  const page = results.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    agents: page.map(output),
    next_cursor:
      results.length > input.per_page && last
        ? encodeSeekCursor({ at: last.created_at, id: last.id })
        : null,
  };
}

/** The `agents.get` operation. */
export async function getAgentOperation(
  ctx: OpContext,
  input: Input<typeof getAgent>,
): Promise<Output<typeof getAgent>> {
  return output(await agentFor(ctx, input.agent, "agents:read"));
}

/** The `agents.disable` operation: the agent's tokens and grants stop working; disabling again changes nothing. */
export async function disableAgentOperation(
  ctx: OpContext,
  input: Input<typeof disableAgent>,
): Promise<Output<typeof disableAgent>> {
  const agent = await agentFor(ctx, input.agent, "agents:write");
  if (agent.disabled_at !== null) return output(agent);
  const now = clock();
  const db = ctx.env.DIRECTORY;
  ctx.metrics.count("d1.query", { db: "directory", op: "agent_disable" }, 2);
  await db.batch([
    db
      .prepare("UPDATE principals SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL")
      .bind(now, agent.id),
    db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, action, target_id, details, request_id)
         VALUES (?, ?, 'agent.disable', ?, NULL, ?)`,
      )
      .bind(now, ctx.auth.principalId, agent.id, ctx.requestId ?? null),
  ]);
  return output({ ...agent, disabled_at: now });
}

/** The `agents.tokens.create` operation. */
export async function createAgentTokenOperation(
  ctx: OpContext,
  input: Input<typeof createAgentToken>,
): Promise<Output<typeof createAgentToken>> {
  const agent = await agentFor(ctx, input.agent, "agents:write");
  if (agent.disabled_at !== null)
    throw new OperationError(409, "agent_disabled", `The agent ${agent.handle} is disabled.`);
  // Never wider than the token minting it: a narrow token hands out no more than it holds.
  const own = ctx.auth.scopes;
  const scopes = input.scopes.length === 0 ? own : input.scopes;
  if (!scopes.every((scope) => isPermission(scope) && scopesAllow(own, scope)))
    throw new OperationError(403, "scope_exceeds_token", "The scopes exceed your token's.");
  const minted = await tokenStore(ctx.env, { metrics: ctx.metrics }).mint({
    principalId: agent.id,
    type: input.type,
    scopes,
    repoIds: ctx.auth.repoIds,
    ttlMs: input.expires_in_days * DAY_MS,
    audit: {
      actorId: ctx.auth.principalId,
      ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    },
  });
  return {
    id: minted.id,
    token: minted.token,
    type: input.type,
    agent_id: agent.id,
    scopes,
    expires_at: minted.expiresAt,
  };
}

/** The `agents.tokens.list` operation: for the agent's owner (an organization's owners). */
export async function listAgentTokensOperation(
  ctx: OpContext,
  input: Input<typeof listAgentTokens>,
): Promise<Output<typeof listAgentTokens>> {
  const agent = await agentFor(ctx, input.agent, "agents:read");
  return listTokensOf(ctx, agent.id, input);
}

/** The `agents.tokens.revoke` operation: one token, so a leaked one ends without disabling the agent. */
export async function revokeAgentTokenOperation(
  ctx: OpContext,
  input: Input<typeof revokeAgentToken>,
): Promise<Output<typeof revokeAgentToken>> {
  const agent = await agentFor(ctx, input.agent, "agents:write");
  return revokeTokenOf(ctx, agent.id, input.token_id);
}
