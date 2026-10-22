import type {
  addAssignees,
  addIssueLabels,
  clearIssueLabels,
  copyDefaultLabels,
  createLabel,
  deleteLabel,
  getDefaultLabels,
  getLabel,
  Input,
  listIssueLabels,
  listLabels,
  Output,
  removeAssignees,
  removeIssueLabel,
  setDefaultLabels,
  setIssueLabels,
  updateLabel,
} from "@fyrden/api-contract";
import { LABEL_NAME, MAX_LABEL_NAME_LENGTH } from "@fyrden/domain";
import { orgFor } from "../accounts/account.js";
import type { MetaInput } from "../do/repo/subject-meta.js";
import { decodeCursor, encodeCursor } from "../ops/cursor.js";
import { type OpContext, OperationError } from "../ops/execute.js";
import type { RepoEntry } from "./directory.js";
import { actorOf, failure } from "./pulls.js";
import { labelOutput, subjectOutput } from "./shapes.js";
import { assigneesByLogin, sortingFailure, unassigneesByLogin } from "./sorting.js";
import { subjectAccess, subjectNotFound, tokenKinds } from "./subjects.js";

/*
 * Labels serve issues and pull requests alike: reading them takes either
 * kind's read permission, managing them (write access) either kind's write
 * permission. Changing a subject's labels or assignees takes triage and
 * the permission for that subject's kind.
 */

const repo = (ctx: OpContext, entry: RepoEntry, method: string) => {
  ctx.metrics.count("do.request", { class: "RepoDO", method });
  return ctx.env.REPO.getByName(entry.id);
};

const labelNotFound = (name: string) =>
  new OperationError(404, "label_not_found", `The repository has no label ${name}.`);

/** The problem for a refusal of a label's management. */
function labelFailure(entry: RepoEntry, code: string, name: string): OperationError {
  switch (code) {
    case "label_not_found":
      return labelNotFound(name);
    case "label_exists":
      return new OperationError(
        422,
        "label_exists",
        `The repository has a label named ${name} already (ignoring case).`,
      );
    case "too_many_labels":
      return new OperationError(422, "too_many_labels", "A repository holds at most 1,000 labels.");
    case "forbidden":
      return new OperationError(403, "forbidden", "Managing labels takes write access.");
    default:
      return sortingFailure(code) ?? failure(entry, code);
  }
}

/** The problem for a refusal of a change of a subject's labels or assignees. */
function subjectFailure(entry: RepoEntry, code: string, number: number): OperationError {
  if (code === "not_found") return subjectNotFound(number);
  if (code === "forbidden")
    return new OperationError(
      403,
      "forbidden",
      "Labeling and assigning take triage, the author's own issue included.",
    );
  return sortingFailure(code) ?? failure(entry, code, number);
}

/** The `labels.list` operation. */
export async function listLabelsOperation(
  ctx: OpContext,
  input: Input<typeof listLabels>,
): Promise<Output<typeof listLabels>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "read");
  // The cursor is the last label's name.
  const after = decodeCursor(
    input.cursor,
    (name) => name.length <= MAX_LABEL_NAME_LENGTH && LABEL_NAME.test(name),
  );
  const labels = await repo(ctx, entry, "listLabels").listLabels(
    after === "" ? null : after,
    input.per_page + 1,
  );
  if (labels === null) throw failure(entry, "repo_not_found");
  const page = labels.slice(0, input.per_page);
  const last = page.at(-1);
  return {
    labels: page.map(labelOutput),
    next_cursor: labels.length > input.per_page && last ? encodeCursor(last.name) : null,
  };
}

/** The `labels.get` operation. */
export async function getLabelOperation(
  ctx: OpContext,
  input: Input<typeof getLabel>,
): Promise<Output<typeof getLabel>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const label = await repo(ctx, entry, "getLabel").getLabel(input.name);
  if (label === null) throw failure(entry, "repo_not_found");
  if (!label) throw labelNotFound(input.name);
  return labelOutput(label);
}

/** The `labels.create` operation. */
export async function createLabelOperation(
  ctx: OpContext,
  input: Input<typeof createLabel>,
): Promise<Output<typeof createLabel>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "createLabel").createLabel(
    { name: input.name, color: input.color, description: input.description ?? null },
    actorOf(ctx),
  );
  if (!result.ok) throw labelFailure(entry, result.code, input.name);
  return labelOutput(result.label);
}

/** The `labels.update` operation. */
export async function updateLabelOperation(
  ctx: OpContext,
  input: Input<typeof updateLabel>,
): Promise<Output<typeof updateLabel>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "updateLabel").updateLabel(
    input.name,
    {
      ...(input.new_name !== undefined && { name: input.new_name }),
      ...(input.color !== undefined && { color: input.color }),
      ...(input.description !== undefined && { description: input.description }),
    },
    actorOf(ctx),
  );
  if (!result.ok)
    throw labelFailure(
      entry,
      result.code,
      result.code === "label_exists" ? (input.new_name ?? input.name) : input.name,
    );
  return labelOutput(result.label);
}

/** The `labels.delete` operation. */
export async function deleteLabelOperation(
  ctx: OpContext,
  input: Input<typeof deleteLabel>,
): Promise<Output<typeof deleteLabel>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "deleteLabel").deleteLabel(input.name, actorOf(ctx));
  if (!result.ok) throw labelFailure(entry, result.code, input.name);
  return { name: input.name, state: "deleted" };
}

/** The `labels.copy_defaults` operation: the owner account's defaults, copied in. */
export async function copyDefaultLabelsOperation(
  ctx: OpContext,
  input: Input<typeof copyDefaultLabels>,
): Promise<Output<typeof copyDefaultLabels>> {
  const { entry } = await subjectAccess(ctx, input.owner, input.repo, "write");
  ctx.metrics.count("do.request", { class: "OrgDO", method: "defaultLabels" });
  const defaults = await ctx.env.ORG.getByName(entry.ownerId).defaultLabels();
  const result = await repo(ctx, entry, "copyLabels").copyLabels(defaults, actorOf(ctx));
  if (!result.ok) throw labelFailure(entry, result.code, "");
  return { labels: result.labels.map(labelOutput) };
}

/** The `issues.labels.list` operation. */
export async function listIssueLabelsOperation(
  ctx: OpContext,
  input: Input<typeof listIssueLabels>,
): Promise<Output<typeof listIssueLabels>> {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "read");
  const labels = await repo(ctx, entry, "subjectLabels").subjectLabels(input.issue_number, kinds);
  if (labels === null) throw failure(entry, "repo_not_found");
  if (!labels) throw subjectNotFound(input.issue_number);
  return { labels: labels.map(labelOutput) };
}

/** Changes a subject's labels or assignees; answers the subject as it then stands. */
async function changeSubject(
  ctx: OpContext,
  input: { owner: string; repo: string; issue_number: number },
  /** Worked out once the caller may act here (assignees are found by handle). */
  meta: MetaInput | (() => Promise<MetaInput>),
  /** What a label it names that the repository does not have answers (GitHub: 404 to remove one). */
  unknownLabel?: (code: string) => OperationError | undefined,
) {
  const { entry, kinds } = await subjectAccess(ctx, input.owner, input.repo, "write");
  const result = await repo(ctx, entry, "changeSubjectMeta").changeSubjectMeta(
    input.issue_number,
    typeof meta === "function" ? await meta() : meta,
    actorOf(ctx),
    kinds,
  );
  if (!result.ok)
    throw unknownLabel?.(result.code) ?? subjectFailure(entry, result.code, input.issue_number);
  return { subject: result.subject, entry };
}

/** The `issues.labels.add` operation. */
export async function addIssueLabelsOperation(
  ctx: OpContext,
  input: Input<typeof addIssueLabels>,
): Promise<Output<typeof addIssueLabels>> {
  const { subject } = await changeSubject(ctx, input, { labels: { add: input.labels } });
  return { labels: subject.meta.labels.map(labelOutput) };
}

/** The `issues.labels.set` operation. */
export async function setIssueLabelsOperation(
  ctx: OpContext,
  input: Input<typeof setIssueLabels>,
): Promise<Output<typeof setIssueLabels>> {
  const { subject } = await changeSubject(ctx, input, { labels: { set: input.labels } });
  return { labels: subject.meta.labels.map(labelOutput) };
}

/** The `issues.labels.remove` operation. */
export async function removeIssueLabelOperation(
  ctx: OpContext,
  input: Input<typeof removeIssueLabel>,
): Promise<Output<typeof removeIssueLabel>> {
  const { subject } = await changeSubject(
    ctx,
    input,
    { labels: { remove: [input.name] } },
    (code) => (code === "label_not_found" ? labelNotFound(input.name) : undefined),
  );
  return { labels: subject.meta.labels.map(labelOutput) };
}

/** The `issues.labels.clear` operation. */
export async function clearIssueLabelsOperation(
  ctx: OpContext,
  input: Input<typeof clearIssueLabels>,
): Promise<Output<typeof clearIssueLabels>> {
  const { subject } = await changeSubject(ctx, input, { labels: { set: [] } });
  return { labels: subject.meta.labels.map(labelOutput) };
}

/** The `issues.assignees.add` operation. */
export async function addAssigneesOperation(
  ctx: OpContext,
  input: Input<typeof addAssignees>,
): Promise<Output<typeof addAssignees>> {
  const { subject, entry } = await changeSubject(ctx, input, async () => ({
    assignees: { add: await assigneesByLogin(ctx, input.assignees) },
  }));
  return subjectOutput(subject, tokenKinds(ctx, entry, "read"));
}

/** The `issues.assignees.remove` operation. */
export async function removeAssigneesOperation(
  ctx: OpContext,
  input: Input<typeof removeAssignees>,
): Promise<Output<typeof removeAssignees>> {
  const { subject, entry } = await changeSubject(ctx, input, async () => ({
    assignees: { remove: await unassigneesByLogin(ctx, input.assignees) },
  }));
  return subjectOutput(subject, tokenKinds(ctx, entry, "read"));
}

/** The `orgs.default_labels.get` operation: for the organization's members. */
export async function getDefaultLabelsOperation(
  ctx: OpContext,
  input: Input<typeof getDefaultLabels>,
): Promise<Output<typeof getDefaultLabels>> {
  const org = await orgFor(ctx, input.org, "members:read");
  ctx.metrics.count("do.request", { class: "OrgDO", method: "defaultLabels" });
  return { labels: await ctx.env.ORG.getByName(org.id).defaultLabels() };
}

/** The `orgs.default_labels.set` operation: for the organization's owners. */
export async function setDefaultLabelsOperation(
  ctx: OpContext,
  input: Input<typeof setDefaultLabels>,
): Promise<Output<typeof setDefaultLabels>> {
  const org = await orgFor(ctx, input.org, "members:write");
  const stub = ctx.env.ORG.getByName(org.id);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "setDefaultLabels" });
  const set = await stub.setDefaultLabels(input.labels, {
    accountId: org.id,
    actor: {
      principalId: ctx.auth.principalId,
      ...(ctx.requestId !== undefined && { requestId: ctx.requestId }),
    },
  });
  if (!set.ok)
    throw set.code === "forbidden"
      ? new OperationError(
          403,
          "forbidden",
          "Only an owner of the organization sets its default labels.",
        )
      : new OperationError(404, "org_not_found", `No organization ${input.org} was found.`);
  ctx.metrics.count("do.request", { class: "OrgDO", method: "deliverAudit" });
  await stub.deliverAudit().catch(() => {});
  return { labels: set.labels };
}
