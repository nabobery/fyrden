import type {
  addRunnerRepo,
  cancelRunnerRegistrationTokens,
  createRunnerRegistrationToken,
  deleteRunner,
  getRunner,
  Input,
  listRunners,
  Output,
  removeRunnerRepo,
  updateRunnerAccess,
} from "@fyrden/api-contract";
import { generateToken, hashToken, MAX_RUNNER_REPOS, secureRandomBytes } from "@fyrden/domain";
import { type Account, orgFor } from "../accounts/account.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock } from "../services.js";
import { type AccessRefusal, accessJson, changeAccess, changeListed } from "./access.js";
import { runnerAdmissionFor } from "./admission.js";
import {
  cancelRegistrations,
  createRegistration,
  fleetRoom,
  type ListedRunner,
  listRunners as listRunnerRows,
  readRunner,
  revokeRunner,
} from "./registry.js";
import { runnersOn } from "./service.js";

/** How long a registration token registers a runner: GitHub's lifetime for its own. */
const REGISTRATION_TTL_MS = 60 * 60 * 1000;

export async function createRunnerRegistrationTokenOperation(
  ctx: OpContext,
  input: Input<typeof createRunnerRegistrationToken>,
): Promise<Output<typeof createRunnerRegistrationToken>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:write");
  if (!runnersOn(ctx.env))
    throw new OperationError(
      409,
      "runners_off",
      "Runner registration is turned off on this deployment.",
    );
  const repositoryAccess = input.repository_access ?? "all";
  if (input.selected_repository_ids !== undefined && repositoryAccess !== "selected")
    throw new OperationError(
      422,
      "invalid_input",
      "selected_repository_ids needs repository_access selected.",
    );
  const now = clock();
  const { fleet } = runnerAdmissionFor(ctx.env);
  const room = fleet && (await fleetRoom(ctx.env.DIRECTORY, fleet, now, ctx.metrics));
  if (room === "fleet_full")
    throw new OperationError(
      409,
      "runner_fleet_full",
      "This deployment's runner fleet is full; delete a runner before registering another.",
    );
  if (room === "polls_spent")
    throw new OperationError(
      409,
      "runner_fleet_full",
      "This deployment's runners have used today's polling; register again after 00:00 UTC.",
    );
  const token = generateToken("run", secureRandomBytes);
  const expiresAt = now + REGISTRATION_TTL_MS;
  const made = await createRegistration(
    ctx.env.DIRECTORY,
    {
      tokenHash: await hashToken(token),
      accountId: org.id,
      createdBy: ctx.auth.principalId,
      now,
      expiresAt,
      access: {
        repositoryAccess,
        allowsPublic: input.allows_public ?? false,
        allowsForks: input.allows_forks ?? false,
      },
      selectedRepos: [...new Set(input.selected_repository_ids)],
      requestId: ctx.requestId,
    },
    ctx.metrics,
  );
  if (!made) throw refusal("unknown_repository", org);
  return { token, expires_at: expiresAt };
}

export async function cancelRunnerRegistrationTokensOperation(
  ctx: OpContext,
  input: Input<typeof cancelRunnerRegistrationTokens>,
): Promise<Output<typeof cancelRunnerRegistrationTokens>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:write");
  const cancelled = await cancelRegistrations(
    ctx.env.DIRECTORY,
    {
      accountId: org.id,
      now: clock(),
      actor: { principalId: ctx.auth.principalId, requestId: ctx.requestId },
    },
    ctx.metrics,
  );
  ctx.log.info("runner registration tokens cancelled", { accountId: org.id, cancelled });
  return { cancelled };
}

const RUNNER_ID = /^[1-9][0-9]{0,15}$/;

/** The `orgs.runners.list` operation: oldest first. */
export async function listRunnersOperation(
  ctx: OpContext,
  input: Input<typeof listRunners>,
): Promise<Output<typeof listRunners>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:read");
  const after = decodeCursor(input.cursor, (id) => RUNNER_ID.test(id));
  const rows = await listRunnerRows(
    ctx.env.DIRECTORY,
    {
      accountId: org.id,
      afterId: after === "" ? 0 : Number(after),
      limit: input.per_page + 1,
      status: input.status,
      now: clock(),
    },
    ctx.metrics,
  );
  const page = rows.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    runners: page.map(runnerOutput),
    next_cursor: rows.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

const runnerOutput = (runner: ListedRunner) => ({
  id: runner.id,
  name: runner.name,
  labels: runner.labels,
  version: runner.version,
  ephemeral: runner.ephemeral,
  created_at: runner.createdAt,
  declared_at: runner.declaredAt,
  revoked_at: runner.revokedAt,
  ...accessJson(runner.access),
  selected_count: runner.selectedCount,
  task_assigned_at: runner.taskAssignedAt,
  revoked_reason: runner.revokedReason,
});

const targetOf = (ctx: OpContext, org: Account, id: number) => ({
  accountId: org.id,
  id,
  now: clock(),
  actor: { principalId: ctx.auth.principalId, requestId: ctx.requestId },
});

function refusal(code: AccessRefusal, org: Account, id?: number): OperationError {
  switch (code) {
    case "runner_not_found":
      return new OperationError(404, code, `No runner ${id} of ${org.handle} was found.`);
    case "runner_revoked":
      return new OperationError(409, code, "The runner no longer serves.");
    case "forks_need_ephemeral":
      return new OperationError(
        422,
        code,
        "Only an ephemeral runner may take fork jobs: register one with --ephemeral.",
      );
    case "access_not_selected":
      return new OperationError(
        409,
        code,
        "The runner's repository_access is not selected, so it lists no repositories.",
      );
    case "unknown_repository":
      return new OperationError(
        422,
        code,
        `A repository given is not an active repository of ${org.handle}.`,
      );
    case "too_many_repositories":
      return new OperationError(
        422,
        code,
        `A runner lists ${MAX_RUNNER_REPOS} repositories at most.`,
      );
  }
}

async function runnerDetail(ctx: OpContext, org: Account, id: number) {
  const runner = await readRunner(ctx.env.DIRECTORY, { accountId: org.id, id }, ctx.metrics);
  if (!runner) throw refusal("runner_not_found", org, id);
  return {
    ...runnerOutput(runner),
    repositories: runner.repositories.map((repo) => ({
      id: repo.id,
      name: repo.name,
      full_name: `${org.handle}/${repo.name}`,
      visibility: repo.visibility,
    })),
  };
}

export async function getRunnerOperation(
  ctx: OpContext,
  input: Input<typeof getRunner>,
): Promise<Output<typeof getRunner>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:read");
  return runnerDetail(ctx, org, input.runner_id);
}

export async function updateRunnerAccessOperation(
  ctx: OpContext,
  input: Input<typeof updateRunnerAccess>,
): Promise<Output<typeof updateRunnerAccess>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:write");
  const change = {
    repositoryAccess: input.repository_access,
    selectedRepos: input.selected_repository_ids && [...new Set(input.selected_repository_ids)],
    allowsPublic: input.allows_public,
    allowsForks: input.allows_forks,
  };
  if (Object.values(change).every((value) => value === undefined))
    throw new OperationError(422, "invalid_input", "There is nothing to change.");
  const refused = await changeAccess(
    ctx.env.DIRECTORY,
    targetOf(ctx, org, input.runner_id),
    change,
    ctx.metrics,
  );
  if (refused) throw refusal(refused, org, input.runner_id);
  ctx.log.info("runner access changed", { runnerId: input.runner_id, accountId: org.id });
  return runnerDetail(ctx, org, input.runner_id);
}

async function changeRepo(
  ctx: OpContext,
  input: Input<typeof addRunnerRepo>,
  change: "add" | "remove",
): Promise<null> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:write");
  const refused = await changeListed(
    ctx.env.DIRECTORY,
    targetOf(ctx, org, input.runner_id),
    input.repository_id,
    change,
    ctx.metrics,
  );
  if (refused) throw refusal(refused, org, input.runner_id);
  ctx.log.info("runner access changed", { runnerId: input.runner_id, accountId: org.id });
  return null;
}

export function addRunnerRepoOperation(
  ctx: OpContext,
  input: Input<typeof addRunnerRepo>,
): Promise<Output<typeof addRunnerRepo>> {
  return changeRepo(ctx, input, "add");
}

export function removeRunnerRepoOperation(
  ctx: OpContext,
  input: Input<typeof removeRunnerRepo>,
): Promise<Output<typeof removeRunnerRepo>> {
  return changeRepo(ctx, input, "remove");
}

/** The `orgs.runners.delete` operation: revokes the runner's credential at once. */
export async function deleteRunnerOperation(
  ctx: OpContext,
  input: Input<typeof deleteRunner>,
): Promise<Output<typeof deleteRunner>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:write");
  const found = await revokeRunner(
    ctx.env.DIRECTORY,
    targetOf(ctx, org, input.runner_id),
    ctx.metrics,
  );
  if (!found) throw refusal("runner_not_found", org, input.runner_id);
  ctx.log.info("runner deleted", { runnerId: input.runner_id, accountId: org.id });
  return null;
}
