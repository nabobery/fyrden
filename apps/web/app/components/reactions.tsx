import type { getIssue, Output } from "@fyrden/api-contract";
import type { ReactionContent } from "@fyrden/domain";
import { type ReactNode, useEffect, useRef } from "react";
import { Form } from "react-router";

/** GitHub's eight contents, in its order, as the page shows each. */
export const REACTIONS: readonly { content: ReactionContent; emoji: string; name: string }[] = [
  { content: "+1", emoji: "👍", name: "Thumbs up" },
  { content: "-1", emoji: "👎", name: "Thumbs down" },
  { content: "laugh", emoji: "😄", name: "Laugh" },
  { content: "hooray", emoji: "🎉", name: "Hooray" },
  { content: "confused", emoji: "😕", name: "Confused" },
  { content: "heart", emoji: "❤️", name: "Heart" },
  { content: "rocket", emoji: "🚀", name: "Rocket" },
  { content: "eyes", emoji: "👀", name: "Eyes" },
];

/** A subject's or comment's reactions as the API rolls them up (its contract's shape). */
export type Rollup = Output<typeof getIssue>["reactions"];

/**
 * A subject's or comment's reactions: each content's count and, for a
 * viewer who may react, a toggle (taken back by the viewer's own
 * reaction's id when the rollup names it; else it adds, which the API
 * answers with the one there is). `target` is `issue` or a comment's id.
 */
export function Reactions({
  rollup,
  target,
  canReact,
  busy,
  hidden,
}: {
  rollup: Rollup;
  target: "issue" | number;
  canReact: boolean;
  busy: boolean;
  /** Fields every form carries (the viewer it was drawn for). */
  hidden?: ReactNode;
}) {
  const list = useRef<HTMLUListElement>(null);
  // The content last sent from here: its toggle moves (into the counted ones, or back into the
  // picker) when the page is read again, and focus goes with it rather than to the page.
  const sent = useRef<ReactionContent | undefined>(undefined);
  // Run when the page is read again: a new rollup comes with each reading.
  useEffect(() => {
    const content = sent.current;
    if (content === undefined || !rollup) return;
    sent.current = undefined;
    // Only when focus was lost with the old toggle: never taken from where someone moved it.
    if (document.activeElement && document.activeElement !== document.body) return;
    const button = list.current?.querySelector<HTMLButtonElement>(
      `button[data-content="${content}"]`,
    );
    const picker = button?.closest("details");
    if (picker && !picker.open) picker.querySelector("summary")?.focus();
    else button?.focus();
  }, [rollup]);
  const own = new Map((rollup.viewer ?? []).map((r) => [r.content, r.id]));
  const shown = REACTIONS.filter((r) => rollup[r.content] > 0);
  const others = REACTIONS.filter((r) => !(rollup[r.content] > 0));
  if (!canReact && shown.length === 0) return null;
  /** What a content reads as: its emoji, its name for assistive technology, its count. */
  const face = (r: (typeof REACTIONS)[number], count: number) => (
    <>
      <span aria-hidden="true">{r.emoji}</span>
      <span className="visually-hidden">{r.name}</span> {count > 0 ? count : ""}
    </>
  );
  const toggle = (r: (typeof REACTIONS)[number]) => {
    const mine = own.get(r.content);
    return (
      <li key={r.content}>
        <Form
          method="post"
          className="reaction"
          onSubmit={() => {
            sent.current = r.content;
          }}
        >
          <input type="hidden" name="intent" value={mine === undefined ? "react" : "unreact"} />
          <input type="hidden" name="target" value={String(target)} />
          <input type="hidden" name="content" value={r.content} />
          {mine !== undefined && <input type="hidden" name="reaction_id" value={mine} />}
          {hidden}
          <button
            type="submit"
            data-content={r.content}
            disabled={busy}
            // Known only when the rollup names the viewer's own (else it adds).
            aria-pressed={rollup.viewer ? mine !== undefined : undefined}
            title={mine === undefined ? `React with ${r.name}` : `Take back your ${r.name}`}
          >
            {face(r, rollup[r.content])}
          </button>
        </Form>
      </li>
    );
  };
  return (
    <ul className="reactions row" aria-label="Reactions" ref={list}>
      {shown.map((r) =>
        canReact ? (
          toggle(r)
        ) : (
          <li key={r.content} className="reaction">
            {face(r, rollup[r.content])}
          </li>
        ),
      )}
      {canReact && others.length > 0 && (
        <li>
          <details className="reaction-picker">
            <summary>Add a reaction</summary>
            <ul className="reactions row" aria-label="More reactions">
              {others.map(toggle)}
            </ul>
          </details>
        </li>
      )}
    </ul>
  );
}
