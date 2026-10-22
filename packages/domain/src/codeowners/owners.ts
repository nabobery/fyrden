import { type MatchBudget, matchesPath, preparePath } from "./match.js";
import type { CodeOwner, CodeOwnersFile } from "./parse.js";

/*
 * Who owns a path: the last rule that matches it decides. A path no rule
 * matches has no code owners; one an ownerless rule matches last is
 * explicitly ownerless (and so exempt); otherwise its owners are the rule's.
 * Paths are matched as text: a path that is not UTF-8 cannot be matched
 * safely (two such paths could decode to the same text), so its caller
 * refuses rather than match it.
 */

export type PathOwnership =
  | { readonly kind: "unmatched" }
  | { readonly kind: "ownerless"; readonly line: number }
  | { readonly kind: "owned"; readonly line: number; readonly owners: readonly CodeOwner[] };

/** `path`'s owners under `file`'s rules, spending steps from `budget`. */
export function ownershipOf(
  file: CodeOwnersFile,
  path: string,
  budget: MatchBudget,
): PathOwnership {
  const prepared = preparePath(path, budget);
  for (let i = file.rules.length - 1; i >= 0; i--) {
    const rule = file.rules[i];
    if (!rule || !matchesPath(rule.pattern, prepared, budget)) continue;
    return rule.owners.length === 0
      ? { kind: "ownerless", line: rule.line }
      : { kind: "owned", line: rule.line, owners: rule.owners };
  }
  return { kind: "unmatched" };
}

/**
 * A path's bytes as the text CODEOWNERS matches; undefined when they are
 * not UTF-8. Every byte counts: a leading byte order mark is kept, so no
 * two paths become one text.
 */
export function pathText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
