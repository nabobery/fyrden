import { Form, Link, redirect, useActionData, useNavigation } from "react-router";
import { ConflictEditor } from "../components/conflict-editor.js";
import { PullHeader } from "../components/pull-header.js";
import { apiCall, assertSameOrigin, readForm, signedInUser, signInUrl } from "../lib/api.server.js";
import {
  type Conflicts,
  KIND_TEXT,
  type LineEnding,
  lineEnding,
  shellQuote,
  withLineEndings,
} from "../lib/conflicts.js";
import { field, problemCode, problemDetail, pullPage, rawField } from "../lib/pulls.js";
import { loadPull, pullApiOf } from "../lib/pulls.server.js";
import type { Route } from "./+types/repo.pull.conflicts";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  const title = loaderData?.pull.title ?? `#${params.number}`;
  return [{ title: `Conflicts · ${title} · ${params.owner}/${params.repo} · Fyrden` }];
}

/** Editable files a resolution carries at most (the API's limit). */
const MAX_FILES = 50;
/** The editor's form at most: 50 files of 1 MiB, URL-encoded (up to 3 bytes for each), and the rest. */
const CONFLICTS_FORM_MAX_BYTES = 3 * MAX_FILES * 1024 * 1024 + 64 * 1024;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { pull, viewer } = await loadPull(context, request, params);
  const base = {
    owner: params.owner,
    repo: params.repo,
    pull,
    viewer,
  };
  if (pull.state !== "open") return { ...base, conflicts: null, failure: null };
  const read = await apiCall<Conflicts>(context, request, "GET", `${pullApiOf(params)}/conflicts`);
  if (read.status === 401) throw redirect(signInUrl(request));
  if (read.status !== 200)
    return {
      ...base,
      conflicts: null,
      failure: problemDetail(read.body, "The conflicts could not be read; try again."),
    };
  return {
    ...base,
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
  | { error: string; stale?: boolean; ok?: undefined }
  | { ok: true; sha: string; markers: string[]; error?: undefined };

export async function action({ request, context, params }: Route.ActionArgs): Promise<Answer> {
  assertSameOrigin(request);
  // Signed in before a large form is read.
  if (!(await signedInUser(context, request))) throw redirect(signInUrl(request));
  const form = await readForm(request, CONFLICTS_FORM_MAX_BYTES);
  const snapshot = field(form, "conflict_snapshot");
  if (!/^[0-9a-f]{80}$/.test(snapshot)) return { error: "Read the conflicts again.", stale: true };
  const count = Number(field(form, "count"));
  if (!Number.isInteger(count) || count < 0 || count > MAX_FILES)
    return { error: "Too many files to resolve here." };
  const files: { path: string; content: string }[] = [];
  for (let i = 0; i < count; i++) {
    const path = rawField(form, `path:${i}`);
    if (!path) return { error: "A file of the resolution is missing." };
    const ending = field(form, `eol:${i}`);
    files.push({
      path,
      content: withLineEndings(
        rawField(form, `content:${i}`),
        ending === "crlf" ? "crlf" : ending === "mixed" ? "mixed" : "lf",
      ),
    });
  }
  const message = rawField(form, "commit_message");
  const result = await apiCall<{ sha: string; markers: string[] }>(
    context,
    request,
    "POST",
    `${pullApiOf(params)}/conflicts`,
    { conflict_snapshot: snapshot, files, ...(message.trim() && { commit_message: message }) },
  );
  if (result.status === 201)
    return { ok: true, sha: result.body.sha, markers: result.body.markers };
  const code = problemCode(result.body);
  return {
    error: problemDetail(result.body, "The conflicts were not resolved."),
    stale: code === "head_moved" || code === "base_moved",
  };
}

export default function PullConflicts({ loaderData }: Route.ComponentProps) {
  const answer = useActionData<typeof action>();
  const navigation = useNavigation();
  const { owner, repo, pull, viewer, conflicts, failure } = loaderData;
  const page = pullPage(owner, repo, pull.number);
  const editable = conflicts?.files.filter(
    (f): f is typeof f & { content: string } => f.editable && f.content !== null,
  );
  const stuck = conflicts?.files.filter((f) => !f.editable || f.content === null) ?? [];
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
      {answer?.error && (
        <p className="error" role="alert">
          {answer.error} {answer.stale && <Link to=".">Read the conflicts again</Link>}
        </p>
      )}
      {pull.state !== "open" ? (
        <p className="muted">Only an open pull request's conflicts are resolved here.</p>
      ) : failure !== null ? (
        <p className="error">{failure}</p>
      ) : conflicts === null || conflicts.files.length === 0 ? (
        !answer?.ok && (
          <p className="ok-text">
            No conflicts: the head merges cleanly with the base branch.{" "}
            <Link to={page}>Back to the conversation</Link>
          </p>
        )
      ) : (
        <>
          <p>
            Merging <code>{pull.base.ref}</code> ({conflicts.base_sha.slice(0, 7)}) into{" "}
            <code>{pull.head.ref}</code> ({conflicts.head_sha.slice(0, 7)}) conflicts in{" "}
            {conflicts.files.length} file{conflicts.files.length === 1 ? "" : "s"}.
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
              <pre>{`git fetch origin\ngit switch ${shellQuote(pull.head.ref)}\ngit merge ${shellQuote(`origin/${pull.base.ref}`)}`}</pre>
              {pull.head_repo_id !== null && (
                <p className="muted">The head branch is in a fork: push the merge there.</p>
              )}
            </section>
          )}
          {editable && editable.length > 0 && (
            <Form method="post">
              <input type="hidden" name="conflict_snapshot" value={conflicts.conflict_snapshot} />
              <input type="hidden" name="count" value={editable.length} />
              {editable.map((f, i) => (
                <div key={f.path}>
                  <input type="hidden" name={`eol:${i}`} value={f.ending} />
                  {f.ending === "mixed" && (
                    <p className="muted">
                      {f.path} mixes line endings: it is saved with LF line endings.
                    </p>
                  )}
                  <ConflictEditor file={f} index={i} />
                </div>
              ))}
              <label htmlFor="commit-message">Commit message (optional)</label>
              <input
                id="commit-message"
                name="commit_message"
                size={60}
                placeholder={`Merge branch '${pull.base.ref}' into ${pull.head.ref}`}
              />
              <p className="row">
                <button
                  type="submit"
                  className="primary"
                  disabled={stuck.length > 0 || navigation.state !== "idle"}
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
