import type { WranglerRunner } from "./wrangler.ts";

export interface Account {
  id: string;
  name: string;
}

export class AccountError extends Error {
  override name = "AccountError";
}

// wrangler's answer when there is no login at all, as opposed to a login
// that may not list accounts.
const NOT_LOGGED_IN = /not authenticated|not logged in|wrangler login/i;

/**
 * The Cloudflare account to act on: `CLOUDFLARE_ACCOUNT_ID` when set,
 * otherwise the login's only account. With several accounts the operator
 * must choose; the CLI never guesses. Callers then pin every wrangler call to
 * the result (`pinAccount`), so wrangler's own per-directory account cache
 * cannot send one command to another account, or a stale cache (left by
 * logging in to a different account) break every command with an
 * unexplained authentication error.
 */
export async function resolveAccount(
  runner: WranglerRunner,
  envAccountId: string | undefined,
): Promise<Account> {
  const whoami = await runner.run(["whoami", "--json"]);
  // A scoped API token may be allowed to deploy but not to list accounts:
  // whoami then fails or lists none, and an explicit id is trusted.
  const trusted = (id: string): Account => ({ id, name: "(name not visible to this login)" });
  if (whoami.code !== 0) {
    if (envAccountId && !NOT_LOGGED_IN.test(whoami.stdout + whoami.stderr))
      return trusted(envAccountId);
    throw new AccountError("wrangler is not logged in: run `wrangler login`");
  }
  const { accounts = [] } = JSON.parse(whoami.stdout) as { accounts?: Account[] };

  if (envAccountId) {
    const account = accounts.find((a) => a.id === envAccountId);
    if (account) return account;
    if (accounts.length === 0) return trusted(envAccountId);
    throw new AccountError(
      `CLOUDFLARE_ACCOUNT_ID ${envAccountId} is not an account this login can reach`,
    );
  }
  const [only] = accounts;
  if (accounts.length === 1 && only) return only;
  throw new AccountError(
    accounts.length === 0
      ? "this login lists no accounts: set CLOUDFLARE_ACCOUNT_ID"
      : `this login can reach ${accounts.length} accounts (${accounts.map((a) => `${a.name} ${a.id}`).join(", ")}): set CLOUDFLARE_ACCOUNT_ID to choose one`,
  );
}

/**
 * wrangler prefers a config's `account_id` over `CLOUDFLARE_ACCOUNT_ID`, so a
 * committed one that names another account would defeat `pinAccount`.
 */
export function assertConfigAccount(
  file: string,
  config: Readonly<Record<string, unknown>>,
  accountId: string,
): void {
  if (config.account_id !== undefined && config.account_id !== accountId) {
    throw new AccountError(
      `${file} sets account_id ${String(config.account_id)}, but this deploy targets ${accountId}`,
    );
  }
}

/** A runner whose every wrangler call targets `accountId`, whatever directory it runs in. */
export function pinAccount(runner: WranglerRunner, accountId: string): WranglerRunner {
  return {
    run: (args, options = {}) =>
      runner.run(args, { ...options, env: { ...options.env, CLOUDFLARE_ACCOUNT_ID: accountId } }),
  };
}
