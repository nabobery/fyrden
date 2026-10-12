import { OID_BYTES } from "../object/oid.js";
import { compareAt } from "../pack/idx-format.js";

/** An oid in one of several tables: table index and byte offset of the oid. */
export interface OidCursor {
  readonly table: number;
  readonly at: number;
}

/** A min-heap of the next oid of each table, for a k-way merge. */
export class OidHeap {
  readonly #tables: readonly Uint8Array[];
  readonly #heads: OidCursor[] = [];

  constructor(tables: readonly Uint8Array[]) {
    this.#tables = tables;
    tables.forEach((t, table) => {
      if (t.length % OID_BYTES !== 0) throw new RangeError(`table ${table} is not whole oids`);
      if (t.length > 0) this.#insert({ table, at: 0 });
    });
  }

  pop(): OidCursor | undefined {
    const heads = this.#heads;
    const top = heads[0];
    if (top === undefined) return undefined;
    const last = heads.pop() as OidCursor;
    if (heads.length > 0) {
      heads[0] = last;
      this.#down(0);
    }
    const next = top.at + OID_BYTES;
    if (next < (this.#tables[top.table] as Uint8Array).length) {
      this.#insert({ table: top.table, at: next });
    }
    return top;
  }

  #less(a: OidCursor, b: OidCursor): boolean {
    const d = compareAt(
      this.#tables[a.table] as Uint8Array,
      a.at,
      this.#tables[b.table] as Uint8Array,
      b.at,
    );
    return d < 0 || (d === 0 && a.table < b.table);
  }

  #insert(item: OidCursor): void {
    const heads = this.#heads;
    heads.push(item);
    let i = heads.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.#less(heads[i] as never, heads[parent] as never)) break;
      [heads[i], heads[parent]] = [heads[parent] as never, heads[i] as never];
      i = parent;
    }
  }

  #down(i: number): void {
    const heads = this.#heads;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heads.length && this.#less(heads[l] as never, heads[m] as never)) m = l;
      if (r < heads.length && this.#less(heads[r] as never, heads[m] as never)) m = r;
      if (m === i) return;
      [heads[i], heads[m]] = [heads[m] as never, heads[i] as never];
      i = m;
    }
  }
}

/**
 * Calls `onGroup` once per distinct oid across sorted oid tables (20 bytes
 * per oid), in oid order, with every copy of it: ordered by table, then by
 * position in the table.
 */
export function forEachOidGroup(
  tables: readonly Uint8Array[],
  onGroup: (copies: readonly OidCursor[]) => void,
): void {
  const heap = new OidHeap(tables);
  let group: OidCursor[] = [];
  for (let head = heap.pop(); head !== undefined; head = heap.pop()) {
    const first = group[0];
    if (
      first !== undefined &&
      compareAt(
        tables[first.table] as Uint8Array,
        first.at,
        tables[head.table] as Uint8Array,
        head.at,
      ) !== 0
    ) {
      onGroup(group);
      group = [];
    }
    group.push(head);
  }
  if (group.length > 0) onGroup(group);
}
