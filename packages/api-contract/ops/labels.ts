import {
  HANDLE_SHAPE,
  LABEL_COLOR,
  LABEL_NAME,
  labelNameKey,
  MAX_ASSIGNEES,
  MAX_DEFAULT_LABELS,
  MAX_HANDLE_LENGTH,
  MAX_LABEL_DESCRIPTION_LENGTH,
  MAX_LABEL_NAME_LENGTH,
  MAX_SUBJECT_LABELS,
} from "@fyrden/domain";
import { z } from "zod";
import { defineOperation } from "../src/op.js";
import { Issue } from "./issues.js";
import { REPO_NAME_PATTERN } from "./repos.js";
import { Label } from "./subject-meta.js";

const RepoInput = {
  owner: z
    .string()
    .min(1)
    .max(MAX_HANDLE_LENGTH)
    .regex(HANDLE_SHAPE)
    .describe("The owner's handle."),
  repo: z.string().regex(REPO_NAME_PATTERN).describe("The repository's name."),
};
const IssueNumber = z.coerce
  .number()
  .int()
  .positive()
  .describe("The issue's or pull request's number.");
export const LabelName = z
  .string()
  .min(1)
  .max(MAX_LABEL_NAME_LENGTH)
  .regex(LABEL_NAME)
  .describe("A label's name (matched ignoring the case of ASCII letters); not `.` or `..`.");
const Color = z
  .string()
  .regex(LABEL_COLOR)
  .describe("Six hex digits, without `#` (kept lower-case).");
const Description = z.string().max(MAX_LABEL_DESCRIPTION_LENGTH);
const Names = z
  .array(LabelName)
  .max(MAX_SUBJECT_LABELS)
  .describe("Label names, matched ignoring case; each must exist in the repository.");
const Logins = z
  .array(z.string().min(1).max(MAX_HANDLE_LENGTH).regex(HANDLE_SHAPE))
  .min(1)
  .max(MAX_ASSIGNEES)
  .describe("Handles of users and agents who can read the repository.");

const Labels = z.object({ labels: z.array(Label) });

const MANAGE =
  "Takes write access, and the `issues:write` or `pull_requests:write` permission (labels serve both).";
const READ = "Takes the `issues:read` or `pull_requests:read` permission (labels serve both).";
const ON_SUBJECT =
  "Takes triage, and the permission for the subject's kind (`issues:write`, or `pull_requests:write` for a pull request's number).";

export const listLabels = defineOperation({
  id: "labels.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/labels",
  summary: "List labels",
  description: `The repository's labels by name, ignoring case. ${READ}`,
  input: z.object({
    ...RepoInput,
    q: z
      .string()
      .min(1)
      .max(MAX_LABEL_NAME_LENGTH)
      .optional()
      .describe("Fyrden: only labels whose name starts with this, ignoring case."),
    per_page: z.coerce.number().int().min(1).max(100).default(30).describe("Page size, 1-100."),
    cursor: z.string().max(400).optional().describe("From a previous page's `next_cursor`."),
  }),
  output: z.object({
    labels: z.array(Label),
    next_cursor: z
      .string()
      .nullable()
      .describe("Pass as `cursor` for the next page; null on the last page."),
  }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_labels",
    title: "List labels",
    description: "List a repository's labels.",
    readOnly: true,
  },
});

export const getLabel = defineOperation({
  id: "labels.get",
  method: "GET",
  path: "/repos/{owner}/{repo}/labels/{name}",
  summary: "Get a label",
  description: `One label by name, ignoring case. ${READ}`,
  input: z.object({ ...RepoInput, name: LabelName }),
  output: Label,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_label",
    title: "Get a label",
    description: "Get one of a repository's labels by name.",
    readOnly: true,
  },
});

export const createLabel = defineOperation({
  id: "labels.create",
  method: "POST",
  path: "/repos/{owner}/{repo}/labels",
  summary: "Create a label",
  description: `Creates a label; its name must be new, ignoring case. ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    name: LabelName,
    color: Color,
    description: Description.optional(),
  }),
  output: Label,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  successStatus: 201,
  mcp: {
    tool: "create_label",
    title: "Create a label",
    description: "Create a label in a repository (write access).",
    readOnly: false,
  },
});

export const updateLabel = defineOperation({
  id: "labels.update",
  method: "PATCH",
  path: "/repos/{owner}/{repo}/labels/{name}",
  summary: "Update a label",
  description: `Renames a label (\`new_name\`), or changes its color or description; issues and pull requests keep it. ${MANAGE}`,
  input: z.object({
    ...RepoInput,
    name: LabelName,
    new_name: LabelName.optional(),
    color: Color.optional(),
    description: Description.nullable().optional().describe("Null clears it."),
  }),
  output: Label,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "update_label",
    title: "Update a label",
    description: "Rename a label or change its color or description (write access).",
    readOnly: false,
  },
});

export const deleteLabel = defineOperation({
  id: "labels.delete",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/labels/{name}",
  summary: "Delete a label",
  description: `Deletes a label; issues and pull requests carrying it no longer do. Answers what was deleted (GitHub answers 204). ${MANAGE}`,
  input: z.object({ ...RepoInput, name: LabelName }),
  output: z.object({ name: z.string(), state: z.literal("deleted") }),
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "delete_label",
    title: "Delete a label",
    description: "Delete a repository's label (write access).",
    readOnly: false,
  },
});

export const copyDefaultLabels = defineOperation({
  id: "labels.copy_defaults",
  method: "POST",
  path: "/repos/{owner}/{repo}/labels/defaults",
  summary: "Copy the default labels in",
  description: `Fyrden: copies the account's default labels (its organization's set, or GitHub's) into the repository; names it has already are kept as they are. New repositories get them when created. Answers the labels added. ${MANAGE}`,
  input: z.object(RepoInput),
  output: Labels,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "copy_default_labels",
    title: "Copy the default labels in",
    description: "Add the account's default labels a repository is missing (write access).",
    readOnly: false,
  },
});

export const listIssueLabels = defineOperation({
  id: "issues.labels.list",
  method: "GET",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/labels",
  summary: "List an issue's labels",
  description:
    "An issue's or a pull request's labels by name (at most 100, all on one page), for a caller that may read that kind.",
  input: z.object({ ...RepoInput, issue_number: IssueNumber }),
  output: Labels,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "list_issue_labels",
    title: "List an issue's labels",
    description: "List the labels of an issue or pull request.",
    readOnly: true,
  },
});

export const addIssueLabels = defineOperation({
  id: "issues.labels.add",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/labels",
  summary: "Add labels to an issue",
  description: `Adds labels to an issue or pull request (it holds at most 100); ones it has are kept. Names that do not exist are refused (GitHub creates them). Answers its labels. ${ON_SUBJECT}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, labels: Names.min(1) }),
  output: Labels,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "add_issue_labels",
    title: "Add labels to an issue",
    description: "Add labels to an issue or pull request (triage).",
    readOnly: false,
  },
});

export const setIssueLabels = defineOperation({
  id: "issues.labels.set",
  method: "PUT",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/labels",
  summary: "Set an issue's labels",
  description: `Replaces an issue's or pull request's labels (empty takes them all off). Answers its labels. ${ON_SUBJECT}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, labels: Names }),
  output: Labels,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "set_issue_labels",
    title: "Set an issue's labels",
    description: "Replace the labels of an issue or pull request (triage).",
    readOnly: false,
  },
});

export const removeIssueLabel = defineOperation({
  id: "issues.labels.remove",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
  summary: "Remove a label from an issue",
  description: `Takes a label off an issue or pull request (one it does not have changes nothing; one the repository does not have is not found). Answers its labels. ${ON_SUBJECT}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, name: LabelName }),
  output: Labels,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_issue_label",
    title: "Remove a label from an issue",
    description: "Take a label off an issue or pull request (triage).",
    readOnly: false,
  },
});

export const clearIssueLabels = defineOperation({
  id: "issues.labels.clear",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/labels",
  summary: "Remove all labels from an issue",
  description: `Takes every label off an issue or pull request. Answers its labels, none (GitHub answers 204). ${ON_SUBJECT}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber }),
  output: Labels,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "clear_issue_labels",
    title: "Remove all labels from an issue",
    description: "Take every label off an issue or pull request (triage).",
    readOnly: false,
  },
});

export const addAssignees = defineOperation({
  id: "issues.assignees.add",
  method: "POST",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/assignees",
  summary: "Add assignees to an issue",
  description: `Assigns users or agents who can read the repository to an issue or pull request (at most 10 in all); ones assigned already are kept. Answers the issue (or pull request, as the issue endpoints show one). ${ON_SUBJECT}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, assignees: Logins }),
  output: Issue,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "add_assignees",
    title: "Add assignees to an issue",
    description: "Assign users or agents to an issue or pull request (triage).",
    readOnly: false,
  },
});

export const removeAssignees = defineOperation({
  id: "issues.assignees.remove",
  method: "DELETE",
  path: "/repos/{owner}/{repo}/issues/{issue_number}/assignees",
  summary: "Remove assignees from an issue",
  description: `Unassigns users or agents from an issue or pull request; ones not assigned are ignored. Answers the issue. ${ON_SUBJECT}`,
  input: z.object({ ...RepoInput, issue_number: IssueNumber, assignees: Logins }),
  output: Issue,
  permission: "metadata:read",
  principals: ["user", "agent"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "remove_assignees",
    title: "Remove assignees from an issue",
    description: "Unassign users or agents from an issue or pull request (triage).",
    readOnly: false,
  },
});

const Org = z
  .string()
  .min(1)
  .max(MAX_HANDLE_LENGTH)
  .regex(HANDLE_SHAPE)
  .describe("The organization's handle.");
const DefaultLabel = z.object({
  name: LabelName,
  color: Color,
  description: Description.nullable().default(null),
});

export const getDefaultLabels = defineOperation({
  id: "orgs.default_labels.get",
  method: "GET",
  path: "/orgs/{org}/default-labels",
  summary: "Get an organization's default labels",
  description:
    "Fyrden: the labels the organization's new repositories get, in order; GitHub's nine until its owners set them. For its members.",
  input: z.object({ org: Org }),
  output: z.object({ labels: z.array(DefaultLabel) }),
  permission: "members:read",
  principals: ["user", "agent"],
  rateLimit: "read",
  idempotency: "none",
  mcp: {
    tool: "get_default_labels",
    title: "Get an organization's default labels",
    description: "List the labels an organization's new repositories get.",
    readOnly: true,
  },
});

export const setDefaultLabels = defineOperation({
  id: "orgs.default_labels.set",
  method: "PUT",
  path: "/orgs/{org}/default-labels",
  summary: "Set an organization's default labels",
  description: `Fyrden: replaces the labels the organization's new repositories get (at most ${MAX_DEFAULT_LABELS}, names unique ignoring case); repositories made before keep theirs. For its owners.`,
  input: z.object({
    org: Org,
    labels: z
      .array(DefaultLabel)
      .max(MAX_DEFAULT_LABELS)
      .refine(
        (labels) => new Set(labels.map((l) => labelNameKey(l.name))).size === labels.length,
        "Label names must be unique, ignoring case.",
      ),
  }),
  output: z.object({ labels: z.array(DefaultLabel) }),
  permission: "members:write",
  principals: ["user"],
  rateLimit: "write",
  idempotency: "key",
  mcp: {
    tool: "set_default_labels",
    title: "Set an organization's default labels",
    description: "Replace the labels an organization's new repositories get (owners).",
    readOnly: false,
  },
});
