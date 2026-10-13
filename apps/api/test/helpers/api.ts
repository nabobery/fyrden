// The REST API as the tests call it: a request with a bearer token (and an
// idempotency key on writes), and its status with its JSON body.
import { exports } from "cloudflare:workers";
import { ORIGIN } from "./git-http.js";
import { principalWithToken } from "./principals.js";

export type Who = { principalId: string; token: string; handle: string };

export const handleOf = (id: string) => id.toLowerCase().replace("_", "-");

export function api(method: string, path: string, token: string, body?: unknown) {
  return exports.default.fetch(`${ORIGIN}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method !== "GET" && {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

export async function json<T = Record<string, unknown>>(res: Response | Promise<Response>) {
  const r = await res;
  return { status: r.status, body: await r.json<T>() };
}

/** A new user with a personal access token; an instance administrator with `admin`. */
export async function user(admin = false): Promise<Who> {
  const p = await principalWithToken("user", "pat", { admin });
  return { ...p, handle: handleOf(p.principalId) };
}
