// A route's loader or action run with fyrden-api faked behind the service
// binding: each call it makes is recorded, and `answer` replies to it.

import { RouterContextProvider } from "react-router";
import { cloudflareContext } from "../../app/lib/cloudflare.server.js";

export const ORIGIN = "https://fyrden.test";

export function fakeApi(answer: (request: Request) => Response | Promise<Response>): {
  context: RouterContextProvider;
  calls: Request[];
} {
  const calls: Request[] = [];
  const context = new RouterContextProvider();
  const API = {
    fetch: async (request: Request) => {
      calls.push(request.clone() as unknown as Request);
      return answer(request);
    },
  };
  context.set(cloudflareContext, {
    env: { API } as unknown as Env,
    ctx: {} as ExecutionContext,
  });
  return { context, calls };
}

/** A JSON reply. */
export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A same-origin form post to `path` with a session cookie. */
export function formPost(path: string, fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: "fyrden_session=s" },
    body: new URLSearchParams(fields),
  });
}
