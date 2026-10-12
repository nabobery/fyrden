import { concatBytes, copyBytes, latin1Bytes, startsWithAscii } from "./bytes.js";
import { type FsckIssue, type FsckMessageId, GitObjectError, issue, type Parsed } from "./fsck.js";
import { encodeHeader, type Header, lazyHeaders, verifyHeaders } from "./headers.js";
import { encodeIdent, type Ident, parseIdent } from "./ident.js";
import { OID_HEX_LENGTH, type Oid, oidToHex, parseOidHex } from "./oid.js";

export interface Commit {
  readonly tree: Oid;
  readonly parents: readonly Oid[];
  readonly author: Ident;
  readonly committer: Ident;
  /** Headers after `committer`, in order (`encoding`, `gpgsig`, `mergetag`, unknown). */
  readonly headers: readonly Header[];
  /** Everything after the blank line; empty when there is none. */
  readonly message: Uint8Array;
}

const LF = 0x0a;

/**
 * Parses a commit body with the checks of git's `fsck_commit`, in its order.
 * Like git, it stops at the first error and throws it as a `GitObjectError`;
 * the only finding it returns is the `nulInCommit` warning.
 */
export function parseCommit(body: Uint8Array): Parsed<Commit> {
  const headersEnd = verifyHeaders(body);
  const reader = { p: 0 };
  const tree = readOidLine(body, reader, "tree ", "badTreeSha1");
  if (!tree) throw new GitObjectError("missingTree", "invalid format - expected 'tree' line");
  const parents: Oid[] = [];
  for (let parent = readOidLine(body, reader, "parent ", "badParentSha1"); parent; ) {
    parents.push(parent);
    parent = readOidLine(body, reader, "parent ", "badParentSha1");
  }
  const authors: Ident[] = [];
  while (startsWithAscii(body, reader.p, "author ")) {
    authors.push(readIdentLine(body, reader, "author ".length));
  }
  const [author] = authors;
  if (!author) throw new GitObjectError("missingAuthor", "invalid format - expected 'author' line");
  if (authors.length > 1) {
    throw new GitObjectError("multipleAuthors", "invalid format - multiple 'author' lines");
  }
  if (!startsWithAscii(body, reader.p, "committer ")) {
    throw new GitObjectError("missingCommitter", "invalid format - expected 'committer' line");
  }
  const committer = readIdentLine(body, reader, "committer ".length);
  const issues: FsckIssue[] = body.includes(0) ? [issue("nulInCommit")] : [];
  const headers = lazyHeaders(body, reader.p, headersEnd);
  const message = copyBytes(body, Math.min(headersEnd + 1, body.length));
  return {
    value: {
      tree,
      parents,
      author,
      committer,
      get headers() {
        return headers();
      },
      message,
    },
    issues,
  };
}

/**
 * Reads `<prefix><40 hex>\n`. Returns undefined when the prefix is absent;
 * throws `bad` when the id or the line end is wrong.
 */
export function readOidLine(
  body: Uint8Array,
  reader: { p: number },
  prefix: string,
  bad: FsckMessageId,
): Oid | undefined {
  if (!startsWithAscii(body, reader.p, prefix)) return undefined;
  const start = reader.p + prefix.length;
  const oid = parseOidHex(body, start);
  if (!oid || body[start + OID_HEX_LENGTH] !== LF) {
    throw new GitObjectError(bad, `invalid '${prefix.trim()}' line format - bad sha1`);
  }
  reader.p = start + OID_HEX_LENGTH + 1;
  return oid;
}

/** Reads an ident line whose keyword (`skip` bytes) is already matched. */
export function readIdentLine(body: Uint8Array, reader: { p: number }, skip: number): Ident {
  const start = reader.p + skip;
  // verify_headers guarantees a newline ends every header line.
  const nl = body.indexOf(LF, start);
  reader.p = nl + 1;
  return parseIdent(body, start, nl);
}

/** Encodes a commit as git writes one. */
export function encodeCommit(commit: Commit): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [latin1Bytes(`tree ${oidToHex(commit.tree)}\n`)];
  for (const parent of commit.parents) parts.push(latin1Bytes(`parent ${oidToHex(parent)}\n`));
  parts.push(latin1Bytes("author "), encodeIdent(commit.author), Uint8Array.of(LF));
  parts.push(latin1Bytes("committer "), encodeIdent(commit.committer), Uint8Array.of(LF));
  for (const header of commit.headers) parts.push(encodeHeader(header));
  parts.push(Uint8Array.of(LF), commit.message);
  return concatBytes(parts);
}
