import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { type DiffSide, type Thread, when, who } from "../../lib/pulls.js";
import { useDraft, useScopedKey, ViewerField } from "../drafts.js";
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

/**
 * The comments of `thread` holding a suggested change that can be applied:
 * read in the browser once the page is hydrated (the parser loads on
 * demand), only for comments on the current head's side.
 */
function useSuggestions(thread: Thread): ReadonlySet<number> {
  const [found, setFound] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => {
    const candidates = thread.comments.filter((c) => c.onHead);
    if (candidates.length === 0) return setFound(new Set());
    let live = true;
    void import("../../lib/suggestion.client.js").then(({ holdsSuggestion }) => {
      if (live)
        setFound(new Set(candidates.filter((c) => holdsSuggestion(c.body)).map((c) => c.id)));
    });
    return () => {
      live = false;
    };
  }, [thread]);
  return found;
}

/**
 * The fetcher applying suggestions on a file's threads. Applying moves the
 * head, so the thread goes outdated and moves off the diff (remounting it);
 * the file's section shares the fetcher and keeps its answer.
 */
const applyKey = (file: string) => `apply-suggestion:${file}`;

/** The answer to applying a suggestion on one of `file`'s threads. */
export function AppliedSuggestion({ file }: { file: string }) {
  const apply = useFetcher<Answer>({ key: applyKey(file) });
  return <Outcome answer={apply.data} done="Suggestion applied." />;
}

/**
 * A thread's reply being written, and the fetcher sending it: both outlive
 * the thread's view, which remounts when it moves between the diff and the
 * list (or is drawn again as the diff scrolls).
 */
const replyKey = (thread: number) => `reply:${thread}`;

/**
 * Empties a thread's reply once it is sent, wherever the thread is drawn by
 * then: the file's section keeps one for each of its threads.
 */
export function SentReply({ thread }: { thread: number }) {
  const reply = useFetcher<Answer>({ key: useScopedKey(replyKey(thread)) });
  const [, setDraft] = useDraft(replyKey(thread));
  const sending = useRef(false);
  useEffect(() => {
    if (reply.state !== "idle") sending.current = true;
    else if (sending.current) {
      sending.current = false;
      if (reply.data?.ok) setDraft("");
    }
  }, [reply.state, reply.data, setDraft]);
  return null;
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
  const suggestions = useSuggestions(thread);
  const reply = useFetcher<Answer>({ key: useScopedKey(replyKey(thread.id)) });
  const [draft, setDraft] = useDraft(replyKey(thread.id));
  const resolve = useFetcher<Answer>();
  const apply = useFetcher<Answer>({ key: applyKey(thread.file) });
  const replyId = useId();
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
            <Markdown source={c.body} />
            {suggestions.has(c.id) && canAct && (
              <apply.Form method="post">
                <input type="hidden" name="intent" value="apply" />
                <ViewerField />
                <input type="hidden" name="comment_id" value={c.id} />
                <button type="submit" disabled={apply.state !== "idle"}>
                  Apply suggestion
                </button>
              </apply.Form>
            )}
          </li>
        ))}
      </ol>
      {canAct && (
        <>
          <reply.Form method="post" className="thread-reply">
            <input type="hidden" name="intent" value="reply" />
            <ViewerField />
            <input type="hidden" name="in_reply_to" value={thread.comments[0]?.id ?? ""} />
            <label htmlFor={replyId}>Reply</label>
            <textarea
              id={replyId}
              name="body"
              className="short"
              required
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
            />
            <p className="row">
              <button type="submit" disabled={reply.state !== "idle"}>
                Reply
              </button>
            </p>
          </reply.Form>
          <Outcome answer={reply.data} done="Reply added." />
          <resolve.Form method="post">
            <input type="hidden" name="intent" value={thread.resolved ? "unresolve" : "resolve"} />
            <ViewerField />
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

/** A new comment's lines, as its fields hold them. */
interface LineFields {
  side: DiffSide;
  start: string;
  line: string;
}

/** The fields for lines picked in the diff (empty for none). */
function fieldsOf(pick: LinePick | null): LineFields {
  return {
    side: pick?.side ?? "RIGHT",
    start: pick && pick.start !== pick.end ? String(pick.start) : "",
    line: pick ? String(pick.end) : "",
  };
}

/**
 * A new comment on lines of a file: the lines picked in the diff fill it in,
 * and it can be filled in by hand (from the keyboard) as well. It is always
 * sent for the head whose changes are shown: when the head moves while a
 * comment is being written, its text is kept and its lines asked for again
 * (those picked were lines of the older head).
 */
export function LineCommentForm({
  path,
  previousPath,
  headSha,
  pick,
  open,
  onToggle,
}: {
  path: string;
  /** A renamed file's old path: comments on its old side name it. */
  previousPath?: string | undefined;
  headSha: string;
  pick: LinePick | null;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const fetcher = useFetcher<Answer>();
  const id = useId();
  const bodyField = useRef<HTMLTextAreaElement>(null);
  const [lines, setLines] = useState(() => fieldsOf(pick));
  const [body, setBody] = useState("");
  const [shown, setShown] = useState({ pick, head: headSha });
  /** The head moved under a comment being written (to the one shown now). */
  const [moved, setMoved] = useState(false);
  if (shown.head !== headSha) {
    setShown({ pick, head: headSha });
    setLines(fieldsOf(null));
    setMoved(body.trim() !== "");
  } else if (shown.pick !== pick) {
    // Lines picked again fill the fields in afresh; the comment written so far stays.
    setShown({ pick, head: headSha });
    setLines(fieldsOf(pick));
    setMoved(false);
  }
  const edit = (change: Partial<LineFields>) => {
    setLines({ ...lines, ...change });
    setMoved(false);
  };
  // Lines picked in the diff: the form opens on them, ready to type.
  useEffect(() => {
    if (pick && open) bodyField.current?.focus();
  }, [pick, open]);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setBody("");
      setMoved(false);
    }
  }, [fetcher.state, fetcher.data]);
  return (
    <details
      className="line-comment"
      open={open}
      onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Comment on lines</summary>
      {moved && (
        <p className="error" role="alert">
          The pull request moved to <code>{headSha.slice(0, 7)}</code> since you started this
          comment: pick its lines again in these changes.
        </p>
      )}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="comment" />
        <ViewerField />
        <input type="hidden" name="path" value={path} />
        {previousPath !== undefined && (
          <input type="hidden" name="previous_path" value={previousPath} />
        )}
        <input type="hidden" name="commit_id" value={shown.head} />
        <div className="row">
          <span>
            <label htmlFor={`${id}-side`}>Side</label>
            <select
              id={`${id}-side`}
              name="side"
              value={lines.side}
              onChange={(e) => edit({ side: e.currentTarget.value === "LEFT" ? "LEFT" : "RIGHT" })}
            >
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
              value={lines.start}
              onChange={(e) => edit({ start: e.currentTarget.value })}
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
              value={lines.line}
              onChange={(e) => edit({ line: e.currentTarget.value })}
            />
          </span>
        </div>
        <label htmlFor={`${id}-body`}>
          Comment (Markdown; a ```suggestion block suggests a change)
        </label>
        <textarea
          id={`${id}-body`}
          name="body"
          className="short"
          required
          ref={bodyField}
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
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
