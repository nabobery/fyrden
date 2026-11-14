// The self-hosted runner operations: registration tokens, and listing and
// deleting an organization's runners.

import type {
  createRunnerRegistrationToken,
  deleteRunner,
  Input,
  listRunners,
  Output,
} from "@fyrden/api-contract";
import { generateToken, hashToken, secureRandomBytes } from "@fyrden/domain";
import { orgFor } from "../accounts/account.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import { clock } from "../services.js";
import { createRegistration, listRunners as listRunnerRows, revokeRunner } from "./registry.js";
import { runnersOn } from "./service.js";

/** How long a registration token registers a runner: GitHub's lifetime for its own. */
const REGISTRATION_TTL_MS = 60 * 60 * 1000;

/** The `orgs.runners.registration_tokens.create` operation. */
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
  const token = generateToken("run", secureRandomBytes);
  const now = clock();
  const expiresAt = now + REGISTRATION_TTL_MS;
  await createRegistration(
    ctx.env.DIRECTORY,
    {
      tokenHash: await hashToken(token),
      accountId: org.id,
      createdBy: ctx.auth.principalId,
      now,
      expiresAt,
    },
    ctx.metrics,
  );
  return { token, expires_at: expiresAt };
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
    { accountId: org.id, afterId: after === "" ? 0 : Number(after), limit: input.per_page + 1 },
    ctx.metrics,
  );
  const page = rows.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    runners: page.map((row) => ({
      id: row.id,
      name: row.name,
      labels: row.labels,
      version: row.version,
      ephemeral: row.ephemeral,
      created_at: row.createdAt,
      declared_at: row.declaredAt,
      revoked_at: row.revokedAt,
    })),
    next_cursor: rows.length > input.per_page && last ? encodeCursor(String(last.id)) : null,
  };
}

/** The `orgs.runners.delete` operation: revokes the runner's credential at once. */
export async function deleteRunnerOperation(
  ctx: OpContext,
  input: Input<typeof deleteRunner>,
): Promise<Output<typeof deleteRunner>> {
  const org = await orgFor(ctx, input.org, "self_hosted_runners:write");
  const found = await revokeRunner(
    ctx.env.DIRECTORY,
    { accountId: org.id, id: input.runner_id, now: clock() },
    ctx.metrics,
  );
  if (!found)
    throw new OperationError(
      404,
      "runner_not_found",
      `No runner ${input.runner_id} of ${org.handle} was found.`,
    );
  ctx.log.info("runner deleted", { runnerId: input.runner_id, accountId: org.id });
  return null;
}
