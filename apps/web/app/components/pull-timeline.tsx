import { when, who } from "../lib/pulls.js";
import { Markdown } from "./markdown.js";

/** One event of a pull request's conversation, with its Markdown source. */
export type TimelineItem =
  | {
      kind: "comment";
      id: number;
      at: number;
      author: string;
      agents: string[];
      body: string;
      edited: boolean;
    }
  | {
      kind: "review";
      id: number;
      at: number;
      author: string;
      agents: string[];
      state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
      commit: string;
      body: string | null;
      dismissal: { by: string; message: string; at: number } | null;
    }
  | { kind: "closed" | "merged"; at: number; by: string | null; commit: string | null };

const REVIEW_LABEL = {
  APPROVED: "approved these changes",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "reviewed",
  DISMISSED: "reviewed (dismissed)",
} as const;

/** The items in the order they happened (a stable sort: ties keep their given order). */
export function inOrder(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort((a, b) => a.at - b.at);
}

function Byline({
  author,
  agents,
  viewer,
}: {
  author: string;
  agents: string[];
  viewer: string | null;
}) {
  return (
    <>
      <strong>{who(author, viewer)}</strong>
      {agents.length > 0 && <span className="muted"> (via {agents.join(", ")})</span>}
    </>
  );
}

/** A pull request's conversation: its comments, reviews, and when it was closed or merged. */
export function Timeline({ items, viewer }: { items: TimelineItem[]; viewer: string | null }) {
  if (items.length === 0) return <p className="muted">No comments or reviews yet.</p>;
  return (
    <ol className="timeline" aria-label="Conversation">
      {items.map((item) => {
        if (item.kind === "comment")
          return (
            <li key={`c${item.id}`} id={`comment-${item.id}`}>
              <article className="panel" aria-label={`Comment by ${who(item.author, viewer)}`}>
                <header className="muted">
                  <Byline author={item.author} agents={item.agents} viewer={viewer} /> commented{" "}
                  <time dateTime={new Date(item.at).toISOString()}>{when(item.at)}</time>
                  {item.edited && " (edited)"}
                </header>
                <Markdown source={item.body} />
              </article>
            </li>
          );
        if (item.kind === "review")
          return (
            <li key={`r${item.id}`} id={`review-${item.id}`}>
              <article
                className={`panel review review-${item.state.toLowerCase()}`}
                aria-label={`Review by ${who(item.author, viewer)}`}
              >
                <header className="muted">
                  <Byline author={item.author} agents={item.agents} viewer={viewer} />{" "}
                  {REVIEW_LABEL[item.state]} at <code>{item.commit.slice(0, 7)}</code>{" "}
                  <time dateTime={new Date(item.at).toISOString()}>{when(item.at)}</time>
                </header>
                {item.body && <Markdown source={item.body} />}
                {item.dismissal && (
                  <p className="muted">
                    Dismissed by {who(item.dismissal.by, viewer)} {when(item.dismissal.at)}:{" "}
                    {item.dismissal.message}
                  </p>
                )}
              </article>
            </li>
          );
        return (
          <li key={item.kind} className="muted timeline-event">
            {item.kind === "merged" ? "Merged" : "Closed"}
            {item.by && <> by {who(item.by, viewer)}</>}
            {item.commit && (
              <>
                {" "}
                as <code>{item.commit.slice(0, 7)}</code>
              </>
            )}{" "}
            <time dateTime={new Date(item.at).toISOString()}>{when(item.at)}</time>
          </li>
        );
      })}
    </ol>
  );
}
