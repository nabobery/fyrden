/** A release's assets at most. Proposed: GitHub allows 1,000, and each costs rows and capture bytes. */
export const MAX_RELEASE_ASSETS = 100;
/** Upload sessions a repository may have open at once. Proposed. */
export const MAX_ASSET_UPLOADS = 20;
/** An asset name's UTF-8 bytes at most, as most file systems take. */
export const MAX_ASSET_NAME_BYTES = 255;
/** The content type of an asset that declares none. */
export const ASSET_CONTENT_TYPE_DEFAULT = "application/octet-stream";

export type AssetName =
  | { readonly ok: true; readonly name: string; readonly fold: string }
  | { readonly ok: false; readonly reason: string };

const utf8 = new TextEncoder();

/** The bidirectional formatting characters (Unicode's Bidi_Control). */
const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/**
 * An asset's name as stored, in NFC, and the form two names are compared
 * by (`fold`, lowercased); or why it can't be one. A name is a file's:
 * no separator, no control or bidirectional formatting character, not
 * `.` or `..`, and short enough
 * for a file system, counted in the stored form's UTF-8 bytes.
 */
export function assetName(raw: string): AssetName {
  if (!raw.isWellFormed()) return { ok: false, reason: "isn't well-formed Unicode" };
  const name = raw.normalize("NFC");
  const length = utf8.encode(name).length;
  if (length === 0) return { ok: false, reason: "is empty" };
  if (length > MAX_ASSET_NAME_BYTES)
    return { ok: false, reason: `is over ${MAX_ASSET_NAME_BYTES} bytes` };
  if (/[\p{Cc}/\\]/u.test(name))
    return { ok: false, reason: "holds a slash, a backslash or a control character" };
  // A bidirectional control can show a name as another (`a\u202Etxt.exe` as `aexe.txt`).
  if (BIDI_CONTROL.test(name))
    return { ok: false, reason: "holds a bidirectional formatting character" };
  if (name === "." || name === "..") return { ok: false, reason: "is a directory's name" };
  return { ok: true, name, fold: name.toLowerCase() };
}

/** A media type's name: RFC 6838's restricted names, 127 characters each. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * An asset's declared content type, lowercased, with no parameters; the
 * default when none is declared. Metadata only: a download is always sent
 * as `application/octet-stream`.
 */
export function assetContentType(
  raw: string | undefined,
): { readonly ok: true; readonly type: string } | { readonly ok: false } {
  if (raw === undefined) return { ok: true, type: ASSET_CONTENT_TYPE_DEFAULT };
  const type = raw.toLowerCase();
  return MEDIA_TYPE.test(type) ? { ok: true, type } : { ok: false };
}
