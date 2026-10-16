import { useEffect, useId, useRef } from "react";
import { useFetcher } from "react-router";
import { type DiffSide, type Thread, when, who } from "../../lib/pulls.js";
import { Markdown } from "../markdown.js";

/** What a files-page form answers: what was done, or why not. */
type Answer = { ok?: string; error?: string } | undefined;

/** An answer's message for screen readers and sighted people alike. */
function Outcome({ answer, done }: { answer: Answer; done: string }) {
  if (answer?.error)
    return (
      <p className="error" role="alert">
        {answer.error}
      </p>
    );
  return answer?.ok ? <p role="status">{done}</p> : null;
}

const sideName = (side: DiffSide) => (side === "LEFT" ? "old" : "new");

/** Where a thread is, in words: its lines and side. */
export function anchorText(
  thread: Pick<Thread, "side" | "line" | "startLine" | "originalLine">,
): string {
  const last = thread.line ?? thread.originalLine;
  const lines =
    thread.startLine !== null && thread.startLine !== last
      ? `lines ${thread.startLine}-${last}`
      : `line ${last}`;
  return `${lines} of the ${sideName(thread.side)} file`;
}

/**
 * A review thread: its comments, a reply, resolving it, and applying a
 * comment's suggested change.
 */
export function ThreadView({
  thread,
  viewer,
  canAct,
}: {
  thread: Thread;
  viewer: string | null;
  canAct: boolean;
}) {
  const reply = useFetcher<Answer>();
  const resolve = useFetcher<Answer>();
  const apply = useFetcher<Answer>();
  const replyBody = useRef<HTMLTextAreaElement>(null);
  const replyId = useId();
  // A sent reply clears its box.
  useEffect(() => {
    if (reply.state === "idle" && reply.data?.ok && replyBody.current) replyBody.current.value = "";
  }, [reply.state, reply.data]);
  return (
    <section
      className={`thread panel${thread.resolved ? " resolved" : ""}`}
      aria-label={`Comments on ${anchorText(thread)}`}
      id={`thread-${thread.id}`}
    >
      <p className="muted thread-anchor">
        {anchorText(thread)}
        {thread.outdated && (
          <>
            {" "}
            at <code>{thread.commit.slice(0, 7)}</code> <span className="badge">outdated</span>
          </>
        )}
        {thread.resolved && <span className="badge">resolved</span>}
      </p>
      <ol className="thread-comments">
        {thread.comments.map((c) => (
          <li key={c.id} id={`review-comment-${c.id}`}>
            <p className="muted">
              <strong>{who(c.author, viewer)}</strong>
              {c.agents.length > 0 && <> (via {c.agents.join(", ")})</>}{" "}
              <time dateTime={new Date(c.at).toISOString()}>{when(c.at)}</time>
            </p>
            <Markdown html={c.html} />
            {c.applicable && canAct && (
              <apply.Form method="post">
                <input type="hidden" name="intent" value="apply" />
                <input type="hidden" name="comment_id" value={c.id} />
                <button type="submit" disabled={apply.state !== "idle"}>
                  Apply suggestion
                </button>
              </apply.Form>
            )}
          </li>
        ))}
      </ol>
      <Outcome answer={apply.data} done="Suggestion applied." />
      {canAct && (
        <>
          <reply.Form method="post" className="thread-reply">
            <input type="hidden" name="intent" value="reply" />
            <input type="hidden" name="in_reply_to" value={thread.comments[0]?.id ?? ""} />
            <label htmlFor={replyId}>Reply</label>
            <textarea id={replyId} name="body" className="short" required ref={replyBody} />
            <p className="row">
              <button type="submit" disabled={reply.state !== "idle"}>
                Reply
              </button>
            </p>
          </reply.Form>
          <Outcome answer={reply.data} done="Reply added." />
          <resolve.Form method="post">
            <input type="hidden" name="intent" value={thread.resolved ? "unresolve" : "resolve"} />
            <input type="hidden" name="thread_id" value={thread.id} />
            <button type="submit" disabled={resolve.state !== "idle"}>
              {thread.resolved ? "Unresolve conversation" : "Resolve conversation"}
            </button>
          </resolve.Form>
          <Outcome answer={resolve.data} done={thread.resolved ? "Resolved." : "Unresolved."} />
        </>
      )}
    </section>
  );
}

/** Lines a new comment is on, as a gutter click or a selection names them. */
export interface LinePick {
  side: DiffSide;
  start: number;
  end: number;
}

/**
 * A new comment on lines of a file: the lines picked in the diff fill it in,
 * and it can be filled in by hand (from the keyboard) as well.
 */
export function LineCommentForm({
  path,
  headSha,
  pick,
  open,
  onToggle,
}: {
  path: string;
  headSha: string;
  pick: LinePick | null;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const fetcher = useFetcher<Answer>();
  const id = useId();
  const body = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // Lines picked in the diff: the form opens on them, ready to type.
  useEffect(() => {
    if (pick && open) body.current?.focus();
  }, [pick, open]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  const range = pick && pick.start !== pick.end;
  return (
    <details
      className="line-comment"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Comment on lines</summary>
      <fetcher.Form
        method="post"
        ref={form}
        key={pick ? `${pick.side}${pick.start}-${pick.end}` : "none"}
      >
        <input type="hidden" name="intent" value="comment" />
        <input type="hidden" name="path" value={path} />
        <input type="hidden" name="commit_id" value={headSha} />
        <div className="row">
          <span>
            <label htmlFor={`${id}-side`}>Side</label>
            <select id={`${id}-side`} name="side" defaultValue={pick?.side ?? "RIGHT"}>
              <option value="RIGHT">New file (head)</option>
              <option value="LEFT">Old file (base)</option>
            </select>
          </span>
          <span>
            <label htmlFor={`${id}-start`}>First line (for a range)</label>
            <input
              id={`${id}-start`}
              name="start_line"
              type="number"
              min={1}
              inputMode="numeric"
              defaultValue={range ? pick.start : ""}
            />
          </span>
          <span>
            <label htmlFor={`${id}-line`}>Line</label>
            <input
              id={`${id}-line`}
              name="line"
              type="number"
              min={1}
              required
              inputMode="numeric"
              defaultValue={pick?.end ?? ""}
            />
          </span>
        </div>
        <label htmlFor={`${id}-body`}>
          Comment (Markdown; a ```suggestion block suggests a change)
        </label>
        <textarea id={`${id}-body`} name="body" className="short" required ref={body} />
        <p>
          <button type="submit" className="primary" disabled={fetcher.state !== "idle"}>
            Add comment
          </button>
        </p>
      </fetcher.Form>
      <Outcome answer={fetcher.data} done="Comment added." />
    </details>
  );
}
