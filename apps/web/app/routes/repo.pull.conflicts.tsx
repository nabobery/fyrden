import { useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation, useRevalidator } from "react-router";
import { ConflictEditor } from "../components/conflict-editor.js";
import { PullHeader } from "../components/pull-header.js";
import {
  API_MAX_JSON_BODY_BYTES,
  apiCall,
  apiFetch,
  assertSameOrigin,
  readForm,
  signedInUser,
  signInUrl,
} from "../lib/api.server.js";
import {
  type Conflicts,
  conflictsView,
  KIND_TEXT,
  type LineEnding,
  lineEnding,
  shellQuote,
  withLineEndings,
} from "../lib/conflicts.js";
import { utf8Length } from "../lib/continuation.js";
import { field, problemCode, problemDetail, pullNumber, pullPage, rawField } from "../lib/pulls.js";
import { loadPull, pullApiOf } from "../lib/pulls.server.js";
import type { Route } from "./+types/repo.pull.conflicts";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.pull?.title ?? `#${params.number}`;
  return [{ title: `Conflicts · ${title} · ${params.owner}/${params.repo} · Fyrden` }];
}

/** Editable files a resolution carries at most (the API's limit). */
const MAX_FILES = 50;
/** A resolved file's content at most, in UTF-8 bytes (the API's limit). */
export const MAX_FILE_BYTES = 1024 * 1024;
/**
 * A resolution's content at most, in UTF-8 bytes: what the conflicts are
 * read with (4 MiB of editable files in all, see docs/operations/limits.md).
 */
export const MAX_RESOLUTION_BYTES = 4 * 1024 * 1024;
/**
 * The editor's form at most, as sent: multipart (content as its bytes), and
 * browsers send every line break as CRLF, so content takes up to twice its
 * size; then each file's path and line ending and the commit message
 * (generously). The form is buffered whole before it is read, so the bound
 * is the content's, not 50 files' worth.
 */
export const CONFLICTS_FORM_MAX_BYTES = 2 * MAX_RESOLUTION_BYTES + 512 * 1024;

/**
 * Whether a loader's failure is one to show as the error page: a redirect
 * (signed out) or a pull request not found. Any other (the API down, a
 * fetch refused, a limit) is shown on the page, which keeps its editors.
 */
function fatal(error: unknown): boolean {
  if (error instanceof Response) return true;
  return (error as { init?: { status?: number } } | null)?.init?.status === 404;
}

/**
 * The pull request and its conflicts, read again after every change: a read
 * that fails answers `failure` (never throws, but for a redirect or a pull
 * request not found), so a page re-read in the background keeps the edits
 * it holds.
 */
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const number = pullNumber(params.number);
  const base = { owner: params.owner, repo: params.repo, number };
  let loaded: Awaited<ReturnType<typeof loadPull>>;
  try {
    loaded = await loadPull(context, request, params);
  } catch (error) {
    if (fatal(error)) throw error;
    return {
      ...base,
      pull: null,
      viewer: null,
      conflicts: null,
      failure: "The pull request could not be read; try again.",
    };
  }
  const { pull, viewer } = loaded;
  if (pull.state !== "open") return { ...base, pull, viewer, conflicts: null, failure: null };
  let read: Awaited<ReturnType<typeof apiCall<Conflicts>>>;
  try {
    read = await apiCall<Conflicts>(context, request, "GET", `${pullApiOf(params)}/conflicts`);
  } catch {
    return {
      ...base,
      pull,
      viewer,
      conflicts: null,
      failure: "The conflicts could not be read; try again.",
    };
  }
  if (read.status === 401) throw redirect(signInUrl(request));
  if (read.status !== 200)
    return {
      ...base,
      pull,
      viewer,
      conflicts: null,
      failure: problemDetail(read.body, "The conflicts could not be read; try again."),
    };
  return {
    ...base,
    pull,
    viewer,
    conflicts: {
      ...read.body,
      files: read.body.files.map((f) => ({
        ...f,
        ending: f.content === null ? ("lf" as LineEnding) : lineEnding(f.content),
      })),
    },
    failure: null,
  };
}

type Answer =
  | { error: string; stale?: boolean; snapshot?: string; ok?: undefined }
  | {
      ok: true;
      sha: string;
      markers: string[];
      error?: undefined;
      stale?: undefined;
      snapshot?: undefined;
    };

export async function action({ request, context, params }: Route.ActionArgs): Promise<Answer> {
  assertSameOrigin(request);
  // Signed in before a large form is read.
  if (!(await signedInUser(context, request))) throw redirect(signInUrl(request));
  const form = await readForm(request, CONFLICTS_FORM_MAX_BYTES);
  const snapshot = field(form, "conflict_snapshot");
  if (!/^[0-9a-f]{80}$/.test(snapshot)) return { error: "Read the conflicts again.", stale: true };
  const count = Number(field(form, "count"));
  if (!Number.isInteger(count) || count < 0 || count > MAX_FILES)
    return { error: "Too many files to resolve here.", snapshot };
  const files: { path: string; content: string }[] = [];
  const encoder = new TextEncoder();
  let total = 0;
  for (let i = 0; i < count; i++) {
    const path = rawField(form, `path:${i}`);
    if (!path) return { error: "A file of the resolution is missing.", snapshot };
    const ending = field(form, `eol:${i}`);
    const content = withLineEndings(
      rawField(form, `content:${i}`),
      ending === "crlf" ? "crlf" : ending === "mixed" ? "mixed" : "lf",
    );
    const bytes = encoder.encode(content).length;
    if (bytes > MAX_FILE_BYTES)
      return { error: `${path} is larger than 1 MiB: merge it locally.`, snapshot };
    total += bytes;
    if (total > MAX_RESOLUTION_BYTES)
      return {
        error: "The resolved files are larger than 4 MiB in all: merge them locally.",
        snapshot,
      };
    files.push({ path, content });
  }
  const message = rawField(form, "commit_message");
  // As sent: escaping (a line break is two characters, a control character six) can take
  // content within its limits past what the API reads.
  const json = JSON.stringify({
    conflict_snapshot: snapshot,
    files,
    ...(message.trim() && { commit_message: message }),
  });
  if (utf8Length(json) > API_MAX_JSON_BODY_BYTES)
    return {
      error:
        "These files are too large to send in one resolution: merge the base branch into the head with git instead.",
      snapshot,
    };
  // Whatever goes wrong from here is answered (never thrown, which would replace the
  // editors with the error page): what the API did is told apart from what is not known.
  let res: Response;
  try {
    res = await apiFetch(context, request, "POST", `${pullApiOf(params)}/conflicts`, json);
  } catch {
    return {
      error:
        "No answer came back: the merge may or may not have been made. Look at the pull request before sending it again.",
      snapshot,
    };
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.status === 201)
    return isMerge(body)
      ? { ok: true, sha: body.sha, markers: body.markers }
      : {
          error: "The merge was made, but its answer could not be read: look at the pull request.",
          snapshot,
        };
  const code = problemCode(body);
  return {
    error: problemDetail(body, "The conflicts were not resolved."),
    stale: code === "head_moved" || code === "base_moved",
    snapshot,
  };
}

/** The API's answer to a resolution: the merge commit, and the files still holding markers. */
function isMerge(body: unknown): body is { sha: string; markers: string[] } {
  if (typeof body !== "object" || body === null || !("sha" in body) || !("markers" in body))
    return false;
  const { sha, markers } = body;
  return (
    typeof sha === "string" && Array.isArray(markers) && markers.every((m) => typeof m === "string")
  );
}

/** What the editor works on: the conflicts as read, and the branch names their markers carry. */
interface Editing {
  conflicts: NonNullable<Route.ComponentProps["loaderData"]["conflicts"]>;
  labels: { head: string; base: string };
  /** Bumped by each re-read, so the editors start again from the text read. */
  generation: number;
}

export default function PullConflicts({ loaderData }: Route.ComponentProps) {
  const answer = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const { owner, repo, number, conflicts, failure } = loaderData;
  // The pull request as last read: a read that failed (no pull request) keeps the page as it was.
  const known = useRef({ pull: loaderData.pull, viewer: loaderData.viewer });
  if (loaderData.pull) known.current = { pull: loaderData.pull, viewer: loaderData.viewer };
  const { pull, viewer } = known.current;
  const page = pullPage(owner, repo, number);
  const read = (generation: number): Editing | null =>
    pull && conflicts && conflicts.files.length > 0
      ? { conflicts, labels: { head: pull.head.ref, base: pull.base.ref }, generation }
      : null;
  // The editors keep the conflicts they were opened on, snapshot and text together: a later
  // read (after a refusal, or any revalidation) replaces them only when asked, and a failed
  // read never does.
  const [editing, setEditing] = useState<Editing | null>(() => read(0));
  const [drafts, setDrafts] = useState<{ path: string; content: string }[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const view = conflictsView({
    adopted: editing?.conflicts.conflict_snapshot ?? null,
    latest: conflicts && conflicts.files.length > 0 ? conflicts.conflict_snapshot : null,
    failure,
    open: pull?.state === "open",
    answer,
  });
  const readAgain = () => {
    // A failed read is asked for again; the editors stay as they are meanwhile.
    if (view.readAgain === "revalidate") return void revalidator.revalidate();
    // The text edited so far stays at hand, apart from the fresh conflicts.
    if (form.current) {
      const data = new FormData(form.current);
      const count = Number(data.get("count") ?? 0);
      const kept: { path: string; content: string }[] = [];
      for (let i = 0; i < count; i++)
        kept.push({
          path: String(data.get(`path:${i}`) ?? ""),
          content: String(data.get(`content:${i}`) ?? ""),
        });
      setDrafts(kept);
    }
    setEditing(read((editing?.generation ?? 0) + 1));
  };
  const files = editing?.conflicts.files ?? [];
  const editable = files.filter(
    (f): f is typeof f & { content: string } => f.editable && f.content !== null,
  );
  const stuck = files.filter((f) => !f.editable || f.content === null);
  // Not read yet at all (the first read failed): what failed, and a way to try again.
  if (!pull)
    return (
      <main className="wide">
        <h1>Conflicts of pull request #{number}</h1>
        <p className="error" role="alert">
          {failure}
        </p>
        <button
          type="button"
          onClick={() => void revalidator.revalidate()}
          disabled={revalidator.state !== "idle"}
        >
          Try again
        </button>
      </main>
    );
  return (
    <main className="wide">
      <PullHeader owner={owner} repo={repo} pull={pull} viewer={viewer} active="conflicts" />
      {answer?.ok && (
        <div className="panel" role="status">
          <p>
            Resolved: the base branch was merged into <code>{pull.head.ref}</code> as{" "}
            <code>{answer.sha.slice(0, 7)}</code>.
          </p>
          {answer.markers.length > 0 && (
            <p className="error">
              These files still hold conflict markers: {answer.markers.join(", ")}.
            </p>
          )}
          <p>
            <Link to={page}>Back to the conversation</Link>
          </p>
        </div>
      )}
      {answer?.error && view.showRefusal && (
        <p className="error" role="alert">
          {answer.error}
        </p>
      )}
      {failure !== null && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      {failure !== null && !view.editors && (
        <p>
          <button
            type="button"
            onClick={() => void revalidator.revalidate()}
            disabled={revalidator.state !== "idle"}
          >
            Try again
          </button>
        </p>
      )}
      {(view.moved || (failure !== null && view.editors)) && (
        <div className="panel" role="status">
          <p className="error">
            {view.moved
              ? "The branches have moved since these conflicts were read: what you edit here is of the older conflicts, and will not be merged."
              : "The conflicts could not be read again: your edits are kept here, but cannot be sent until they are."}
          </p>
          <button type="button" onClick={readAgain} disabled={revalidator.state !== "idle"}>
            Read the conflicts again
          </button>
        </div>
      )}
      {drafts.length > 0 && (
        <details className="panel">
          <summary>Your edits to the earlier conflicts</summary>
          {drafts.map((d, i) => (
            <div key={d.path}>
              <label htmlFor={`draft-${i}`}>{d.path} (earlier edit, to copy from)</label>
              <textarea id={`draft-${i}`} readOnly value={d.content} className="short" />
            </div>
          ))}
        </details>
      )}
      {pull.state !== "open" && !answer?.ok && (
        <p className="muted">Only an open pull request's conflicts are resolved here.</p>
      )}
      {answer?.ok || !view.editors || editing === null ? (
        !answer?.ok &&
        pull.state === "open" &&
        failure === null &&
        editing === null &&
        !view.moved && (
          <p className="ok-text">
            No conflicts: the head merges cleanly with the base branch.{" "}
            <Link to={page}>Back to the conversation</Link>
          </p>
        )
      ) : (
        <>
          <p>
            Merging <code>{editing.labels.base}</code> ({editing.conflicts.base_sha.slice(0, 7)})
            into <code>{editing.labels.head}</code> ({editing.conflicts.head_sha.slice(0, 7)})
            conflicts in {files.length} file
            {files.length === 1 ? "" : "s"}.
          </p>
          {stuck.length > 0 && (
            <section className="panel" aria-labelledby="stuck">
              <h2 id="stuck">Conflicts to resolve on your machine</h2>
              <p>
                These cannot be edited here. Merge the base branch into the head with git, resolve
                them and push:
              </p>
              <ul>
                {stuck.map((f) => (
                  <li key={f.path}>
                    <code className="file-name-inline">{f.path}</code>: {KIND_TEXT[f.kind]}
                  </li>
                ))}
              </ul>
              <pre>{`git fetch origin\ngit switch ${shellQuote(editing.labels.head)}\ngit merge ${shellQuote(`origin/${editing.labels.base}`)}`}</pre>
              {pull.head_repo_id !== null && (
                <p className="muted">The head branch is in a fork: push the merge there.</p>
              )}
            </section>
          )}
          {editable.length > 0 && (
            <Form
              method="post"
              // Multipart: content goes as its bytes, not URL-encoded (three times the size).
              encType="multipart/form-data"
              ref={form}
              key={`${editing.conflicts.conflict_snapshot}:${editing.generation}`}
            >
              <input
                type="hidden"
                name="conflict_snapshot"
                value={editing.conflicts.conflict_snapshot}
              />
              <input type="hidden" name="count" value={editable.length} />
              {editable.map((f, i) => (
                <div key={f.path}>
                  <input type="hidden" name={`eol:${i}`} value={f.ending} />
                  {f.ending === "mixed" && (
                    <p className="muted">
                      {f.path} mixes line endings: it is saved with LF line endings.
                    </p>
                  )}
                  <ConflictEditor file={f} index={i} labels={editing.labels} />
                </div>
              ))}
              <label htmlFor="commit-message">Commit message (optional)</label>
              <input
                id="commit-message"
                name="commit_message"
                size={60}
                placeholder={`Merge branch '${editing.labels.base}' into ${editing.labels.head}`}
              />
              <p className="row">
                <button
                  type="submit"
                  className="primary"
                  disabled={stuck.length > 0 || !view.canSubmit || navigation.state !== "idle"}
                  aria-describedby={stuck.length > 0 ? "stuck" : undefined}
                >
                  Commit merge
                </button>
                {stuck.length > 0 && (
                  <span className="muted">
                    The conflicts above must be resolved on your machine first.
                  </span>
                )}
              </p>
            </Form>
          )}
        </>
      )}
    </main>
  );
}
