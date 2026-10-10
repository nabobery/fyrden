import type { ApiRpcContract } from "@fyrden/api-contract";
import { createContext, type RouterContextProvider } from "react-router";

export interface CloudflareContext {
  env: Env;
  ctx: ExecutionContext;
}

export const cloudflareContext = createContext<CloudflareContext>();

/**
 * Typed client for fyrden-api over the service binding. The binding is typed
 * from this Worker's config only, so the shared contract supplies the methods.
 */
export function api(context: Readonly<RouterContextProvider>): ApiRpcContract {
  return context.get(cloudflareContext).env.API as unknown as ApiRpcContract;
}
