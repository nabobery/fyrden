import { data, Link, redirect } from "react-router";
import { BlameFile } from "../components/blame-file.js";
import { apiCall, bodyOf, type Problem } from "../lib/api.server.js";
import {
  BLAME_LIMIT_LINES,
  type BlameAnswer,
  blameBlocks,
  blamePath,
  blameTarget,
  blameWindow,
  decodeBlameBytes,
  drawnLines,
  hasLoneCr,
  refusalSentence,
} from "../lib/blame.js";
import { blockHolding, gotoTarget, MAX_RAW_BYTES, parseLineRange } from "../lib/file-view.js";
import { pageUrl, refAndPath } from "../lib/target.js";
import { bytesOfBase64, type Contents, encodePath } from "../lib/types.js";
import type { Route } from "./+types/repo.blame";

/** A busy blame's wait on the page's own answer: a loader's headers reach it only from here. */
export function headers({ loaderHeaders }: Route.HeadersArgs): HeadersInit {
  const wait = loaderHeaders.get("Retry-After");
  return wait === null ? {} : { "Retry-After": wait };
}

export function meta({ params, loaderData }: Route.MetaArgs): Route.MetaDescriptors {
  return [{ title: `Blame · ${loaderData?.path} · ${params.owner}/${params.repo} · Fyrden` }];
}

const BUSY = "Blame is busy right now. Try again in a moment.";
const UNMATCHED = "This file's lines couldn't be matched to its blame.";

type Base = { owner: string; repo: string; ref: string; path: string };

/** A page with a sentence and no blame drawn. */
function message(
  base: Base,
  status: number,
  sentence: string,
  extra: { commit?: string; seeFile?: boolean; again?: string; history?: boolean } = {},
  headers?: HeadersInit,
) {
  return data(
    {
      kind: "message" as const,
      ...base,
      sentence,
      commit: extra.commit ?? null,
      seeFile: extra.seeFile === true,
      again: extra.again ?? null,
      history: extra.history === true,
    },
    { status, ...(headers && { headers }) },
  );
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { ref, path } = refAndPath(request);
  const page = pageUrl(new URL(request.url));
  const query = page.searchParams;
  // A form can't set a fragment: answered before any call, capped at blame's limit, and
  // clamped to the file's length on the next load.
  if (query.has("goto")) throw redirect(gotoTarget(page, BLAME_LIMIT_LINES));
  const base = { owner: params.owner, repo: params.repo, ref, path };
  const repoPath = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;

  // Blame first: it resolves the ref, and the text is then read at the commit it answered.
  const target = blameTarget(query);
  const window = blameWindow(target);
  const asked = new URLSearchParams({
    path,
    ref,
    line_start: String(window.start),
    line_end: String(window.end),
  });
  const answered = await apiCall<BlameAnswer | Problem>(
    context,
    request,
    "GET",
    `${repoPath}/blame?${asked}`,
  );
  if (answered.status === 503 && (answered.body as Problem | null)?.code === "blame_busy") {
    const wait = (answered.body as Problem).retry_after ?? 1;
    return message(
      base,
      503,
      BUSY,
      { again: page.pathname + page.search },
      {
        "Retry-After": String(wait),
      },
    );
  }
  const code = answered.status >= 400 ? (answered.body as Problem | null)?.code : undefined;
  // Blame has no file at a directory or a submodule either: the contents say which it was.
  if (code === "path_not_found") {
    const there = await apiCall<Contents | Problem>(
      context,
      request,
      "GET",
      `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    // Nothing there either: the missing-file page. Any other failure is the page's own (a
    // signed-out viewer signs in, a refusal keeps its status).
    if (there.status === 404 && (there.body as Problem | null)?.code === "path_not_found")
      return message(base, 404, "", { history: true });
    const found = bodyOf(there, request) as Contents;
    if (found.type === "dir")
      throw redirect(
        `/${params.owner}/${params.repo}/tree/${encodeURIComponent(ref)}/${encodePath(path)}`,
      );
    if (found.type === "submodule")
      return message(base, 200, `A submodule at commit ${found.sha}.`);
    return message(base, 404, "", { history: true });
  }
  const refused = code === undefined ? null : refusalSentence(code);
  if (refused !== null) return message(base, answered.status, refused);
  const blame = bodyOf(answered, request) as BlameAnswer;
  const commit = blame.commit;

  const contents = bodyOf(
    await apiCall<Contents>(
      context,
      request,
      "GET",
      `${repoPath}/contents/${encodePath(path)}?ref=${encodeURIComponent(commit)}`,
    ),
    request,
  );
  const at = { commit };
  if (contents.type === "dir") return message(base, 404, "", { history: true });
  if (contents.type === "symlink")
    return message(base, 200, `A symbolic link to ${contents.target}.`, at);
  if (contents.type === "submodule")
    return message(base, 200, `A submodule at commit ${contents.sha}.`, at);
  if (contents.encoding === "none")
    return message(
      base,
      200,
      contents.size > MAX_RAW_BYTES
        ? "This file is too large to view or download here."
        : "This file is too large to blame.",
      at,
    );
  // One commit for both reads, so only a fault makes them disagree: nothing is drawn then.
  if (contents.sha !== blame.blob) return message(base, 502, UNMATCHED, at);
  if (contents.size === 0) return message(base, 200, "This file is empty.", at);
  const read = decodeBlameBytes(bytesOfBase64(contents.content));
  if (read.kind === "binary")
    return message(base, 200, "This is a binary file.", { ...at, seeFile: true });
  if (read.kind === "undecodable")
    return message(base, 200, "This file isn't valid UTF-8.", { ...at, seeFile: true });

  const { blocks, totalLines } = blameBlocks(read.text);
  if (totalLines !== blame.lines || blocks.length === 0) return message(base, 502, UNMATCHED, at);
  if (target > totalLines) {
    // A hand-written line past the end: the last window, whose first line is a real one, at
    // the commit already read. A target that came from `line` is clamped to the last line, so
    // the fragment names it too: the browser would otherwise keep one naming no row.
    const last = new URL(blamePath(params.owner, params.repo, commit, path), page);
    last.search = page.search;
    last.searchParams.set("from", String((blocks.at(-1) as (typeof blocks)[number]).firstLine));
    const selected = query.has("from") ? null : parseLineRange(query.get("line"), totalLines);
    throw redirect(`${last.pathname}${last.search}${selected ? `#L${selected.start}` : ""}`);
  }
  const block = blockHolding(blocks, target);
  const index = blocks.indexOf(block);
  const lastLine = block.firstLine + block.lineCount - 1;
  const ranges = blame.ranges.filter(
    (r) => r.start_line <= lastLine && r.start_line + r.line_count - 1 >= block.firstLine,
  );
  const named = new Set(ranges.flatMap((r) => ("commit" in r ? [r.commit] : [])));
  return {
    kind: "view" as const,
    ...base,
    commit,
    blame: {
      state: blame.state,
      lines: blame.lines,
      resolved: blame.resolved_lines,
      unresolved: blame.unresolved_lines,
      ranges,
      commits: Object.fromEntries(Object.entries(blame.commits).filter(([id]) => named.has(id))),
    },
    window: {
      firstLine: block.firstLine,
      lastLine,
      cut: block.cut,
      previous: blocks[index - 1]?.firstLine ?? null,
      next: blocks[index + 1]?.firstLine ?? null,
      lines: drawnLines(read.text, block),
    },
    whole: blocks.length === 1 && !block.cut,
    size: contents.size,
    selected: parseLineRange(query.get("line"), totalLines),
    loneCr: hasLoneCr(read.text),
  };
}

export default function BlamePage({ loaderData }: Route.ComponentProps) {
  const { owner, repo, ref, path, commit } = loaderData;
  const base = `/${owner}/${repo}`;
  const shownAt = commit ?? ref;
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
        <Link
          className="button"
          to={`${base}/blob/${encodeURIComponent(shownAt)}/${encodePath(path)}`}
        >
          File
        </Link>
        <Link
          className="button"
          to={`${base}/commits/${encodeURIComponent(shownAt)}/${encodePath(path)}`}
        >
          History
        </Link>
      </div>
      <p className="muted">Renames aren't followed.</p>
      {loaderData.kind === "view" ? (
        <BlameFile view={loaderData} />
      ) : loaderData.history ? (
        <>
          <p>
            This file doesn't exist at <code>{ref}</code>.
          </p>
          <p>
            <Link to={`${base}/commits/${encodeURIComponent(ref)}/${encodePath(path)}`}>
              See this path's history
            </Link>
          </p>
        </>
      ) : (
        <>
          <p>{loaderData.sentence}</p>
          {loaderData.again !== null && (
            <p>
              <a href={loaderData.again}>Try again</a>
            </p>
          )}
          {loaderData.seeFile && commit !== null && (
            <p>
              <Link to={`${base}/blob/${encodeURIComponent(commit)}/${encodePath(path)}`}>
                See the file
              </Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
