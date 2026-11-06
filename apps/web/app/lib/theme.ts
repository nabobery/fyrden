/**
 * The colour scheme a visitor picked in the site header: System follows the
 * operating system, Light and Dark override it. Kept in a cookie on this browser,
 * so the server can draw the page in it from the first byte.
 */

export type ThemeMode = "system" | "light" | "dark";

export const THEME_COOKIE = "fyrden_theme";

const COOKIE_ATTRIBUTES = "HttpOnly; Secure; SameSite=Lax";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const MAX_RETURN_LENGTH = 4096;

/** The mode `value` names, if any. */
export function themeModeOf(value: unknown): ThemeMode | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

/** The visitor's mode, by the cookie's exact name; anything unknown reads as System. */
export function themePreference(request: Request): ThemeMode {
  for (const pair of (request.headers.get("Cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at >= 0 && pair.slice(0, at).trim() === THEME_COOKIE) {
      return themeModeOf(pair.slice(at + 1).trim()) ?? "system";
    }
  }
  return "system";
}

/** The `Set-Cookie` value that keeps `mode`; System keeps nothing. */
export function themeCookie(mode: ThemeMode): string {
  return mode === "system"
    ? `${THEME_COOKIE}=; Path=/; Max-Age=0; ${COOKIE_ATTRIBUTES}`
    : `${THEME_COOKIE}=${mode}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; ${COOKIE_ATTRIBUTES}`;
}

/**
 * A page on this origin to return to: the resolved path, since a value that looks
 * local can resolve to another origin once normalized (`/.//evil.test`). Anything
 * else returns home.
 */
export function safeReturnPath(raw: string, origin: string): string {
  // URL parsing drops tabs and newlines, so they could hide a `//` from the check below.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (!raw.startsWith("/") || raw.length > MAX_RETURN_LENGTH || /[\u0000-\u001f]/.test(raw))
    return "/";
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}`;
}
