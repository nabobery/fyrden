import { colorOf, type Label, textOn } from "../lib/labels.js";

/** A label's chip: its name on its colour, in black or white, whichever reads better. */
export function LabelChip({ label }: { label: Pick<Label, "name" | "color"> }) {
  // Only six hex digits reach the style (the API answers no other).
  const color = colorOf(label.color) ?? "ededed";
  return (
    <span className="label-chip" style={{ backgroundColor: `#${color}`, color: textOn(color) }}>
      {label.name}
    </span>
  );
}
