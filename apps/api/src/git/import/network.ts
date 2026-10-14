import {
  checkOutboundUrl,
  dohResolver,
  guardedFetch,
  type Resolver,
  type SsrfPolicy,
} from "@fyrden/adapters-cloudflare/net";
import { type ClientResponse, type HttpTransport, withoutTrailingSlashes } from "@fyrden/git-core";

/*
 * Every request an import makes goes through the shared outbound URL guard:
 * the source URL is checked when the import is requested, and again (name
 * resolved and checked, redirects refused) on every request the fetch makes.
 */

/** The two Workers' names, as in their wrangler.jsonc files. */
const WORKER_NAMES = ["fyrden-api", "fyrden-web"];

/**
 * The deployment's own hostnames, which an import must never fetch: a
 * request to them would loop back through the front door. They are the host
 * the request arrived on; on `workers.dev`, both Workers' hosts on the same
 * account subdomain; and any extra hosts in `FYRDEN_OWN_HOSTS` (comma
 * separated), such as custom domains routed to either Worker.
 */
export function ownHostsOf(env: object, requestHost: string): string[] {
  const hosts = new Set<string>([requestHost.toLowerCase()]);
  const workersDev = /^([a-z0-9-]+)\.([a-z0-9-]+\.workers\.dev)$/.exec(requestHost.toLowerCase());
  if (workersDev && WORKER_NAMES.includes(workersDev[1] as string)) {
    for (const name of WORKER_NAMES) hosts.add(`${name}.${workersDev[2]}`);
  }
  const raw = (env as { FYRDEN_OWN_HOSTS?: unknown }).FYRDEN_OWN_HOSTS;
  if (typeof raw === "string") {
    for (const h of raw.split(",")) if (h.trim() !== "") hosts.add(h.trim().toLowerCase());
  }
  return [...hosts];
}

export function importPolicy(ownHosts: readonly string[], resolve: Resolver): SsrfPolicy {
  return { ownHosts, resolve };
}

export type ImportUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The source URL, checked: https only, no credentials, query or fragment,
 * not private, internal or the deployment's own; a trailing slash removed.
 */
export async function checkImportUrl(raw: string, policy: SsrfPolicy): Promise<ImportUrlCheck> {
  const check = await checkOutboundUrl(raw, policy);
  if (!check.ok) return { ok: false, reason: check.reason };
  if (check.url.search !== "" || check.url.hash !== "") return { ok: false, reason: "query" };
  return { ok: true, url: withoutTrailingSlashes(check.url.href) };
}

/** How an import reaches the network; tests replace it. */
export interface ImportNetwork {
  /** Resolves names for the guard. */
  readonly resolve: Resolver;
  /** The client's transport for one import, every request guarded by `policy`. */
  transport(policy: SsrfPolicy, signal: AbortSignal): HttpTransport;
}

export const defaultImportNetwork = (): ImportNetwork => ({
  resolve: dohResolver(),
  transport: guardedTransport,
});

/** The fetch client's transport over `guardedFetch`. */
export function guardedTransport(policy: SsrfPolicy, signal: AbortSignal): HttpTransport {
  return async (request) => {
    const response = await guardedFetch(
      request.url,
      {
        method: request.method,
        headers: request.headers,
        ...(request.body ? { body: request.body } : {}),
        signal,
      },
      policy,
    );
    return clientResponse(response);
  };
}

/** A fetch `Response` as the client reads it. */
export function clientResponse(response: Response): ClientResponse {
  const stream = response.body;
  return {
    status: response.status,
    contentType: response.headers.get("Content-Type"),
    body: {
      async *[Symbol.asyncIterator]() {
        if (!stream) return;
        const reader = stream.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          reader.releaseLock();
        }
      },
    },
    cancel: async () => {
      await stream?.cancel().catch(() => {});
    },
  };
}
