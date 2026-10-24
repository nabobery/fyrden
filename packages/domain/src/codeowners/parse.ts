import { HANDLE_PATTERN } from "../principals/principal.js";
import {
  type CompiledPattern,
  compilePattern,
  MAX_PATTERN_SEGMENTS,
  MAX_PATTERN_WILDCARDS,
  type PatternRefusal,
} from "./match.js";

/*
 * A CODEOWNERS file as GitHub reads it: one rule a line, a pattern and its
 * owners (`@user` or `@org/team`; none makes matching paths ownerless),
 * an unescaped `#` anywhere starting a comment, the last matching rule
 * deciding. GitHub skips an invalid line; Fyrden keeps every
 * error (with its line, column and reason) so that a merge needing code
 * owners can refuse while any is left (fail closed). Email owners are not
 * supported: Fyrden has no email identities to match them to.
 */

/** Where GitHub looks for the file, in its order: the first that exists is used. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/** The file's largest size, in bytes (GitHub: under 3 MB). Proposed. */
export const MAX_CODEOWNERS_BYTES = 3_000_000;
/** Rule lines a file holds at most (ownerless and invalid ones included). Proposed. */
export const MAX_CODEOWNERS_RULES = 1_000;
/** A pattern's largest size, in UTF-8 bytes. Proposed. */
export const MAX_PATTERN_BYTES = 4 * 1024;
/** Owners one rule names at most. Proposed. */
export const MAX_RULE_OWNERS = 32;
/** Owner names a file holds at most, all rules together. Proposed. */
export const MAX_FILE_OWNERS = 4_096;

/** A team's slug, as Fyrden makes them. */
const TEAM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEAM_SLUG_LENGTH = 100;

/** An owner a rule names. */
export type CodeOwner =
  | { readonly kind: "user"; readonly handle: string }
  | { readonly kind: "team"; readonly org: string; readonly slug: string };

export interface CodeOwnersRule {
  /** Its line, from 1. */
  readonly line: number;
  readonly pattern: CompiledPattern;
  /** None: the paths it matches have no owners. */
  readonly owners: readonly CodeOwner[];
}

/** An error, as GitHub's `codeowners/errors` reports one. */
export interface CodeOwnersError {
  /** From 1; 0 for the file as a whole. */
  readonly line: number;
  /** From 1, where the error starts; 0 for the file as a whole. */
  readonly column: number;
  readonly kind:
    | "File too large"
    | "Too many rules"
    | "Too many owners"
    | "Invalid pattern"
    | "Pattern too long"
    | "Invalid owner"
    | "Unsupported owner"
    | "Invalid encoding";
  /** The line as written (empty for the file as a whole). */
  readonly source: string;
  readonly message: string;
  readonly suggestion: string | null;
}

export interface CodeOwnersFile {
  readonly rules: readonly CodeOwnersRule[];
  readonly errors: readonly CodeOwnersError[];
}

const PATTERN_MESSAGES: Record<PatternRefusal, { message: string; suggestion: string | null }> = {
  empty: { message: "The pattern is empty.", suggestion: null },
  negation: {
    message: "Negating a pattern with `!` is not supported.",
    suggestion: "Give the paths an ownerless rule after the broader one instead.",
  },
  globstar_only: {
    message: "A pattern of `**` and slashes alone has no agreed meaning.",
    suggestion: "Use `*` for every file, or `/dir/` for everything under a directory.",
  },
  escaped_comment: {
    message: "A pattern cannot start with an escaped `#`.",
    suggestion: "Escape a `#` that is not first, such as `/**/\\#name`.",
  },
  escaped_slash: {
    message: "A slash cannot be escaped: it always separates directories.",
    suggestion: "Write the slash unescaped.",
  },
  triple_star: { message: "`***` is not a valid pattern.", suggestion: "Use `**`." },
  too_many_segments: {
    message: `A pattern holds at most ${MAX_PATTERN_SEGMENTS} path segments.`,
    suggestion: "Name a shorter path, or a directory above it.",
  },
  too_many_wildcards: {
    message: `A pattern holds at most ${MAX_PATTERN_WILDCARDS} wildcards (\`*\` and \`?\`).`,
    suggestion: "Split it into several rules, or name the paths more directly.",
  },
  root_only: { message: "The pattern `/` matches nothing.", suggestion: "Use `*` for every file." },
  trailing_escape: {
    message: "The pattern ends with a lone `\\`.",
    suggestion: "Escape the character after it, or remove it.",
  },
};

/** A token of a line: its text as written (escapes kept) and its column (code points, from 1). */
interface Token {
  readonly text: string;
  readonly column: number;
}

/** The bytes of a code point in UTF-8. */
const utf8Bytes = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4);

/**
 * A line's tokens, split on unescaped spaces and tabs; an unescaped `#`
 * and the rest are a comment. Read in place, at most `max` tokens, and the
 * first (the pattern) only up to `MAX_PATTERN_BYTES`: past either, reading
 * stops before anything more is kept (`tooLong` names the pattern's column).
 */
function tokensOf(line: string, max: number): { tokens: Token[]; tooLong?: number } {
  const tokens: Token[] = [];
  let start = -1;
  let startColumn = 0;
  let column = 0;
  let bytes = 0;
  // Where reading stopped: the line's end, or a comment.
  let end = line.length;
  for (let i = 0; i < line.length; ) {
    const code = line.codePointAt(i) as number;
    let units = code > 0xffff ? 2 : 1;
    column++;
    if (code === 0x20 || code === 0x09) {
      if (start >= 0) {
        tokens.push({ text: line.slice(start, i), column: startColumn });
        start = -1;
        if (tokens.length === max) return { tokens };
      }
      i += units;
      continue;
    }
    if (code === 0x23) {
      end = i;
      break;
    }
    if (start < 0) {
      start = i;
      startColumn = column;
      bytes = 0;
    }
    bytes += utf8Bytes(code);
    if (code === 0x5c && i + units < line.length) {
      // An escape: the next code point is the token's too, whatever it is.
      const next = line.codePointAt(i + units) as number;
      units += next > 0xffff ? 2 : 1;
      column++;
      bytes += utf8Bytes(next);
    }
    if (tokens.length === 0 && bytes > MAX_PATTERN_BYTES) return { tokens, tooLong: startColumn };
    i += units;
  }
  if (start >= 0) tokens.push({ text: line.slice(start, end), column: startColumn });
  return { tokens };
}

/** Characters of a token a message quotes at most (a token is as long as its line may be). */
export const MAX_QUOTED_CHARACTERS = 256;

/**
 * `text` cut to its first `max` code points, `…` marking a cut: what an
 * error message or answer quotes of a line or token.
 */
export function quoteExcerpt(text: string, max: number): string {
  let units = 0;
  let points = 0;
  while (units < text.length && points < max) {
    units += (text.codePointAt(units) as number) > 0xffff ? 2 : 1;
    points++;
  }
  return units < text.length ? `${text.slice(0, units)}…` : text;
}

/** A file of `size` bytes, too large to read: no rules, and its whole-file error (read no further). */
export function codeOwnersTooLarge(size: number): CodeOwnersFile {
  return {
    rules: [],
    errors: [
      {
        line: 0,
        column: 0,
        kind: "File too large",
        source: "",
        message: `The file is ${size} bytes; it must be under ${MAX_CODEOWNERS_BYTES}.`,
        suggestion: null,
      },
    ],
  };
}

/** An owner token as an owner, or why it is not one. */
function ownerOf(
  token: string,
): { ok: true; owner: CodeOwner } | { ok: false; kind: CodeOwnersError["kind"]; message: string } {
  const quoted = quoteExcerpt(token, MAX_QUOTED_CHARACTERS);
  if (!token.startsWith("@")) {
    return token.includes("@")
      ? {
          ok: false,
          kind: "Unsupported owner",
          message: `Email owners (${quoted}) are not supported.`,
        }
      : {
          ok: false,
          kind: "Invalid owner",
          message: `${quoted} is not an owner: use @user or @org/team.`,
        };
  }
  const name = token.slice(1);
  const slash = name.indexOf("/");
  if (slash < 0)
    return HANDLE_PATTERN.test(name)
      ? { ok: true, owner: { kind: "user", handle: name } }
      : { ok: false, kind: "Invalid owner", message: `${quoted} is not a valid user.` };
  const org = name.slice(0, slash);
  const slug = name.slice(slash + 1);
  return HANDLE_PATTERN.test(org) &&
    slug.length <= MAX_TEAM_SLUG_LENGTH &&
    TEAM_SLUG.test(slug.toLowerCase())
    ? { ok: true, owner: { kind: "team", org, slug: slug.toLowerCase() } }
    : { ok: false, kind: "Invalid owner", message: `${quoted} is not a valid team.` };
}

/**
 * Reads a CODEOWNERS file's bytes: its valid rules, in order, and every
 * error. A file over the size cap or not UTF-8 has no rules.
 */
export function parseCodeOwners(bytes: Uint8Array): CodeOwnersFile {
  const whole = (kind: CodeOwnersError["kind"], message: string): CodeOwnersFile => ({
    rules: [],
    errors: [{ line: 0, column: 0, kind, source: "", message, suggestion: null }],
  });
  if (bytes.length >= MAX_CODEOWNERS_BYTES) return codeOwnersTooLarge(bytes.length);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return whole("Invalid encoding", "The file is not valid UTF-8.");
  }
  const rules: CodeOwnersRule[] = [];
  const errors: CodeOwnersError[] = [];
  let owners = 0;
  // Rule lines read, valid or not: past the cap, reading stops with one error.
  let read = 0;
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const source = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const line = index + 1;
    // The pattern, its owners, and one past their cap.
    const { tokens, tooLong } = tokensOf(source, MAX_RULE_OWNERS + 2);
    const [first, ...rest] = tokens;
    if (!first && tooLong === undefined) continue;
    const error = (
      column: number,
      kind: CodeOwnersError["kind"],
      message: string,
      suggestion: string | null = null,
    ) => errors.push({ line, column, kind, source, message, suggestion });
    if (++read > MAX_CODEOWNERS_RULES) {
      error(
        first?.column ?? tooLong ?? 1,
        "Too many rules",
        `A file holds at most ${MAX_CODEOWNERS_RULES} rules; the rest is not read.`,
      );
      break;
    }
    if (!first) {
      error(tooLong ?? 1, "Pattern too long", `A pattern is at most ${MAX_PATTERN_BYTES} bytes.`);
      continue;
    }
    const compiled = compilePattern(first.text);
    if (!compiled.ok) {
      const { message, suggestion } = PATTERN_MESSAGES[compiled.refusal];
      error(first.column, "Invalid pattern", message, suggestion);
      continue;
    }
    if (rest.length > MAX_RULE_OWNERS) {
      error(
        rest[MAX_RULE_OWNERS]?.column ?? first.column,
        "Too many owners",
        `A rule names at most ${MAX_RULE_OWNERS} owners.`,
      );
      continue;
    }
    const named: CodeOwner[] = [];
    // One error a line: the first owner refused, and how many more were.
    let refused: { column: number; kind: CodeOwnersError["kind"]; message: string } | undefined;
    let more = 0;
    for (const token of rest) {
      const owner = ownerOf(token.text);
      if (owner.ok) named.push(owner.owner);
      else if (refused) more++;
      else refused = { column: token.column, kind: owner.kind, message: owner.message };
    }
    if (refused) {
      error(
        refused.column,
        refused.kind,
        more === 0
          ? refused.message
          : `${refused.message} ${more} more owner${more === 1 ? " is" : "s are"} not valid either.`,
      );
      continue;
    }
    if (owners + named.length > MAX_FILE_OWNERS) {
      error(
        first.column,
        "Too many owners",
        `A file names at most ${MAX_FILE_OWNERS} owners in all.`,
      );
      continue;
    }
    owners += named.length;
    rules.push({ line, pattern: compiled.pattern, owners: named });
  }
  return { rules, errors };
}
