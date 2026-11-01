import { visibleText } from "../pulls/mentions.js";

/*
 * References to issues and pull requests in the text a reader sees
 * (outside code, as mentions are read): `#12` in the same repository,
 * `owner/repo#12` in another. Those right after one of GitHub's closing
 * keywords close what they name when a pull request whose description
 * holds them merges into its repository's default branch.
 */

/** References one text names at most; the rest are ignored. */
export const MAX_REFERENCES = 50;

/** A reference: a number, in this repository or in `owner/repo`. */
export interface Reference {
  /** Lower-cased owner handle and repository name; absent for this repository. */
  readonly repo?: { readonly owner: string; readonly name: string };
  readonly number: number;
  /** Right after a closing keyword. */
  readonly closes: boolean;
}

/**
 * `#N` or `owner/repo#N`, standing apart: not inside a word, a path or a
 * URL (`a#1`, `x/y/z#1`, `&#1`), and not followed by more of a word.
 */
const REFERENCE =
  /(?<![A-Za-z0-9_/#&.-])(?:([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9._-]{1,100}))?#([1-9][0-9]{0,9})(?![A-Za-z0-9_])/g;

/** GitHub's closing keywords (matched ignoring case). */
const CLOSING_KEYWORDS = new Set([
  "close",
  "closes",
  "closed",
  "fix",
  "fixes",
  "fixed",
  "resolve",
  "resolves",
  "resolved",
]);
const WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Whether the reference at `index` of `plain` comes right after a closing
 * keyword: spaces or tabs before it, an optional colon, and a whole word
 * that is one (read backwards to the word's start, however long the run).
 */
function closesAt(plain: string, index: number): boolean {
  let end = index;
  while (end > 0 && (plain[end - 1] === " " || plain[end - 1] === "\t")) end--;
  if (end === index) return false;
  if (plain[end - 1] === ":") end--;
  let start = end;
  while (start > 0 && WORD_CHAR.test(plain[start - 1] as string)) start--;
  return CLOSING_KEYWORDS.has(plain.slice(start, end).toLowerCase());
}

/**
 * The references `text` names, in order of first appearance, at most
 * `MAX_REFERENCES`; one named twice closes if either does. A repository
 * name of `.` or `..` names none.
 */
export function referencesIn(text: string | null | undefined): Reference[] {
  if (!text) return [];
  const plain = visibleText(text);
  const found = new Map<string, Reference>();
  for (const match of plain.matchAll(REFERENCE)) {
    const [, owner, name, digits] = match;
    if (name === "." || name === "..") continue;
    const number = Number(digits);
    if (!Number.isSafeInteger(number)) continue;
    const repo =
      owner && name ? { owner: owner.toLowerCase(), name: name.toLowerCase() } : undefined;
    const key = `${repo ? `${repo.owner}/${repo.name}` : ""}#${number}`;
    const closes = closesAt(plain, match.index ?? 0);
    const known = found.get(key);
    if (known) {
      if (closes && !known.closes) found.set(key, { ...known, closes });
      continue;
    }
    if (found.size >= MAX_REFERENCES) break;
    found.set(key, { ...(repo && { repo }), number, closes });
  }
  return [...found.values()];
}
