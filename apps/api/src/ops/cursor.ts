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
