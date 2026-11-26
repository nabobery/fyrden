// The Actions secrets and variables operations, for repositories and
// organizations. Each answer is the account object's (`OrgDO`), which keeps
// them; a secret's value is opened and sealed again only there, and no
// operation answers one.

import type {
  addOrgSecretRepo,
  addOrgVariableRepo,
  createOrgVariable,
  createRepoVariable,
  deleteOrgSecret,
  deleteOrgVariable,
  deleteRepoSecret,
  deleteRepoVariable,
  getCiDataKey,
  getOrgSecret,
  getOrgSecretPublicKey,
  getOrgVariable,
  getRepoSecret,
  getRepoSecretPublicKey,
  getRepoVariable,
  Input,
  listOrgSecretRepos,
  listOrgSecrets,
  listOrgVariableRepos,
  listOrgVariables,
  listRepoOrgSecrets,
  listRepoOrgVariables,
  listRepoSecrets,
  listRepoVariables,
  Output,
  removeOrgSecretRepo,
  removeOrgVariableRepo,
  replaceCiDataKey,
  rewrapCiSecrets,
  setOrgSecret,
  setOrgSecretRepos,
  setOrgVariableRepos,
  setRepoSecret,
  updateOrgVariable,
  updateRepoVariable,
} from "@fyrden/api-contract";
import type { Permission, RepoPermission } from "@fyrden/domain";
import { type Account, findAccount, orgFor } from "../accounts/account.js";
import { recordedAccount } from "../accounts/grants.js";
import type { OrgDO } from "../do/OrgDO.js";
import type { CiKind, CiResult, CiSecretItem, CiVariableItem } from "../do/org/ci-secrets.js";
import { type OpContext, OperationError, statusResult } from "../ops/execute.js";
import { ownedReposPage, type RepoEntry, settledRepo } from "../repos/directory.js";
import { ciSecretKeys } from "./envelope.js";

const ORG = "org";

function settled<T>(result: CiResult<T>): T {
  if (!result.ok) throw new OperationError(result.status, result.code, result.error);
  return result.value;
}

const iso = (ms: number) => new Date(ms).toISOString();
const actorOf = (ctx: OpContext) => ({
  principalId: ctx.auth.principalId,
  requestId: ctx.requestId,
});

/** Test seams: between the access decision and the second ownership check. */
export const ciScopeHooks: { afterAuthorize?: () => Promise<void> } = {};

/**
 * The repository, if the caller may use `permission` there, and its account
 * object. The access decision is bound to settled ownership (see
 * `settledRepo`): a transfer under way, or one started across it, answers
 * 409 `repo_transferring`; an owner changed since, 404.
 */
async function repoScope(
  ctx: OpContext,
  owner: string,
  repo: string,
  permission: RepoPermission,
  record = false,
): Promise<{ repo: RepoEntry; stub: DurableObjectStub<OrgDO> }> {
  const entry = await settledRepo(ctx.env, ctx.auth, owner, repo, permission, {
    transferring:
      "The repository is being transferred, or was transferred after this request was authorized. Once any active transfer ends, look the repository up again (its owner may have changed) and retry the request, with a new Idempotency-Key if it had one: the same key answers this refusal again.",
    metrics: ctx.metrics,
    afterAuthorize: () => ciScopeHooks.afterAuthorize?.() ?? Promise.resolve(),
  });
  ctx.metrics.count("do.request", { class: "OrgDO", method: "ci" });
  const stub = record
    ? await recordedAccount(ctx.env, { id: entry.ownerId, handle: entry.ownerHandle }, ctx.metrics)
    : ctx.env.ORG.getByName(entry.ownerId);
  return { repo: entry, stub };
}

async function orgScope(ctx: OpContext, handle: string, permission: Permission) {
  const account = await findAccount(ctx.env, handle, { metrics: ctx.metrics });
  if (account?.type === "user")
    throw new OperationError(404, "not_an_org", `${account.handle} is not an organization.`);
  const org = await orgFor(ctx, handle, permission);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "ci" });
  return { org, stub: ctx.env.ORG.getByName(org.id) };
}

/** After a write: its audit row goes to the directory now (the alarm retries otherwise). */
function deliverAudit(ctx: OpContext, stub: { deliverAudit(): Promise<void> }) {
  ctx.waitUntil(stub.deliverAudit());
}

const secretOut = (s: CiSecretItem) => ({
  name: s.name,
  created_at: iso(s.createdAt),
  updated_at: iso(s.updatedAt),
  ...(s.unreadable && { unreadable: true }),
});

const variableOut = (
  v: Pick<CiVariableItem, "name" | "createdAt" | "updatedAt"> & { value?: string },
) => ({
  name: v.name,
  value: v.value ?? "",
  created_at: iso(v.createdAt),
  updated_at: iso(v.updatedAt),
});

/** An organization entry as GitHub answers it: with its visibility and, for `selected`, where its list is. */
function orgEntryOut<T extends object>(
  ctx: OpContext,
  org: Account,
  kind: CiKind,
  base: T,
  item: { name: string; visibility?: "all" | "private" | "selected" },
) {
  const visibility = item.visibility ?? "private";
  return {
    ...base,
    visibility,
    ...(visibility === "selected" && {
      selected_repositories_url: `${ctx.requestOrigin}/api/orgs/${org.handle}/actions/${kind}s/${item.name}/repositories`,
    }),
  };
}

export async function getRepoSecretPublicKeyOperation(
  ctx: OpContext,
  input: Input<typeof getRepoSecretPublicKey>,
): Promise<Output<typeof getRepoSecretPublicKey>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "secrets:read", true);
  const key = settled(await stub.ciPublicKey(actorOf(ctx), repo.id));
  deliverAudit(ctx, stub);
  return { key_id: key.keyId, key: key.key };
}

export async function listRepoSecretsOperation(
  ctx: OpContext,
  input: Input<typeof listRepoSecrets>,
): Promise<Output<typeof listRepoSecrets>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "secrets:read");
  const page = settled(await stub.ciSecrets(repo.id, input.page, input.per_page));
  return { total_count: page.total, secrets: page.items.map(secretOut) };
}

export async function getRepoSecretOperation(
  ctx: OpContext,
  input: Input<typeof getRepoSecret>,
): Promise<Output<typeof getRepoSecret>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "secrets:read");
  return secretOut(settled(await stub.ciSecret(repo.id, input.secret_name)));
}

export async function setRepoSecretOperation(ctx: OpContext, input: Input<typeof setRepoSecret>) {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "secrets:write", true);
  const { created } = settled(
    await stub.ciSetSecret({
      actor: actorOf(ctx),
      scope: repo.id,
      name: input.secret_name,
      keyId: input.key_id,
      encryptedValue: input.encrypted_value,
    }),
  );
  deliverAudit(ctx, stub);
  return statusResult(created ? 201 : 204, null);
}

export async function deleteRepoSecretOperation(
  ctx: OpContext,
  input: Input<typeof deleteRepoSecret>,
): Promise<Output<typeof deleteRepoSecret>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "secrets:write");
  settled(await stub.ciDelete(actorOf(ctx), "secret", repo.id, input.secret_name));
  deliverAudit(ctx, stub);
  return null;
}

export async function listRepoOrgSecretsOperation(
  ctx: OpContext,
  input: Input<typeof listRepoOrgSecrets>,
): Promise<Output<typeof listRepoOrgSecrets>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "secrets:read");
  const page = settled(
    await stub.ciRepoView("secret", repo.id, repo.visibility, input.page, input.per_page),
  );
  return { total_count: page.total, secrets: page.items.map(secretOut) };
}

export async function getOrgSecretPublicKeyOperation(
  ctx: OpContext,
  input: Input<typeof getOrgSecretPublicKey>,
): Promise<Output<typeof getOrgSecretPublicKey>> {
  const { stub } = await orgScope(ctx, input.org, "organization_secrets:read");
  const key = settled(await stub.ciPublicKey(actorOf(ctx), ORG));
  deliverAudit(ctx, stub);
  return { key_id: key.keyId, key: key.key };
}

export async function listOrgSecretsOperation(
  ctx: OpContext,
  input: Input<typeof listOrgSecrets>,
): Promise<Output<typeof listOrgSecrets>> {
  const { org, stub } = await orgScope(ctx, input.org, "organization_secrets:read");
  const page = settled(await stub.ciSecrets(ORG, input.page, input.per_page));
  return {
    total_count: page.total,
    secrets: page.items.map((s) => orgEntryOut(ctx, org, "secret", secretOut(s), s)),
  };
}

export async function getOrgSecretOperation(
  ctx: OpContext,
  input: Input<typeof getOrgSecret>,
): Promise<Output<typeof getOrgSecret>> {
  const { org, stub } = await orgScope(ctx, input.org, "organization_secrets:read");
  const secret = settled(await stub.ciSecret(ORG, input.secret_name));
  return orgEntryOut(ctx, org, "secret", secretOut(secret), secret);
}

export async function setOrgSecretOperation(ctx: OpContext, input: Input<typeof setOrgSecret>) {
  const { stub } = await orgScope(ctx, input.org, "organization_secrets:write");
  const { created } = settled(
    await stub.ciSetSecret({
      actor: actorOf(ctx),
      scope: ORG,
      name: input.secret_name,
      keyId: input.key_id,
      encryptedValue: input.encrypted_value,
      visibility: input.visibility,
      ...(input.selected_repository_ids && { selectedRepoIds: input.selected_repository_ids }),
    }),
  );
  deliverAudit(ctx, stub);
  return statusResult(created ? 201 : 204, null);
}

export async function deleteOrgSecretOperation(
  ctx: OpContext,
  input: Input<typeof deleteOrgSecret>,
): Promise<Output<typeof deleteOrgSecret>> {
  const { stub } = await orgScope(ctx, input.org, "organization_secrets:write");
  settled(await stub.ciDelete(actorOf(ctx), "secret", ORG, input.secret_name));
  deliverAudit(ctx, stub);
  return null;
}

async function listSelected(
  ctx: OpContext,
  kind: CiKind,
  handle: string,
  name: string,
  paging: { readonly page: number; readonly per_page: number },
) {
  const permission =
    kind === "secret" ? "organization_secrets:read" : "organization_variables:read";
  const { org, stub } = await orgScope(ctx, handle, permission);
  const ids = settled(await stub.ciSelectedRepos(kind, name));
  // Counted and paged as the directory has them: only the organization's own, so an id of a
  // repository being deleted, or one a transfer has moved before the organization lets it go,
  // is neither listed nor counted.
  const { total, repos } = await ownedReposPage(
    ctx.env,
    org.id,
    ids,
    { page: paging.page, perPage: paging.per_page },
    ctx.metrics,
  );
  return {
    total_count: total,
    repositories: repos.map((r) => ({
      id: r.id,
      name: r.name,
      full_name: `${r.ownerHandle}/${r.name}`,
      visibility: r.visibility,
    })),
  };
}

async function changeSelected(
  ctx: OpContext,
  kind: CiKind,
  handle: string,
  name: string,
  change: { set: readonly string[] } | { add: string } | { remove: string },
): Promise<null> {
  const permission =
    kind === "secret" ? "organization_secrets:write" : "organization_variables:write";
  const { stub } = await orgScope(ctx, handle, permission);
  settled(await stub.ciChangeSelected(actorOf(ctx), kind, name, change));
  deliverAudit(ctx, stub);
  return null;
}

export function listOrgSecretReposOperation(
  ctx: OpContext,
  input: Input<typeof listOrgSecretRepos>,
): Promise<Output<typeof listOrgSecretRepos>> {
  return listSelected(ctx, "secret", input.org, input.secret_name, input);
}

export function setOrgSecretReposOperation(
  ctx: OpContext,
  input: Input<typeof setOrgSecretRepos>,
): Promise<Output<typeof setOrgSecretRepos>> {
  return changeSelected(ctx, "secret", input.org, input.secret_name, {
    set: input.selected_repository_ids,
  });
}

export function addOrgSecretRepoOperation(
  ctx: OpContext,
  input: Input<typeof addOrgSecretRepo>,
): Promise<Output<typeof addOrgSecretRepo>> {
  return changeSelected(ctx, "secret", input.org, input.secret_name, { add: input.repository_id });
}

export function removeOrgSecretRepoOperation(
  ctx: OpContext,
  input: Input<typeof removeOrgSecretRepo>,
): Promise<Output<typeof removeOrgSecretRepo>> {
  return changeSelected(ctx, "secret", input.org, input.secret_name, {
    remove: input.repository_id,
  });
}

export function listOrgVariableReposOperation(
  ctx: OpContext,
  input: Input<typeof listOrgVariableRepos>,
): Promise<Output<typeof listOrgVariableRepos>> {
  return listSelected(ctx, "variable", input.org, input.name, input);
}

export function setOrgVariableReposOperation(
  ctx: OpContext,
  input: Input<typeof setOrgVariableRepos>,
): Promise<Output<typeof setOrgVariableRepos>> {
  return changeSelected(ctx, "variable", input.org, input.name, {
    set: input.selected_repository_ids,
  });
}

export function addOrgVariableRepoOperation(
  ctx: OpContext,
  input: Input<typeof addOrgVariableRepo>,
): Promise<Output<typeof addOrgVariableRepo>> {
  return changeSelected(ctx, "variable", input.org, input.name, { add: input.repository_id });
}

export function removeOrgVariableRepoOperation(
  ctx: OpContext,
  input: Input<typeof removeOrgVariableRepo>,
): Promise<Output<typeof removeOrgVariableRepo>> {
  return changeSelected(ctx, "variable", input.org, input.name, { remove: input.repository_id });
}

export async function listRepoVariablesOperation(
  ctx: OpContext,
  input: Input<typeof listRepoVariables>,
): Promise<Output<typeof listRepoVariables>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "variables:read");
  const page = settled(await stub.ciVariables(repo.id, input.page, input.per_page));
  return { total_count: page.total, variables: page.items.map(variableOut) };
}

export async function createRepoVariableOperation(
  ctx: OpContext,
  input: Input<typeof createRepoVariable>,
): Promise<Output<typeof createRepoVariable>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "variables:write", true);
  settled(
    await stub.ciCreateVariable({
      actor: actorOf(ctx),
      scope: repo.id,
      name: input.name,
      value: input.value,
    }),
  );
  deliverAudit(ctx, stub);
  return null;
}

export async function getRepoVariableOperation(
  ctx: OpContext,
  input: Input<typeof getRepoVariable>,
): Promise<Output<typeof getRepoVariable>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "variables:read");
  return variableOut(settled(await stub.ciVariable(repo.id, input.name)));
}

export async function updateRepoVariableOperation(
  ctx: OpContext,
  input: Input<typeof updateRepoVariable>,
): Promise<Output<typeof updateRepoVariable>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "variables:write");
  settled(
    await stub.ciUpdateVariable({
      actor: actorOf(ctx),
      scope: repo.id,
      name: input.name,
      ...(input.value !== undefined && { value: input.value }),
    }),
  );
  deliverAudit(ctx, stub);
  return null;
}

export async function deleteRepoVariableOperation(
  ctx: OpContext,
  input: Input<typeof deleteRepoVariable>,
): Promise<Output<typeof deleteRepoVariable>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "variables:write");
  settled(await stub.ciDelete(actorOf(ctx), "variable", repo.id, input.name));
  deliverAudit(ctx, stub);
  return null;
}

export async function listRepoOrgVariablesOperation(
  ctx: OpContext,
  input: Input<typeof listRepoOrgVariables>,
): Promise<Output<typeof listRepoOrgVariables>> {
  const { repo, stub } = await repoScope(ctx, input.owner, input.repo, "variables:read");
  const page = settled(
    await stub.ciRepoView("variable", repo.id, repo.visibility, input.page, input.per_page),
  );
  return { total_count: page.total, variables: page.items.map(variableOut) };
}

export async function listOrgVariablesOperation(
  ctx: OpContext,
  input: Input<typeof listOrgVariables>,
): Promise<Output<typeof listOrgVariables>> {
  const { org, stub } = await orgScope(ctx, input.org, "organization_variables:read");
  const page = settled(await stub.ciVariables(ORG, input.page, input.per_page));
  return {
    total_count: page.total,
    variables: page.items.map((v) => orgEntryOut(ctx, org, "variable", variableOut(v), v)),
  };
}

export async function createOrgVariableOperation(
  ctx: OpContext,
  input: Input<typeof createOrgVariable>,
): Promise<Output<typeof createOrgVariable>> {
  const { stub } = await orgScope(ctx, input.org, "organization_variables:write");
  settled(
    await stub.ciCreateVariable({
      actor: actorOf(ctx),
      scope: ORG,
      name: input.name,
      value: input.value,
      visibility: input.visibility,
      ...(input.selected_repository_ids && { selectedRepoIds: input.selected_repository_ids }),
    }),
  );
  deliverAudit(ctx, stub);
  return null;
}

export async function getOrgVariableOperation(
  ctx: OpContext,
  input: Input<typeof getOrgVariable>,
): Promise<Output<typeof getOrgVariable>> {
  const { org, stub } = await orgScope(ctx, input.org, "organization_variables:read");
  const variable = settled(await stub.ciVariable(ORG, input.name));
  return orgEntryOut(ctx, org, "variable", variableOut(variable), variable);
}

export async function updateOrgVariableOperation(
  ctx: OpContext,
  input: Input<typeof updateOrgVariable>,
): Promise<Output<typeof updateOrgVariable>> {
  const { stub } = await orgScope(ctx, input.org, "organization_variables:write");
  settled(
    await stub.ciUpdateVariable({
      actor: actorOf(ctx),
      scope: ORG,
      name: input.name,
      ...(input.value !== undefined && { value: input.value }),
      ...(input.visibility && { visibility: input.visibility }),
      ...(input.selected_repository_ids && { selectedRepoIds: input.selected_repository_ids }),
    }),
  );
  deliverAudit(ctx, stub);
  return null;
}

export async function deleteOrgVariableOperation(
  ctx: OpContext,
  input: Input<typeof deleteOrgVariable>,
): Promise<Output<typeof deleteOrgVariable>> {
  const { stub } = await orgScope(ctx, input.org, "organization_variables:write");
  settled(await stub.ciDelete(actorOf(ctx), "variable", ORG, input.name));
  deliverAudit(ctx, stub);
  return null;
}

const REWRAP_ACCOUNTS = 25;

export async function rewrapCiSecretsOperation(
  ctx: OpContext,
  input: Input<typeof rewrapCiSecrets>,
): Promise<Output<typeof rewrapCiSecrets>> {
  const keys = await ciSecretKeys(ctx.env);
  if (!keys.current)
    throw new OperationError(
      503,
      "ci_key_unavailable",
      keys.misconfigured
        ? `${keys.misconfigured}: data keys cannot be wrapped again until it is fixed.`
        : "CI_SECRETS_KEY is not set: data keys cannot be wrapped again.",
    );
  ctx.metrics.count("d1.query", { db: "directory", op: "ci_rewrap_accounts" });
  const { results } = await ctx.env.DIRECTORY.prepare(
    "SELECT id FROM principals WHERE id > ? AND type IN ('user', 'org') ORDER BY id LIMIT ?",
  )
    .bind(input.cursor ?? "", REWRAP_ACCOUNTS)
    .all<{ id: string }>();
  let rewrapped = 0;
  let remaining = 0;
  let unreadable = 0;
  for (const { id } of results) {
    ctx.metrics.count("do.request", { class: "OrgDO", method: "ciRewrap" });
    const done = await ctx.env.ORG.getByName(id).ciRewrap(keys.current.id);
    rewrapped += done.rewrapped;
    remaining += done.remaining;
    unreadable += done.unreadable;
  }
  return {
    rewrapped,
    remaining,
    unreadable,
    next_cursor: results.length === REWRAP_ACCOUNTS ? (results.at(-1)?.id ?? null) : null,
  };
}

/** An account an administrator recovers: suspended ones too, since suspending one must not block it. */
async function adminAccount(ctx: OpContext, handle: string) {
  const account = await findAccount(ctx.env, handle, {
    metrics: ctx.metrics,
    includeDisabled: true,
  });
  if (!account)
    throw new OperationError(404, "account_not_found", `No account ${handle} was found.`);
  return account;
}

/** The `admin.ci.data_key.get` operation (instance administrators; the executor checked it). */
export async function getCiDataKeyOperation(
  ctx: OpContext,
  input: Input<typeof getCiDataKey>,
): Promise<Output<typeof getCiDataKey>> {
  const account = await adminAccount(ctx, input.account);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "ciDataKeyStatus" });
  const status = await ctx.env.ORG.getByName(account.id).ciDataKeyStatus();
  return {
    account_id: account.id,
    generation: status.generation,
    created_at: status.createdAt === null ? null : iso(status.createdAt),
    secrets: status.secrets,
    unreadable_secrets: status.unreadableSecrets,
    unreadable: status.unreadable.map((s) => ({ scope: s.scope, name: s.name })),
    unreadable_truncated: status.unreadableTruncated,
  };
}

/** The `admin.ci.data_key.replace` operation (instance administrators; the executor checked it). */
export async function replaceCiDataKeyOperation(
  ctx: OpContext,
  input: Input<typeof replaceCiDataKey>,
): Promise<Output<typeof replaceCiDataKey>> {
  const account = await adminAccount(ctx, input.account);
  if (account.id !== input.account_id)
    throw new OperationError(
      409,
      "account_changed",
      `${input.account} is not account ${input.account_id} any more: read its status again.`,
    );
  const stub = ctx.env.ORG.getByName(account.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "ciReplaceDataKey" });
  // Audited in the same transaction, and delivered to the directory now or by the object's alarm.
  const done = settled(await stub.ciReplaceDataKey(actorOf(ctx), input.generation));
  ctx.metrics.count("do.request", { class: "OrgDO", method: "deliverAudit" });
  await stub.deliverAudit().catch(() => {});
  return {
    account_id: account.id,
    generation: done.generation,
    replaced_generation: done.replacedGeneration,
    replaced_at: iso(done.replacedAt),
  };
}
