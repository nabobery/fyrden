/** The pull request shapes the pages read (see @fyrden/api-contract for the full ones). */

import { data } from "react-router";

export interface PullSide {
  ref: string;
  sha: string;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  head_repo_id: string | null;
  mergeable: boolean | null;
  mergeable_state: "clean" | "dirty" | "draft" | "unknown";
  draft: boolean;
  maintainer_can_modify: boolean;
  title: string;
  body: string | null;
  user: { id: string };
  performed_via_agents: string[];
  head: PullSide;
  base: PullSide;
  head_ref_deleted: boolean;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  merged_at: number | null;
  merge_commit_sha: string | null;
  merged_by: { id: string } | null;
}

export interface IssueComment {
  id: number;
  user: { id: string };
  performed_via_agents: string[];
  body: string;
  created_at: number;
  updated_at: number;
}

export type ReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";

export interface Review {
  id: number;
  user: { id: string };
  performed_via_agents: string[];
  state: ReviewState;
  body: string | null;
  commit_id: string;
  submitted_at: number;
  dismissal: { by: string; message: string; at: number } | null;
}

/** What a page calls a pull request's state. */
export type PullStatus = "open" | "draft" | "closed" | "merged";

export function statusOf(pull: Pick<PullRequest, "state" | "merged" | "draft">): PullStatus {
  if (pull.merged) return "merged";
  if (pull.state === "closed") return "closed";
  return pull.draft ? "draft" : "open";
}

/** `/repos/{owner}/{repo}` for the API. */
export const repoApiPath = (owner: string, repo: string): string =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

/** `/repos/{owner}/{repo}/pulls/{number}` for the API. */
export const pullApiPath = (owner: string, repo: string, number: number | string): string =>
  `${repoApiPath(owner, repo)}/pulls/${encodeURIComponent(String(number))}`;

/** A pull request's page in the web app. */
export const pullPage = (owner: string, repo: string, number: number | string): string =>
  `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${encodeURIComponent(String(number))}`;

/** A route's pull request number: a positive integer, else the page is not found. */
export function pullNumber(param: string | undefined): number {
  const number = Number(param);
  if (!/^[1-9][0-9]{0,15}$/.test(param ?? "") || !Number.isSafeInteger(number))
    throw data("Not found", { status: 404 });
  return number;
}

/** A moment (Unix milliseconds) as the pages show it: UTC, to the minute. */
export function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Who a principal is to the viewer: "you", or its id (the API names principals by id only). */
export function who(id: string, viewer: string | null): string {
  return id === viewer ? "you" : id;
}

/** A problem's message from the API, or `fallback`. */
export function problemDetail(body: unknown, fallback: string): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail ? detail : fallback;
}

/** A problem's stable code from the API, if any. */
export function problemCode(body: unknown): string | undefined {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A form field as trimmed text ("" when absent). */
export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** A form field as written (a body keeps its leading spaces: Markdown reads them). */
export function rawField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}
