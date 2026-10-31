import type {
  deleteThreadSubscription,
  getThreadSubscription,
  Input,
  Output,
  setThreadSubscription,
} from "@fyrden/api-contract";
import type { ThreadRow, ThreadState } from "../do/repo/thread-preferences.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { subjectAccess, subjectNotFound } from "./subjects.js";
import { COPY_FENCE, type CopyState, copyPreference, recovering } from "./watching.js";

/*
 * Thread subscriptions (a Fyrden extension, at Gitea's route): the caller's
 * preference for one issue or pull request of a repository it reads, of a
 * kind its token may read, kept by the repository under the conversation's
 * identity and copied to the directory (`thread_preferences`) as watching
 * is: a command answers only after both, a copy that could not be written
 * answers 503 with the repository's change kept, and the same request
 * repeated sets the same state (on the conversation the number names then).
 */

type Subscription = Output<typeof getThreadSubscription>;

function subscriptionOf(
  ctx: OpContext,
  entry: RepoEntry,
  number: number,
  row: ThreadRow,
): Subscription {
  const repositoryUrl = `${ctx.requestOrigin}/api/repos/${entry.ownerHandle}/${entry.name}`;
  const issueUrl = `${repositoryUrl}/issues/${number}`;
  return {
    subscribed: row.state === "subscribed",
    ignored: row.state === "unsubscribed",
    reason: null,
    created_at: new Date(row.at).toISOString(),
    url: `${issueUrl}/subscription`,
    issue_url: issueUrl,
    repository_url: repositoryUrl,
  };
}

const noPreference = () =>
  new OperationError(
    404,
    "subscription_not_found",
    "No subscription to, or unsubscription from, this conversation.",
  );

/** The `watching.thread_get` operation: 404 without a preference. */
export async function getThreadSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof getThreadSubscription>,
): Promise<Output<typeof getThreadSubscription>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "threadPreference" });
  const answer = await ctx.env.REPO.getByName(entry.id).threadPreference(
    ctx.auth.principalId,
    input.issue_number,
    kinds,
  );
  if (answer.status === "recovering") throw recovering();
  if (answer.status !== "ok") throw subjectNotFound(input.issue_number);
  if (!answer.row) throw noPreference();
  return subscriptionOf(ctx, entry, input.issue_number, answer.row as ThreadRow);
}

/** The `watching.thread_put` operation: `ignored` wins; neither, no preference. */
export async function setThreadSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof setThreadSubscription>,
): Promise<Output<typeof setThreadSubscription>> {
  const state: ThreadState | null = input.ignored
    ? "unsubscribed"
    : (input.subscribed ?? true)
      ? "subscribed"
      : null;
  const { row, entry } = await setPreference(
    ctx,
    input.owner,
    input.repo,
    input.issue_number,
    state,
  );
  return subscriptionOf(ctx, entry, input.issue_number, row);
}

/** The `watching.thread_delete` operation: no preference. */
export async function deleteThreadSubscriptionOperation(
  ctx: OpContext,
  input: Input<typeof deleteThreadSubscription>,
): Promise<Output<typeof deleteThreadSubscription>> {
  await setPreference(ctx, input.owner, input.repo, input.issue_number, null);
  return {};
}

/** Sets the caller's preference in the repository, then its copy in the directory. */
async function setPreference(
  ctx: OpContext,
  owner: string,
  repo: string,
  number: number,
  state: ThreadState | null,
) {
  const { entry, kinds } = await subjectAccess(ctx, owner, repo, "read");
  ctx.metrics.count("do.request", { class: "RepoDO", method: "setThreadPreference" });
  const answer = await ctx.env.REPO.getByName(entry.id).setThreadPreference(
    ctx.auth.principalId,
    ctx.auth.grantId,
    number,
    kinds,
    state,
  );
  if (answer.status === "recovering") throw recovering();
  if (answer.status === "full")
    throw answer.cap === "kind"
      ? new OperationError(
          409,
          "thread_subscriptions_full",
          "You have as many preferences for this repository's conversations of this kind as it keeps (1,000).",
        )
      : new OperationError(
          409,
          "thread_subscribers_full",
          `This conversation has as many ${state === "unsubscribed" ? "unsubscribed" : "subscribed"} principals as it keeps (1,000).`,
        );
  if (answer.status !== "set") throw subjectNotFound(number);
  const row = answer.row as ThreadRow;
  await copyThread(ctx, entry.id, row);
  return { row, entry };
}

/**
 * Writes the command to the directory's copy (fenced as watching's; a
 * deletion kept as `none`, so an older command held in flight never brings
 * the preference back).
 */
export function copyThread(ctx: OpContext, repoId: string, row: ThreadRow): Promise<void> {
  return copyPreference(
    row,
    async () => {
      ctx.metrics.count("d1.query", { db: "directory", op: "thread_copy_put" });
      const written = await ctx.env.DIRECTORY.prepare(
        `INSERT INTO thread_preferences (principal_id, repo_id, root_id, state, revision,
           epoch_gen, at, conversation, number, kind)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE ${COPY_FENCE}
         ON CONFLICT (principal_id, repo_id, conversation) DO UPDATE SET
           root_id = excluded.root_id, state = excluded.state, revision = excluded.revision,
           epoch_gen = excluded.epoch_gen, at = excluded.at, number = excluded.number,
           kind = excluded.kind
         WHERE (excluded.epoch_gen, excluded.revision)
           > (thread_preferences.epoch_gen, thread_preferences.revision)`,
      )
        .bind(
          row.principal,
          repoId,
          row.root,
          row.state,
          row.revision,
          row.epochGen,
          row.at,
          row.conversation,
          row.number,
          row.kind,
        )
        .run();
      return written.meta.changes;
    },
    () => {
      ctx.metrics.count("d1.query", { db: "directory", op: "thread_copy_check" });
      return ctx.env.DIRECTORY.prepare(
        `SELECT (SELECT epoch_gen FROM source_epochs WHERE source_id = ?2) AS epoch_gen,
           c.epoch_gen AS copied_epoch, c.revision AS copied_revision
         FROM (SELECT 1) LEFT JOIN thread_preferences c
           ON c.principal_id = ?1 AND c.repo_id = ?2 AND c.conversation = ?3`,
      )
        .bind(row.principal, repoId, row.conversation)
        .first<CopyState>();
    },
  );
}
