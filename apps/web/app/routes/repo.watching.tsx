import { redirect, useActionData, useNavigation } from "react-router";
import { PreferenceForm } from "../components/preference-form.js";
import { RepoHeader } from "../components/repo-header.js";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  bodyOf,
  readForm,
  signedInUser,
  signInUrl,
} from "../lib/api.server.js";
import { repoApiPath } from "../lib/pulls.js";
import type { Repo } from "../lib/types.js";
import { OTHER_VIEWER, sameViewer } from "../lib/viewer.server.js";
import type { Route } from "./+types/repo.watching";

/*
 * How the signed-in person hears of a repository: participating (only what
 * they take part in, the default), watching (every conversation), or
 * ignoring (nothing). Its own page, so other repository pages make no call
 * for it.
 */

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Watching · ${params.owner}/${params.repo} · Fyrden` }];
}

const LEVELS = [
  {
    value: "participating",
    label: "Participating",
    hint: "Notified of what you take part in, are mentioned in, or asked to act on.",
  },
  {
    value: "watching",
    label: "Watching",
    hint: "Notified of activity in every issue and pull request.",
  },
  {
    value: "ignoring",
    label: "Ignoring",
    hint: "Never notified of this repository, even when mentioned.",
  },
] as const;

type Level = (typeof LEVELS)[number]["value"];

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const base = repoApiPath(params.owner, params.repo);
  const [viewer, repo, subscription] = await Promise.all([
    signedInUser(context, request),
    apiGet<Repo>(context, request, base),
    apiCall<{ subscribed: boolean; ignored: boolean; detail?: string }>(
      context,
      request,
      "GET",
      `${base}/subscription`,
    ),
  ]);
  // None set: participating (GitHub's 404).
  const level: Level =
    subscription.status === 404
      ? "participating"
      : bodyOf(subscription, request).ignored
        ? "ignoring"
        : subscription.body.subscribed
          ? "watching"
          : "participating";
  if (!viewer) throw redirect(signInUrl(request));
  return { repo, level, origin: new URL(request.url).origin, viewer: viewer.id };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const form = await readForm(request);
  if (form.get("intent") !== "set") return { error: "That is not something this page does." };
  if (!(await sameViewer(context, request, form))) return { error: OTHER_VIEWER };
  const level = String(form.get("level") ?? "");
  const path = `${repoApiPath(params.owner, params.repo)}/subscription`;
  type Answer = { status: number; body: { detail?: string } | null };
  const answer = (
    level === "watching"
      ? await apiCall(context, request, "PUT", path, { subscribed: true })
      : level === "ignoring"
        ? await apiCall(context, request, "PUT", path, { ignored: true })
        : level === "participating"
          ? await apiCall(context, request, "DELETE", path)
          : { status: 400, body: { detail: "Choose a level." } }
  ) as Answer;
  if (answer.status >= 200 && answer.status < 300) return { done: "Saved." };
  return { error: answer.body?.detail ?? "It was not saved." };
}

export default function Watching({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { repo, level, origin, viewer } = loaderData;
  return (
    <main>
      <RepoHeader repo={repo} origin={origin} active="watching" />
      <h2>Notifications</h2>
      {result && "done" in result && <p role="status">{result.done}</p>}
      {result && "error" in result && (
        <p className="error" role="alert">
          {result.error}
        </p>
      )}
      <p className="muted">
        Watching takes effect once this deployment tells watchers of activity (an operator's
        switch); until then your choice is saved.
      </p>
      <PreferenceForm
        key={`${repo.id}:${viewer}`}
        viewer={viewer}
        legend="How you hear of this repository"
        name="level"
        levels={LEVELS}
        current={level}
        busy={busy}
      />
    </main>
  );
}
