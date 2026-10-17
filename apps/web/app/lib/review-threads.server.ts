import type { RouterContextProvider } from "react-router";
import { apiGet } from "./api.server.js";
import {
  type Continuation,
  readContinuation,
  utf8Length,
  within,
  writeContinuation,
} from "./continuation.js";
import type { PullRequest, ReviewComment, ReviewCommentsPage, Thread } from "./pulls.js";

/** Review comments read from the API at a time: one page per navigation. */
const COMMENTS_PER_PAGE = 30;
/**
 * Markdown source (UTF-8 bytes) of the shown comments one response carries
 * at most (the page renders it in the browser); the rest of the API's page
 * follows on the next navigation.
 */
const SOURCE_BUDGET = 512 * 1024;

/**
 * Review threads on the listed files, from one page of a pull request's
 * diff comments: from where `continuation` says (the first page when
 * null), as many as fit the source budget. `next` continues from the first
 * comment left out, so none is skipped.
 */
export async function loadThreads(
  context: Readonly<RouterContextProvider>,
  request: Request,
  api: string,
  pull: Pick<PullRequest, "state" | "head">,
  files: ReadonlyMap<string, string>,
  continuation: string | null,
): Promise<{ threads: Thread[]; next: string | null }> {
  const at: Continuation = readContinuation(continuation);
  const query = new URLSearchParams({ per_page: String(COMMENTS_PER_PAGE) });
  if (at.cursor) query.set("cursor", at.cursor);
  const page = await apiGet<ReviewCommentsPage>(
    context,
    request,
    `${api}/comments?${query.toString()}`,
  );
  // Comments on other files cost nothing here: they are not sent.
  const shown = within(
    page.comments,
    at,
    (c) => (files.has(c.path) ? utf8Length(c.body) : 0),
    SOURCE_BUDGET,
    page.next_cursor,
  );
  return {
    threads: threadsOf(shown.items, pull, files),
    next: shown.next && writeContinuation(shown.next),
  };
}

/** Comments grouped into their threads (on the listed files only), in the order they were started. */
export function threadsOf(
  comments: readonly ReviewComment[],
  pull: Pick<PullRequest, "state" | "head">,
  files: ReadonlyMap<string, string>,
): Thread[] {
  const threads = new Map<number, Thread>();
  addComments(threads, comments, pull, files);
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
    thread.comments.push({
      id: c.id,
      author: c.user.id,
      agents: c.performed_via_agents,
      body: c.body,
      at: c.created_at,
      // As the API applies suggestions: on the head's side, at the current head, while open.
      // Whether the body holds one is read in the browser: the server parses no bodies.
      onHead:
        pull.state === "open" && !c.outdated && c.side === "RIGHT" && c.commit_id === pull.head.sha,
    });
  }
}
