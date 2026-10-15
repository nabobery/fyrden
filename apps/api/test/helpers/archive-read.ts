// Reads back tar.gz and zip archives in the tests, with node:zlib (a
// .tar.gz may be several gzip members; gunzip reads them as one stream).
import { gunzipSync, inflateRawSync } from "node:zlib";

export interface ArchivedEntry {
  readonly path: string;
  readonly type: "file" | "dir" | "symlink";
  readonly executable: boolean;
  readonly data: Uint8Array;
  readonly link?: string;
}

const decoder = new TextDecoder();

const field = (block: Uint8Array, at: number, length: number) => {
  const bytes = block.subarray(at, at + length);
  const nul = bytes.indexOf(0);
  return decoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
};

function paxRecords(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const length = Number(decoder.decode(data.subarray(at, space)));
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const eq = record.indexOf("=");
    records[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return records;
}

/** A .tar.gz's entries, and the commit id its pax global header carries. */
export function untarGz(bytes: Uint8Array): { entries: ArchivedEntry[]; commit?: string } {
  const tar = new Uint8Array(gunzipSync(bytes));
  const entries: ArchivedEntry[] = [];
  let commit: string | undefined;
  let pax: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length; ) {
    const block = tar.subarray(at, at + 512);
    if (block.every((b) => b === 0)) break;
    const size = Number.parseInt(field(block, 124, 12), 8);
    const type = String.fromCharCode(block[156] as number);
    const data = tar.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") {
      commit = paxRecords(data).comment;
      continue;
    }
    if (type === "x") {
      pax = paxRecords(data);
      continue;
    }
    const prefix = field(block, 345, 155);
    const name = pax.path ?? (prefix ? `${prefix}/${field(block, 0, 100)}` : field(block, 0, 100));
    const mode = Number.parseInt(field(block, 100, 8), 8);
    entries.push({
      path: name.replace(/\/$/, ""),
      type: type === "5" ? "dir" : type === "2" ? "symlink" : "file",
      executable: type === "0" && (mode & 0o100) !== 0,
      data: new Uint8Array(data),
      ...(type === "2" && { link: pax.linkpath ?? field(block, 157, 100) }),
    });
    pax = {};
  }
  return { entries, ...(commit && { commit }) };
}

/** A zip's entries, read through its central directory. */
export function unzip(bytes: Uint8Array): ArchivedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("no end of central directory");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ArchivedEntry[] = [];
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const mode = view.getUint32(at + 38, true) >>> 16;
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extra + comment;
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    const start = local + 30 + localName + localExtra;
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : new Uint8Array(raw);
    const kind = mode & 0o170000;
    const type = kind === 0o40000 ? "dir" : kind === 0o120000 ? "symlink" : "file";
    entries.push({
      path: name.replace(/\/$/, ""),
      type,
      executable: type === "file" && (mode & 0o100) !== 0,
      data,
      ...(type === "symlink" && { link: decoder.decode(data) }),
    });
  }
  return entries;
}
