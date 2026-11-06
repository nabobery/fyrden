import type { getCodeOwnersErrors, Output } from "@fyrden/api-contract";
import { data, Link, redirect } from "react-router";
import { FilePreview } from "../components/file-preview.js";
import { NumberedFile } from "../components/file-view.js";
import { Markdown } from "../components/markdown.js";
import { apiCall, bodyOf } from "../lib/api.server.js";
import { type FileState, fileState, gotoTarget, rawBytesUrl } from "../lib/file-view.js";
import { dirOf } from "../lib/markdown-place.js";
import { previewOf, previewUrl } from "../lib/raster.js";
import { pageUrl, refAndPath } from "../lib/target.js";
import { type Contents, encodePath } from "../lib/types.js";
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
  const answer = await apiCall<Contents>(
    context,
    request,
    "GET",
    `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
  );
  // A commit that deleted a file links here from its history, so this page leads back to it.
  if (answer.status === 404)
    return data(
      { kind: "missing" as const, owner: params.owner, repo: params.repo, ref, path },
      { status: 404 },
    );
  const contents = bodyOf(answer, request);
  // A directory (a README's link without a trailing slash): its listing.
  if (contents.type === "dir")
    throw redirect(
      `/${params.owner}/${params.repo}/tree/${encodeURIComponent(ref)}/${encodePath(path)}`,
    );
  const page = pageUrl(new URL(request.url));
  const markdown = /\.(md|markdown)$/i.test(path);
  const file = fileState(contents, page.searchParams, { markdown });
  if (page.searchParams.has("goto"))
    throw redirect(gotoTarget(page, file.state === "text" ? file.totalLines : null));
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
    file,
    // Bytes that decode as text are shown as text, though they start like an image: a browser
    // draws text with a GIF's header as a blank image. PNG and JPEG never decode so; a GIF with
    // no frames or no final NUL can, and is left to Raw.
    preview:
      contents.type === "file" && file.state !== "text" && file.state !== "markdown"
        ? previewOf(contents, path)
        : null,
    // Rendered in the browser (see components/markdown.tsx), with its links into the repository.
    markdownAt:
      file.state === "markdown"
        ? {
            base: `/${params.owner}/${params.repo}`,
            ref: encodeURIComponent(ref),
            dir: dirOf(path),
          }
        : null,
  };
}

/** What the page says of a file it has no lines to show for. */
const MESSAGES: Partial<Record<FileState["state"], string>> = {
  empty: "This file is empty.",
  binary: "This is a binary file.",
  undecodable: "This file isn't valid UTF-8.",
  "too-large": "This file is too large to show here.",
  "too-large-for-raw": "This file is too large to view or download here.",
};

export default function Blob({ loaderData }: Route.ComponentProps) {
  if (loaderData.kind === "missing") {
    const { owner, repo, ref, path } = loaderData;
    const history = `/${owner}/${repo}/commits/${encodeURIComponent(ref)}/${encodePath(path)}`;
    return (
      <main>
        <h1>Not found</h1>
        <p>
          This file doesn't exist at <code>{ref}</code>.
        </p>
        <p>
          <Link to={history}>See this path's history</Link>
        </p>
      </main>
    );
  }
  const { owner, repo, ref, path, kind, size, file, preview, markdownAt, codeOwners } = loaderData;
  const base = `/${owner}/${repo}`;
  const at = `${encodeURIComponent(ref)}/${encodePath(path)}`;
  const message = MESSAGES[file.state];
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
        {kind === "file" && file.state !== "too-large-for-raw" && (
          <a className="button" href={rawBytesUrl(owner, repo, ref, path)}>
            Raw
          </a>
        )}
        {(file.state === "text" || file.state === "markdown" || file.state === "empty") && (
          <Link className="button" to={`${base}/edit/${at}`}>
            Edit
          </Link>
        )}
        {file.state === "markdown" && (
          <a className="button" href="?plain=1">
            Source
          </a>
        )}
        <Link className="button" to={`${base}/commits/${at}`}>
          History
        </Link>
        {size !== null && <span className="muted">{size} bytes</span>}
      </div>
      {codeOwners && <CodeOwnersNotes notes={codeOwners} owner={owner} repo={repo} gitRef={ref} />}
      {preview?.kind === "image" ? (
        <FilePreview
          src={previewUrl(base, preview.commit, path)}
          alt={path}
          width={preview.width}
          height={preview.height}
        />
      ) : preview?.kind === "image-too-large" ? (
        <p className="muted">This image is too large to preview.</p>
      ) : file.state === "symlink" ? (
        <p>
          A symbolic link to <code>{file.target}</code>.
        </p>
      ) : file.state === "submodule" ? (
        <p>
          A submodule at commit <code>{file.sha}</code>.
        </p>
      ) : file.state === "markdown" && markdownAt !== null ? (
        <div className="panel">
          <Markdown source={file.source} at={markdownAt} />
        </div>
      ) : file.state === "text" ? (
        <NumberedFile
          // Another file or commit: its selection and drawing start over.
          key={`${file.sha}/${path}/${file.plain}`}
          file={file}
          owner={owner}
          repo={repo}
          gitRef={ref}
          path={path}
        />
      ) : (
        <p className="muted">{message}</p>
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
