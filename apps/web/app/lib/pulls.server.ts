import type { RouterContextProvider } from "react-router";
import { apiCall, apiGet, checkSession } from "./api.server.js";
import {
  field,
  type PullRequest,
  problemCode,
  problemDetail,
  pullApiPath,
  pullNumber,
  rawField,
} from "./pulls.js";

export interface PullParams {
  owner: string;
  repo: string;
  number: string;
}

/** A pull request page's pull request and who is viewing it. */
export async function loadPull(
  context: Readonly<RouterContextProvider>,
  request: Request,
  params: PullParams,
): Promise<{
  number: number;
  pull: PullRequest;
  viewer: string | null;
  /** Whether the session could be checked: when not, `viewer` is null but nothing is known. */
  viewerKnown: boolean;
}> {
  const number = pullNumber(params.number);
  const [pull, session] = await Promise.all([
    apiGet<PullRequest>(context, request, pullApiPath(params.owner, params.repo, number)),
    checkSession(context, request),
  ]);
  return {
    number,
    pull,
    viewer: session.state === "signed-in" ? session.user.id : null,
    viewerKnown: session.state !== "unknown",
  };
}

/** An action's answer: what was done, or why not. */
export type ActionResult =
  | {
      ok: string;
      error?: undefined;
      /** The version an edit's save made. */
      version?: number | undefined;
    }
  | {
      error: string;
      ok?: undefined;
      /** An edit's text that was not saved, and the version it was written from. */
      kept?: { title: string; body: string; version: number | undefined; viewer: string };
    };

/**
 * Sends a change to a pull request and answers `ok` (naming `intent`) when
 * the API took it, else the API's reason.
 */
export async function send(
  context: Readonly<RouterContextProvider>,
  request: Request,
  method: string,
  path: string,
  body: unknown,
  intent: string,
  fallback: string,
): Promise<ActionResult> {
  const result = await apiCall<unknown>(context, request, method, path, body);
  if (result.status >= 200 && result.status < 300) return { ok: intent };
  return { error: problemDetail(result.body, fallback) };
}

/** `pullApiPath` for a page's params (its number checked). */
export const pullApiOf = (params: PullParams): string =>
  pullApiPath(params.owner, params.repo, pullNumber(params.number));

const REVIEW_EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);

/** Submits a review form: the event, the head reviewed, and a body (needed unless approving). */
export async function submitReview(
  context: Readonly<RouterContextProvider>,
  request: Request,
  api: string,
  form: FormData,
): Promise<ActionResult> {
  const event = field(form, "event");
  const body = rawField(form, "body");
  if (!REVIEW_EVENTS.has(event)) return { error: "Choose comment, approve or request changes." };
  if (event !== "APPROVE" && !body.trim())
    return { error: "A comment or a request for changes needs a review comment." };
  return send(
    context,
    request,
    "POST",
    `${api}/reviews`,
    { commit_id: field(form, "commit_id"), event, ...(body.trim() && { body }) },
    "review",
    "The review was not submitted.",
  );
}

/** A merge's answer: done, still rebasing in the background, or refused (with the reason). */
export type MergeResult = ActionResult | { pending: true; ok?: undefined; error?: undefined };

/** Merges with the form's method, at the head it showed; a long rebase answers `pending`. */
export async function mergePull(
  context: Readonly<RouterContextProvider>,
  request: Request,
  api: string,
  form: FormData,
): Promise<MergeResult> {
  const method = field(form, "merge_method");
  if (!["merge", "squash", "rebase"].includes(method)) return { error: "Choose a merge method." };
  const title = field(form, "commit_title");
  const message = rawField(form, "commit_message");
  const sha = field(form, "sha");
  const result = await apiCall<unknown>(context, request, "PUT", `${api}/merge`, {
    merge_method: method,
    ...(/^[0-9a-f]{40}$/.test(sha) && { sha }),
    ...(method !== "rebase" && title && { commit_title: title }),
    ...(method !== "rebase" && message.trim() && { commit_message: message }),
  });
  if (result.status === 200) return { ok: "merge" };
  if (result.status === 409 && problemCode(result.body) === "merge_in_progress")
    return { pending: true };
  return { error: problemDetail(result.body, "The pull request was not merged.") };
}
