/**
 * Labels as the pages read and show them: the API's own shapes (types
 * only), a colour as the API takes it, the text colour a chip of it
 * reads best in, and where a label's issues are listed.
 */

import type { getLabel, listLabels, Output } from "@fyrden/api-contract";

export type Label = Output<typeof getLabel>;
export type LabelsPage = Output<typeof listLabels>;

/**
 * Bytes of a label form read at most: a name (50 characters) and a
 * description (100), URL-encoded at up to 9 bytes a character, and the rest.
 */
export const LABEL_FORM_MAX_BYTES = 16 * 1024;

/** A colour as the API takes it (six hex digits, lower-case, no `#`), from a form's; else null. */
export function colorOf(value: string): string | null {
  const hex = value.trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(hex) ? hex : null;
}

/** sRGB relative luminance (WCAG 2) of six hex digits. */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((at) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The text colour a chip of `color` reads best in: black or white,
 * whichever contrasts more with it (at least 4.58:1 for any colour).
 */
export function textOn(color: string): "#000000" | "#ffffff" {
  const l = luminance(colorOf(color) ?? "ededed");
  const onBlack = (l + 0.05) / 0.05;
  const onWhite = 1.05 / (l + 0.05);
  return onBlack >= onWhite ? "#000000" : "#ffffff";
}

/**
 * The issue list of a label: by name (GitHub's `labels`), or by id for a
 * name holding a comma (`labels` reads one as two names).
 */
export function labelIssues(
  owner: string,
  repo: string,
  label: Pick<Label, "id" | "name">,
): string {
  const query = label.name.includes(",")
    ? new URLSearchParams({ label_ids: String(label.id) })
    : new URLSearchParams({ labels: label.name });
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?${query}`;
}

/** `/repos/{owner}/{repo}/labels/{name}` for the API. */
export const labelApiPath = (repoApi: string, name: string): string =>
  `${repoApi}/labels/${encodeURIComponent(name)}`;
