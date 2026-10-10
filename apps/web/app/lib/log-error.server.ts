import { createLogger, type Logger } from "@fyrden/adapters-cloudflare/obs";
import { isRouteErrorResponse } from "react-router";

/**
 * Logs a server-side loader, action or render error through the redacting
 * logger. React Router's default handler uses console.error, which would
 * write a token in a URL ("No route matches URL /…") or an error message
 * straight into the logs.
 */
/** A route error response can wrap the original error ("No route matches URL …"). */
function unwrap(error: unknown): unknown {
  if (isRouteErrorResponse(error)) {
    // `error` is private in React Router's types but set at runtime.
    const inner = (error as unknown as { error?: unknown }).error;
    if (inner !== undefined) return inner;
  }
  return error;
}

export function logServerError(
  error: unknown,
  request: Request | undefined,
  log: Logger = createLogger(),
): void {
  // An aborted request is the client going away, not a server error.
  if (request?.signal.aborted) return;
  log.error("web server error", {
    error: unwrap(error),
    ...(request && { method: request.method, path: new URL(request.url).pathname }),
  });
}
