/**
 * Whether a diff comment holds a suggested change, read in the browser
 * only: the same reading the API applies them with (`@fyrden/domain`'s
 * parser alone, not the whole package), which validates them again when
 * they are applied. The server never parses comment bodies (its CPU
 * budget is small).
 */
import { parseSuggestion } from "@fyrden/domain/suggestion";

export function holdsSuggestion(body: string): boolean {
  return parseSuggestion(body) !== undefined;
}
