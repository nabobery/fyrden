// React Router's default Workers entry (@react-router/dev
// config/defaults/entry.server.web.tsx), with every server error logged
// through the redacting logger instead of console.error.
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, HandleErrorFunction, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { logServerError } from "./lib/log-error.server.js";

export const streamTimeout = 5_000;

/**
 * The pages' Content Security Policy. Scripts: the app's own bundles and
 * React Router's inline scripts, which carry this response's nonce; nothing
 * else inline, so markup that got past the Markdown renderer cannot run.
 * Styles may be inline (Mermaid's diagrams carry theirs). Images come only
 * from this origin: a README's third-party image would tell its author who
 * viewed a private repository (Fyrden has no image proxy).
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

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
  // A new one for every response, never reused or derived from the request.
  const nonce = crypto.randomUUID().replaceAll("-", "");
  responseHeaders.set("Content-Type", "text/html");
  // No page is framed (clickjacking, even by a sibling site the session cookie reaches), and
  // pages carrying a person's data are not kept by shared caches. HEAD answers the same headers.
  responseHeaders.set("Content-Security-Policy", contentSecurityPolicy(nonce));
  responseHeaders.set("X-Frame-Options", "DENY");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  responseHeaders.set("Referrer-Policy", "same-origin");
  if (!responseHeaders.has("Cache-Control"))
    responseHeaders.set("Cache-Control", "private, no-store");

  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
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

  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
