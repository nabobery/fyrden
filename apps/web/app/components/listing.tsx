import { Link } from "react-router";
import { type Entry, encodePath } from "../lib/types.js";

/** A directory's entries, linked to their pages. */
export function Listing({
  owner,
  repo,
  gitRef,
  entries,
}: {
  owner: string;
  repo: string;
  gitRef: string;
  entries: Entry[];
}) {
  const base = `/${owner}/${repo}`;
  const ref = encodeURIComponent(gitRef);
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Kind</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.path}>
            <td>
              {e.type === "dir" ? (
                <Link to={`${base}/tree/${ref}/${encodePath(e.path)}`}>{e.name}/</Link>
              ) : e.type === "file" || e.type === "symlink" ? (
                <Link to={`${base}/blob/${ref}/${encodePath(e.path)}`}>{e.name}</Link>
              ) : (
                <span>{e.name}</span>
              )}
            </td>
            <td className="muted">{e.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
