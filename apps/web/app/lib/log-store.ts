export type IncomingRow =
  | { readonly i: number; readonly t: number | null; readonly c: string }
  | {
      readonly i: number;
      readonly t: number | null;
      readonly c: string;
      readonly o: number;
      readonly end: boolean;
    }
  | { readonly i: number; readonly omitted: string; readonly bytes: number };

export type StoredRow =
  | { readonly kind: "whole"; readonly t: number | null; readonly c: string; readonly cut: boolean }
  | {
      readonly kind: "prefix";
      readonly t: number | null;
      readonly c: string;
      readonly cut: boolean;
      /** The source offset the row's next piece starts at; past `c` once the row is cut. */
      readonly next: number;
    }
  | { readonly kind: "suffix"; readonly t: number | null; readonly c: string; readonly o: number }
  | { readonly kind: "omitted"; readonly bytes: number };

export type LogState = "none" | "streaming" | "complete" | "incomplete";

/** A row is drawn up to this many UTF-16 units; the raw view has the rest. Proposed. */
export const DISPLAY_CUT_UNITS = 10_000;
const BLOCK = 1_024;
const FOLLOWED_ROWS = 1_024;

export type RowRange = readonly [first: number, last: number];

const unitsOf = (row: StoredRow | undefined) => (row && "c" in row ? row.c.length : 0);

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** A flat copy, so a cut row does not keep the whole row's text alive through a sliced string (unverified). */
const detached = (text: string): string => text.split("").join("");

/**
 * A job's log rows as one viewer holds them: from pages and the live socket,
 * pieces of a row joined in order, each drawn up to `DISPLAY_CUT_UNITS`,
 * within a hard bound of text and rows: rows farthest from the focused ranges
 * go first, the focused rows and a followed log's last rows last. Its extents
 * only grow, except past a row discarded unfinished, and once the log is
 * closed no later answer changes its state.
 */
export class LogStore {
  readonly #blocks = new Map<number, (StoredRow | undefined)[]>();
  readonly #maxUnits: number;
  readonly #maxRows: number;
  #units = 0;
  #rows = 0;
  #received = 0;
  #unfinishedTop = 0;
  #durable = 0;
  #state: LogState = "none";
  #closed = false;
  #terminal = false;
  #focus: readonly RowRange[] = [];
  #following = false;

  constructor({ maxUnits = 64 * 1024 * 1024, maxRows = 300_000 } = {}) {
    this.#maxUnits = maxUnits;
    this.#maxRows = maxRows;
  }

  get length(): number {
    return Math.max(this.#received, this.#unfinishedTop, this.#durable);
  }
  get durable(): number {
    return this.#durable;
  }
  get state(): LogState {
    return this.#state;
  }
  /** No more rows can come: a page said so (no cursor), or the socket's terminal end. */
  get closed(): boolean {
    return this.#closed;
  }
  get units(): number {
    return this.#units;
  }

  row(i: number): StoredRow | undefined {
    return this.#blocks.get(Math.floor(i / BLOCK))?.[i % BLOCK];
  }

  /** Whether a row past the terminal `durable` was shown live but never stored. */
  notStored(i: number): boolean {
    return this.#terminal && i >= this.#durable;
  }

  /** Whether reading on from row `i` would add to what is drawn. */
  wantsMoreOf(i: number): boolean {
    const row = this.row(i);
    return row === undefined || (row.kind === "prefix" && !row.cut);
  }

  missing(first: number, last: number): number | null {
    for (let i = first; i < last; i++) if (this.row(i) === undefined) return i;
    return null;
  }

  focused(): readonly RowRange[] {
    return this.#focus;
  }

  focus(ranges: readonly RowRange[]): void {
    this.#focus = ranges;
  }

  follow(following: boolean): void {
    this.#following = following;
  }

  applyPage(page: {
    readonly rows: readonly IncomingRow[];
    readonly state: LogState;
    readonly end: number;
    readonly next: string | null;
  }): void {
    this.#put(page.rows);
    this.#durable = Math.max(this.#durable, page.end);
    if (this.#closed) return;
    this.#state = page.state;
    if (page.next === null) this.#closed = true;
  }

  applyLive(rows: readonly IncomingRow[]): void {
    this.#put(rows);
  }

  applyTerminal(durable: number, state: "complete" | "incomplete"): void {
    this.#durable = Math.max(this.#durable, durable);
    this.#state = state;
    this.#closed = true;
    this.#terminal = true;
  }

  forget(i: number): void {
    this.#set(i, undefined);
  }

  dropUnfinishedFrom(from: number): void {
    for (const [block, rows] of this.#blocks)
      rows.forEach((row, k) => {
        const i = block * BLOCK + k;
        if (i >= from && row?.kind === "prefix") this.#set(i, undefined);
      });
    this.#unfinishedTop = Math.min(this.#unfinishedTop, from);
  }

  #put(rows: readonly IncomingRow[]): void {
    for (const row of rows) {
      if ("omitted" in row) this.#set(row.i, { kind: "omitted", bytes: row.bytes });
      else if (!("o" in row)) this.#set(row.i, this.#assembled(row.t, row.c, true));
      else this.#piece(row);
    }
    this.#evict();
  }

  #piece(row: { i: number; t: number | null; c: string; o: number; end: boolean }): void {
    const held = this.row(row.i);
    const reach = row.o + row.c.length;
    if (row.o === 0) {
      if (held?.kind === "whole") return;
      if (!row.end && held?.kind === "prefix" && held.next >= reach) return;
      this.#set(row.i, this.#assembled(row.t, row.c, row.end));
      return;
    }
    if (held?.kind === "prefix" && row.o <= held.next && (reach > held.next || row.end)) {
      if (!held.cut)
        this.#set(row.i, this.#assembled(held.t, held.c.slice(0, row.o) + row.c, row.end));
      else if (row.end) this.#set(row.i, { kind: "whole", t: held.t, c: held.c, cut: true });
      else this.#set(row.i, { ...held, next: reach });
      return;
    }
    if (held === undefined && row.end) {
      let dropped = Math.max(0, row.c.length - DISPLAY_CUT_UNITS);
      if (dropped > 0 && isLow(row.c.charCodeAt(dropped)) && isHigh(row.c.charCodeAt(dropped - 1)))
        dropped += 1;
      const c = dropped > 0 ? detached(row.c.slice(dropped)) : row.c;
      this.#set(row.i, { kind: "suffix", t: row.t, c, o: row.o + dropped });
    }
  }

  #assembled(t: number | null, c: string, end: boolean): StoredRow {
    const cut = c.length > DISPLAY_CUT_UNITS;
    const at = isHigh(c.charCodeAt(DISPLAY_CUT_UNITS - 1))
      ? DISPLAY_CUT_UNITS - 1
      : DISPLAY_CUT_UNITS;
    const shown = cut ? detached(c.slice(0, at)) : c;
    if (end) return { kind: "whole", t, c: shown, cut };
    return {
      kind: "prefix",
      t,
      c: shown,
      cut: cut || c.length === DISPLAY_CUT_UNITS,
      next: c.length,
    };
  }

  #set(i: number, row: StoredRow | undefined): void {
    const key = Math.floor(i / BLOCK);
    let block = this.#blocks.get(key);
    if (!block) {
      if (row === undefined) return;
      block = [];
      this.#blocks.set(key, block);
    }
    const before = block[i % BLOCK];
    this.#units += unitsOf(row) - unitsOf(before);
    this.#rows += (row ? 1 : 0) - (before ? 1 : 0);
    block[i % BLOCK] = row;
    if (row?.kind === "prefix") this.#unfinishedTop = Math.max(this.#unfinishedTop, i + 1);
    else if (row) this.#received = Math.max(this.#received, i + 1);
  }

  #over(): boolean {
    return this.#units > this.#maxUnits || this.#rows > this.#maxRows;
  }

  #distance(first: number, last: number): number {
    const ranges: RowRange[] = this.#focus.length > 0 ? [...this.#focus] : [[0, 1]];
    if (this.#following) ranges.push([this.length - 1, this.length]);
    let best = Number.POSITIVE_INFINITY;
    for (const [a, b] of ranges)
      best = Math.min(best, last <= a ? a - last + 1 : first >= b ? first - b + 1 : 0);
    return best;
  }

  #protected(first: number, last: number): boolean {
    const tail = this.length - FOLLOWED_ROWS;
    if (this.#following && last > tail) return true;
    return this.#focus.some(([a, b]) => first < b && last > a);
  }

  #evict(): void {
    if (!this.#over()) return;
    const span = (b: number) => [b * BLOCK, (b + 1) * BLOCK] as const;
    const blocks = [...this.#blocks.keys()]
      .filter((b) => !this.#protected(...span(b)))
      .sort((x, y) => this.#distance(...span(y)) - this.#distance(...span(x)));
    for (const b of blocks) {
      if (!this.#over()) return;
      for (const row of this.#blocks.get(b) ?? []) {
        this.#units -= unitsOf(row);
        if (row) this.#rows -= 1;
      }
      this.#blocks.delete(b);
    }
    const left: number[] = [];
    for (const [b, block] of this.#blocks)
      block.forEach((row, k) => {
        if (row) left.push(b * BLOCK + k);
      });
    const rank = (i: number) => (this.#protected(i, i + 1) ? 1 : 0);
    left.sort((x, y) => rank(x) - rank(y) || this.#distance(y, y + 1) - this.#distance(x, x + 1));
    for (const i of left) {
      if (!this.#over()) return;
      this.#set(i, undefined);
    }
  }
}
