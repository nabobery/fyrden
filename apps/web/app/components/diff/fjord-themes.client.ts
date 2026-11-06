import { registerCustomTheme } from "@pierre/diffs";
import { FJORD_THEME_NAMES } from "../../lib/fjord.js";

let registered = false;

/** Fjord under one name for each highlighter: Highlights reads the Zed form, Shiki the TextMate. */
export function registerFjordThemes(): void {
  if (registered) return;
  registered = true;
  for (const appearance of ["light", "dark"] as const) {
    const name = FJORD_THEME_NAMES[appearance];
    registerCustomTheme(
      name,
      async () => (await import("../../lib/fjord-themes.js")).zedTheme(appearance),
      "zed",
    );
    registerCustomTheme(
      name,
      async () => (await import("../../lib/fjord-themes.js")).textMateTheme(appearance),
      "textmate",
    );
  }
}
