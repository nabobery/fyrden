import { data, redirect } from "react-router";
import { assertSameOrigin, readForm } from "../lib/api.server.js";
import { safeReturnPath, themeCookie, themeModeOf } from "../lib/theme.js";
import type { Route } from "./+types/appearance";

/**
 * `POST /appearance`: keeps the colour scheme picked in the site header, for
 * anyone, signed in or not, and returns to the page. A native form, so the whole
 * page draws again in it, with or without JavaScript.
 */
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  const mode = themeModeOf(form.get("mode"));
  if (!mode) throw data("Pick System, Light or Dark.", { status: 400 });
  const target = form.get("return");
  const location = safeReturnPath(
    typeof target === "string" ? target : "/",
    new URL(request.url).origin,
  );
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Set-Cookie": themeCookie(mode) },
  });
}

export function loader() {
  return redirect("/");
}
