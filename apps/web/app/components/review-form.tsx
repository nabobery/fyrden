import { useEffect, useId, useRef } from "react";
import { useFetcher } from "react-router";

type Answer = { ok?: string; error?: string } | undefined;

/**
 * A review of the pull request at its current head: a comment, an approval
 * or a request for changes (its author may only comment). It counts for
 * that head only.
 */
export function ReviewForm({ headSha, isAuthor }: { headSha: string; isAuthor: boolean }) {
  const fetcher = useFetcher<Answer>();
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Review</h2>
      <fetcher.Form method="post" ref={form}>
        <input type="hidden" name="intent" value="review" />
        <input type="hidden" name="commit_id" value={headSha} />
        <fieldset>
          <legend>
            Your review of <code>{headSha.slice(0, 7)}</code>
          </legend>
          <p>
            <input id={`${id}-comment`} type="radio" name="event" value="COMMENT" defaultChecked />{" "}
            <label htmlFor={`${id}-comment`} className="inline">
              Comment
            </label>
          </p>
          <p>
            <input
              id={`${id}-approve`}
              type="radio"
              name="event"
              value="APPROVE"
              disabled={isAuthor}
            />{" "}
            <label htmlFor={`${id}-approve`} className="inline">
              Approve
            </label>
          </p>
          <p>
            <input
              id={`${id}-changes`}
              type="radio"
              name="event"
              value="REQUEST_CHANGES"
              disabled={isAuthor}
            />{" "}
            <label htmlFor={`${id}-changes`} className="inline">
              Request changes
            </label>
          </p>
          {isAuthor && <p className="muted">You opened this pull request: you may only comment.</p>}
        </fieldset>
        <label htmlFor={`${id}-body`}>Review comment (Markdown; needed unless approving)</label>
        <textarea id={`${id}-body`} name="body" className="short" />
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
