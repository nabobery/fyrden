import { parseSuggestion } from "@fyrden/domain";
import type { RouterContextProvider } from "react-router";
import { apiGet } from "./api.server.js";
import { renderMarkdown } from "./markdown.js";
import type { PullRequest, ReviewComment, Thread } from "./pulls.js";

/** Pages of review comments read at most (100 each). */
const MAX_COMMENT_PAGES = 10;

/**
 * The review threads on the given paths, from a pull request's diff
 * comments (read a page at a time, `MAX_COMMENT_PAGES` at most): each
 * thread anchored where its first comment is.
 */
export async function loadThreads(
  context: Readonly<RouterContextProvider>,
  request: Request,
  api: string,
  pull: PullRequest,
  paths: ReadonlySet<string>,
): Promise<{ threads: Thread[]; complete: boolean }> {
  const comments: ReviewComment[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query: string = `per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page: { comments: ReviewComment[]; next_cursor: string | null } = await apiGet(
      context,
      request,
      `${api}/comments?${query}`,
    );
    comments.push(...page.comments);
    cursor = page.next_cursor;
    pages++;
  } while (cursor && pages < MAX_COMMENT_PAGES);
  return { threads: threadsOf(comments, pull, paths), complete: cursor === null };
}

/** Comments grouped into their threads (on `paths` only), in the order they were started. */
export function threadsOf(
  comments: readonly ReviewComment[],
  pull: Pick<PullRequest, "state" | "head">,
  paths: ReadonlySet<string>,
): Thread[] {
  const threads = new Map<number, Thread>();
  for (const c of comments) {
    if (!paths.has(c.path)) continue;
    let thread = threads.get(c.thread_id);
    if (!thread) {
      thread = {
        id: c.thread_id,
        path: c.path,
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
      html: renderMarkdown(c.body),
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
  return [...threads.values()];
}
