/**
 * One window of a blamed file as a plain table, which works with no script at all: each group
 * of lines under a row saying which commit they came from, or why that isn't known. Every link
 * is native and names the commit blamed, so the page keeps showing one version however its
 * branch moves.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import {
  authorDate,
  type BlameView,
  type CommitFacts,
  displayGroups,
  type Group,
  historyPath,
  unresolvedSentence,
} from "../lib/blame.js";
import { type LineRange, lineLink, lineParam, rawBytesUrl } from "../lib/file-view.js";

/** `at` with `query`, its empty values left out. */
function withQuery(at: string, query: Record<string, string | null>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) if (value !== null) search.set(name, value);
  const text = search.toString();
  return text ? `${at}?${text}` : at;
}

export const count = (n: number) => n.toLocaleString("en");

/** What a group's row says: its commit's summary, author and date, or why it has none. */
export function GroupLabel({
  group,
  facts,
  history,
}: {
  group: Group;
  facts: CommitFacts | undefined;
  /** The commit's history of this path: the link its summary leads to. */
  history: string;
}) {
  if (group.kind === "pending") return <span className="muted">Not worked out yet.</span>;
  if (group.kind === "unresolved") return <span>{unresolvedSentence(group.reason)}</span>;
  const short = group.commit.slice(0, 7);
  return (
    <>
      <Link to={history}>{facts?.summary || short}</Link>{" "}
      {facts && (
        <span className="muted">
          {facts.author.name}, {authorDate(facts.author.date)}
        </span>
      )}{" "}
      <code>{short}</code>
    </>
  );
}

/**
 * The page's blame. `progress` takes the place of the server's own line and Continue link once
 * the script runs; `rows` is false while the renderer draws the file instead; `selection` is
 * the script's, which may have moved from the query's.
 */
export function BlameTable({
  view,
  at,
  progress,
  rows = true,
  selection = view.selected,
}: {
  view: BlameView;
  at: string;
  progress?: ReactNode;
  rows?: boolean;
  selection?: LineRange | null;
}) {
  const { owner, repo, commit, path, blame, window: shown } = view;
  const selected = selection;
  const groups = displayGroups(blame.ranges, shown.firstLine, shown.lastLine);
  const lines = new Map(shown.lines.map((line) => [line.number, line.text]));
  const keep = lineParam(selected);
  const settled = blame.resolved + blame.unresolved;
  const digits = String(blame.lines).length;
  const paging = (label: string) =>
    rows &&
    !view.whole && (
      <nav className="row file-paging" aria-label={label}>
        {shown.previous !== null && (
          <a href={withQuery(at, { from: String(shown.previous), line: keep })}>Previous</a>
        )}
        <span className="muted">
          {`Lines ${count(shown.firstLine)} to ${count(shown.lastLine)} of ${count(blame.lines)}`}
        </span>
        {shown.next !== null && (
          <a href={withQuery(at, { from: String(shown.next), line: keep })}>Next</a>
        )}
      </nav>
    );
  return (
    <>
      {progress !== undefined ? (
        progress
      ) : blame.state === "partial" ? (
        <p className="row">
          <span role="status">{`${count(settled)} of ${count(blame.lines)} lines worked out so far.`}</span>
          {/* The same window again, at the commit: each request walks further. */}
          <a className="button" href={withQuery(at, { from: String(shown.firstLine), line: keep })}>
            Continue
          </a>
        </p>
      ) : (
        blame.unresolved > 0 && (
          <p className="notice">
            {`${count(blame.unresolved)} of ${count(blame.lines)} lines couldn't be attributed: their rows say why.`}
          </p>
        )
      )}
      <form method="get" action={at} className="row file-goto">
        <label htmlFor="blame-goto">Go to line</label>
        <input id="blame-goto" name="goto" inputMode="numeric" size={8} autoComplete="off" />
        <button type="submit">Go</button>
      </form>
      {paging("Pages of this file")}
      {rows && (
        <div className="blame-scroll">
          <table className="blame" aria-label={`Blame of ${path}`}>
            <thead className="visually-hidden">
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Text</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.startLine}>
                <tr className="blame-group">
                  <th colSpan={2} scope="rowgroup">
                    <GroupLabel
                      group={group}
                      facts={group.kind === "commit" ? blame.commits[group.commit] : undefined}
                      history={historyPath(
                        owner,
                        repo,
                        group.kind === "commit" ? group.commit : commit,
                        path,
                      )}
                    />
                  </th>
                </tr>
                {Array.from({ length: group.lineCount }, (_, k) => {
                  const number = group.startLine + k;
                  const marked =
                    selected !== null && number >= selected.start && number <= selected.end;
                  return (
                    <tr key={number} className={marked ? "blame-line selected" : "blame-line"}>
                      <td className="blame-num" style={{ minWidth: `${digits}ch` }}>
                        <a
                          id={`L${number}`}
                          href={`${at}${lineLink({ start: number, end: number }, false)}`}
                        >
                          {number}
                        </a>
                      </td>
                      <td className="blame-text">
                        <code>{lines.get(number)}</code>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {rows && shown.cut && (
        <p className="muted">
          This line is cut at 64 KiB. <a href={rawBytesUrl(owner, repo, commit, path)}>Raw</a> has
          all of it.
        </p>
      )}
      {paging("Pages of this file, again")}
    </>
  );
}
