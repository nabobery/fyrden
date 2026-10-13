import { OperationError } from "./execute.js";

/** A page cursor: the last name of a page, opaque to clients. */
export function encodeCursor(name: string): string {
  return btoa(name).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The name a cursor carries ("" without one); a cursor this API could not
 * have returned (not decodable, or not a valid name) is refused.
 */
export function decodeCursor(cursor: string | undefined, valid: (name: string) => boolean): string {
  if (cursor === undefined) return "";
  let name: string | undefined;
  try {
    name = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    name = undefined;
  }
  if (name === undefined || !valid(name))
    throw new OperationError(422, "invalid_cursor", "The cursor is not one this API returned.");
  return name;
}
