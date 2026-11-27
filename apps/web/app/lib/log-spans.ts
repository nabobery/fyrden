import { logTokens, plainLogText } from "./log-text.js";

/**
 * xterm's default 16 colours, the palette other colours are mapped onto
 * (verified: the names in https://github.com/ThomasDickey/xterm-snapshots/blob/master/XTerm-col.ad,
 * their RGB values in the xterm column of
 * https://en.wikipedia.org/wiki/ANSI_escape_code#3-bit_and_4-bit).
 */
const PALETTE: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

export function nearest16(r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  PALETTE.forEach(([pr, pg, pb], k) => {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  });
  return best;
}

function color256(n: number): number | null {
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + 10 * (n - 232);
    return nearest16(v, v, v);
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + 40 * x);
  return nearest16(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
}

interface Style {
  fg: number | null;
  bg: number | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

const plain = (): Style => ({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
});

function extended(codes: readonly number[], k: number): { color: number | null; used: number } {
  if (codes[k + 1] === 5) return { color: color256(codes[k + 2] ?? -1), used: 2 };
  if (codes[k + 1] === 2) {
    const [r, g, b] = [codes[k + 2], codes[k + 3], codes[k + 4]];
    const ok = [r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255);
    return { color: ok ? nearest16(r as number, g as number, b as number) : null, used: 4 };
  }
  return { color: null, used: 0 };
}

function apply(style: Style, params: string): Style {
  const next = { ...style };
  const codes = params === "" ? [0] : params.split(";").map((p) => (p === "" ? 0 : Number(p)));
  for (let k = 0; k < codes.length; k++) {
    const c = codes[k] as number;
    if (c === 0) Object.assign(next, plain());
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 3) next.italic = true;
    else if (c === 4) next.underline = true;
    else if (c === 7) next.inverse = true;
    else if (c === 22) next.bold = next.dim = false;
    else if (c === 23) next.italic = false;
    else if (c === 24) next.underline = false;
    else if (c === 27) next.inverse = false;
    else if (c >= 30 && c <= 37) next.fg = c - 30;
    else if (c >= 90 && c <= 97) next.fg = c - 90 + 8;
    else if (c === 39) next.fg = null;
    else if (c >= 40 && c <= 47) next.bg = c - 40;
    else if (c >= 100 && c <= 107) next.bg = c - 100 + 8;
    else if (c === 49) next.bg = null;
    else if (c === 38 || c === 48) {
      const { color, used } = extended(codes, k);
      if (color !== null) {
        if (c === 38) next.fg = color;
        else next.bg = color;
      }
      k += used;
    }
  }
  return next;
}

function classOf(style: Style): string {
  const swapped = style.inverse && (style.fg !== null || style.bg !== null);
  const fg = swapped ? style.bg : style.fg;
  const bg = swapped ? style.fg : style.bg;
  const names: string[] = [];
  if (fg !== null) names.push(`a-f${fg}`);
  if (bg !== null) names.push(`a-k${bg}`);
  if (style.bold) names.push("a-b");
  if (style.dim) names.push("a-d");
  if (style.italic) names.push("a-i");
  if (style.underline) names.push("a-u");
  if (style.inverse && !swapped) names.push("a-inv");
  return names.join(" ");
}

export interface LogSpan {
  readonly text: string;
  readonly className: string;
}

/** Spans drawn for one row at most; the rest of a row is drawn plain. Proposed. */
export const MAX_ROW_SPANS = 200;

/** A row as coloured spans (classes only, never markup), with `plainLogText`'s characters. */
export function logSpans(text: string): LogSpan[] {
  const spans: LogSpan[] = [];
  let style = plain();
  let current = "";
  let open = "";
  for (const [token, end] of logTokens(text)) {
    if (token.kind === "sgr") {
      const next = classOf(apply(style, token.params));
      style = apply(style, token.params);
      if (next !== open && current !== "") {
        spans.push({ text: current, className: open });
        current = "";
        if (spans.length === MAX_ROW_SPANS) {
          const rest = plainLogText(text.slice(end));
          if (rest !== "") spans.push({ text: rest, className: "" });
          return spans;
        }
      }
      open = next;
      continue;
    }
    current += token.text;
  }
  if (current !== "") spans.push({ text: current, className: open });
  return spans;
}

/** Spans kept parsed across the rows drawn most recently, at most. Proposed. */
export const MAX_CACHED_SPANS = 20_000;
/** Characters of row text the span cache holds at most. Proposed. */
export const MAX_CACHED_UNITS = 2 * 1024 * 1024;

const weight = (spans: readonly LogSpan[]) => Math.max(1, spans.length);

export class SpanCache {
  readonly #rows = new Map<number, { readonly c: string; readonly spans: LogSpan[] }>();
  #spans = 0;
  parsed = 0;

  #units = 0;

  constructor(
    readonly maxSpans = MAX_CACHED_SPANS,
    readonly maxUnits = MAX_CACHED_UNITS,
  ) {}

  get units(): number {
    return this.#units;
  }

  get spans(): number {
    return this.#spans;
  }

  get(i: number, c: string): LogSpan[] {
    const hit = this.#rows.get(i);
    if (hit) {
      this.#rows.delete(i);
      if (hit.c === c) {
        this.#rows.set(i, hit);
        return hit.spans;
      }
      this.#spans -= weight(hit.spans);
      this.#units -= hit.c.length;
    }
    const spans = logSpans(c);
    this.parsed += 1;
    this.#rows.set(i, { c, spans });
    this.#spans += weight(spans);
    this.#units += c.length;
    for (const [k, old] of this.#rows) {
      if ((this.#spans <= this.maxSpans && this.#units <= this.maxUnits) || k === i) break;
      this.#rows.delete(k);
      this.#spans -= weight(old.spans);
      this.#units -= old.c.length;
    }
    return spans;
  }
}
