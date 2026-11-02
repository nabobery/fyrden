import { countedD1 } from "@fyrden/adapters-cloudflare/obs";

/**
 * `env` with its D1 bindings counted: every statement a Worker request runs
 * (and the rows D1 reports) counted against its invocation, as the objects'
 * are.
 */
export function countedEnv(env: Env): Env {
  return { ...env, DIRECTORY: countedD1(env.DIRECTORY), ORG_READ: countedD1(env.ORG_READ) };
}
