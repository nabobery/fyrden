import { auditStatement } from "@fyrden/adapters-cloudflare/auth";
import type {
  createOrg,
  Input,
  listMembers,
  Output,
  removeMembership,
  setMembership,
} from "@fyrden/api-contract";
import { isValidHandle, type OrgRole } from "@fyrden/domain";
import type { MemberChange } from "../do/OrgDO.js";
import { allocateEpoch } from "../events/epochs.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock, newId } from "../services.js";
import { type Account, findAccount, invalidateAccountRepos, orgFor } from "./account.js";

// D1 reports a unique-index violation in the error message.
const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;

/** GitHub's membership role names: an `admin` is an owner. */
const toOrgRole = (role: "admin" | "member"): OrgRole => (role === "admin" ? "owner" : "member");
const toApiRole = (role: OrgRole): "admin" | "member" => (role === "owner" ? "admin" : "member");

/** The enabled user `handle` (or, with `includeDisabled`, a disabled one), or 404. */
async function userFor(ctx: OpContext, handle: string, includeDisabled = false): Promise<Account> {
  const user = await findAccount(ctx.env, handle, { metrics: ctx.metrics, includeDisabled });
  if (user?.type !== "user")
    throw new OperationError(404, "user_not_found", `No user ${handle} was found.`);
  return user;
}

/** The organization object's answer to a change, as the API answers it. */
function changed(change: MemberChange): Extract<MemberChange, { ok: true }> {
  if (change.ok) return change;
  if (change.code === "forbidden") throw new OperationError(403, change.code, change.error);
  throw new OperationError(409, change.code, change.error);
}

/** The `admin.orgs.create` operation: the organization's object first, then its directory rows. */
export async function createOrgOperation(
  ctx: OpContext,
  input: Input<typeof createOrg>,
): Promise<Output<typeof createOrg>> {
  const { env, auth, requestId, metrics } = ctx;
  const admin = await userFor(ctx, input.admin);
  if (await findAccount(env, input.login, { metrics, includeDisabled: true }))
    throw new OperationError(409, "handle_taken", `The handle ${input.login} is already taken.`);
  // The object first: if the directory rows then fail, it is unreachable.
  const id = newId("org");
  const epochGen = await allocateEpoch(env.DIRECTORY, id, metrics);
  metrics.count("do.request", { class: "OrgDO", method: "init" });
  const init = await env.ORG.getByName(id).init({
    accountId: id,
    kind: "org",
    owner: { id: admin.id, handle: admin.handle },
    epochGen,
  });
  if (!init.ok) throw new Error(`initializing the organization failed: ${init.error}`);
  const now = clock();
  const db = env.DIRECTORY;
  metrics.count("d1.query", { db: "directory", op: "org_create" }, 2);
  try {
    await db.batch([
      db
        .prepare("INSERT INTO principals (id, type, handle, created_at) VALUES (?, 'org', ?, ?)")
        .bind(id, input.login, now),
      auditStatement(db, now, { actorId: auth.principalId, requestId }, "org.create", id, {
        login: input.login,
        admin: admin.id,
      }),
    ]);
  } catch (error) {
    if (error instanceof Error && UNIQUE_VIOLATION.test(error.message))
      throw new OperationError(409, "handle_taken", `The handle ${input.login} is already taken.`);
    throw error;
  }
  return { id, login: input.login, created_at: now };
}

/**
 * The `orgs.memberships.set` operation. The organization's object checks
 * that the caller is an owner and makes the change in one transaction, in
 * force when it answers, with its audit row, which it then delivers.
 */
export async function setMembershipOperation(
  ctx: OpContext,
  input: Input<typeof setMembership>,
): Promise<Output<typeof setMembership>> {
  const { env, auth, requestId, metrics } = ctx;
  const org = await orgFor(ctx, input.org, "members:write");
  const user = await userFor(ctx, input.username);
  const stub = env.ORG.getByName(org.id);
  metrics.count("do.request", { class: "OrgDO", method: "setMember" });
  const change = changed(
    await stub.setMember(
      { principalId: auth.principalId, requestId },
      { id: user.id, handle: user.handle },
      toOrgRole(input.role),
    ),
  );
  ctx.waitUntil(stub.deliverAudit());
  if (change.changed) ctx.waitUntil(invalidateAccountRepos(env, org.id, change, metrics));
  return { org: org.handle, user: user.handle, role: input.role, state: "active" };
}

/** The `orgs.memberships.remove` operation: in force when the organization's object answers. */
export async function removeMembershipOperation(
  ctx: OpContext,
  input: Input<typeof removeMembership>,
): Promise<Output<typeof removeMembership>> {
  const { env, auth, requestId, metrics } = ctx;
  const org = await orgFor(ctx, input.org, "members:write");
  // A disabled user can still be removed from where it is.
  const user = await userFor(ctx, input.username, true);
  const stub = env.ORG.getByName(org.id);
  metrics.count("do.request", { class: "OrgDO", method: "removeMember" });
  const change = await stub.removeMember({ principalId: auth.principalId, requestId }, user.id);
  // Already gone (a retry): nothing to do.
  if (change.ok || change.code !== "not_a_member") changed(change);
  ctx.waitUntil(stub.deliverAudit());
  if (change.ok) ctx.waitUntil(invalidateAccountRepos(env, org.id, change, metrics));
  return { org: org.handle, user: user.handle, state: "removed" };
}

/** The `orgs.members.list` operation, from the organization's object. */
export async function listMembersOperation(
  ctx: OpContext,
  input: Input<typeof listMembers>,
): Promise<Output<typeof listMembers>> {
  const { env, metrics } = ctx;
  const org = await orgFor(ctx, input.org, "members:read");
  const after = decodeCursor(input.cursor, isValidHandle);
  metrics.count("do.request", { class: "OrgDO", method: "members" });
  const rows = await env.ORG.getByName(org.id).members(after, input.per_page + 1);
  const page = rows.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    members: page.map((m) => ({ id: m.id, login: m.handle, role: toApiRole(m.role) })),
    next_cursor: rows.length > input.per_page && last ? encodeCursor(last.handle) : null,
  };
}
