import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare.server.js";
import { tail } from "./tail.js";

const requestHandler = createRequestHandler(
  // The virtual module's inferred type marks `basename` optional, which
  // exactOptionalPropertyTypes rejects; it is a ServerBuild at runtime.
  () => import("virtual:react-router/server-build") as Promise<ServerBuild>,
  import.meta.env.MODE,
);

/** Paths fyrden-api answers: its REST and MCP surfaces, sign-in and OAuth, discovery, bootstrap. */
const API_PREFIXES = ["/api/", "/mcp", "/oauth/", "/auth/", "/.well-known/", "/v0/"];
/** git's smart HTTP and chunked upload paths under a repository. */
const GIT_PATH = /^\/[^/]+\/[^/]+\/(info\/refs$|git-upload-pack$|git-receive-pack$|uploads\/)/;

/**
 * Whether fyrden-api answers `path`: the web Worker serves those on its own
 * origin through the service binding, so browsers, git and MCP clients use
 * one origin (and the session cookie it sets).
 */
export function isApiPath(path: string): boolean {
  return (
    API_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p)) ||
    GIT_PATH.test(path)
  );
}

export default {
  fetch(request, env, ctx) {
    if (isApiPath(new URL(request.url).pathname))
      return (env.API as unknown as Fetcher).fetch(request);
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
  tail,
} satisfies ExportedHandler<Env>;
