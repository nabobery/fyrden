import { type FormEvent, type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import type { Draft } from "../lib/edits.js";

/**
 * A page's editors and what they hold unsent: the version each writes
 * from (`useBaseline`), the drafts the page keeps for them apart from
 * what it shows (`useDrafts`), and what is shown of a draft whose editor
 * has gone (`UnsentText`).
 */

/** What an editor's own last answer says: saved (and the version made), or refused (and the draft's). */
export type Outcome = { readonly saved: boolean; readonly version: number | undefined } | undefined;

/**
 * The version an editor writes from. While nothing unsent is written in
 * it, the page's (the editor is drawn again with what it shows, so its
 * fields and version agree); once something is, the version it showed
 * then; when its own draft is refused, that draft's version, for as long
 * as the draft is there (sent again, it is refused again until read
 * anew); after its own save, the page's again (nothing unsent: what was
 * saved is what the page shows), unless something was written while it
 * was saving (then the version the save made). A draft is checked against
 * what it was written from, never against what the page shows now.
 */
export function useBaseline(
  current: number,
  outcome: Outcome,
  /** The answer the outcome came from: a new one each time, even with the same values. */
  answer: object | undefined,
  /** The page's kept draft of this editor, when it is drawn: it starts from that. */
  resumed: Draft | undefined,
): { version: number; key: string; onInput: () => void; onSubmit: () => void } {
  const start = outcome && !outcome.saved ? outcome : resumed;
  const [frozen, setFrozen] = useState<number | undefined>(start?.version);
  // The form's identity while it holds what it was written with: kept whatever its version
  // becomes, so a save or refusal answered while someone types never draws it again.
  const [kept, setKept] = useState<string | undefined>(start ? `kept ${start.version}` : undefined);
  const writtenSinceSubmit = useRef(false);
  const shownKey = kept ?? `version ${current}`;
  const shown = useRef(shownKey);
  shown.current = shownKey;
  // Read when a new answer comes, not on every drawing (an outcome is a new object each time).
  const latest = useRef(outcome);
  latest.current = outcome;
  useEffect(() => {
    const now = latest.current;
    if (!now || !answer) return;
    if (!now.saved || writtenSinceSubmit.current) {
      // Refused, or written in since it was sent: the version it is checked against moves, the
      // form (and what is in it) stays.
      setFrozen(now.version);
      setKept((was) => was ?? shown.current);
    } else {
      // Saved with nothing unsent: it follows the page again.
      setFrozen(undefined);
      setKept(undefined);
    }
  }, [answer]);
  return {
    version: frozen ?? current,
    // A pristine editor is drawn again for each version; one written in keeps its identity.
    key: shownKey,
    onInput: () => {
      writtenSinceSubmit.current = true;
      setFrozen((was) => was ?? current);
      setKept((was) => was ?? shown.current);
    },
    onSubmit: () => {
      writtenSinceSubmit.current = false;
    },
  };
}

/** The named fields of the form an input event came from. */
export function fieldsOf(
  event: FormEvent<HTMLFormElement>,
  names: readonly string[],
): Draft["fields"] {
  const data = new FormData(event.currentTarget);
  return Object.fromEntries(names.map((name) => [name, String(data.get(name) ?? "")]));
}

/** Which editor an answer is of, as a page names its editors. */
export interface DraftEditors {
  /** The editor a refused draft came from. */
  ofDraft(draft: Draft): string;
  /** The editor a done answer is of; `gone` when what it edits went with it (a deletion). */
  ofAnswer(ok: string, target: number | undefined): { editor: string; gone?: boolean } | undefined;
}

/** An action's answer as `useDrafts` takes it. */
type Answer =
  | {
      readonly ok?: string | undefined;
      readonly target?: number | undefined;
      readonly version?: number | undefined;
      readonly draft?: Draft | undefined;
    }
  | undefined;

export type Drafts = ReturnType<typeof useDrafts>;

/**
 * Unsent drafts by scope (a page and a viewer) for this browser tab: they
 * outlive the component of the page that holds them, so a page an error
 * replaced on a failed reload comes back with them, and go with the tab.
 */
const tabDrafts = new Map<string, ScopeDrafts>();
/** Scopes whose drafts a tab keeps at most. */
const MAX_SCOPES = 32;

/**
 * The unsent drafts of one page for one viewer (`scope`), by editor: what
 * an editor holds (recorded as it is written, dropped when its send is
 * answered as done) and a refused draft (until sent again and done,
 * discarded, or what it edits deleted). Kept apart from what the page
 * shows now and from the latest answer, so an editor that goes (its item
 * on another page, the conversation locked) leaves its text to copy, and
 * one that comes back resumes from it. Text written while an editor's
 * send is answered is newer than what was sent: a refusal does not
 * replace it, and a save moves its version to the one the save made.
 */
export function useDrafts(scope: string, own: Answer, editors: DraftEditors) {
  const rendered = useRef(new Map<string, ScopeDrafts>());
  const taken = useRef<object | undefined>(undefined);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  // In the browser, the tab's: the page drawn again (after an error page replaced it, or back
  // from elsewhere) finds them. On the server, this render's alone.
  const all = typeof window === "undefined" ? rendered.current : tabDrafts;
  let drafts = all.get(scope);
  if (!drafts) {
    drafts = { held: new Map(), sending: new Set(), since: new Set() };
    // The oldest scope's go first past the bound.
    if (all.size >= MAX_SCOPES) all.delete(all.keys().next().value as string);
    all.set(scope, drafts);
  }
  const { held, sending, since } = drafts;
  // Each answer taken once: drawn again, it changes nothing.
  if (own && taken.current !== own) {
    taken.current = own;
    const done = own.ok !== undefined ? editors.ofAnswer(own.ok, own.target) : undefined;
    const editor = own.draft ? editors.ofDraft(own.draft) : done?.editor;
    if (editor !== undefined) {
      const newer = since.has(editor) ? held.get(editor) : undefined;
      if (done?.gone) held.delete(editor);
      else if (own.draft) {
        if (!newer) held.set(editor, own.draft);
      } else if (!newer) held.delete(editor);
      else if (own.version !== undefined) held.set(editor, { ...newer, version: own.version });
      sending.delete(editor);
      since.delete(editor);
    }
  }
  return {
    get: (editor: string) => held.get(editor),
    entries: () => [...held.entries()],
    write: (editor: string, draft: Draft) => {
      held.set(editor, draft);
      if (sending.has(editor)) since.add(editor);
    },
    // What was sent stays until its answer says it was done: an answer that never comes (the
    // page left while it was sent) leaves it to copy, never sent again by itself.
    sent: (editor: string) => {
      sending.add(editor);
      since.delete(editor);
    },
    discard: (editor: string) => {
      held.delete(editor);
      redraw();
    },
  };
}

interface ScopeDrafts {
  readonly held: Map<string, Draft>;
  /** Editors sent and not yet answered. */
  readonly sending: Set<string>;
  /** Of those, the ones written in since. */
  readonly since: Set<string>;
}

/**
 * A disclosure opened when it holds a draft (drawn open, or opened when
 * one comes), never closed by the page: whoever opened it closes it.
 */
export function DraftDetails({
  held,
  summary,
  children,
}: {
  held: boolean;
  summary: string;
  children: ReactNode;
}) {
  const [atFirst] = useState(held);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (held && details.current) details.current.open = true;
  }, [held]);
  return (
    <details ref={details} open={atFirst}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

/**
 * Kept drafts whose editors are not on the page now, to copy or discard;
 * `why` says where an editor may have gone, `label` names each field.
 */
export function UnsentText({
  unsent,
  drafts,
  why,
  label,
}: {
  unsent: readonly (readonly [string, Draft])[];
  drafts: Drafts;
  why: string;
  label: (editor: string, field: string) => string;
}) {
  if (unsent.length === 0) return null;
  return (
    <section className="panel" aria-labelledby="unsent-text">
      <h2 id="unsent-text">Your unsent text</h2>
      <p className="muted">What it was for is not on this page now ({why}): copy it from here.</p>
      {unsent.map(([editor, draft]) => (
        <div key={editor}>
          {Object.entries(draft.fields).map(([name, text]) => (
            <p key={name}>
              <label htmlFor={`unsent-${editor}-${name}`}>{label(editor, name)}</label>
              <textarea id={`unsent-${editor}-${name}`} className="short" readOnly value={text} />
            </p>
          ))}
          <p>
            <button
              type="button"
              aria-label={`Discard: ${label(editor, "body")}`}
              onClick={() => drafts.discard(editor)}
            >
              Discard
            </button>
          </p>
        </div>
      ))}
    </section>
  );
}
