import type { listRequestedReviewers, Output } from "@fyrden/api-contract";
import { useRef } from "react";
import { Form, useActionData, useNavigation } from "react-router";
import { PullHeader } from "../components/pull-header.js";
import { apiGet, assertSameOrigin, checkSession, readForm } from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope } from "../lib/edits.js";
import { editSender } from "../lib/edits.server.js";
import { field, type PullRequest, pullApiPath, pullNumber, repoApiPath } from "../lib/pulls.js";
import { reviewRequest } from "../lib/reviewers.server.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.pull.reviewers";

type Requested = Output<typeof listRequestedReviewers>;

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Reviewers of #${params.number} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const number = pullNumber(params.number);
  const api = pullApiPath(params.owner, params.repo, number);
  const [pull, requested, repo, session] = await Promise.all([
    apiGet<PullRequest>(context, request, api),
    apiGet<Requested>(context, request, `${api}/requested_reviewers`),
    apiGet<Repo>(context, request, repoApiPath(params.owner, params.repo)),
    checkSession(context, request),
  ]);
  return {
    at: { owner: params.owner, repo: params.repo, number },
    pull,
    requested,
    triage: repo.permissions?.triage === true,
    // Only an organization's repository takes team reviewers (not known from an earlier API: offered),
    // its current owner's: an old name of a transferred repository resolves to it.
    teamsOf: repo.owner_type === "User" ? null : repo.owner,
    viewer: session.state === "signed-in" ? session.user.id : null,
    viewerKnown: session.state !== "unknown",
  };
}

/** A reviewers page's answer is about its viewer and pull request. */
type ReviewersScope = Scope & { owner: string; repo: string; number: number; page: "reviewers" };

/** A principal or team id as the API names one (it checks it is one). */
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<ReviewersScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, 16 * 1024);
  const number = pullNumber(params.number);
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): ReviewersScope => ({
      viewer,
      owner: params.owner,
      repo: params.repo,
      number,
      page: "reviewers",
    }),
    () => undefined,
  );
  if (sender.refused) return sender.refused;
  const { scope, send } = sender;
  const path = `${pullApiPath(params.owner, params.repo, number)}/requested_reviewers`;
  const intent = field(form, "intent");
  switch (intent) {
    case "request": {
      // Teams are named as the owner the form showed; the API asks them only while it is still
      // the repository's (a transfer since: refused, never another account's teams). Through a
      // path of their own: an API that predates the check answers 404, never asks unchecked.
      const teamsOf = field(form, "teams_of");
      const asked = reviewRequest(form, teamsOf);
      if ("refused" in asked) return { error: asked.refused, scope };
      if (asked.team_reviewers.length > 0 && !teamsOf)
        return { error: "This repository takes no team reviewers.", scope };
      return asked.team_reviewers.length > 0
        ? send(
            "POST",
            `${path}/teams`,
            { ...asked, team_owner: teamsOf },
            intent,
            "No review was requested.",
          )
        : send("POST", path, asked, intent, "No review was requested.");
    }
    case "withdraw-user":
    case "withdraw-team": {
      const id = field(form, "id");
      if (!ID.test(id)) return { error: "No such request.", scope };
      // By id: a deleted user's handle names no one; two requests can carry one team slug.
      return send(
        "DELETE",
        path,
        intent === "withdraw-user" ? { reviewer_ids: [id] } : { team_ids: [id] },
        intent,
        "The request was not withdrawn.",
      );
    }
    default:
      return { error: "Unknown action.", scope };
  }
}

const DONE: Record<string, string> = {
  request: "Review requested.",
  "withdraw-user": "Request withdrawn.",
  "withdraw-team": "Request withdrawn.",
};

/** Who a pull request's review is asked of and has not reviewed yet: users, agents and teams. */
export default function Reviewers({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { at, pull, requested, triage, teamsOf } = loaderData;
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  const scope: ReviewersScope | undefined =
    viewer === null ? undefined : { viewer, ...at, page: "reviewers" };
  const own =
    result?.scope === undefined || (scope && sameScope(result.scope, scope)) ? result : undefined;
  // The author asks reviews of their own; on someone else's it takes triage (the API decides).
  const may = viewer !== null && pull.state === "open" && (pull.user.id === viewer || triage);
  const withdraw = (intent: string, id: string, label: string) => (
    <Form method="post" className="inline-form">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="viewer" value={viewer ?? ""} />
      <button type="submit" disabled={busy}>
        {label}
      </button>
    </Form>
  );
  return (
    <main key={`${at.owner}/${at.repo}#${at.number}:${viewer ?? "anonymous"}`}>
      <PullHeader owner={at.owner} repo={at.repo} pull={pull} viewer={viewer} active="reviewers" />
      <section className="panel" aria-labelledby="requested">
        <h2 id="requested">Requested reviews</h2>
        <p className="muted">
          Who is asked and has not reviewed yet; a review ends its request. Reviews given are in the
          conversation.
        </p>
        {requested.users.length === 0 && requested.teams.length === 0 ? (
          <p className="muted">No review is requested.</p>
        ) : (
          <ul className="label-list" aria-label="Requested reviewers">
            {requested.users.map((user) => (
              <li key={`u${user.id}`} className="row">
                <span>{user.login}</span>
                {may && withdraw("withdraw-user", user.id, `Withdraw ${user.login}'s request`)}
              </li>
            ))}
            {requested.teams.map((team) => (
              <li key={`t${team.id}`} className="row">
                <span>
                  {team.name} <span className="muted">(team {team.slug})</span>
                </span>
                {may && withdraw("withdraw-team", team.id, `Withdraw ${team.slug}'s request`)}
              </li>
            ))}
          </ul>
        )}
      </section>
      {may && (
        <section className="panel" aria-labelledby="request-review">
          <h2 id="request-review">Request a review</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="request" />
            <input type="hidden" name="viewer" value={viewer ?? ""} />
            <label htmlFor="reviewers">Users or agents (handles, separated by commas)</label>
            <input id="reviewers" name="reviewers" size={40} maxLength={1024} />
            {teamsOf !== null && (
              <>
                <input type="hidden" name="teams_of" value={teamsOf} />
                <label htmlFor="teams">{`Teams of ${teamsOf} (slugs, separated by commas)`}</label>
                <input id="teams" name="teams" size={40} maxLength={2048} />
              </>
            )}
            <p>
              <button type="submit" className="primary" disabled={busy}>
                Request
              </button>
            </p>
          </Form>
        </section>
      )}
      {own?.error && (
        <p className="error" role="alert">
          {own.error}
        </p>
      )}
      {own?.ok && <p role="status">{DONE[own.ok] ?? "Done."}</p>}
    </main>
  );
}
