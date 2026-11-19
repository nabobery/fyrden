import { colorOf, type Label, textOn } from "../lib/labels.js";

export function LabelChip({ label }: { label: Pick<Label, "name" | "color"> }) {
  // Only six hex digits reach the style (the API answers no other).
  const color = colorOf(label.color) ?? "ededed";
  return (
    <span className="label-chip" style={{ backgroundColor: `#${color}`, color: textOn(color) }}>
      {label.name}
    </span>
  );
}
