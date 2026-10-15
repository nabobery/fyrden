import { type IdPrefix, isId } from "@fyrden/domain";
import { OperationError } from "./execute.js";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Base64url of `bytes`, unpadded. */
export function encodeBytesCursor(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The bytes of a cursor `encodeBytesCursor` made, or undefined. */
export function decodeBytesCursor(cursor: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(cursor.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return undefined;
  }
}

/** A page cursor: the last name of a page (UTF-8), opaque to clients. */
export function encodeCursor(name: string): string {
  return encodeBytesCursor(new TextEncoder().encode(name));
}

/**
 * The name a cursor carries ("" without one); a cursor this API could not
 * have returned (not decodable, or not a valid name) is refused.
 */
export function decodeCursor(cursor: string | undefined, valid: (name: string) => boolean): string {
  if (cursor === undefined) return "";
  const bytes = decodeBytesCursor(cursor);
  let name: string | undefined;
  try {
    name = bytes && utf8.decode(bytes);
  } catch {
    name = undefined;
  }
  if (name === undefined || !valid(name)) throw invalidCursor();
  return name;
}

export function invalidCursor(): OperationError {
  return new OperationError(422, "invalid_cursor", "The cursor is not one this API returned.");
}

/** A seek cursor: a row's time and id (a repository's, unless another prefix is named), `<time>:<id>`. */
export function encodeSeekCursor(row: { readonly at: number; readonly id: string }): string {
  return encodeCursor(`${row.at}:${row.id}`);
}

/** The row an `encodeSeekCursor` cursor names (null without one); any other cursor is refused. */
export function decodeSeekCursor(
  cursor: string | undefined,
  prefix: IdPrefix = "rep",
): { readonly at: number; readonly id: string } | null {
  if (cursor === undefined) return null;
  const text = decodeCursor(cursor, (value) => {
    const at = value.indexOf(":");
    const time = value.slice(0, at);
    return (
      /^(0|[1-9][0-9]{0,15})$/.test(time) &&
      Number.isSafeInteger(Number(time)) &&
      isId(value.slice(at + 1), prefix)
    );
  });
  const at = text.indexOf(":");
  return { at: Number(text.slice(0, at)), id: text.slice(at + 1) };
}
