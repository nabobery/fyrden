import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";
import { cloudflareContext } from "../app/lib/cloudflare.server.js";
import { tail } from "./tail.js";

const requestHandler = createRequestHandler(
  // The virtual module's inferred type marks `basename` optional, which
  // exactOptionalPropertyTypes rejects; it is a ServerBuild at runtime.
  () => import("virtual:react-router/server-build") as Promise<ServerBuild>,
  import.meta.env.MODE,
);

export default {
  fetch(request, env, ctx) {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx });
    return requestHandler(request, context);
  },
  tail,
} satisfies ExportedHandler<Env>;
