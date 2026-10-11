import { isValidRefnameBelowPrefix } from "../refs/refname.js";
import { concatBytes, copyBytes, latin1, latin1Bytes, startsWithAscii } from "./bytes.js";
import { readIdentLine, readOidLine } from "./commit.js";
import { type FsckIssue, GitObjectError, issue, type Parsed } from "./fsck.js";
import { encodeHeader, type Header, lazyHeaders, verifyHeaders } from "./headers.js";
import { encodeIdent, type Ident } from "./ident.js";
import { isObjectType, type ObjectType } from "./object.js";
import { type Oid, oidToHex } from "./oid.js";

export interface Tag {
  readonly object: Oid;
  readonly type: ObjectType;
  /** The tag's name as written in the object (raw bytes; usually the ref name without `refs/tags/`). */
  readonly name: Uint8Array;
  /** Absent in some early tags. */
  readonly tagger: Ident | null;
  /** Headers after `tagger`: `gpgsig`, `gpgsig-sha256`, unknown. */
  readonly headers: readonly Header[];
  /** Everything after the blank line, including any inline signature. */
  readonly message: Uint8Array;
}

const LF = 0x0a;
/** Longest `type` value worth decoding: anything longer is not an object type. */
const MAX_TYPE_BYTES = 16;

/**
 * Parses a tag body with the checks of git's `fsck_tag_standalone`, in its
 * order, throwing the first error. A name that is not a valid ref name and a
 * missing tagger are returned as findings (info level in git).
 */
export function parseTag(body: Uint8Array): Parsed<Tag> {
  const headersEnd = verifyHeaders(body);
  const reader = { p: 0 };
  const object = readOidLine(body, reader, "object ", "badObjectSha1");
  if (!object) throw new GitObjectError("missingObject", "invalid format - expected 'object' line");
  const [typeStart, typeEnd] = readLine(body, reader, "type ", "missingTypeEntry", "missingType");
  const typeText =
    typeEnd - typeStart <= MAX_TYPE_BYTES ? latin1(body.subarray(typeStart, typeEnd)) : "";
  if (!isObjectType(typeText)) throw new GitObjectError("badType", "invalid 'type' value");
  // The name can be as long as the object: it is copied once and checked as
  // bytes (as "refs/tags/<name>", without building that string or array).
  const [nameStart, nameEnd] = readLine(body, reader, "tag ", "missingTagEntry", "missingTag");
  const name = copyBytes(body, nameStart, nameEnd);
  const issues: FsckIssue[] = [];
  if (!isValidRefnameBelowPrefix(name)) issues.push(issue("badTagName"));
  let tagger: Ident | null = null;
  if (startsWithAscii(body, reader.p, "tagger ")) {
    tagger = readIdentLine(body, reader, "tagger ".length);
  } else {
    issues.push(issue("missingTaggerEntry"));
  }
  const headers = lazyHeaders(body, reader.p, headersEnd);
  const message = copyBytes(body, Math.min(headersEnd + 1, body.length));
  return {
    value: {
      object,
      type: typeText,
      name,
      tagger,
      get headers() {
        return headers();
      },
      message,
    },
    issues,
  };
}

/** The value of the line `<prefix><value>\n` at the reader, as [start, end) in `body`. */
function readLine(
  body: Uint8Array,
  reader: { p: number },
  prefix: string,
  missingEntry: "missingTypeEntry" | "missingTagEntry",
  missingEnd: "missingType" | "missingTag",
): [number, number] {
  if (!startsWithAscii(body, reader.p, prefix)) {
    throw new GitObjectError(missingEntry, `invalid format - expected '${prefix.trim()}' line`);
  }
  const start = reader.p + prefix.length;
  const nl = body.indexOf(LF, start);
  if (nl < 0)
    throw new GitObjectError(
      missingEnd,
      `invalid format - unexpected end after '${prefix.trim()}' line`,
    );
  reader.p = nl + 1;
  return [start, nl];
}

/** Encodes a tag as git writes one. */
export function encodeTag(tag: Tag): Uint8Array<ArrayBuffer> {
  if (tag.name.length === 0 || tag.name.includes(LF) || tag.name.includes(0)) {
    throw new RangeError("a tag name must be non-empty, without LF or NUL");
  }
  // Without a tagger line, a first header named "tagger" would be read back as one.
  if (tag.tagger === null && tag.headers[0]?.key === "tagger") {
    throw new RangeError("a tag without a tagger cannot start its headers with 'tagger'");
  }
  const parts: Uint8Array[] = [
    latin1Bytes(`object ${oidToHex(tag.object)}\ntype ${tag.type}\ntag `),
    tag.name,
    Uint8Array.of(LF),
  ];
  if (tag.tagger) parts.push(latin1Bytes("tagger "), encodeIdent(tag.tagger), Uint8Array.of(LF));
  for (const header of tag.headers) parts.push(encodeHeader(header));
  parts.push(Uint8Array.of(LF), tag.message);
  return concatBytes(parts);
}
