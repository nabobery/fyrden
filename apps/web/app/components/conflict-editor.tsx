import { useId, useRef, useState } from "react";
import {
  type Choice,
  type ConflictFile,
  type ConflictReading,
  type MarkerLabels,
  readConflicts,
  resolveRegion,
} from "../lib/conflicts.js";

/** What is left in a file, in words. */
export function leftText(reading: ConflictReading): string {
  if (reading.ambiguous)
    return "The conflict markers in this file do not read as whole conflicts: edit it by hand.";
  const left = reading.regions.length;
  if (left > 0) return `${left} conflict${left === 1 ? "" : "s"} left in this file.`;
  return reading.starts.length > 0
    ? "Lines that look like conflict markers remain: check them."
    : "No conflict markers left.";
}

/**
 * One conflicted file's text, with git's conflict markers (the head's side
 * first), edited by hand or a conflict at a time: from the keyboard, the
 * buttons move to the previous or next conflict and keep the head's side,
 * the base's or both for the conflict at the caret. When the markers do not
 * read as whole conflicts, only editing by hand is offered.
 */
export function ConflictEditor({
  file,
  index,
  labels,
}: {
  file: ConflictFile & { content: string };
  index: number;
  labels: MarkerLabels;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [reading, setReading] = useState(() => readConflicts(file.content, labels));
  const [said, setSaid] = useState("");
  const reread = () => {
    const next = readConflicts(area.current?.value ?? "", labels);
    setReading(next);
    return next;
  };

  /** The conflict at the caret, or else the next one after it, or else the first. */
  const current = (now: ConflictReading) => {
    const caret = area.current?.selectionStart ?? 0;
    return (
      now.regions.find((r) => caret >= r.start && caret < r.end) ??
      now.regions.find((r) => r.start >= caret) ??
      now.regions[0]
    );
  };

  const move = (step: 1 | -1) => {
    const el = area.current;
    if (!el) return;
    const { starts } = reread();
    if (starts.length === 0) return setSaid("No conflict markers left in this file.");
    const caret = el.selectionStart;
    const target =
      step === 1
        ? (starts.find((s) => s > caret) ?? starts[0])
        : ([...starts].reverse().find((s) => s < caret) ?? starts[starts.length - 1]);
    if (target === undefined) return;
    el.focus();
    // The marker line selected, so the editor scrolls to it.
    const lineEnd = el.value.indexOf("\n", target);
    el.setSelectionRange(target, lineEnd < 0 ? el.value.length : lineEnd);
    setSaid(`Conflict ${starts.indexOf(target) + 1} of ${starts.length}.`);
  };

  const keep = (choice: Choice) => {
    const el = area.current;
    const now = reread();
    if (now.ambiguous) return setSaid(leftText(now));
    const region = el && current(now);
    if (!el || !region) return setSaid("No conflicts left in this file.");
    el.value = resolveRegion(el.value, region, choice);
    el.focus();
    el.setSelectionRange(region.start, region.start);
    const after = reread();
    const kept =
      choice === "both" ? "both sides" : choice === "head" ? "the head's side" : "the base's side";
    setSaid(`Kept ${kept}. ${leftText(after)}`);
  };

  const fine = !reading.ambiguous && reading.regions.length === 0 && reading.starts.length === 0;
  return (
    <section className="panel conflict-file" aria-labelledby={`${id}-name`}>
      <h3 id={`${id}-name`} className="file-name">
        {file.path}
      </h3>
      <input type="hidden" name={`path:${index}`} value={file.path} />
      <fieldset className="row conflict-tools">
        <legend>Conflicts in {file.path}</legend>
        <button type="button" onClick={() => move(-1)}>
          Previous conflict
        </button>
        <button type="button" onClick={() => move(1)}>
          Next conflict
        </button>
        <button type="button" onClick={() => keep("head")} disabled={reading.ambiguous}>
          Keep head
        </button>
        <button type="button" onClick={() => keep("base")} disabled={reading.ambiguous}>
          Keep base
        </button>
        <button type="button" onClick={() => keep("both")} disabled={reading.ambiguous}>
          Keep both
        </button>
      </fieldset>
      <label htmlFor={`${id}-text`}>
        Resolved content of {file.path} (the head's side is first in each conflict)
      </label>
      <textarea
        id={`${id}-text`}
        ref={area}
        name={`content:${index}`}
        defaultValue={file.content}
        spellCheck={false}
        onInput={reread}
        aria-describedby={`${id}-left`}
      />
      <p id={`${id}-left`} className={fine ? "ok-text" : "error"}>
        {leftText(reading)}
      </p>
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </section>
  );
}
