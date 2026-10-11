import { excerpt } from "../protocol/errors.js";
import { parseGitConfig } from "./git-config.js";

/*
 * The checks `git fsck` runs on a `.gitmodules` blob (fsck.c
 * `fsck_gitmodules_fn`, submodule-config.c `check_submodule_name` and
 * `check_submodule_url`, urlmatch.c `url_normalize`, url.c `url_decode`,
 * submodule.c `parse_submodule_update_type`; git v2.53.0, verified). They
 * stop submodule names that escape `.git/modules`, URLs and paths that a
 * later `git submodule` would pass on as command-line options or that
 * smuggle a newline into a credential helper, and `update = !command`.
 */

export type GitmodulesFindingId =
  | "gitmodulesName"
  | "gitmodulesUrl"
  | "gitmodulesPath"
  | "gitmodulesUpdate"
  | "gitmodulesParse";

export interface GitmodulesFinding {
  readonly id: GitmodulesFindingId;
  /** git's message text before the value, e.g. "disallowed submodule name". */
  readonly what: string;
  /** The offending value, whole, as git prints it after `what` (absent for a parse failure). */
  readonly value?: string;
  /**
   * The message for clients and logs: `what`, then the value as an
   * escaped excerpt (values are attacker-sized and may hold control
   * characters).
   */
  readonly message: string;
}

/**
 * Every finding git's fsck reports for a `.gitmodules` blob with these
 * bytes, up to `maxFindings`; past that, the rest are counted per id into
 * one finding each ("and N more"), so a policy that ignores one id still
 * sees every other id that was left out.
 */
export function checkGitmodules(
  blob: Uint8Array,
  maxFindings = Number.POSITIVE_INFINITY,
): GitmodulesFinding[] {
  const findings: GitmodulesFinding[] = [];
  // At most one counter per id, in the order the ids were first left out.
  const omitted = new Map<GitmodulesFindingId, number>();
  const report = (id: GitmodulesFindingId, what: string, value: string) => {
    if (findings.length < maxFindings) {
      findings.push({ id, what, value, message: `${what}: ${shown(value)}` });
    } else {
      omitted.set(id, (omitted.get(id) ?? 0) + 1);
    }
  };
  const parsed = parseGitConfig(blob, (variable, rawValue) => {
    const key = parseConfigKey(variable, "submodule");
    if (!key || key.subsection === undefined) return;
    // C strings: everything from a NUL on is invisible to git's checks.
    const name = cString(key.subsection);
    const value = rawValue === null ? null : cString(rawValue);
    if (!isValidSubmoduleName(name)) {
      report("gitmodulesName", "disallowed submodule name", name);
    }
    if (key.key === "url" && value !== null && !isValidSubmoduleUrl(value)) {
      report("gitmodulesUrl", "disallowed submodule url", value);
    }
    if (key.key === "path" && value !== null && looksLikeOption(value)) {
      report("gitmodulesPath", "disallowed submodule path", value);
    }
    if (key.key === "update" && value !== null && value.startsWith("!")) {
      report("gitmodulesUpdate", "disallowed submodule update setting", value);
    }
  });
  for (const [id, count] of omitted) {
    const what = `and ${count} more disallowed submodule settings`;
    findings.push({ id, what, message: what });
  }
  if (!parsed) {
    const what = "could not parse gitmodules blob";
    findings.push({ id: "gitmodulesParse", what, message: what });
  }
  return findings;
}

/** A value as a message shows it: `excerpt` of its first bytes (each character is one byte). */
function shown(value: string): string {
  const head = value.slice(0, EXCERPT_CHARS + 1);
  return excerpt(Uint8Array.from({ length: head.length }, (_, i) => head.charCodeAt(i) & 0xff));
}

/** More than `excerpt` shows, so it still marks a cut. */
const EXCERPT_CHARS = 64;

function cString(text: string): string {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}

/** config.c `parse_config_key`: the subsection runs to the last dot. */
function parseConfigKey(
  variable: string,
  section: string,
): { subsection: string | undefined; key: string } | undefined {
  if (!variable.startsWith(section) || variable.charAt(section.length) !== ".") return undefined;
  const rest = variable.slice(section.length);
  const lastDot = rest.lastIndexOf(".");
  const key = rest.slice(lastDot + 1);
  return { subsection: lastDot === 0 ? undefined : rest.slice(1, lastDot), key };
}

const isSeparator = (c: string | undefined) => c === "/" || c === "\\";

/** `check_submodule_name`: not empty, and no ".." path component ('/' or '\' separated). */
export function isValidSubmoduleName(name: string): boolean {
  if (name.length === 0) return false;
  const dotdotAt = (i: number) =>
    name.charAt(i) === "." &&
    name.charAt(i + 1) === "." &&
    (i + 2 >= name.length || isSeparator(name.charAt(i + 2)));
  if (dotdotAt(0)) return false;
  for (let i = 0; i < name.length; i++) {
    if (isSeparator(name.charAt(i)) && dotdotAt(i + 1)) return false;
  }
  return true;
}

/** path.c `looks_like_command_line_option`. */
function looksLikeOption(text: string): boolean {
  return text.startsWith("-");
}

const startsWithDotSlash = (s: string) => s.charAt(0) === "." && isSeparator(s.charAt(1));
const startsWithDotDotSlash = (s: string) =>
  s.charAt(0) === "." && s.charAt(1) === "." && isSeparator(s.charAt(2));

/** `check_submodule_url`. */
export function isValidSubmoduleUrl(url: string): boolean {
  if (looksLikeOption(url)) return false;
  if (startsWithDotSlash(url) || startsWithDotDotSlash(url) || url.startsWith("git://")) {
    if (urlDecode(url).includes("\n")) return false;
    // Relative URLs that climb out with "../" and then start a host or
    // scheme can rewrite the host field (CVE-2020-11008).
    let rest = url;
    let dotdots = 0;
    for (;;) {
      if (startsWithDotDotSlash(rest)) {
        dotdots++;
        rest = rest.slice(3);
      } else if (startsWithDotSlash(rest)) {
        rest = rest.slice(2);
      } else {
        break;
      }
    }
    return !(dotdots > 0 && (rest.startsWith(":") || rest.startsWith("/")));
  }
  const curl = curlUrl(url);
  if (curl !== undefined) {
    const normalized = normalizeUrl(curl);
    return normalized !== undefined && !urlDecode(normalized).includes("\n");
  }
  return true;
}

/** submodule-config.c `url_to_curl_url`: URLs git-remote-curl would be handed. */
function curlUrl(url: string): string | undefined {
  for (const prefix of ["http::", "https::", "ftp::", "ftps::"]) {
    if (url.startsWith(prefix)) return url.slice(prefix.length);
  }
  for (const prefix of ["http://", "https://", "ftp://", "ftps://"]) {
    if (url.startsWith(prefix)) return url;
  }
  return undefined;
}

function hexValue(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x61 && code <= 0x66) return code - 0x57;
  if (code >= 0x41 && code <= 0x46) return code - 0x37;
  return -1;
}

/** hex-ll.c `hex2chr`: two hex digits, or -1. */
function hex2chr(s: string, at: number): number {
  if (at + 1 >= s.length) return -1;
  const hi = hexValue(s.charAt(at));
  const lo = hexValue(s.charAt(at + 1));
  return hi < 0 || lo < 0 ? -1 : (hi << 4) | lo;
}

/** url.c `url_decode`: %XX decoded after the scheme; "%00" stays as it is. */
export function urlDecode(url: string): string {
  const colon = url.indexOf(":");
  let out = colon > 0 ? url.slice(0, colon) : "";
  let i = colon > 0 ? colon : 0;
  while (i < url.length) {
    const c = url.charAt(i);
    if (c === "\0") break;
    if (c === "%" && url.length - i >= 3) {
      const value = hex2chr(url, i + 1);
      if (value > 0) {
        out += String.fromCharCode(value);
        i += 3;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const URL_ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const URL_DIGIT = "0123456789";
const URL_SCHEME_CHARS = `${URL_ALPHA}${URL_DIGIT}+.-`;
const URL_HOST_CHARS = `${URL_ALPHA}${URL_DIGIT}.-_[:]`;
const URL_UNSAFE_CHARS = ' <>"%{}|\\^`';
const URL_RESERVED = ":/?#[]@!$&'()*+,;=";

/** Length of the prefix of `s` (from `at`) made of characters in `set`, as C `strspn`. */
function span(s: string, at: number, set: string): number {
  let n = 0;
  while (at + n < s.length && set.includes(s.charAt(at + n))) n++;
  return n;
}

/** The first index at or after `at` holding a character of `set`, or the length. */
function cspan(s: string, at: number, set: string): number {
  let i = at;
  while (i < s.length && !set.includes(s.charAt(i))) i++;
  return i;
}

/**
 * urlmatch.c `append_normalized_escapes`: undefined for a '%' not followed
 * by two hex digits.
 */
function normalizeEscapes(from: string, escOk: string): string | undefined {
  let out = "";
  for (let i = 0; i < from.length; ) {
    let code = from.charCodeAt(i++);
    let wasEscaped = false;
    if (code === 0x25) {
      if (from.length - i < 2) return undefined;
      code = hex2chr(from, i);
      if (code < 0) return undefined;
      i += 2;
      wasEscaped = true;
    }
    const ch = String.fromCharCode(code);
    if (
      code <= 0x1f ||
      code >= 0x7f ||
      URL_UNSAFE_CHARS.includes(ch) ||
      (wasEscaped && escOk.includes(ch))
    ) {
      out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * urlmatch.c `url_normalize` (without globs): the normalized URL, or
 * undefined for a URL git refuses (bad scheme, bad escapes, bad host
 * characters, bad port, a ".." above the root).
 */
export function normalizeUrl(input: string): string | undefined {
  let url = input;
  let spanned = span(url, 0, URL_SCHEME_CHARS);
  const first = url.charCodeAt(0);
  const isAlphaFirst = (first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a);
  if (
    !spanned ||
    !isAlphaFirst ||
    spanned + 3 > url.length ||
    url.charAt(spanned) !== ":" ||
    url.charAt(spanned + 1) !== "/" ||
    url.charAt(spanned + 2) !== "/"
  ) {
    return undefined;
  }
  spanned += 3;
  let norm = url.slice(0, spanned).toLowerCase();
  url = url.slice(spanned);

  // user:password@
  const at = url.indexOf("@");
  let slash = cspan(url, 0, "/?#");
  if (at >= 0 && at < slash) {
    if (at > 0) {
      const userinfo = normalizeEscapes(url.slice(0, at), URL_RESERVED);
      if (userinfo === undefined) return undefined;
      norm += userinfo;
    }
    norm += "@";
    url = url.slice(at + 1);
    slash = cspan(url, 0, "/?#");
  }

  // Host (no escapes), required except for file: URLs.
  let hasHost = true;
  if (url.length === 0 || ":/?#".includes(url.charAt(0))) {
    if (!norm.startsWith("file:")) return undefined;
    hasHost = false;
  }
  let colon = slash - 1;
  while (colon > 0 && url.charAt(colon) !== ":" && url.charAt(colon) !== "]") colon--;
  if (url.charAt(colon) !== ":") {
    colon = slash;
  } else if (!hasHost && colon < slash && colon + 1 !== slash) {
    return undefined;
  }
  if (span(url, 0, URL_HOST_CHARS) < colon) return undefined;
  norm += url.slice(0, colon).toLowerCase();

  // Port, without leading zeros or the scheme's default.
  if (colon < slash) {
    let p = colon + 1;
    while (p < slash && url.charAt(p) === "0") p++;
    if (p === slash && url.charAt(p - 1) === "0") p--;
    const port = url.slice(p, slash);
    if (port === "") {
      // ":" alone means the default port.
    } else if (port === "80" && norm.startsWith("http:")) {
      // Default for http.
    } else if (port === "443" && norm.startsWith("https:")) {
      // Default for https.
    } else {
      if (span(port, 0, URL_DIGIT) < port.length) return undefined;
      const number = port.length <= 5 ? Number.parseInt(port, 10) : 0;
      if (number === 0 || number > 65535) return undefined;
      norm += `:${port}`;
    }
  }
  url = url.slice(slash);

  // Path, resolving "." and ".." segments.
  const pathStart = norm.length;
  norm += "/";
  if (url.startsWith("/")) url = url.slice(1);
  for (;;) {
    const segmentStart = norm.length;
    const next = cspan(url, 0, "/?#");
    const segment = normalizeEscapes(url.slice(0, next), URL_RESERVED);
    if (segment === undefined) return undefined;
    norm += segment;
    let skipSlash = false;
    const added = norm.slice(segmentStart);
    if (added === ".") {
      if (segmentStart === pathStart + 1) {
        norm = norm.slice(0, -1);
        skipSlash = true;
      } else {
        norm = norm.slice(0, -2);
      }
    } else if (added === "..") {
      let prev = norm.length - 3;
      if (prev === pathStart) return undefined;
      do prev--;
      while (norm.charAt(prev) !== "/");
      if (prev === pathStart) {
        norm = norm.slice(0, prev + 1);
        skipSlash = true;
      } else {
        norm = norm.slice(0, prev);
      }
    }
    url = url.slice(next);
    if (!url.startsWith("/")) break;
    url = url.slice(1);
    if (!skipSlash) norm += "/";
  }

  if (url.length > 0) {
    const rest = normalizeEscapes(url, URL_RESERVED);
    if (rest === undefined) return undefined;
    norm += rest;
  }
  return norm;
}
