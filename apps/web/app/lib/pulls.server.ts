import type { RouterContextProvider } from "react-router";
import { apiCall, apiGet, signedInUser } from "./api.server.js";
import { type PullRequest, problemDetail, pullApiPath, pullNumber } from "./pulls.js";

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
): Promise<{ number: number; pull: PullRequest; viewer: string | null }> {
  const number = pullNumber(params.number);
  const [pull, user] = await Promise.all([
    apiGet<PullRequest>(context, request, pullApiPath(params.owner, params.repo, number)),
    signedInUser(context, request),
  ]);
  return { number, pull, viewer: user?.id ?? null };
}

/** An action's answer: what was done, or why not. */
export type ActionResult = { ok: string; error?: undefined } | { error: string; ok?: undefined };

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
