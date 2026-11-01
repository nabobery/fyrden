import { useRef } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import { Pager } from "../components/pager.js";
import {
  apiCallBounded,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope } from "../lib/edits.js";
import { editSender } from "../lib/edits.server.js";
import { type Issue, issueApiPath, issuePage } from "../lib/issues.js";
import { dateOf, type MilestonesPage } from "../lib/milestones.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { field, pullNumber, pullPage, repoApiPath } from "../lib/pulls.js";
import { META_DONE } from "../lib/subject-meta.js";
import { metaCall } from "../lib/subject-meta.server.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.issue.milestone";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Milestone of #${params.number} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const number = pullNumber(params.number);
  const base = repoApiPath(params.owner, params.repo);
  const [subject, repo, page, session] = await Promise.all([
    apiGet<Issue>(context, request, issueApiPath(params.owner, params.repo, number)),
    apiGet<Repo>(context, request, base),
    apiCallBounded<MilestonesPage>(
      context,
      request,
      `${base}/milestones?state=open&${pageQuery(url, "cursor", 30)}`,
    ),
    checkSession(context, request),
  ]);
  const listed = bodyOf(page, request);
  return {
    at: { owner: params.owner, repo: params.repo, number },
    subject,
    milestones: listed.milestones,
    pages: pageLinks(url, "cursor", listed.next_cursor),
    triage: repo.permissions?.triage === true,
    viewer: session.state === "signed-in" ? session.user.id : null,
    viewerKnown: session.state !== "unknown",
  };
}

/** A milestone picker's answer is about its viewer and issue. */
type PickerScope = Scope & { owner: string; repo: string; number: number; page: "milestone" };

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<PickerScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, 16 * 1024);
  const number = pullNumber(params.number);
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): PickerScope => ({
      viewer,
      owner: params.owner,
      repo: params.repo,
      number,
      page: "milestone",
    }),
    () => undefined,
  );
  if (sender.refused) return sender.refused;
  const { scope, send } = sender;
  const intent = field(form, "intent");
  if (intent !== "milestone-set" && intent !== "milestone-clear")
    return { error: "Unknown action.", scope };
  const call = metaCall(intent, form, issueApiPath(params.owner, params.repo, number));
  if ("refused" in call) return { error: call.refused, scope };
  return send(call.method, call.path, call.body, intent, "Nothing was changed.");
}

/** The milestone of an issue or pull request, chosen from the open ones a page at a time. */
export default function IssueMilestone({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { at, subject, milestones, pages, triage } = loaderData;
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  const scope: PickerScope | undefined =
    viewer === null ? undefined : { viewer, ...at, page: "milestone" };
  const own =
    result?.scope === undefined || (scope && sameScope(result.scope, scope)) ? result : undefined;
  const back = subject.pull_request
    ? pullPage(at.owner, at.repo, at.number)
    : issuePage(at.owner, at.repo, at.number);
  const may = viewer !== null && triage;
  const current = subject.milestone;
  const form = (intent: string, label: string, number?: number) => (
    <Form method="post" className="inline-form">
      <input type="hidden" name="intent" value={intent} />
      {number !== undefined && <input type="hidden" name="milestone" value={number} />}
      <input type="hidden" name="viewer" value={viewer ?? ""} />
      <button type="submit" disabled={busy}>
        {label}
      </button>
    </Form>
  );
  return (
    <main key={`${at.owner}/${at.repo}#${at.number}:${viewer ?? "anonymous"}`}>
      <p>
        <Link to={back}>
          {`Back to ${subject.pull_request ? "the pull request" : "the issue"}`}{" "}
          <span className="muted">#{at.number}</span>
        </Link>
      </p>
      <h1>
        Milestone of <span className="pull-title">{subject.title}</span>
      </h1>
      <p className="row">
        {current === null ? (
          <span className="muted">In no milestone.</span>
        ) : (
          <>
            <span>
              {`In ${current.title}`}
              {current.state === "closed" && <span className="muted"> (closed)</span>}
            </span>
            {may && form("milestone-clear", "Clear the milestone")}
          </>
        )}
      </p>
      {!may && <p className="muted">Choosing its milestone takes triage access.</p>}
      {milestones.length === 0 ? (
        <p className="muted">{pages.first ? "No more open milestones." : "No open milestones."}</p>
      ) : (
        <ul className="label-list" aria-label="Open milestones">
          {milestones.map((milestone) => (
            <li key={milestone.number} className="row">
              <span>{milestone.title}</span>
              <span className="muted">
                {milestone.due_on === null ? "No due date" : `Due ${dateOf(milestone.due_on)}`}
              </span>
              {current?.number === milestone.number ? (
                <span className="muted">(its milestone)</span>
              ) : (
                may && form("milestone-set", `Set ${milestone.title}`, milestone.number)
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager links={pages} label="Milestone" />
      {own?.error && (
        <p className="error" role="alert">
          {own.error}
        </p>
      )}
      {own?.ok && <p role="status">{META_DONE[own.ok as keyof typeof META_DONE] ?? "Done."}</p>}
    </main>
  );
}
