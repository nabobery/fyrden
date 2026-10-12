import { copyBytes } from "../object/bytes.js";
import {
  decodeEntryHeader,
  type EntryHeader,
  PACK_HEADER_BYTES,
  PACK_TRAILER_BYTES,
} from "../pack/entry-header.js";
import { PackError } from "../pack/errors.js";
import { inflateEntry, maxCompressedBytes, NeedMoreInput } from "../pack/inflate.js";
import type { Zlib } from "../ports/zlib.js";
import type { PackBytesSource } from "./block-reader.js";
import type { ViewPack } from "./view.js";

/** The longest entry header: 10 size bytes and a 20-byte REF_DELTA base. */
const MAX_HEADER_BYTES = 30;
/**
 * Entries above this size are read in growing steps from here, so a large
 * object that compresses well does not pull its whole uncompressed size
 * through the cache. Proposed default; tuned under load.
 */
const FIRST_READ_LARGE = 1024 * 1024;

/** An entry's header and its inflated body: the object, or a delta program. */
export interface RawEntry {
  readonly header: EntryHeader;
  readonly data: Uint8Array;
}

/** Where the pack's entries end: the trailer follows. */
function entriesEnd(pack: ViewPack): number {
  return pack.bytes - PACK_TRAILER_BYTES;
}

function checkOffset(pack: ViewPack, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < PACK_HEADER_BYTES || offset >= entriesEnd(pack)) {
    throw new PackError("truncated", `entry offset ${offset} is outside the pack`, offset);
  }
}

/** Decodes the header of the entry at `offset`, reading as little as the source allows. */
export async function readEntryHeader(
  source: PackBytesSource,
  pack: ViewPack,
  offset: number,
  maxObjectBytes: number,
): Promise<{ header: EntryHeader; bytes: Uint8Array }> {
  checkOffset(pack, offset);
  const end = entriesEnd(pack);
  const bytes = (await source(pack, offset, Math.min(end, offset + MAX_HEADER_BYTES))).subarray(
    0,
    end - offset,
  );
  const header = decodeEntryHeader(bytes, 0, offset, maxObjectBytes);
  if (header === undefined) {
    throw new PackError("truncated", "entry header runs into the trailer", offset);
  }
  return { header, bytes };
}

/** An entry header and pack bytes from the entry's offset, as `readEntry` starts from. */
export interface EntryHead {
  readonly header: EntryHeader;
  readonly bytes: Uint8Array;
}

/** Where `readEntry`'s first read of an entry ends, and the longest stream it accepts. */
function firstRead(pack: ViewPack, offset: number, header: EntryHeader): [number, number] {
  const bodyStart = offset + header.length;
  const bound = Math.min(entriesEnd(pack), bodyStart + maxCompressedBytes(header.size));
  const guess =
    header.size <= FIRST_READ_LARGE ? header.size + (header.size >> 6) + 64 : FIRST_READ_LARGE;
  return [Math.min(bound, bodyStart + guess), bound];
}

/**
 * The header of the entry at `offset`, for reading the entry later with
 * `readEntry`. When the bytes read for the header already cover the entry's
 * first read and that is at most `keepBytes`, a copy of them is kept, so the
 * later read does not ask the source again; otherwise only the header bytes
 * are kept. The copy never pins the source's (possibly larger) buffer.
 */
export async function readEntryHead(
  source: PackBytesSource,
  pack: ViewPack,
  offset: number,
  maxObjectBytes: number,
  keepBytes: number,
): Promise<EntryHead> {
  const { header, bytes } = await readEntryHeader(source, pack, offset, maxObjectBytes);
  const want = firstRead(pack, offset, header)[0] - offset;
  const keep = want <= keepBytes && bytes.length >= want ? want : header.length;
  return { header, bytes: copyBytes(bytes, 0, keep) };
}

/**
 * Reads and inflates the entry at `offset`, starting from `head` when the
 * header was read already. The first read covers what the entry most likely
 * needs (its size plus zlib's overhead for incompressible data, up to
 * 1 MiB); a stream that goes on is read again with twice the span, up to
 * the longest stream accepted for its size. Throws PackError.
 */
export async function readEntry(
  source: PackBytesSource,
  zlib: Zlib,
  pack: ViewPack,
  offset: number,
  maxObjectBytes: number,
  head?: EntryHead,
): Promise<RawEntry> {
  const end = entriesEnd(pack);
  let { header, bytes } = head ?? (await readEntryHeader(source, pack, offset, maxObjectBytes));
  const [firstEnd, bound] = firstRead(pack, offset, header);
  let want = firstEnd;
  for (;;) {
    if (offset + bytes.length < want) {
      bytes = (await source(pack, offset, want)).subarray(0, end - offset);
    }
    const available = Math.min(offset + bytes.length, bound);
    try {
      const body = bytes.subarray(header.length, available - offset);
      return { header, data: inflateEntry(zlib, body, header.size, offset).data };
    } catch (error) {
      if (!(error instanceof NeedMoreInput)) throw error;
      if (available >= bound) {
        throw bound === end
          ? new PackError("truncated", "entry runs into the trailer", offset)
          : new PackError(
              "compressed-too-large",
              "zlib stream longer than its size allows",
              offset,
            );
      }
      want = Math.min(bound, offset + 2 * (available - offset));
    }
  }
}
