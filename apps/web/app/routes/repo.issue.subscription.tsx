import { Link, redirect, useActionData, useNavigation } from "react-router";
import { PreferenceForm } from "../components/preference-form.js";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  bodyOf,
  readForm,
  signedInUser,
  signInUrl,
} from "../lib/api.server.js";
import { type Issue, issueApiPath, issuePage } from "../lib/issues.js";
import { pullNumber, pullPage } from "../lib/pulls.js";
import { OTHER_VIEWER, sameViewer } from "../lib/viewer.server.js";
import type { Route } from "./+types/repo.issue.subscription";

/*
 * How the signed-in person hears of one issue or pull request: as a
 * participant (the default), subscribed (all of its activity), or
 * unsubscribed (nothing but what asks something of them: review requests,
 * mentions, assignments).
 */

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [
    { title: `Notifications for #${params.number} · ${params.owner}/${params.repo} · Fyrden` },
  ];
}

const LEVELS = [
  {
    value: "default",
    label: "Participating",
    hint: "Notified as someone taking part: when you are asked, mentioned, or have commented.",
  },
  {
    value: "subscribed",
    label: "Subscribed",
    hint: "Notified of all its activity.",
  },
  {
    value: "unsubscribed",
    label: "Unsubscribed",
    hint: "Notified only of review requests, mentions and assignments.",
  },
] as const;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const number = pullNumber(params.number);
  const path = issueApiPath(params.owner, params.repo, number);
  const [viewer, subject, subscription] = await Promise.all([
    signedInUser(context, request),
    apiGet<Issue & { pull_request?: unknown }>(context, request, path),
    apiCall<{ subscribed: boolean; ignored: boolean; code?: string; detail?: string }>(
      context,
      request,
      "GET",
      `${path}/subscription`,
    ),
  ]);
  if (!viewer) throw redirect(signInUrl(request));
  // None set: participating. Any other refusal (the subject gone or hidden since) is the page's.
  const level =
    subscription.status === 404 && subscription.body?.code === "subscription_not_found"
      ? "default"
      : bodyOf(subscription, request).ignored
        ? "unsubscribed"
        : subscription.body.subscribed
          ? "subscribed"
          : "default";
  const back = subject.pull_request
    ? pullPage(params.owner, params.repo, number)
    : issuePage(params.owner, params.repo, number);
  return { number, title: subject.title, back, level, viewer: viewer.id, subjectId: subject.id };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  if (form.get("intent") !== "set") return { error: "That is not something this page does." };
  if (!(await sameViewer(context, request, form))) return { error: OTHER_VIEWER };
  const level = String(form.get("level") ?? "");
  const path = `${issueApiPath(params.owner, params.repo, pullNumber(params.number))}/subscription`;
  type Answer = { status: number; body: { detail?: string } | null };
  const answer = (
    level === "subscribed"
      ? await apiCall(context, request, "PUT", path, { subscribed: true })
      : level === "unsubscribed"
        ? await apiCall(context, request, "PUT", path, { ignored: true })
        : level === "default"
          ? await apiCall(context, request, "DELETE", path)
          : { status: 400, body: { detail: "Choose a level." } }
  ) as Answer;
  if (answer.status >= 200 && answer.status < 300) return { done: "Saved." };
  return { error: answer.body?.detail ?? "It was not saved." };
}

export default function ThreadSubscription({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { number, title, back, level, viewer, subjectId } = loaderData;
  return (
    <main>
      <h1>
        Notifications for <Link to={back}>{title}</Link> #{number}
      </h1>
      {result && "done" in result && <p role="status">{result.done}</p>}
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <p className="muted">
        A subscription takes effect once this deployment tells subscribers of activity (an
        operator's switch); until then your choice is saved.
      </p>
      <PreferenceForm
        key={`${subjectId}:${viewer}`}
        viewer={viewer}
        legend="How you hear of this thread"
        name="level"
        levels={LEVELS}
        current={level}
        busy={busy}
      />
    </main>
  );
}
