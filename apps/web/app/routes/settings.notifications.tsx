import { Form, redirect, useActionData, useNavigation } from "react-router";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  readForm,
  signedInUser,
  signInUrl,
} from "../lib/api.server.js";
import type { Route } from "./+types/settings.notifications";

/*
 * Where notification email goes and what is sent: the account's addresses
 * (added, confirmed by the link mailed to each, removed, a new link asked
 * for) and the categories of notification email. A web session's only:
 * the API refuses any other credential. Every change is a form posting to
 * this page's action with an `intent`, and the page says what the API
 * answered.
 */

export function meta(): Route.MetaDescriptors {
  return [{ title: "Notifications · Fyrden" }];
}

interface Address {
  email: string;
  primary: boolean;
  verified: boolean;
  deliverable: boolean;
}

interface Settings {
  email: { direct: boolean; participating: boolean; watching: boolean };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  if (!(await signedInUser(context, request))) throw redirect(signInUrl(request));
  const [addresses, settings] = await Promise.all([
    apiGet<Address[]>(context, request, "/user/emails"),
    apiGet<Settings>(context, request, "/user/notification-settings"),
  ]);
  return { addresses, settings: settings.email };
}

type Answer = { status: number; body: { detail?: string; code?: string } | null };

/** What the page says of an answer that was not a success. */
const refused = (answer: Answer, fallback: string) => ({
  error: answer.body?.detail ?? fallback,
});

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  const intent = String(form.get("intent") ?? "");
  const email = String(form.get("email") ?? "").trim();
  switch (intent) {
    case "add": {
      if (!email) return { error: "Enter an email address." };
      const added = (await apiCall<Address[]>(context, request, "POST", "/user/emails", {
        emails: [email],
      })) as { status: number; body: (Address[] & { detail?: string }) | null };
      if (added.status === 201) {
        // Answered with the address as it stands: one confirmed already was only kept.
        if (added.body?.[0]?.verified) return { done: `${email} is yours and confirmed already.` };
        return {
          done: `${email} was added. A link to confirm it is on its way: follow it within a day. If none arrives, send a new one below.`,
        };
      }
      return refused(added as Answer, "The address was not added.");
    }
    case "remove": {
      const removed = (await apiCall(context, request, "DELETE", "/user/emails", {
        emails: [email],
      })) as Answer;
      if (removed.status === 204) return { done: `${email} was removed.` };
      return refused(removed, "The address was not removed.");
    }
    case "resend": {
      const sent = (await apiCall(context, request, "POST", "/user/emails/confirmation", {
        email,
      })) as Answer;
      if (sent.status === 204)
        return {
          done: `A new link to confirm ${email} is on its way; earlier ones no longer work. If none arrives, try again later.`,
        };
      return refused(sent, "No new link was sent.");
    }
    case "settings": {
      const on = (name: string) => form.get(name) === "on";
      const saved = (await apiCall(context, request, "PUT", "/user/notification-settings", {
        email: {
          direct: on("direct"),
          participating: on("participating"),
          watching: on("watching"),
        },
      })) as Answer;
      if (saved.status === 200) return { done: "Your notification email settings were saved." };
      return refused(saved, "The settings were not saved.");
    }
    default:
      return { error: "That is not something this page does." };
  }
}

const CATEGORIES = [
  {
    name: "direct",
    label: "What asks something of you",
    hint: "Review requests (yours or your team's), assignments, mentions, and your own issues and pull requests closed, reopened, merged or in conflict.",
  },
  {
    name: "participating",
    label: "Threads you take part in",
    hint: "Activity on issues and pull requests you opened, commented on or subscribed to.",
  },
  {
    name: "watching",
    label: "Repositories you watch",
    hint: "Saved, but not sent yet: Fyrden does not email watched activity so far.",
  },
] as const;

/** What an address's state is, in words. */
function stateOf(address: Address): string {
  if (!address.deliverable)
    return "Not deliverable: the email provider suppresses it (it bounced, or Fyrden's mail was marked as spam)";
  if (!address.verified) return "Unconfirmed: follow the link sent to it";
  return address.primary ? "Confirmed; notifications go here" : "Confirmed";
}

export default function Notifications({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const { addresses, settings } = loaderData;
  // One change at a time: a second click while one is sent would spend another link.
  const busy = useNavigation().state !== "idle";
  return (
    <main>
      <h1>Notifications</h1>
      {result && "done" in result && <p role="status">{result.done}</p>}
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <section className="panel" aria-labelledby="addresses">
        <h2 id="addresses">Email addresses</h2>
        {addresses.length === 0 ? (
          <p>No address yet: Fyrden emails you nothing.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Address</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {addresses.map((a) => (
                <tr key={a.email}>
                  <td>{a.email}</td>
                  <td>{stateOf(a)}</td>
                  <td>
                    <Form method="post">
                      <input type="hidden" name="email" value={a.email} />
                      {!a.verified && a.deliverable && (
                        <button type="submit" name="intent" value="resend" disabled={busy}>
                          Send a new link
                        </button>
                      )}{" "}
                      <button
                        className="danger"
                        type="submit"
                        name="intent"
                        value="remove"
                        disabled={busy}
                        aria-label={`Remove ${a.email}`}
                      >
                        Remove
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Form method="post">
          <label htmlFor="new-email">Add an address</label>
          <input id="new-email" name="email" type="email" autoComplete="email" maxLength={254} />
          <p>
            <button className="primary" type="submit" name="intent" value="add" disabled={busy}>
              Add address
            </button>
          </p>
        </Form>
      </section>
      <section className="panel" aria-labelledby="email-settings">
        <h2 id="email-settings">What Fyrden emails you</h2>
        <p className="muted">
          Sent to your first confirmed address that is deliverable. Every email also has a link to
          stop its kind for that address.
        </p>
        <Form method="post">
          <fieldset>
            <legend>Email me about</legend>
            {CATEGORIES.map((c) => (
              <div key={c.name}>
                <input
                  id={`category-${c.name}`}
                  type="checkbox"
                  name={c.name}
                  defaultChecked={settings[c.name]}
                  aria-describedby={`category-${c.name}-hint`}
                />{" "}
                <label
                  htmlFor={`category-${c.name}`}
                  style={{ display: "inline", fontWeight: "normal" }}
                >
                  {c.label}
                </label>
                <p id={`category-${c.name}-hint`} className="muted">
                  {c.hint}
                </p>
              </div>
            ))}
          </fieldset>
          <p>
            <button
              className="primary"
              type="submit"
              name="intent"
              value="settings"
              disabled={busy}
            >
              Save
            </button>
          </p>
        </Form>
      </section>
    </main>
  );
}
