import {
  D1TokenStore,
  TokenCache,
  type TokenRecord,
  TouchLedger,
} from "@fyrden/adapters-cloudflare/auth";
import type { Metrics } from "@fyrden/adapters-cloudflare/obs";
import { createIdFactory, secureRandomBytes } from "@fyrden/domain";

// Shared per isolate: read paths reuse verified tokens for up to 30 s, and
// last-used writes are scheduled at most once per token per interval.
const tokenCache = new TokenCache<TokenRecord>(() => Date.now());
const touchLedger = new TouchLedger();

export const clock = () => Date.now();
export const newId = createIdFactory(clock, secureRandomBytes);

export function tokenStore(
  env: Env,
  options: { defer?: (p: Promise<unknown>) => void; metrics?: Metrics } = {},
): D1TokenStore {
  return new D1TokenStore(env.DIRECTORY, {
    clock,
    newId,
    randomBytes: secureRandomBytes,
    cache: tokenCache,
    ledger: touchLedger,
    ...options,
  });
}
