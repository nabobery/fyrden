import { Form, redirect, useActionData } from "react-router";
import { apiCall, assertSameOrigin, readForm, signedInUser, signInUrl } from "../lib/api.server.js";
import type { Route } from "./+types/settings.emails.confirm";

/*
 * The page a confirmation email links to. Opening it changes nothing (mail
 * scanners and previews open links): it asks the signed-in user to confirm,
 * and only that form's post, from this origin, confirms the address. A
 * signed-out visitor signs in first and comes back here, the link unspent.
 */

export function meta(): Route.MetaDescriptors {
  return [{ title: "Confirm your email address · Fyrden" }];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = await signedInUser(context, request);
  if (!user) throw redirect(signInUrl(request));
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return { token, handle: user.handle };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  const confirmed = await apiCall<{ email?: string; code?: string; detail?: string }>(
    context,
    request,
    "POST",
    "/user/emails/confirm",
    { token: String(form.get("token") ?? "") },
  );
  if (confirmed.status === 200) return { confirmed: confirmed.body.email ?? "" };
  if (confirmed.status === 409)
    return { error: "Another account has confirmed this address. This link is used up." };
  if (confirmed.status === 404)
    return {
      error:
        "This link does not work now: it was used, it is more than a day old, its address was removed, or it is another account's. Ask for a new one from your email settings.",
    };
  return { error: confirmed.body.detail ?? "The address was not confirmed. Try again." };
}

export default function ConfirmEmail({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const { token, handle } = loaderData;
  if (result && "confirmed" in result)
    return (
      <main>
        <h1>Address confirmed</h1>
        <p role="status">
          {result.confirmed} is confirmed for {handle}.
        </p>
      </main>
    );
  return (
    <main>
      <h1>Confirm your email address</h1>
      <p>
        Confirm the address this link was sent to for your account, <strong>{handle}</strong>.
      </p>
      <Form method="post">
        <input type="hidden" name="token" value={token} />
        <button className="primary" type="submit">
          Confirm this address
        </button>
      </Form>
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
    </main>
  );
}
