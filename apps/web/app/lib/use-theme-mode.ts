import { useRouteLoaderData } from "react-router";
import type { ThemeMode } from "./theme.js";

/** The visitor's colour scheme; System where the root's data is missing (an error page). */
export function useThemeMode(): ThemeMode {
  const data = useRouteLoaderData("root") as { theme?: ThemeMode } | undefined;
  return data?.theme ?? "system";
}
