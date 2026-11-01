/**
 * Issues as the pages read them: the API's own shapes, from its contract
 * (types only: nothing of it is in the browser's bundle).
 */

import type { getIssue, listIssues, Output } from "@fyrden/api-contract";
import { repoApiPath } from "./pulls.js";

export type Issue = Output<typeof getIssue>;
export type IssuesPage = Output<typeof listIssues>;

/** `/repos/{owner}/{repo}/issues/{number}` for the API. */
export const issueApiPath = (owner: string, repo: string, number: number | string): string =>
  `${repoApiPath(owner, repo)}/issues/${encodeURIComponent(String(number))}`;

/** An issue's page in the web app. */
export const issuePage = (owner: string, repo: string, number: number | string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`;

/**
 * Bytes of an issue form read at most: a title and a body of 65,536
 * characters each, URL-encoded (up to 9 bytes a character), and the rest.
 */
export const ISSUE_FORM_MAX_BYTES = 9 * 65_536 + 16 * 1024;

export const ISSUE_STATES = ["open", "closed", "all"] as const;
export type IssueStateFilter = (typeof ISSUE_STATES)[number];

/** The listing's filters a page's URL may name, passed to the API as they are. */
export const ISSUE_FILTERS = ["labels", "label_ids", "assignee", "milestone", "creator"] as const;

/** What the list shows: issues only (its default), or issues and pull requests (a milestone's). */
export type IssueKinds = "issues" | "all";

/** What the issue list's URL asks for: its state, kinds and filters (empty ones left out). */
export function listingOf(url: URL): {
  state: IssueStateFilter;
  kind: IssueKinds;
  filters: Partial<Record<(typeof ISSUE_FILTERS)[number], string>>;
} {
  const state = ISSUE_STATES.find((s) => s === url.searchParams.get("state")) ?? "open";
  const kind = url.searchParams.get("kind") === "all" ? "all" : "issues";
  const filters: Partial<Record<(typeof ISSUE_FILTERS)[number], string>> = {};
  for (const name of ISSUE_FILTERS) {
    const value = url.searchParams.get(name)?.trim();
    // The API checks each; a page only keeps them to a sane length.
    if (value && value.length <= 1_100) filters[name] = value;
  }
  return { state, kind, filters };
}

/** What an issue's state reads as (a pull request's, for one listed among issues). */
export function issueStatus(issue: Pick<Issue, "state" | "state_reason" | "pull_request">): {
  label: string;
  className: string;
} {
  if (issue.pull_request)
    return issue.pull_request.merged_at !== null
      ? { label: "Merged", className: "status-merged" }
      : issue.state === "open"
        ? { label: "Open", className: "status-open" }
        : { label: "Closed", className: "status-closed" };
  if (issue.state === "open") return { label: "Open", className: "status-open" };
  if (issue.state_reason === "not_planned")
    return { label: "Closed as not planned", className: "status-closed" };
  if (issue.state_reason === "duplicate")
    return { label: "Closed as duplicate", className: "status-closed" };
  return { label: "Closed", className: "status-merged" };
}
