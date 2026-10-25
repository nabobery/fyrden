import { type ReactNode, useEffect, useRef } from "react";
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
import { LabelChip } from "../components/label-chip.js";
import { Pager } from "../components/pager.js";
import { RepoHeader } from "../components/repo-header.js";
import {
  apiCall,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import { type EditResult, type Scope, sameScope, type Written } from "../lib/edits.js";
import { editSender } from "../lib/edits.server.js";
import {
  colorOf,
  LABEL_FORM_MAX_BYTES,
  type Label,
  type LabelsPage,
  labelApiPath,
  labelIssues,
} from "../lib/labels.js";
import { pageLinks, pageQuery } from "../lib/pages.js";
import { field, repoApiPath } from "../lib/pulls.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.labels";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Labels · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const base = repoApiPath(params.owner, params.repo);
  const [repo, page, session] = await Promise.all([
    apiGet<Repo>(context, request, base),
    apiCall<LabelsPage>(context, request, "GET", `${base}/labels?${pageQuery(url, "cursor")}`),
    checkSession(context, request),
  ]);
  const listed = bodyOf(page, request);
  return {
    repo,
    // The repository as this page's URL names it: its answers are scoped by the same.
    at: { owner: params.owner, repo: params.repo },
    origin: url.origin,
    labels: listed.labels,
    pages: pageLinks(url, "cursor", listed.next_cursor),
    viewer: session.state === "signed-in" ? session.user.id : null,
    // A session check that failed says nothing of who is viewing: the page keeps the last known.
    viewerKnown: session.state !== "unknown",
  };
}

/** A labels page's answer is about its viewer and repository. */
type LabelsScope = Scope & { owner: string; repo: string; page: "labels" };

/** The id of the label a form is of, else none. */
const labelId = (form: FormData): number | null => {
  const value = field(form, "label_id");
  return /^[1-9][0-9]{0,14}$/.test(value) ? Number(value) : null;
};

/** What a label form wrote, as its refused draft keeps it. */
function draftOf(form: FormData): Written | undefined {
  const fields = {
    name: field(form, field(form, "intent") === "edit" ? "new_name" : "name"),
    color: colorOf(field(form, "color")) ?? field(form, "color"),
    description: field(form, "description"),
  };
  switch (field(form, "intent")) {
    case "create":
      return { fields };
    case "edit": {
      const id = labelId(form);
      return id === null ? undefined : { fields, target: id };
    }
    default:
      return undefined;
  }
}

export async function action({
  request,
  context,
  params,
}: Route.ActionArgs): Promise<EditResult<LabelsScope>> {
  assertSameOrigin(request);
  const form = await readForm(request, LABEL_FORM_MAX_BYTES);
  // The form was made for one viewer: another signed in since (another tab) sends nothing.
  const sender = await editSender(
    context,
    request,
    form,
    (viewer): LabelsScope => ({ viewer, owner: params.owner, repo: params.repo, page: "labels" }),
    draftOf,
  );
  if (sender.refused) return sender.refused;
  const { scope, expected, send, refuse } = sender;
  const base = repoApiPath(params.owner, params.repo);
  const intent = field(form, "intent");
  if (intent === "copy-defaults")
    return send(
      "POST",
      `${base}/labels/defaults`,
      undefined,
      intent,
      "The default labels were not copied in.",
    );
  const id = labelId(form);
  // A change made by name holds only while the name names the label the form showed.
  const shown = { ...(id !== null && { expected_id: id }), ...expected };
  switch (intent) {
    case "create": {
      const draft = draftOf(form);
      const color = colorOf(field(form, "color"));
      const name = field(form, "name");
      if (!name || !color) return refuse("Give it a name and a colour.", draft);
      const description = field(form, "description");
      return send(
        "POST",
        `${base}/labels`,
        { name, color, ...(description && { description }) },
        intent,
        "The label was not created.",
        draft,
      );
    }
    case "edit": {
      const draft = draftOf(form);
      const color = colorOf(field(form, "color"));
      const name = field(form, "new_name");
      if (id === null) return { error: "No such label.", scope };
      if (!name || !color) return refuse("Give it a name and a colour.", draft);
      const description = field(form, "description");
      return send(
        "PATCH",
        labelApiPath(base, field(form, "name")),
        { new_name: name, color, description: description || null, ...shown },
        intent,
        "The label was not changed.",
        draft,
      );
    }
    case "delete":
      if (id === null) return { error: "No such label.", scope };
      return send(
        "DELETE",
        labelApiPath(base, field(form, "name")),
        shown,
        intent,
        "The label was not deleted.",
        undefined,
        id,
      );
    default:
      return { error: "Unknown action.", scope };
  }
}

const DONE: Record<string, string> = {
  create: "Label created.",
  edit: "Label saved.",
  delete: "Label deleted.",
  "copy-defaults": "Default labels copied in.",
};

type ActionData = Awaited<ReturnType<typeof action>> | undefined;

/** The labels page's editors: the new label's, and each label's. */
const EDITORS: DraftEditors = {
  ofDraft: (draft) => (draft.target === undefined ? "new-label" : `label-${draft.target}`),
  ofAnswer: (ok, target) => {
    if (ok === "create") return { editor: "new-label" };
    if ((ok === "edit" || ok === "delete") && target !== undefined)
      return { editor: `label-${target}`, gone: ok === "delete" };
    return undefined;
  },
};

/** What a kept draft's field is, as its recovery shows it. */
function unsentLabel(editor: string, field: string): string {
  const what = editor === "new-label" ? "New label" : "Your edit of a label";
  if (field === "color") return `${what}: colour`;
  if (field === "description") return `${what}: description`;
  return what;
}

/** A label's name, colour and description fields, filled from `shown`. */
function LabelFields({
  id,
  shown,
}: {
  id: string;
  shown: { name: string; color: string; description: string };
}) {
  return (
    <>
      <label htmlFor={`${id}-name`}>Name</label>
      <input
        id={`${id}-name`}
        name={id === "new" ? "name" : "new_name"}
        required
        maxLength={50}
        defaultValue={shown.name}
      />
      <label htmlFor={`${id}-color`}>Colour</label>
      <input
        id={`${id}-color`}
        name="color"
        type="color"
        defaultValue={`#${colorOf(shown.color) ?? "ededed"}`}
      />
      <label htmlFor={`${id}-description`}>Description (optional)</label>
      <input
        id={`${id}-description`}
        name="description"
        maxLength={100}
        size={60}
        defaultValue={shown.description}
      />
    </>
  );
}

/** A label's editor and its deletion, from the version and id it was opened at. */
function LabelEditor({
  label,
  own,
  busy,
  viewerField,
  drafts,
}: {
  label: Label;
  own: ActionData;
  busy: boolean;
  viewerField: ReactNode;
  drafts: Drafts;
}) {
  const editor = `label-${label.id}`;
  const draft = own?.draft?.target === label.id ? own.draft : undefined;
  const outcome: Outcome =
    own?.ok === "edit" && own.target === label.id
      ? { saved: true, version: own.version }
      : draft
        ? { saved: false, version: draft.version }
        : undefined;
  const kept = drafts.get(editor);
  const baseline = useBaseline(label.version, outcome, outcome && own, kept);
  const shown = draft ?? kept;
  const identity = (
    <>
      <input type="hidden" name="label_id" value={label.id} />
      <input type="hidden" name="name" value={label.name} />
      <input type="hidden" name="version" value={baseline.version} />
      {viewerField}
    </>
  );
  return (
    <>
      <DraftDetails held={shown !== undefined} summary="Edit">
        <Form
          method="post"
          key={baseline.key}
          onInput={(event) => {
            baseline.onInput();
            const fields = fieldsOf(event, ["new_name", "color", "description"]);
            drafts.write(editor, {
              fields: {
                name: fields.new_name ?? "",
                color: colorOf(fields.color ?? "") ?? "",
                description: fields.description ?? "",
              },
              version: baseline.version,
              target: label.id,
            });
          }}
          onSubmit={() => {
            baseline.onSubmit();
            drafts.sent(editor);
          }}
        >
          <input type="hidden" name="intent" value="edit" />
          {identity}
          <LabelFields
            id={`label-${label.id}`}
            shown={{
              name: shown?.fields.name ?? label.name,
              color: shown?.fields.color ?? label.color,
              description: shown?.fields.description ?? label.description ?? "",
            }}
          />
          <p>
            <button type="submit" disabled={busy}>
              Save label
            </button>
          </p>
        </Form>
      </DraftDetails>
      <details>
        <summary>Delete</summary>
        <Form method="post">
          <input type="hidden" name="intent" value="delete" />
          {identity}
          <p className="muted">Issues and pull requests carrying it will no longer.</p>
          <button type="submit" disabled={busy}>
            Delete label {label.name}
          </button>
        </Form>
      </details>
    </>
  );
}

export default function Labels({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const { repo, at, origin, labels, pages } = loaderData;
  // A failed session check keeps the viewer last known (its drafts with it); a confirmed one is taken.
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  const manage = viewer !== null && repo.permissions?.push === true;
  const scope: LabelsScope | undefined =
    viewer === null ? undefined : { viewer, owner: at.owner, repo: at.repo, page: "labels" };
  // An answer is this page's only in its scope (a draft never shows under another viewer).
  const own =
    result?.scope === undefined || (scope && sameScope(result.scope, scope)) ? result : undefined;
  const drafts = useDrafts(`${at.owner}/${at.repo}:labels:${viewer ?? "anonymous"}`, own, EDITORS);
  const createForm = useRef<HTMLFormElement>(null);
  // Cleared after its label is created: back to what it starts from, the kept draft, which holds
  // only what was written while it was sent (if anything).
  useEffect(() => {
    if (own?.ok === "create") createForm.current?.reset();
  }, [own]);
  const viewerField = <input type="hidden" name="viewer" value={viewer ?? ""} />;
  const unsent = drafts
    .entries()
    .filter(
      ([editor]) =>
        !manage || (editor !== "new-label" && !labels.some((l) => `label-${l.id}` === editor)),
    );
  const newDraft =
    own?.draft && own.draft.target === undefined ? own.draft : drafts.get("new-label");
  return (
    // Keyed by whose page it is: another viewer's starts with empty forms.
    <main key={`${repo.full_name}:${viewer ?? "anonymous"}`}>
      <RepoHeader repo={repo} origin={origin} active="issues" />
      <nav aria-label="Issues" className="row">
        <Link to={`/${repo.owner}/${repo.name}/issues`}>Issues</Link>
        <Link to={`/${repo.owner}/${repo.name}/labels`} aria-current="page">
          Labels
        </Link>
      </nav>
      {!loaderData.viewerKnown && (
        <p className="muted" role="status">
          Your session could not be checked just now; your drafts are kept.
        </p>
      )}
      {manage && (
        <section className="panel" aria-labelledby="manage-labels">
          <h2 id="manage-labels" className="visually-hidden">
            Manage labels
          </h2>
          <DraftDetails held={newDraft !== undefined} summary="New label">
            <Form
              method="post"
              ref={createForm}
              onInput={(event) => {
                const fields = fieldsOf(event, ["name", "color", "description"]);
                drafts.write("new-label", {
                  fields: {
                    name: fields.name ?? "",
                    color: colorOf(fields.color ?? "") ?? "",
                    description: fields.description ?? "",
                  },
                });
              }}
              onSubmit={() => drafts.sent("new-label")}
            >
              <input type="hidden" name="intent" value="create" />
              {viewerField}
              <LabelFields
                id="new"
                shown={{
                  name: newDraft?.fields.name ?? "",
                  color: newDraft?.fields.color ?? "ededed",
                  description: newDraft?.fields.description ?? "",
                }}
              />
              <p>
                <button type="submit" className="primary" disabled={busy}>
                  Create label
                </button>
              </p>
            </Form>
          </DraftDetails>
          <Form method="post">
            <input type="hidden" name="intent" value="copy-defaults" />
            {viewerField}
            <button type="submit" disabled={busy}>
              Copy the default labels
            </button>{" "}
            <span className="muted">(the ones it is missing; names it has are kept)</span>
          </Form>
        </section>
      )}
      {labels.length === 0 ? (
        <p className="muted">{pages.first ? "No more labels." : "No labels yet."}</p>
      ) : (
        <ul className="label-list" aria-label="Labels">
          {labels.map((label) => (
            <li key={label.id} className="panel">
              <p className="row">
                <LabelChip label={label} />
                {label.description && <span className="muted">{label.description}</span>}
                <Link to={labelIssues(repo.owner, repo.name, label)}>
                  Issues<span className="visually-hidden"> labelled {label.name}</span>
                </Link>
              </p>
              {manage && (
                <LabelEditor
                  label={label}
                  own={own}
                  busy={busy}
                  viewerField={viewerField}
                  drafts={drafts}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Pager links={pages} label="Label" />
      <UnsentText
        unsent={unsent}
        drafts={drafts}
        why="another page of labels, or it was deleted"
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
