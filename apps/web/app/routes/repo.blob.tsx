import { Link } from "react-router";
import { Markdown } from "../components/markdown.js";
import { apiGet } from "../lib/api.server.js";
import { renderMarkdown } from "../lib/markdown.js";
import { type Contents, decodeText, encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.blob";

export function meta({ params }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `${params["*"]} · ${params.owner}/${params.repo} · Fyrden` }];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const path = params["*"] ?? "";
  const base = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
  const contents = await apiGet<Contents>(
    context,
    request,
    `${base}/contents/${encodePath(path)}?ref=${encodeURIComponent(params.ref)}`,
  );
  if (contents.type === "dir") throw new Response("A directory", { status: 404 });
  const text =
    contents.type === "file" && contents.encoding === "base64"
      ? decodeText(contents.content)
      : undefined;
  return {
    owner: params.owner,
    repo: params.repo,
    ref: params.ref,
    path,
    kind: contents.type,
    size: contents.type === "file" ? contents.size : null,
    target: contents.type === "symlink" ? contents.target : null,
    text: text ?? null,
    html: text !== undefined && /\.(md|markdown)$/i.test(path) ? renderMarkdown(text) : null,
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
