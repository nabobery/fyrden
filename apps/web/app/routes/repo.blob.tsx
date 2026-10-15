import { Link, redirect } from "react-router";
import { Markdown } from "../components/markdown.js";
import { apiGet } from "../lib/api.server.js";
import { dirOf, renderMarkdown } from "../lib/markdown.js";
import { refAndPath } from "../lib/target.js";
import { type Contents, decodeText, encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.blob";

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${loaderData?.path} · ${params.owner}/${params.repo} · Fyrden` }];
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
  return {
    owner: params.owner,
    repo: params.repo,
    ref,
    path,
    kind: contents.type,
    size: contents.type === "file" ? contents.size : null,
    target: contents.type === "symlink" ? contents.target : null,
    text: text ?? null,
    html:
      text !== undefined && /\.(md|markdown)$/i.test(path)
        ? renderMarkdown(text, {
            base: `/${params.owner}/${params.repo}`,
            ref: encodeURIComponent(ref),
            dir: dirOf(path),
          })
        : null,
  };
}

export default function Blob({ loaderData }: Route.ComponentProps) {
  const { owner, repo, ref, path, kind, size, target, text, html } = loaderData;
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
      {kind === "symlink" ? (
        <p>
          A symbolic link to <code>{target}</code>
        </p>
      ) : html !== null ? (
        <div className="panel">
          <Markdown html={html} />
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
