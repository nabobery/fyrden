declare const packIdBrand: unique symbol;

/**
 * A pack's id: a ULID allocated before the upload starts, because the
 * pack's trailer hash is known only after its last byte. Ids are validated
 * before they are used in storage keys.
 */
export type PackId = string & { readonly [packIdBrand]: true };

const PACK_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isPackId(text: string): text is PackId {
  return PACK_ID.test(text);
}

export function asPackId(text: string): PackId {
  if (!isPackId(text)) throw new RangeError("not a pack id");
  return text;
}

export interface PackInfo {
  readonly packId: PackId;
  readonly bytes: number;
}

/** Writes one immutable pack. The pack is not live until `RefStore.commit` adds it. */
export interface PackWriter {
  readonly packId: PackId;
  /** Appends bytes. Do not change `chunk` until the promise settles. */
  write(chunk: Uint8Array): Promise<void>;
  /** Completes the upload. The pack can then be read and committed. */
  finish(): Promise<PackInfo>;
  /** Discards the upload. The pack can never be read or committed. */
  abort(): Promise<void>;
}

/**
 * Immutable pack bytes. Which packs a repository can read (the registry) is
 * changed only through `RefStore.commit`, so `listPacks` and the refs always
 * agree.
 */
export interface PackStore {
  /** The repository's live packs. */
  listPacks(): Promise<readonly PackInfo[]>;
  beginPack(): PackWriter;
  /**
   * Reads `length` bytes at `offset` from a finished pack, live or not (a
   * push indexes its pack before committing it). Throws RangeError for a
   * range outside the pack, and an Error for a pack that does not exist.
   */
  openRange(packId: PackId, offset: number, length: number): Promise<Uint8Array>;
}
