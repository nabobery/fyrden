import type { getCodeOwnersErrors, Output } from "@fyrden/api-contract";
import { Link, redirect } from "react-router";
import { Markdown } from "../components/markdown.js";
import { apiCall, apiGet } from "../lib/api.server.js";
import { dirOf } from "../lib/markdown-place.js";
import { refAndPath } from "../lib/target.js";
import { type Contents, decodeText, encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.blob";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData?.path} · ${params.owner}/${params.repo} · Fyrden` }];
}

/** Where GitHub reads a CODEOWNERS file, the first that holds one in effect. */
const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

type CodeOwnersErrors = Output<typeof getCodeOwnersErrors>;

/**
 * What the blob view says of a CODEOWNERS file at `ref`: its errors when
 * it is the file in effect, read at the same blob (`sha`); else which
 * file is, or that the ref moved between the two reads, or that they could
 * not be read (the file is shown all the same). Null when no file is in
 * effect there.
 */
async function codeOwnersOf(
  context: Parameters<typeof apiCall>[0],
  request: Request,
  base: string,
  ref: string,
  path: string,
  sha: string,
): Promise<
  | { kind: "errors"; errors: CodeOwnersErrors["errors"]; truncated: boolean }
  | { kind: "elsewhere"; path: string }
  | { kind: "moved" }
  | { kind: "unavailable" }
  | null
> {
  let answer: Awaited<ReturnType<typeof apiCall<CodeOwnersErrors>>>;
  try {
    answer = await apiCall<CodeOwnersErrors>(
      context,
      request,
      "GET",
      `${base}/codeowners/errors?ref=${encodeURIComponent(ref)}`,
    );
  } catch {
    // Not reached, or an answer that could not be read: the file is shown all the same.
    return { kind: "unavailable" };
  }
  // No file in effect at that ref: nothing to say.
  if (answer.status === 404) return null;
  if (answer.status !== 200) return { kind: "unavailable" };
  if (!answer.body.file) return null;
  if (answer.body.file.path !== path) return { kind: "elsewhere", path: answer.body.file.path };
  if (answer.body.file.sha !== sha) return { kind: "moved" };
  return { kind: "errors", errors: answer.body.errors, truncated: answer.body.truncated === true };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const contents = await apiGet<Contents>(
    context,
    request,
    `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  // A directory (a README's link without a trailing slash): its listing.
  if (contents.type === "dir")
    throw redirect(
      `/${params.owner}/${params.repo}/tree/${encodeURIComponent(ref)}/${encodePath(path)}`,
    );
  const text =
    contents.type === "file" && contents.encoding === "base64"
      ? decodeText(contents.content)
      : undefined;
  const codeOwners =
    contents.type === "file" && CODEOWNERS_PATHS.includes(path)
      ? await codeOwnersOf(context, request, base, ref, path, contents.sha)
      : null;
  return {
    owner: params.owner,
    repo: params.repo,
    ref,
    path,
    codeOwners,
    kind: contents.type,
    size: contents.type === "file" ? contents.size : null,
    target: contents.type === "symlink" ? contents.target : null,
    text: text ?? null,
    // Rendered in the browser (see components/markdown.tsx), with its links into the repository.
    markdownAt:
      text !== undefined && /\.(md|markdown)$/i.test(path)
        ? {
            base: `/${params.owner}/${params.repo}`,
            ref: encodeURIComponent(ref),
            dir: dirOf(path),
          }
        : null,
  };
}

export default function Blob({ loaderData }: Route.ComponentProps) {
  const { owner, repo, ref, path, kind, size, target, text, markdownAt, codeOwners } = loaderData;
  const base = `/${owner}/${repo}`;
  const at = `${encodeURIComponent(ref)}/${encodePath(path)}`;
  return (
    <main>
      <h1>
        <Link to={base}>
          {owner}/{repo}
        </Link>{" "}
        <span className="muted">
          @ {ref} / {path}
        </span>
      </h1>
      <div className="row">
        {kind === "file" && (
          <a className="button" href={`${base}/raw/${at}`}>
            Raw
          </a>
        )}
        {kind === "file" && text !== null && (
          <Link className="button" to={`${base}/edit/${at}`}>
            Edit
          </Link>
        )}
        {size !== null && <span className="muted">{size} bytes</span>}
      </div>
      {codeOwners && <CodeOwnersNotes notes={codeOwners} owner={owner} repo={repo} gitRef={ref} />}
      {kind === "symlink" ? (
        <p>
          A symbolic link to <code>{target}</code>
        </p>
      ) : text !== null && markdownAt !== null ? (
        <div className="panel">
          <Markdown source={text} at={markdownAt} />
        </div>
      ) : text !== null ? (
        <pre>
          <code>{text}</code>
        </pre>
      ) : (
        <p className="muted">This file is binary or too large to show; download it raw.</p>
      )}
    </main>
  );
}

/** What this CODEOWNERS file's errors are, or why they are not shown here. */
function CodeOwnersNotes({
  notes,
  owner,
  repo,
  gitRef,
}: {
  notes: NonNullable<Awaited<ReturnType<typeof codeOwnersOf>>>;
  owner: string;
  repo: string;
  gitRef: string;
}) {
  if (notes.kind === "elsewhere")
    return (
      <p className="panel muted">
        {"Not the CODEOWNERS file in effect here: "}
        <Link to={`/${owner}/${repo}/blob/${encodeURIComponent(gitRef)}/${encodePath(notes.path)}`}>
          <code>{notes.path}</code>
        </Link>
        {" is (GitHub reads .github/, the root, then docs/)."}
      </p>
    );
  if (notes.kind === "unavailable")
    return <p className="panel muted">This file's CODEOWNERS errors could not be read just now.</p>;
  if (notes.kind === "moved")
    return (
      <p className="panel muted">
        {`${gitRef} moved while this page was read: reload it to see this file's errors.`}
      </p>
    );
  return (
    <section className="panel" aria-labelledby="codeowners-errors">
      <h2 id="codeowners-errors">CODEOWNERS errors</h2>
      {notes.errors.length === 0 ? (
        <p className="muted">None: every line is valid.</p>
      ) : (
        <ul className="label-list" aria-label="Errors">
          {notes.errors.map((error, at) => (
            // In line order, never reordered: one line may hold two alike.
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
            <li key={at}>
              <p>
                <strong>{error.line === 0 ? "The file" : `Line ${error.line}`}</strong>
                {`: ${error.message}`} <span className="muted">{`(${error.kind})`}</span>
              </p>
              {error.source && (
                <pre>
                  <code>{error.source}</code>
                </pre>
              )}
              {error.suggestion && <p className="muted">{`Did you mean: ${error.suggestion}`}</p>}
            </li>
          ))}
        </ul>
      )}
      {notes.truncated && (
        <p className="muted">More errors than one page holds: these are the first.</p>
      )}
    </section>
  );
}
