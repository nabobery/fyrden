import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare.server.js";
import { tail } from "./tail.js";

const requestHandler = createRequestHandler(
  // The virtual module's inferred type marks `basename` optional, which
  // exactOptionalPropertyTypes rejects; it is a ServerBuild at runtime.
  () => import("virtual:react-router/server-build") as Promise<ServerBuild>,
  import.meta.env.MODE,
);

/**
 * Paths fyrden-api answers: its REST and MCP surfaces, sign-in and OAuth,
 * discovery, bootstrap. Each is a whole first segment, which no handle may
 * take (see `isReservedHandle`).
 */
export const API_PREFIXES = ["/api/", "/mcp/", "/oauth/", "/auth/", "/.well-known/", "/v0/"];
/** Single paths fyrden-api answers: unsubscribe links, which mail clients post to. */
export const API_PATHS = ["/unsubscribe"];
/** git's smart HTTP and chunked upload paths under a repository. */
const GIT_PATH = /^\/[^/]+\/[^/]+\/(info\/refs$|git-upload-pack$|git-receive-pack$|uploads\/)/;

/**
 * Whether fyrden-api answers `path`: the web Worker serves those on its own
 * origin through the service binding, so browsers, git and MCP clients use
 * one origin (and the session cookie it sets).
 */
export function isApiPath(path: string): boolean {
  return (
    API_PATHS.includes(path) ||
    API_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p)) ||
    GIT_PATH.test(path)
  );
}

const RELEASE_DOWNLOAD = /^\/[^/]+\/[^/]+\/releases\/download\/./i;

/** Whether React Router would take `path` for a release's download: it ignores case and decodes. */
function isReleaseDownload(path: string): boolean {
  try {
    // decodeURI leaves an encoded slash encoded, so a segment stays one segment.
    return RELEASE_DOWNLOAD.test(decodeURI(path));
  } catch {
    // A bad escape: React Router then matches the path as it stands.
    return RELEASE_DOWNLOAD.test(path);
  }
}

/**
 * Where a browser opening `url` must go instead: React Router takes any
 * path ending in `.data` for its own data request (it strips the suffix),
 * so a page whose last segment ends so (a file `notes.data`, a repository
 * `demo.data`) is opened with a trailing slash, which the pages ignore.
 * Its own data requests are fetches, never navigations. A release's download
 * is moved whatever asks for it, HEAD too: it is a resource with no page, so
 * no data request targets it, and a client's fetch must not get a data
 * response's 200 in place of the file.
 */
export function dataSuffixRedirect(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (!url.pathname.endsWith(".data")) return undefined;
  const moved = isReleaseDownload(url.pathname)
    ? request.method === "GET" || request.method === "HEAD"
    : request.method === "GET" && request.headers.get("Sec-Fetch-Mode") === "navigate";
  if (!moved) return undefined;
  url.pathname = `${url.pathname}/`;
  return Response.redirect(url.toString(), 308);
}

export default {
  fetch(request, env, ctx) {
    if (isApiPath(new URL(request.url).pathname))
      return (env.API as unknown as Fetcher).fetch(request);
    const moved = dataSuffixRedirect(request);
    if (moved) return moved;
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
  tail,
} satisfies ExportedHandler<Env>;
