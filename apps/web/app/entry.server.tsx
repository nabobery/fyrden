// React Router's default Workers entry (@react-router/dev
// config/defaults/entry.server.web.tsx), with every server error logged
// through the redacting logger instead of console.error.
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { logServerError } from "./lib/log-error.server.js";

export const streamTimeout = 5_000;

export const handleError: HandleErrorFunction = (error, { request }) => {
  logServerError(error, request);
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors in the initial shell reject and reach handleError; only
        // streaming errors after the shell are logged here.
        if (shellRendered) logServerError(error, request);
      },
    },
  );
  shellRendered = true;

  // Bots and SPA-mode renders wait for all content before responding.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  // No page is framed (clickjacking, even by a sibling site the session cookie reaches), and
  // pages carrying a person's data are not kept by shared caches.
  responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none'");
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "same-origin");
  if (!responseHeaders.has("Cache-Control"))
    responseHeaders.set("Cache-Control", "private, no-store");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
