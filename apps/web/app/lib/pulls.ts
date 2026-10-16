/**
 * Pull requests as the pages read them: the API's own shapes, from its
 * contract (types only: nothing of it is in the browser's bundle).
 */

import type {
  getPull,
  listComments,
  listPullFiles,
  listReviewComments,
  listReviews,
  Output,
} from "@fyrden/api-contract";
import { data } from "react-router";

export type PullRequest = Output<typeof getPull>;

/** A page of a pull request's conversation comments. */
export type IssueCommentsPage = Output<typeof listComments>;
export type IssueComment = IssueCommentsPage["comments"][number];

/** A page of a pull request's reviews. */
export type ReviewsPage = Output<typeof listReviews>;
export type Review = ReviewsPage["reviews"][number];
export type ReviewState = Review["state"];

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

/** A page of the comments on a pull request's diff. */
export type ReviewCommentsPage = Output<typeof listReviewComments>;
export type ReviewComment = ReviewCommentsPage["comments"][number];
export type DiffSide = ReviewComment["side"];

/** A page of the files a pull request changes. */
export type PullFilesPage = Output<typeof listPullFiles>;
export type PullFile = PullFilesPage["files"][number];
export type PatchOmitted = NonNullable<PullFile["patch_omitted"]>;

/** Why a file's changes are not shown, in words. */
export const OMITTED_REASON: Record<PatchOmitted, string> = {
  binary: "Binary file: its changes are not shown.",
  too_large: "This file is too large to compare here.",
  patch_too_large: "This file's changes are too large to show here.",
  submodule: "Submodule: its changes are not shown.",
  budget: "This file's changes could not be read on this page; open the next page or reload.",
};

/** One comment of a review thread, as the files page shows it. */
export interface ThreadComment {
  id: number;
  author: string;
  agents: string[];
  /** Its Markdown source (rendered in the browser). */
  body: string;
  at: number;
  /**
   * It is on the head's side at the current head of an open pull request:
   * a suggested change it holds (the browser reads its body) can be applied.
   */
  onHead: boolean;
}

/** A review thread on lines of a file, its comments oldest first. */
export interface Thread {
  id: number;
  /** The path its comments name: a renamed file's old path on the old side. */
  path: string;
  /** The listed file it belongs to (its current name). */
  file: string;
  side: DiffSide;
  /** The (last) line at the current head; null once the head has moved (outdated). */
  line: number | null;
  startLine: number | null;
  /** The line at the commit it was started on. */
  originalLine: number;
  commit: string;
  outdated: boolean;
  resolved: boolean;
  comments: ThreadComment[];
}

/**
 * Whether a page of patches compares what the listing compared: the same
 * head and the same merge base (the base branch can move to a commit the
 * head already has, changing the comparison with the head unchanged).
 */
export function sameComparison(
  patches: { head_sha: string; merge_base_sha: string },
  listed: { headSha: string; mergeBaseSha: string },
): boolean {
  return patches.head_sha === listed.headSha && patches.merge_base_sha === listed.mergeBaseSha;
}
