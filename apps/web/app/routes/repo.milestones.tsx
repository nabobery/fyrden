import { type FormEvent, type ReactNode, useEffect, useRef } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";
import {
  DraftDetails,
  type DraftEditors,
  type Drafts,
  fieldsOf,
  type Outcome,
  UnsentText,
  useBaseline,
  useDrafts,
} from "../components/kept-drafts.js";
import { Pager } from "../components/pager.js";
import { RepoHeader } from "../components/repo-header.js";
import {
  apiCallBounded,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope, type Written } from "../lib/edits.js";
import { editSender, NO_VERSION } from "../lib/edits.server.js";
import {
  dateOf,
  dueOf,
  excerpt,
  MILESTONE_FORM_MAX_BYTES,
  type Milestone,
  type MilestonesPage,
  milestoneApiPath,
  milestoneItems,
} from "../lib/milestones.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { field, rawField, repoApiPath } from "../lib/pulls.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.milestones";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Milestones · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = repoApiPath(params.owner, params.repo);
  const state = url.searchParams.get("state") === "closed" ? "closed" : "open";
  const [repo, page, session] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiCallBounded<MilestonesPage>(
      context,
      request,
      `${base}/milestones?state=${state}&${pageQuery(url, "cursor", 30)}`,
    ),
    checkSession(context, request),
  ]);
  const listed = bodyOf(page, request);
  return {
    repo,
    // The repository as this page's URL names it: its answers are scoped by the same.
    at: { owner: params.owner, repo: params.repo },
    origin: url.origin,
    state,
    milestones: listed.milestones,
    pages: pageLinks(url, "cursor", listed.next_cursor),
    viewer: session.state === "signed-in" ? session.user.id : null,
    // A session check that failed says nothing of who is viewing: the page keeps the last known.
    viewerKnown: session.state !== "unknown",
  };
}

/** A milestones page's answer is about its viewer and repository. */
type MilestonesScope = Scope & { owner: string; repo: string; page: "milestones" };

/** The number of the milestone a form is of, else none. */
const milestoneNumber = (form: FormData): number | null => {
  const value = field(form, "number");
  return /^[1-9][0-9]{0,14}$/.test(value) ? Number(value) : null;
};

/** What a milestone form wrote, as its refused draft keeps it. */
function draftOf(form: FormData): Written | undefined {
  const fields = {
    title: field(form, "title"),
    due_on: field(form, "due_on"),
    description: rawField(form, "description"),
  };
  switch (field(form, "intent")) {
    case "create":
      return { fields };
    case "edit": {
      const number = milestoneNumber(form);
      return number === null ? undefined : { fields, target: number };
    }
    default:
      return undefined;
  }
}

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<MilestonesScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, MILESTONE_FORM_MAX_BYTES);
  // The form was made for one viewer: another signed in since (another tab) sends nothing.
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): MilestonesScope => ({
      viewer,
      owner: params.owner,
      repo: params.repo,
      page: "milestones",
    }),
    draftOf,
  );
  if (sender.refused) return sender.refused;
  const { scope, expected, send, refuse } = sender;
  const base = repoApiPath(params.owner, params.repo);
  const intent = field(form, "intent");
  if (intent === "create" || intent === "edit") {
    const draft = draftOf(form);
    const title = field(form, "title");
    const due = dueOf(field(form, "due_on"));
    const description = rawField(form, "description");
    if (!title) return refuse("Give it a title.", draft);
    if (due === undefined) return refuse("That due date is no date.", draft);
    if (intent === "create")
      return send(
        "POST",
        `${base}/milestones`,
        { title, ...(due !== null && { due_on: due }), ...(description && { description }) },
        intent,
        "The milestone was not created.",
        draft,
      );
    const number = milestoneNumber(form);
    if (number === null) return { error: "No such milestone.", scope };
    if (!expected) return refuse(NO_VERSION, draft);
    return send(
      "PATCH",
      milestoneApiPath(base, number),
      { title, due_on: due, description: description || null, ...expected },
      intent,
      "The milestone was not changed.",
      draft,
    );
  }
  const number = milestoneNumber(form);
  if (number === null) return { error: "No such milestone.", scope };
  switch (intent) {
    case "close":
    case "reopen":
      return send(
        "PATCH",
        milestoneApiPath(base, number),
        { state: intent === "close" ? "closed" : "open" },
        intent,
        `The milestone was not ${intent === "close" ? "closed" : "reopened"}.`,
        undefined,
        number,
      );
    case "delete":
      return send(
        "DELETE",
        milestoneApiPath(base, number),
        undefined,
        intent,
        "The milestone was not deleted.",
        undefined,
        number,
      );
    default:
      return { error: "Unknown action.", scope };
  }
}

const DONE: Record<string, string> = {
  create: "Milestone created.",
  edit: "Milestone saved.",
  close: "Milestone closed.",
  reopen: "Milestone reopened.",
  delete: "Milestone deleted.",
};

type ActionData = Awaited<ReturnType<typeof action>> | undefined;

/** The milestones page's editors: the new milestone's, and each milestone's. */
const EDITORS: DraftEditors = {
  ofDraft: (draft) => (draft.target === undefined ? "new-milestone" : `milestone-${draft.target}`),
  ofAnswer: (ok, target) => {
    if (ok === "create") return { editor: "new-milestone" };
    if ((ok === "edit" || ok === "delete") && target !== undefined)
      return { editor: `milestone-${target}`, gone: ok === "delete" };
    return undefined;
  },
};

/** What a kept draft's field is, as its recovery shows it. */
function unsentLabel(editor: string, field: string): string {
  const what = editor === "new-milestone" ? "New milestone" : "Your edit of a milestone";
  if (field === "due_on") return `${what}: due date`;
  if (field === "description") return `${what}: description`;
  return what;
}

/** A milestone's title, due date and description fields, filled from `shown`. */
function MilestoneFields({
  id,
  shown,
}: {
  id: string;
  shown: { title: string; due_on: string; description: string };
}) {
  return (
    <>
      <label htmlFor={`${id}-title`}>Title</label>
      <input
        id={`${id}-title`}
        name="title"
        required
        maxLength={256}
        size={60}
        defaultValue={shown.title}
      />
      <label htmlFor={`${id}-due`}>Due date (optional, a day in UTC)</label>
      <input id={`${id}-due`} name="due_on" type="date" defaultValue={shown.due_on} />
      <label htmlFor={`${id}-description`}>Description (Markdown, optional)</label>
      <textarea
        id={`${id}-description`}
        name="description"
        className="short"
        defaultValue={shown.description}
      />
    </>
  );
}

/** What a milestone form records as it is written. */
const written = (event: FormEvent<HTMLFormElement>) =>
  fieldsOf(event, ["title", "due_on", "description"]);

/** A milestone's editor, from the version it was opened at. */
function MilestoneEditor({
  milestone,
  own,
  busy,
  viewerField,
  drafts,
}: {
  milestone: Milestone;
  own: ActionData;
  busy: boolean;
  viewerField: ReactNode;
  drafts: Drafts;
}) {
  const editor = `milestone-${milestone.number}`;
  const draft = own?.draft?.target === milestone.number ? own.draft : undefined;
  const outcome: Outcome =
    own?.ok === "edit" && own.target === milestone.number
      ? { saved: true, version: own.version }
      : draft
        ? { saved: false, version: draft.version }
        : undefined;
  const kept = drafts.get(editor);
  const baseline = useBaseline(milestone.version, outcome, outcome && own, kept);
  const shown = draft ?? kept;
  return (
    <DraftDetails held={shown !== undefined} summary="Edit">
      <Form
        method="post"
        key={baseline.key}
        onInput={(event) => {
          baseline.onInput();
          drafts.write(editor, {
            fields: written(event),
            version: baseline.version,
            target: milestone.number,
          });
        }}
        onSubmit={() => {
          baseline.onSubmit();
          drafts.sent(editor);
        }}
      >
        <input type="hidden" name="intent" value="edit" />
        <input type="hidden" name="number" value={milestone.number} />
        <input type="hidden" name="version" value={baseline.version} />
        {viewerField}
        <MilestoneFields
          id={`milestone-${milestone.number}`}
          shown={{
            title: shown?.fields.title ?? milestone.title,
            due_on: shown?.fields.due_on ?? dateOf(milestone.due_on),
            description: shown?.fields.description ?? milestone.description ?? "",
          }}
        />
        <p>
          <button type="submit" disabled={busy}>
            Save milestone
          </button>
        </p>
      </Form>
    </DraftDetails>
  );
}

/** How far along a milestone is: its closed items of all it has. */
function progress(milestone: Milestone): string {
  const total = milestone.open_issues + milestone.closed_issues;
  if (total === 0) return "Nothing in it yet";
  const done = Math.floor((milestone.closed_issues * 100) / total);
  return `${done}% complete · ${milestone.open_issues} open · ${milestone.closed_issues} closed`;
}

export default function Milestones({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const { repo, at, origin, state, milestones, pages } = loaderData;
  // A failed session check keeps the viewer last known (its drafts with it); a confirmed one is taken.
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  const manage = viewer !== null && repo.permissions?.push === true;
  const scope: MilestonesScope | undefined =
    viewer === null ? undefined : { viewer, owner: at.owner, repo: at.repo, page: "milestones" };
  // An answer is this page's only in its scope (a draft never shows under another viewer).
  const own =
    result?.scope === undefined || (scope && sameScope(result.scope, scope)) ? result : undefined;
  const drafts = useDrafts(
    `${at.owner}/${at.repo}:milestones:${viewer ?? "anonymous"}`,
    own,
    EDITORS,
  );
  const createForm = useRef<HTMLFormElement>(null);
  // Cleared after its milestone is created: back to what it starts from, the kept draft, which
  // holds only what was written while it was sent (if anything).
  useEffect(() => {
    if (own?.ok === "create") createForm.current?.reset();
  }, [own]);
  const viewerField = <input type="hidden" name="viewer" value={viewer ?? ""} />;
  const unsent = drafts
    .entries()
    .filter(
      ([editor]) =>
        !manage ||
        (editor !== "new-milestone" && !milestones.some((m) => `milestone-${m.number}` === editor)),
    );
  const newDraft =
    own?.draft && own.draft.target === undefined ? own.draft : drafts.get("new-milestone");
  const base = `/${repo.owner}/${repo.name}`;
  return (
    // Keyed by whose page it is: another viewer's starts with empty forms.
    <main key={`${at.owner}/${at.repo}:${viewer ?? "anonymous"}`}>
      <RepoHeader repo={repo} origin={origin} active="issues" />
      <nav aria-label="Issues" className="row">
        <Link to={`${base}/issues`}>Issues</Link>
        <Link to={`${base}/labels`}>Labels</Link>
        <Link to={`${base}/milestones`} aria-current="page">
          Milestones
        </Link>
      </nav>
      <nav aria-label="Filter milestones by state" className="row">
        <Link to={`${base}/milestones`} aria-current={state === "open" ? "page" : undefined}>
          Open
        </Link>
        <Link
          to={`${base}/milestones?state=closed`}
          aria-current={state === "closed" ? "page" : undefined}
        >
          Closed
        </Link>
      </nav>
      {!loaderData.viewerKnown && (
        <p className="muted" role="status">
          Your session could not be checked just now; your drafts are kept.
        </p>
      )}
      {manage && (
        <section className="panel" aria-labelledby="manage-milestones">
          <h2 id="manage-milestones" className="visually-hidden">
            Manage milestones
          </h2>
          <DraftDetails held={newDraft !== undefined} summary="New milestone">
            <Form
              method="post"
              ref={createForm}
              onInput={(event) => drafts.write("new-milestone", { fields: written(event) })}
              onSubmit={() => drafts.sent("new-milestone")}
            >
              <input type="hidden" name="intent" value="create" />
              {viewerField}
              <MilestoneFields
                id="new"
                shown={{
                  title: newDraft?.fields.title ?? "",
                  due_on: newDraft?.fields.due_on ?? "",
                  description: newDraft?.fields.description ?? "",
                }}
              />
              <p>
                <button type="submit" className="primary" disabled={busy}>
                  Create milestone
                </button>
              </p>
            </Form>
          </DraftDetails>
        </section>
      )}
      {milestones.length === 0 ? (
        <p className="muted">{pages.first ? "No more milestones." : `No ${state} milestones.`}</p>
      ) : (
        <ul className="label-list" aria-label="Milestones">
          {milestones.map((milestone) => (
            <li key={milestone.number} className="panel">
              <h2 className="pull-title">{milestone.title}</h2>
              <p className="muted">
                {milestone.due_on === null ? "No due date" : `Due ${dateOf(milestone.due_on)}`}
                {" · "}
                {progress(milestone)}
              </p>
              {milestone.description && (
                <p className="pre-wrap">{excerpt(milestone.description)}</p>
              )}
              <p className="row">
                <Link to={milestoneItems(repo.owner, repo.name, milestone.number)}>
                  Issues and pull requests
                  <span className="visually-hidden"> in {milestone.title}</span>
                </Link>
              </p>
              {manage && (
                <>
                  <MilestoneEditor
                    milestone={milestone}
                    own={own}
                    busy={busy}
                    viewerField={viewerField}
                    drafts={drafts}
                  />
                  <Form method="post" className="row">
                    <input type="hidden" name="number" value={milestone.number} />
                    {viewerField}
                    <button
                      type="submit"
                      name="intent"
                      value={milestone.state === "open" ? "close" : "reopen"}
                      disabled={busy}
                    >
                      {milestone.state === "open" ? "Close milestone" : "Reopen milestone"}
                    </button>
                  </Form>
                  <details>
                    <summary>Delete</summary>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="number" value={milestone.number} />
                      {viewerField}
                      <p className="muted">Its issues and pull requests will be in no milestone.</p>
                      <button type="submit" disabled={busy}>
                        {`Delete milestone ${milestone.title}`}
                      </button>
                    </Form>
                  </details>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager links={pages} label="Milestone" />
      <UnsentText
        unsent={unsent}
        drafts={drafts}
        why="the other state's list, another page, or it was deleted"
        label={unsentLabel}
      />
      {own?.error && (
        <p className="error" role="alert">
          {own.error}
        </p>
      )}
      {own?.ok && <p role="status">{DONE[own.ok] ?? "Done."}</p>}
    </main>
  );
}
