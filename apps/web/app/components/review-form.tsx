import { useEffect, useId, useState } from "react";
import { useFetcher } from "react-router";

type Answer = { ok?: string; error?: string } | undefined;

type Verdict = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/**
 * A review of the pull request at its current head: a comment, an approval
 * or a request for changes (its author may only comment). It counts for
 * that head only, and is always sent for the head it shows: when the head
 * moves while a review is being written, its text is kept and its verdict
 * asked for again.
 */
export function ReviewForm({ headSha, isAuthor }: { headSha: string; isAuthor: boolean }) {
  const fetcher = useFetcher<Answer>();
  const id = useId();
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const [body, setBody] = useState("");
  const [reviewing, setReviewing] = useState(headSha);
  /** The head moved under a review being written (to the one shown now). */
  const [moved, setMoved] = useState(false);
  if (reviewing !== headSha) {
    setReviewing(headSha);
    if (verdict !== "COMMENT" || body.trim()) {
      setVerdict("COMMENT");
      setMoved(true);
    }
  }
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) {
      setVerdict("COMMENT");
      setBody("");
      setMoved(false);
    }
  }, [fetcher.state, fetcher.data]);
  const choice = (value: Verdict, label: string) => (
    <p>
      <input
        id={`${id}-${value}`}
        type="radio"
        name="event"
        value={value}
        checked={verdict === value}
        onChange={() => setVerdict(value)}
        disabled={value !== "COMMENT" && isAuthor}
      />{" "}
      <label htmlFor={`${id}-${value}`} className="inline">
        {label}
      </label>
    </p>
  );
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Review</h2>
      {moved && (
        <p className="error" role="alert">
          The pull request moved to <code>{headSha.slice(0, 7)}</code> since you started this
          review: your review is now of that head. Choose your verdict again.
        </p>
      )}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="review" />
        <input type="hidden" name="commit_id" value={reviewing} />
        <fieldset>
          <legend>
            Your review of <code>{reviewing.slice(0, 7)}</code>
          </legend>
          {choice("COMMENT", "Comment")}
          {choice("APPROVE", "Approve")}
          {choice("REQUEST_CHANGES", "Request changes")}
          {isAuthor && <p className="muted">You opened this pull request: you may only comment.</p>}
        </fieldset>
        <label htmlFor={`${id}-body`}>Review comment (Markdown; needed unless approving)</label>
        <textarea
          id={`${id}-body`}
          name="body"
          className="short"
          value={body}
          onChange={(e) => setBody(e.currentTarget.value)}
        />
        <p>
          <button type="submit" className="primary" disabled={fetcher.state !== "idle"}>
            Submit review
          </button>
        </p>
      </fetcher.Form>
      {fetcher.data?.error && (
        <p className="error" role="alert">
          {fetcher.data.error}
        </p>
      )}
      {fetcher.data?.ok && <p role="status">Review submitted.</p>}
    </section>
  );
}
