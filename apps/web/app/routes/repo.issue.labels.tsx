import { useRef } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import { LabelChip } from "../components/label-chip.js";
import { Pager } from "../components/pager.js";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope } from "../lib/edits.js";
import { editSender } from "../lib/edits.server.js";
import { type Issue, issueApiPath, issuePage } from "../lib/issues.js";
import { LABEL_FORM_MAX_BYTES, type LabelsPage } from "../lib/labels.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { field, pullNumber, pullPage, repoApiPath } from "../lib/pulls.js";
import { META_DONE } from "../lib/subject-meta.js";
import { metaCall } from "../lib/subject-meta.server.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.issue.labels";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Labels of #${params.number} · ${params.owner}/${params.repo} · Fyrden` }];
}

/** Characters of a name search at most (a label's name holds 50). */
const MAX_QUERY = 50;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const number = pullNumber(params.number);
  const base = repoApiPath(params.owner, params.repo);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY);
  const query = new URLSearchParams({ ...(q && { q }) });
  const [subject, repo, page, session] = await Promise.all([
    apiGet<Issue>(context, request, issueApiPath(params.owner, params.repo, number)),
    apiGet<Repo>(context, request, base),
    apiCall<LabelsPage>(
      context,
      request,
      "GET",
      `${base}/labels?${query}${q ? "&" : ""}${pageQuery(url, "cursor", 30)}`,
    ),
    checkSession(context, request),
  ]);
  const listed = bodyOf(page, request);
  return {
    at: { owner: params.owner, repo: params.repo, number },
    subject,
    q,
    labels: listed.labels,
    pages: pageLinks(url, "cursor", listed.next_cursor),
    triage: repo.permissions?.triage === true,
    viewer: session.state === "signed-in" ? session.user.id : null,
    viewerKnown: session.state !== "unknown",
  };
}

/** A labels picker's answer is about its viewer and issue. */
type PickerScope = Scope & { owner: string; repo: string; number: number; page: "labels" };

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<PickerScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, LABEL_FORM_MAX_BYTES);
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
      page: "labels",
    }),
    () => undefined,
  );
  if (sender.refused) return sender.refused;
  const { scope, send } = sender;
  const intent = field(form, "intent");
  if (intent !== "label-add" && intent !== "label-remove")
    return { error: "Unknown action.", scope };
  const call = metaCall(intent, form, issueApiPath(params.owner, params.repo, number));
  if ("refused" in call) return { error: call.refused, scope };
  return send(call.method, call.path, call.body, intent, "Nothing was changed.");
}

/** The labels an issue or pull request carries, to add and take off: by name, a page at a time. */
export default function IssueLabels({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const { at, subject, q, labels, pages, triage } = loaderData;
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  const scope: PickerScope | undefined =
    viewer === null ? undefined : { viewer, ...at, page: "labels" };
  const own =
    result?.scope === undefined || (scope && sameScope(result.scope, scope)) ? result : undefined;
  const back = subject.pull_request
    ? pullPage(at.owner, at.repo, at.number)
    : issuePage(at.owner, at.repo, at.number);
  const has = new Set(subject.labels.map((label) => label.id));
  return (
    <main key={`${at.owner}/${at.repo}#${at.number}:${viewer ?? "anonymous"}`}>
      <p>
        <Link to={back}>
          {`Back to ${subject.pull_request ? "the pull request" : "the issue"}`}{" "}
          <span className="muted">#{at.number}</span>
        </Link>
      </p>
      <h1>
        Labels of <span className="pull-title">{subject.title}</span>
      </h1>
      <Form method="get" className="row" role="search">
        <label htmlFor="label-search" className="inline">
          Labels named
        </label>
        <input id="label-search" name="q" defaultValue={q} maxLength={MAX_QUERY} />
        <button type="submit">Search</button>
      </Form>
      {!(viewer !== null && triage) && (
        <p className="muted">Changing its labels takes triage access.</p>
      )}
      {labels.length === 0 ? (
        <p className="muted">
          {q ? "No label's name starts so." : "The repository has no labels."}
        </p>
      ) : (
        <ul className="label-list" aria-label="Labels">
          {labels.map((label) => {
            const on = has.has(label.id);
            return (
              <li key={label.id} className="row">
                <LabelChip label={label} />
                {label.description && <span className="muted">{label.description}</span>}
                {on && <span className="muted">(on it)</span>}
                {viewer !== null && triage && (
                  <Form method="post" className="inline-form">
                    <input type="hidden" name="intent" value={on ? "label-remove" : "label-add"} />
                    <input type="hidden" name="label" value={label.name} />
                    <input type="hidden" name="label_id" value={label.id} />
                    <input type="hidden" name="viewer" value={viewer} />
                    <button type="submit" disabled={busy}>
                      {on ? `Remove ${label.name}` : `Add ${label.name}`}
                    </button>
                  </Form>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Pager links={pages} label="Label" />
      {own?.error && (
        <p className="error" role="alert">
          {own.error}
        </p>
      )}
      {own?.ok && <p role="status">{META_DONE[own.ok as keyof typeof META_DONE] ?? "Done."}</p>}
    </main>
  );
}
