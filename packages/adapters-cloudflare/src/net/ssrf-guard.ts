import { countSubrequests } from "../obs/invocation.js";
import { isPublicAddress, parseIPv4 } from "./ip.js";

/**
 * The one outbound URL policy for every server-side fetch of a user-supplied
 * URL: server-side import, webhooks, GitHub import, runner provider APIs and
 * CIMD fetches.
 *
 * DNS rebinding is mitigated, not prevented: the guard resolves the name and
 * checks every address, follows no redirects and denies private ranges, but a
 * Worker cannot pin the address `fetch` connects to, so a name that changes
 * between the check and the connection is not caught.
 */
export type Resolver = (hostname: string) => Promise<string[]>;

export interface SsrfPolicy {
  /**
   * The deployment's own hostnames (custom domains and the workers.dev name).
   * With global_fetch_strictly_public, a request to them loops back through
   * the front door and can invoke this Worker, so they and their subdomains
   * are denied.
   */
  ownHosts: readonly string[];
  resolve: Resolver;
  /** Plain http is allowed only where the feature needs it (webhooks). */
  allowHttp?: boolean;
}

export type SsrfDenial =
  | "invalid_url"
  | "scheme"
  | "credentials"
  | "own_host"
  | "internal_name"
  | "private_address"
  | "unresolvable";

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: SsrfDenial };

export class SsrfError extends Error {
  override name = "SsrfError";
  constructor(readonly reason: SsrfDenial | "redirect") {
    super(`outbound request refused: ${reason}`);
  }
}

const normaliseHost = (host: string) => host.toLowerCase().replace(/\.$/, "");

export async function checkOutboundUrl(raw: string, policy: SsrfPolicy): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) {
    return { ok: false, reason: "scheme" };
  }
  if (url.username || url.password) return { ok: false, reason: "credentials" };

  // WHATWG URL parsing already normalised numeric forms such as 0x7f000001.
  const host = normaliseHost(url.hostname);
  const literal = host.startsWith("[")
    ? host.slice(1, -1)
    : parseIPv4(host) !== undefined
      ? host
      : undefined;
  if (literal !== undefined) {
    return isPublicAddress(literal) ? { ok: true, url } : { ok: false, reason: "private_address" };
  }

  for (const own of policy.ownHosts.map(normaliseHost)) {
    if (host === own || host.endsWith(`.${own}`)) return { ok: false, reason: "own_host" };
  }
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "internal_name" };
  }

  let addresses: string[];
  try {
    addresses = await policy.resolve(host);
  } catch {
    return { ok: false, reason: "unresolvable" };
  }
  if (addresses.length === 0) return { ok: false, reason: "unresolvable" };
  if (!addresses.every(isPublicAddress)) return { ok: false, reason: "private_address" };
  return { ok: true, url };
}

/**
 * Checks the URL, then fetches it without following redirects. A 3xx response
 * is refused rather than followed, because its target was never checked.
 */
export async function guardedFetch(
  raw: string,
  init: RequestInit,
  policy: SsrfPolicy,
): Promise<Response> {
  const check = await checkOutboundUrl(raw, policy);
  if (!check.ok) throw new SsrfError(check.reason);
  countSubrequests("external");
  const response = await fetch(check.url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new SsrfError("redirect");
  }
  return response;
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

interface DohAnswer {
  type: number;
  data: string;
}

/**
 * Resolves A and AAAA records over DNS-over-HTTPS (JSON API); `signal`
 * bounds the lookups (a caller's deadline for the whole request).
 */
export function dohResolver(endpoint = DOH_ENDPOINT, signal?: AbortSignal): Resolver {
  const query = async (name: string, type: "A" | "AAAA") => {
    countSubrequests("external");
    const res = await fetch(`${endpoint}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      ...(signal && { signal }),
    });
    if (!res.ok) throw new Error(`DoH ${type} lookup failed: ${res.status}`);
    const body = await res.json<{ Status: number; Answer?: DohAnswer[] }>();
    const wanted = type === "A" ? 1 : 28;
    return (body.Answer ?? []).filter((a) => a.type === wanted).map((a) => a.data);
  };
  return async (hostname) =>
    (await Promise.all([query(hostname, "A"), query(hostname, "AAAA")])).flat();
}
