import { useId, useRef, useState } from "react";
import {
  type Choice,
  type ConflictFile,
  conflictRegions,
  resolveRegion,
} from "../lib/conflicts.js";

/**
 * One conflicted file's text, with git's conflict markers (the head's side
 * first), edited by hand or a conflict at a time: from the keyboard, the
 * buttons move to the previous or next conflict and keep the head's side,
 * the base's or both for the conflict at the caret.
 */
export function ConflictEditor({
  file,
  index,
}: {
  file: ConflictFile & { content: string };
  index: number;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [left, setLeft] = useState(() => conflictRegions(file.content).length);
  const [said, setSaid] = useState("");
  const count = () => setLeft(conflictRegions(area.current?.value ?? "").length);

  /** The conflict at the caret, or else the next one after it, or else the first. */
  const current = () => {
    const text = area.current?.value ?? "";
    const caret = area.current?.selectionStart ?? 0;
    const regions = conflictRegions(text);
    return (
      regions.find((r) => caret >= r.start && caret < r.end) ??
      regions.find((r) => r.start >= caret) ??
      regions[0]
    );
  };

  const move = (step: 1 | -1) => {
    const el = area.current;
    if (!el) return;
    const regions = conflictRegions(el.value);
    if (regions.length === 0) return setSaid("No conflicts left in this file.");
    const caret = el.selectionStart;
    const target =
      step === 1
        ? (regions.find((r) => r.start > caret) ?? regions[0])
        : ([...regions].reverse().find((r) => r.start < caret && !(caret < r.end)) ??
          regions[regions.length - 1]);
    if (!target) return;
    el.focus();
    // The conflict's first marker line selected, so the editor scrolls to it.
    const firstLine = el.value.indexOf("\n", target.start);
    el.setSelectionRange(target.start, firstLine < 0 ? target.end : firstLine);
    setSaid(`Conflict ${regions.indexOf(target) + 1} of ${regions.length}.`);
  };

  const keep = (choice: Choice) => {
    const el = area.current;
    const region = current();
    if (!el || !region) return setSaid("No conflicts left in this file.");
    el.value = resolveRegion(el.value, region, choice);
    el.focus();
    el.setSelectionRange(region.start, region.start);
    count();
    const label =
      choice === "both" ? "both sides" : choice === "head" ? "the head's side" : "the base's side";
    setSaid(`Kept ${label}.`);
  };

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
        <button type="button" onClick={() => keep("head")}>
          Keep head
        </button>
        <button type="button" onClick={() => keep("base")}>
          Keep base
        </button>
        <button type="button" onClick={() => keep("both")}>
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
        onInput={count}
        aria-describedby={`${id}-left`}
      />
      <p id={`${id}-left`} className={left > 0 ? "error" : "ok-text"}>
        {left === 0
          ? "No conflict markers left."
          : `${left} conflict${left === 1 ? "" : "s"} left in this file.`}
      </p>
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </section>
  );
}
