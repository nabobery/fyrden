import { redirect } from "react-router";
import { assertSameOrigin } from "../lib/api.server.js";
import { cloudflareContext } from "../lib/cloudflare.server.js";
import type { Route } from "./+types/sign-out";

/** `POST /sign-out`: ends the session and clears its cookie. */
export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const origin = new URL(request.url).origin;
  const res = await (context.get(cloudflareContext).env.API as unknown as Fetcher).fetch(
    new Request(`${origin}/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: request.headers.get("Cookie") ?? "",
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  const headers = new Headers({ Location: "/" });
  const cleared = res.headers.get("Set-Cookie");
  if (cleared) headers.set("Set-Cookie", cleared);
  return new Response(null, { status: 303, headers });
}

export function loader() {
  return redirect("/");
}
