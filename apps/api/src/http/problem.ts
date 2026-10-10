import { makeProblem, type Problem } from "@fyrden/api-contract";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Sends a problem document as-is (RFC 9457). */
export function problemResponse(
  c: Context,
  body: Problem,
  headers: Record<string, string> = {},
): Response {
  return c.json(body, body.status as ContentfulStatusCode, {
    "Content-Type": "application/problem+json",
    ...headers,
  });
}

/** Builds and sends a problem document carrying the request id. */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  detail: string,
  headers: Record<string, string> = {},
): Response {
  const requestId = c.get("requestId") as string | undefined;
  return problemResponse(c, makeProblem({ status, code, detail, requestId }), headers);
}
