import { parseSuggestion } from "@fyrden/domain";
import type { RouterContextProvider } from "react-router";
import { apiGet } from "./api.server.js";
import { renderMarkdown } from "./markdown.js";
import type { PullRequest, ReviewComment, Thread } from "./pulls.js";

/** Review comments read a page at a time. */
const COMMENTS_PER_PAGE = 30;
/** Pages read for one files page at most. */
const MAX_COMMENT_PAGES = 20;
/**
 * Rendered comment HTML (characters) one files page holds at most: a body of
 * 65,536 characters can render to about four times that (each `<` escaped),
 * so a count of comments alone bounds nothing. Reading stops at the end of
 * the page that passes it; the rest is a continuation.
 */
const MAX_RENDERED_CHARS = 2 * 1024 * 1024;

/**
 * Review threads on the listed files, from a pull request's diff comments
 * read from `cursor` (the first page when null) a page at a time, until the
 * pages or the rendered HTML reach their bounds: each thread anchored where
 * its first comment is. `next` continues where reading stopped.
 */
export async function loadThreads(
  context: Readonly<RouterContextProvider>,
  request: Request,
  api: string,
  pull: Pick<PullRequest, "state" | "head">,
  files: ReadonlyMap<string, string>,
  cursor: string | null,
): Promise<{ threads: Thread[]; next: string | null }> {
  const threads = new Map<number, Thread>();
  const budget = { chars: 0 };
  let next = cursor;
  let pages = 0;
  do {
    const query = new URLSearchParams({ per_page: String(COMMENTS_PER_PAGE) });
    if (next) query.set("cursor", next);
    const page = await apiGet<{ comments: ReviewComment[]; next_cursor: string | null }>(
      context,
      request,
      `${api}/comments?${query.toString()}`,
    );
    addComments(threads, page.comments, pull, files, budget);
    next = page.next_cursor;
    pages++;
  } while (next && pages < MAX_COMMENT_PAGES && budget.chars < MAX_RENDERED_CHARS);
  return { threads: [...threads.values()], next };
}

/** Comments grouped into their threads (on the listed files only), in the order they were started. */
export function threadsOf(
  comments: readonly ReviewComment[],
  pull: Pick<PullRequest, "state" | "head">,
  files: ReadonlyMap<string, string>,
): Thread[] {
  const threads = new Map<number, Thread>();
  addComments(threads, comments, pull, files, { chars: 0 });
  return [...threads.values()];
}

/**
 * The paths whose comments a page of files shows, each to the file it is
 * listed as: a renamed file's old path (its old side's comments) included.
 */
export function filesByPath(
  files: readonly { filename: string; previous_filename?: string | undefined }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) map.set(f.filename, f.filename);
  for (const f of files)
    if (f.previous_filename !== undefined && !map.has(f.previous_filename))
      map.set(f.previous_filename, f.filename);
  return map;
}

function addComments(
  threads: Map<number, Thread>,
  comments: readonly ReviewComment[],
  pull: Pick<PullRequest, "state" | "head">,
  files: ReadonlyMap<string, string>,
  budget: { chars: number },
): void {
  for (const c of comments) {
    const file = files.get(c.path);
    if (file === undefined) continue;
    let thread = threads.get(c.thread_id);
    if (!thread) {
      thread = {
        id: c.thread_id,
        path: c.path,
        file,
        side: c.side,
        line: c.outdated ? null : c.line,
        startLine: c.outdated ? null : c.start_line,
        originalLine: c.original_line,
        commit: c.commit_id,
        outdated: c.outdated,
        resolved: c.resolved,
        comments: [],
      };
      threads.set(c.thread_id, thread);
    }
    const html = renderMarkdown(c.body);
    budget.chars += html.length;
    thread.comments.push({
      id: c.id,
      author: c.user.id,
      agents: c.performed_via_agents,
      html,
      at: c.created_at,
      // As the API applies them: on the head's side, at the current head, while open.
      applicable:
        pull.state === "open" &&
        !c.outdated &&
        c.side === "RIGHT" &&
        c.commit_id === pull.head.sha &&
        parseSuggestion(c.body) !== undefined,
    });
  }
}
