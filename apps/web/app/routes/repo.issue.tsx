import { type FormEvent, type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { Markdown } from "../components/markdown.js";
import { Pager } from "../components/pager.js";
import { Reactions } from "../components/reactions.js";
import {
  apiCall,
  apiCallBounded,
  apiGet,
  assertSameOrigin,
  bodyOf,
  checkSession,
  readForm,
} from "../lib/api.server.js";
import { utf8Length } from "../lib/continuation.js";
import {
  ISSUE_FORM_MAX_BYTES,
  type Issue,
  issueApiPath,
  issuePage,
  issueStatus,
} from "../lib/issues.js";
import {
  field,
  type IssueCommentsPage,
  problemCode,
  problemDetail,
  pullNumber,
  pullPage,
  rawField,
  repoApiPath,
  when,
  who,
} from "../lib/pulls.js";
import { reactionCall } from "../lib/reactions.js";
import { pageUrl } from "../lib/target.js";
import type { Repo } from "../lib/types.js";
import type { Route } from "./+types/repo.issue";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.issue.title ?? `#${params.number}`;
  return [
    { title: `${title} · Issue #${params.number} · ${params.owner}/${params.repo} · Fyrden` },
  ];
}

/** Comments a page shows at most (the API may end a page of large ones sooner). */
const COMMENTS_PAGE = 25;
/**
 * Markdown source (UTF-8 bytes) a page carries at most (the browser renders
 * it, and editable comments carry it twice): past it, the page ends after
 * the last comment shown and the next one goes on from there.
 */
const SOURCE_BUDGET = 256 * 1024;

/** A positive id from a page's URL, else none. */
const idParam = (value: string | null): number | null =>
  value !== null && /^[1-9][0-9]{0,14}$/.test(value) ? Number(value) : null;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  // As the page's own (a navigation's data request's suffix off): its links go to it.
  const url = pageUrl(new URL(request.url));
  const number = pullNumber(params.number);
  const api = issueApiPath(params.owner, params.repo, number);
  const after = idParam(url.searchParams.get("after"));
  const [issue, comments, repo, session] = await Promise.all([
    apiCall<Issue>(context, request, "GET", api),
    apiCallBounded<IssueCommentsPage>(
      context,
      request,
      `${api}/comments?per_page=${COMMENTS_PAGE}${after === null ? "" : `&after=${after}`}`,
    ),
    apiGet<Repo>(context, request, repoApiPath(params.owner, params.repo)),
    checkSession(context, request),
  ]);
  const shown = bodyOf(issue, request);
  // A pull request's number: its own page (as GitHub's).
  if (shown.pull_request) throw redirect(pullPage(params.owner, params.repo, number));
  const page = bodyOf(comments, request);
  const shownComments: IssueCommentsPage["comments"] = [];
  let bytes = 0;
  for (const comment of page.comments) {
    bytes += utf8Length(comment.body);
    if (shownComments.length > 0 && bytes > SOURCE_BUDGET) break;
    shownComments.push(comment);
  }
  const cut = shownComments.length < page.comments.length;
  const last = shownComments.at(-1);
  const at = (id: number | null) => {
    const query = new URLSearchParams(url.search);
    if (id === null) query.delete("after");
    else query.set("after", String(id));
    const search = query.toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  };
  return {
    owner: params.owner,
    repo: params.repo,
    issue: shown,
    comments: shownComments,
    pages: {
      // Cut by its source, or with more in the API: the next page goes on after the last shown.
      next: (cut || page.next_cursor) && last ? at(last.id) : null,
      first: after === null ? null : at(null),
    },
    permissions: repo.permissions ?? null,
    viewer: session.state === "signed-in" ? session.user.id : null,
    // A session check that failed says nothing of who is viewing: the page keeps the last known.
    viewerKnown: session.state !== "unknown",
  };
}

/** Whose and what an action's answer is about: a page shows it only in the same scope. */
interface Scope {
  readonly viewer: string;
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** What a refused edit wrote, the version it was written from, and the comment it was for. */
interface Draft {
  readonly fields: Readonly<Record<string, string>>;
  readonly version?: number | undefined;
  readonly target?: number | undefined;
}

type Result =
  | {
      ok: string;
      /** The comment the change was of, if any. */
      target?: number | undefined;
      /** The version the change made (its record's, as the API answered). */
      version?: number | undefined;
      scope: Scope;
      error?: undefined;
      draft?: undefined;
    }
  | { error: string; scope?: Scope; draft?: Draft | undefined; ok?: undefined };

/** What a form wrote, as its refused draft keeps it (none for one that writes nothing). */
function draftOf(form: FormData): { fields: Record<string, string>; target?: number } | undefined {
  switch (field(form, "intent")) {
    case "comment":
      return { fields: { comment: rawField(form, "body") } };
    case "edit":
      return { fields: { title: field(form, "title"), body: rawField(form, "body") } };
    case "edit-comment": {
      const id = idParam(field(form, "comment_id"));
      return id === null ? undefined : { fields: { body: rawField(form, "body") }, target: id };
    }
    default:
      return undefined;
  }
}

export async function action({ request, context, params }: Route.ActionArgs): Promise<Result> {
  assertSameOrigin(request);
  const form = await readForm(request, ISSUE_FORM_MAX_BYTES);
  const number = pullNumber(params.number);
  const sent = Number(field(form, "version"));
  const version = Number.isSafeInteger(sent) && sent > 0 ? sent : undefined;
  // The form was made for one viewer: another signed in since (another tab) sends nothing.
  const session = await checkSession(context, request);
  if (session.state === "unknown") {
    // Not known who is signed in: nothing is sent, and what was written comes back to the
    // viewer the form was made for (shown only once that viewer is confirmed).
    const scope: Scope = {
      viewer: field(form, "viewer"),
      owner: params.owner,
      repo: params.repo,
      number,
    };
    const draft = draftOf(form);
    return {
      error: "Your session could not be checked just now: nothing was sent; send it again.",
      scope,
      ...(draft && { draft: { ...draft, version } }),
    };
  }
  if (session.state !== "signed-in" || session.user.id !== field(form, "viewer"))
    return { error: "You are signed in as someone else now: reload the page." };
  const scope: Scope = { viewer: session.user.id, owner: params.owner, repo: params.repo, number };
  const api = issueApiPath(params.owner, params.repo, number);
  const repoApi = repoApiPath(params.owner, params.repo);
  const expected = version === undefined ? {} : { expected_version: version };
  const send = async (
    method: string,
    path: string,
    body: unknown,
    intent: string,
    fallback: string,
    draft?: { fields: Record<string, string>; target?: number },
    /** The comment a change without text is of (a deletion). */
    target?: number,
  ): Promise<Result> => {
    let result: Awaited<ReturnType<typeof apiCall<unknown>>>;
    try {
      result = await apiCall<unknown>(context, request, method, path, body);
    } catch {
      // Not reached, or an answer that could not be read: it may or may not have been done.
      return {
        error:
          "Fyrden could not be reached, or its answer read: it may or may not have been done. Reload to check before sending again (your text is kept below).",
        scope,
        ...(draft && { draft: { ...draft, version } }),
      };
    }
    if (result.status >= 200 && result.status < 300) {
      const made = (result.body as { version?: unknown } | null)?.version;
      return {
        ok: intent,
        target: draft?.target ?? target,
        version: typeof made === "number" ? made : undefined,
        scope,
      };
    }
    const error =
      problemCode(result.body) === "stale"
        ? "Someone changed it since you opened this form: reload to see what changed (your text is kept below)."
        : problemDetail(result.body, fallback);
    // The draft keeps the version it was written from: sent again, it is still checked against it.
    return { error, scope, ...(draft && { draft: { ...draft, version } }) };
  };
  switch (field(form, "intent")) {
    case "comment": {
      const body = rawField(form, "body");
      if (!body.trim()) return { error: "Write a comment first.", scope };
      return send("POST", `${api}/comments`, { body }, "comment", "The comment was not added.", {
        fields: { comment: body },
      });
    }
    case "edit": {
      const title = field(form, "title");
      const body = rawField(form, "body");
      return send(
        "PATCH",
        api,
        { title, body: body.trim() ? body : null, ...expected },
        "edit",
        "The issue was not changed.",
        { fields: { title, body } },
      );
    }
    case "edit-comment": {
      const id = idParam(field(form, "comment_id"));
      const body = rawField(form, "body");
      if (id === null || !body.trim()) return { error: "Write the comment first.", scope };
      return send(
        "PATCH",
        `${repoApi}/issues/comments/${id}`,
        { body, ...expected },
        "edit-comment",
        "The comment was not changed.",
        { fields: { body }, target: id },
      );
    }
    case "delete-comment": {
      const id = idParam(field(form, "comment_id"));
      if (id === null) return { error: "No such comment.", scope };
      return send(
        "DELETE",
        `${repoApi}/issues/comments/${id}`,
        undefined,
        "delete-comment",
        "The comment was not deleted.",
        undefined,
        id,
      );
    }
    case "close": {
      const reason = field(form, "state_reason");
      if (!["completed", "not_planned", "duplicate"].includes(reason))
        return { error: "Choose why it is closed.", scope };
      const duplicate = idParam(field(form, "duplicate_of"));
      if (reason === "duplicate" && duplicate === null)
        return { error: "Name the issue or pull request it duplicates.", scope };
      return send(
        "PATCH",
        api,
        {
          state: "closed",
          state_reason: reason,
          ...(reason === "duplicate" && { duplicate_of: duplicate }),
        },
        "close",
        "The issue was not closed.",
      );
    }
    case "reopen":
      return send("PATCH", api, { state: "open" }, "reopen", "The issue was not reopened.");
    case "react":
    case "unreact": {
      const call = reactionCall(form, api, repoApi);
      if (!call) return { error: "No such reaction.", scope };
      return send(
        call.method,
        call.path,
        call.body,
        field(form, "intent"),
        "The reaction was not changed.",
        undefined,
        call.target,
      );
    }
    default:
      return { error: "Unknown action.", scope };
  }
}

const DONE: Record<string, string> = {
  comment: "Comment added.",
  edit: "Saved.",
  "edit-comment": "Comment saved.",
  "delete-comment": "Comment deleted.",
  close: "Closed.",
  reopen: "Reopened.",
  react: "Reaction added.",
  unreact: "Reaction taken back.",
};

type ActionData = Awaited<ReturnType<typeof action>> | undefined;

/** What an editor's own last answer says: saved (and the version made), or refused (and the draft's). */
type Outcome = { readonly saved: boolean; readonly version: number | undefined } | undefined;

/**
 * The version an editor writes from. While nothing unsent is written in
 * it, the page's (the editor is drawn again with what it shows, so its
 * fields and version agree); once something is, the version it showed
 * then; when its own draft is refused, that draft's version, for as long
 * as the draft is there (sent again, it is refused again until read
 * anew); after its own save, the page's again (nothing unsent: what was
 * saved is what the page shows), unless something was written while it
 * was saving (then the version the save made). A draft is checked against
 * what it was written from, never against what the page shows now.
 */
function useBaseline(
  current: number,
  outcome: Outcome,
  /** The answer the outcome came from: a new one each time, even with the same values. */
  answer: object | undefined,
  /** The page's kept draft of this editor, when it is drawn: it starts from that. */
  resumed: Draft | undefined,
): { version: number; key: string; onInput: () => void; onSubmit: () => void } {
  const start = outcome && !outcome.saved ? outcome : resumed;
  const [frozen, setFrozen] = useState<number | undefined>(start?.version);
  // The form's identity while it holds what it was written with: kept whatever its version
  // becomes, so a save or refusal answered while someone types never draws it again.
  const [kept, setKept] = useState<string | undefined>(start ? `kept ${start.version}` : undefined);
  const writtenSinceSubmit = useRef(false);
  const shownKey = kept ?? `version ${current}`;
  const shown = useRef(shownKey);
  shown.current = shownKey;
  // Read when a new answer comes, not on every drawing (an outcome is a new object each time).
  const latest = useRef(outcome);
  latest.current = outcome;
  useEffect(() => {
    const now = latest.current;
    if (!now || !answer) return;
    if (!now.saved || writtenSinceSubmit.current) {
      // Refused, or written in since it was sent: the version it is checked against moves, the
      // form (and what is in it) stays.
      setFrozen(now.version);
      setKept((was) => was ?? shown.current);
    } else {
      // Saved with nothing unsent: it follows the page again.
      setFrozen(undefined);
      setKept(undefined);
    }
  }, [answer]);
  return {
    version: frozen ?? current,
    // A pristine editor is drawn again for each version; one written in keeps its identity.
    key: shownKey,
    onInput: () => {
      writtenSinceSubmit.current = true;
      setFrozen((was) => was ?? current);
      setKept((was) => was ?? shown.current);
    },
    onSubmit: () => {
      writtenSinceSubmit.current = false;
    },
  };
}

/** Which editor a draft is of: the description's, the new comment's, or a comment's. */
function editorOf(draft: Draft): string {
  if (draft.target !== undefined) return `comment-${draft.target}`;
  return "title" in draft.fields ? "issue" : "comment";
}

/** The named fields of the form an input event came from. */
function fieldsOf(event: FormEvent<HTMLFormElement>, names: readonly string[]): Draft["fields"] {
  const data = new FormData(event.currentTarget);
  return Object.fromEntries(names.map((name) => [name, String(data.get(name) ?? "")]));
}

type Drafts = ReturnType<typeof useDrafts>;

/**
 * The unsent drafts of one issue's page for one viewer, by editor: what an
 * editor holds (recorded as it is written, dropped when its send is
 * answered as done) and a refused draft (until sent again and done,
 * discarded, or its comment deleted).
 * Kept apart from what the page shows now and from the latest answer, so
 * an editor that goes (its comment on another page, the conversation
 * locked) leaves its text to copy, and one that comes back resumes from it.
 * Text written while an editor's send is answered is newer than what was
 * sent: a refusal does not replace it, and a save moves its version to the
 * one the save made.
 */
function useDrafts(scope: string, own: ActionData) {
  const all = useRef(new Map<string, ScopeDrafts>());
  const taken = useRef<object | undefined>(undefined);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  let drafts = all.current.get(scope);
  if (!drafts) {
    drafts = { held: new Map(), sending: new Set(), since: new Set() };
    all.current.set(scope, drafts);
  }
  const { held, sending, since } = drafts;
  // Each answer taken once: drawn again, it changes nothing.
  if (own && taken.current !== own) {
    taken.current = own;
    const done = own.ok !== undefined ? own : undefined;
    const editor = own.draft ? editorOf(own.draft) : done && answeredEditor(done.ok, done.target);
    if (editor !== undefined) {
      const newer = since.has(editor) ? held.get(editor) : undefined;
      if (done?.ok === "delete-comment") held.delete(editor);
      else if (own.draft) {
        if (!newer) held.set(editor, own.draft);
      } else if (!newer) held.delete(editor);
      else if (done?.version !== undefined) held.set(editor, { ...newer, version: done.version });
      sending.delete(editor);
      since.delete(editor);
    }
  }
  return {
    get: (editor: string) => held.get(editor),
    entries: () => [...held.entries()],
    write: (editor: string, draft: Draft) => {
      held.set(editor, draft);
      if (sending.has(editor)) since.add(editor);
    },
    // What was sent stays until its answer says it was done: an answer that never comes (the
    // page left while it was sent) leaves it to copy, never sent again by itself.
    sent: (editor: string) => {
      sending.add(editor);
      since.delete(editor);
    },
    discard: (editor: string) => {
      held.delete(editor);
      redraw();
    },
  };
}

interface ScopeDrafts {
  readonly held: Map<string, Draft>;
  /** Editors sent and not yet answered. */
  readonly sending: Set<string>;
  /** Of those, the ones written in since. */
  readonly since: Set<string>;
}

/** The editor a successful answer is of. */
function answeredEditor(ok: string, target: number | undefined): string | undefined {
  if (ok === "edit") return "issue";
  if (ok === "comment") return "comment";
  if ((ok === "edit-comment" || ok === "delete-comment") && target !== undefined)
    return `comment-${target}`;
  return undefined;
}

/** What a kept draft's field is, as its recovery shows it. */
function unsentLabel(editor: string, field: string): string {
  if (editor === "issue") return field === "title" ? "Title" : "Description";
  return editor === "comment" ? "New comment" : "Your edit of a comment";
}

/**
 * A disclosure opened when it holds a draft (drawn open, or opened when
 * one comes), never closed by the page: whoever opened it closes it.
 */
function DraftDetails({
  held,
  summary,
  children,
}: {
  held: boolean;
  summary: string;
  children: ReactNode;
}) {
  const [atFirst] = useState(held);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (held && details.current) details.current.open = true;
  }, [held]);
  return (
    <details ref={details} open={atFirst}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/** The title and description editor (the author's, or write access's: a lock does not stop it). */
function IssueEditor({
  issue,
  own,
  busy,
  viewerField,
  drafts,
}: {
  issue: Issue;
  own: ActionData;
  busy: boolean;
  viewerField: ReactNode;
  drafts: Drafts;
}) {
  const draft =
    own?.draft && own.draft.target === undefined && "title" in own.draft.fields
      ? own.draft
      : undefined;
  const outcome: Outcome =
    own?.ok === "edit"
      ? { saved: true, version: own.version }
      : draft
        ? { saved: false, version: draft.version }
        : undefined;
  const kept = drafts.get("issue");
  const baseline = useBaseline(issue.version, outcome, outcome && own, kept);
  const shown = draft ?? kept;
  return (
    <DraftDetails held={shown !== undefined} summary="Edit title and description">
      <Form
        method="post"
        key={baseline.key}
        onInput={(event) => {
          baseline.onInput();
          drafts.write("issue", {
            fields: fieldsOf(event, ["title", "body"]),
            version: baseline.version,
          });
        }}
        onSubmit={() => {
          baseline.onSubmit();
          drafts.sent("issue");
        }}
      >
        <input type="hidden" name="intent" value="edit" />
        <input type="hidden" name="version" value={baseline.version} />
        {viewerField}
        <label htmlFor="edit-title">Title</label>
        <input
          id="edit-title"
          name="title"
          required
          maxLength={256}
          size={60}
          defaultValue={shown?.fields.title ?? issue.title}
        />
        <label htmlFor="edit-body">Description (Markdown)</label>
        <textarea
          id="edit-body"
          name="body"
          className="short"
          defaultValue={shown?.fields.body ?? issue.body ?? ""}
        />
        <p>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </p>
      </Form>
    </DraftDetails>
  );
}

/** A comment's own editor, its baseline kept as the issue editor's is, and moved by its own save only. */
function CommentEditor({
  comment,
  own,
  busy,
  viewerField,
  drafts,
}: {
  comment: IssueCommentsPage["comments"][number];
  own: ActionData;
  busy: boolean;
  viewerField: ReactNode;
  drafts: Drafts;
}) {
  const draft = own?.draft?.target === comment.id ? own.draft : undefined;
  const outcome: Outcome =
    own?.ok === "edit-comment" && own.target === comment.id
      ? { saved: true, version: own.version }
      : draft
        ? { saved: false, version: draft.version }
        : undefined;
  const editor = `comment-${comment.id}`;
  const kept = drafts.get(editor);
  const baseline = useBaseline(comment.version, outcome, outcome && own, kept);
  return (
    <Form
      method="post"
      key={baseline.key}
      onInput={(event) => {
        baseline.onInput();
        drafts.write(editor, {
          fields: fieldsOf(event, ["body"]),
          version: baseline.version,
          target: comment.id,
        });
      }}
      onSubmit={() => {
        baseline.onSubmit();
        drafts.sent(editor);
      }}
    >
      <input type="hidden" name="intent" value="edit-comment" />
      <input type="hidden" name="comment_id" value={comment.id} />
      <input type="hidden" name="version" value={baseline.version} />
      {viewerField}
      <label htmlFor={`comment-body-${comment.id}`}>Comment (Markdown)</label>
      <textarea
        id={`comment-body-${comment.id}`}
        name="body"
        className="short"
        required
        defaultValue={(draft ?? kept)?.fields.body ?? comment.body}
      />
      <p>
        <button type="submit" disabled={busy}>
          Save comment
        </button>
      </p>
    </Form>
  );
}

export default function IssuePage({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const { owner, repo, issue, comments, pages, permissions } = loaderData;
  // A failed session check keeps the viewer last known (its drafts with it); a confirmed one is taken.
  const known = useRef(loaderData.viewer);
  if (loaderData.viewerKnown) known.current = loaderData.viewer;
  const viewer = known.current;
  const isAuthor = viewer !== null && issue.user.id === viewer;
  const push = permissions?.push === true;
  const triage = permissions?.triage === true;
  // A locked conversation takes comments from write access only (the API decides each).
  const mayTalk = viewer !== null && (!issue.locked || push);
  const mayEdit = viewer !== null && (isAuthor || push);
  const mayClose = viewer !== null && (isAuthor || triage);
  const status = issueStatus(issue);
  const commentForm = useRef<HTMLFormElement>(null);
  // Cleared after its comment is added, unless something new was written while it was sent.
  const commentWritten = useRef(false);
  useEffect(() => {
    if (result?.ok === "comment" && !commentWritten.current) commentForm.current?.reset();
  }, [result]);
  const viewerField = <input type="hidden" name="viewer" value={viewer ?? ""} />;
  // An answer is this page's only in its scope (a draft never shows under another viewer or issue).
  const own =
    result?.scope === undefined ||
    (result.scope.viewer === viewer &&
      result.scope.owner === owner &&
      result.scope.repo === repo &&
      result.scope.number === issue.number)
      ? result
      : undefined;
  const drafts = useDrafts(`${owner}/${repo}#${issue.number}:${viewer ?? "anonymous"}`, own);
  // A kept draft whose editor is not on this page now: shown to copy, never lost.
  const editorHere = (editor: string) =>
    editor === "issue"
      ? mayEdit
      : mayTalk &&
        (editor === "comment" ||
          comments.some((c) => `comment-${c.id}` === editor && c.user.id === viewer));
  const unsent = drafts.entries().filter(([editor]) => !editorHere(editor));
  return (
    // Keyed by what it edits and who: another issue's or viewer's page starts with empty forms.
    <main key={`${owner}/${repo}#${issue.number}:${viewer ?? "anonymous"}`}>
      <p>
        <Link to={`/${owner}/${repo}`}>
          {owner}/{repo}
        </Link>{" "}
        / <Link to={`/${owner}/${repo}/issues`}>Issues</Link>
      </p>
      <h1>
        <span className="pull-title">{issue.title}</span>{" "}
        <span className="muted">#{issue.number}</span>
      </h1>
      <p className="row">
        <span className={`badge ${status.className}`}>{status.label}</span>
        <span>
          {who(issue.user.id, viewer)} opened it {when(issue.created_at)}
          {issue.locked && " · locked"}
        </span>
        {issue.duplicate_of !== null && (
          <span>
            duplicate of{" "}
            <Link to={issuePage(owner, repo, issue.duplicate_of)}>#{issue.duplicate_of}</Link>
          </span>
        )}
      </p>
      {issue.labels.length > 0 && (
        <p className="row">
          <span className="visually-hidden">Labels:</span>
          {issue.labels.map((label) => (
            <span key={label.id} className="label-chip">
              {label.name}
            </span>
          ))}
        </p>
      )}
      {!loaderData.viewerKnown && (
        <p className="muted" role="status">
          Your session could not be checked just now; your drafts are kept.
        </p>
      )}

      <section className="panel" aria-labelledby="issue-description">
        <h2 id="issue-description" className="visually-hidden">
          Description
        </h2>
        {issue.body ? <Markdown source={issue.body} /> : <p className="muted">No description.</p>}
        <Reactions
          rollup={issue.reactions}
          target="issue"
          canReact={mayTalk}
          busy={busy}
          hidden={viewerField}
        />
        {mayEdit && (
          <IssueEditor
            issue={issue}
            own={own}
            busy={busy}
            viewerField={viewerField}
            drafts={drafts}
          />
        )}
      </section>

      <section aria-labelledby="conversation">
        <h2 id="conversation">Conversation</h2>
        {comments.length === 0 ? (
          <p className="muted">{pages.first ? "No more comments." : "No comments yet."}</p>
        ) : (
          <ol className="timeline" aria-label="Comments">
            {comments.map((comment) => {
              const mine = viewer !== null && comment.user.id === viewer;
              return (
                <li key={comment.id} id={`comment-${comment.id}`}>
                  <article
                    className="panel"
                    aria-label={`Comment by ${who(comment.user.id, viewer)}`}
                  >
                    <header className="muted">
                      <strong>{who(comment.user.id, viewer)}</strong> commented{" "}
                      <time dateTime={new Date(comment.created_at).toISOString()}>
                        {when(comment.created_at)}
                      </time>
                      {comment.updated_at > comment.created_at && " (edited)"}
                    </header>
                    <Markdown source={comment.body} />
                    <Reactions
                      rollup={comment.reactions}
                      target={comment.id}
                      canReact={mayTalk}
                      busy={busy}
                      hidden={viewerField}
                    />
                    {mayTalk && (mine || push) && (
                      <DraftDetails
                        held={mine && drafts.get(`comment-${comment.id}`) !== undefined}
                        summary="Edit or delete"
                      >
                        {mine && (
                          <CommentEditor
                            comment={comment}
                            own={own}
                            busy={busy}
                            viewerField={viewerField}
                            drafts={drafts}
                          />
                        )}
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete-comment" />
                          <input type="hidden" name="comment_id" value={comment.id} />
                          {viewerField}
                          <button type="submit" disabled={busy}>
                            Delete comment
                          </button>
                        </Form>
                      </DraftDetails>
                    )}
                  </article>
                </li>
              );
            })}
          </ol>
        )}
        <Pager links={pages} label="Comment" />
      </section>

      {mayClose && (
        <section className="panel" aria-labelledby="issue-state">
          <h2 id="issue-state">State</h2>
          {issue.state === "open" ? (
            <Form method="post">
              <input type="hidden" name="intent" value="close" />
              {viewerField}
              <fieldset>
                <legend>Close as</legend>
                {(
                  [
                    ["completed", "Completed"],
                    ["not_planned", "Not planned"],
                    // Marking a duplicate takes triage, the author's own issue included.
                    ...(triage ? ([["duplicate", "Duplicate of"]] as const) : []),
                  ] as const
                ).map(([value, label]) => (
                  <p key={value}>
                    <input
                      type="radio"
                      id={`close-${value}`}
                      name="state_reason"
                      value={value}
                      defaultChecked={value === "completed"}
                    />{" "}
                    <label htmlFor={`close-${value}`} className="inline">
                      {label}
                    </label>
                  </p>
                ))}
                {triage && (
                  <>
                    <label htmlFor="duplicate-of">Duplicate of (a number, for a duplicate)</label>
                    <input id="duplicate-of" name="duplicate_of" inputMode="numeric" size={8} />
                  </>
                )}
              </fieldset>
              <p>
                <button type="submit" disabled={busy}>
                  Close issue
                </button>
              </p>
            </Form>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="reopen" />
              {viewerField}
              <button type="submit" disabled={busy}>
                Reopen issue
              </button>
            </Form>
          )}
        </section>
      )}

      {mayTalk ? (
        <section className="panel" aria-labelledby="add-comment">
          <h2 id="add-comment">Add a comment</h2>
          <Form
            method="post"
            ref={commentForm}
            onInput={(event) => {
              commentWritten.current = true;
              drafts.write("comment", {
                fields: { comment: fieldsOf(event, ["body"]).body ?? "" },
              });
            }}
            onSubmit={() => {
              commentWritten.current = false;
              drafts.sent("comment");
            }}
          >
            <input type="hidden" name="intent" value="comment" />
            {viewerField}
            <label htmlFor="comment-body">Comment (Markdown)</label>
            <textarea
              id="comment-body"
              name="body"
              className="short"
              required
              defaultValue={drafts.get("comment")?.fields.comment ?? ""}
            />
            <p>
              <button type="submit" className="primary" disabled={busy}>
                Comment
              </button>
            </p>
          </Form>
        </section>
      ) : (
        issue.locked && <p className="muted">This conversation is locked.</p>
      )}

      {unsent.length > 0 && (
        <section className="panel" aria-labelledby="unsent-text">
          <h2 id="unsent-text">Your unsent text</h2>
          <p className="muted">
            What it was for is not on this page now (another page of comments, or the conversation
            was locked): copy it from here.
          </p>
          {unsent.map(([editor, draft]) => (
            <div key={editor}>
              {Object.entries(draft.fields).map(([name, text]) => (
                <p key={name}>
                  <label htmlFor={`unsent-${editor}-${name}`}>{unsentLabel(editor, name)}</label>
                  <textarea
                    id={`unsent-${editor}-${name}`}
                    className="short"
                    readOnly
                    value={text}
                  />
                </p>
              ))}
              <p>
                <button
                  type="button"
                  aria-label={`Discard: ${unsentLabel(editor, "body")}`}
                  onClick={() => drafts.discard(editor)}
                >
                  Discard
                </button>
              </p>
            </div>
          ))}
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
