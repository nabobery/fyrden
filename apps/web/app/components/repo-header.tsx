import { useState } from "react";
import { Link } from "react-router";
import type { Repo } from "../lib/types.js";

/** A repository's name, its pages, and how to clone it. */
export function RepoHeader({
  repo,
  origin,
  active,
}: {
  repo: Repo;
  origin: string;
  active: "code" | "commits" | "pulls" | "settings";
}) {
  const cloneUrl = `${origin}/${repo.owner}/${repo.name}.git`;
  const [copied, setCopied] = useState(false);
  const base = `/${repo.owner}/${repo.name}`;
  return (
    <>
      <h1>
        <Link to={`/`}>{repo.owner}</Link> / <Link to={base}>{repo.name}</Link>
      </h1>
      {repo.description && <p className="muted">{repo.description}</p>}
      <nav aria-label="Repository" className="row">
        <Link to={base} aria-current={active === "code" ? "page" : undefined}>
          Code
        </Link>
        <Link to={`${base}/commits`} aria-current={active === "commits" ? "page" : undefined}>
          Commits
        </Link>
        <Link to={`${base}/pulls`} aria-current={active === "pulls" ? "page" : undefined}>
          Pull requests
        </Link>
        <Link to={`${base}/settings`} aria-current={active === "settings" ? "page" : undefined}>
          Settings
        </Link>
      </nav>
      <div className="panel">
        <label htmlFor="clone-url">Clone with HTTPS</label>
        <div className="row">
          <input id="clone-url" readOnly value={cloneUrl} size={Math.min(cloneUrl.length, 60)} />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(cloneUrl).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="muted">
          git asks for a password: use a <Link to="/settings/tokens">git token</Link> (any user
          name).
        </p>
      </div>
    </>
  );
}
