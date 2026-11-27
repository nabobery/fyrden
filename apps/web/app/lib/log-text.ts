/**
 * Log text as a page shows it: colour (SGR) drawn or dropped, and every other
 * escape sequence or control character drawn as a visible mark. Rows are
 * shown as stored, masked where the API's masker matched; a mark keeps apart
 * what the stored text keeps apart, so text the masker treated as separate is
 * never joined on the page or in copied text.
 */
export const ESCAPE_MARK = "␛";

const ESC = 0x1b;

export type LogToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "sgr"; readonly params: string }
  | { readonly kind: "mark"; readonly text: string };

function controlMark(code: number): string {
  if (code === 0x7f) return "␡";
  if (code < 0x20) return String.fromCharCode(0x2400 + code);
  return ESCAPE_MARK;
}

const isControl = (code: number) =>
  (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f);

class Terminators {
  #st = { from: -1, at: -1 };
  #bel = { from: -1, at: -1 };
  constructor(
    readonly text: string,
    readonly work: { steps: number },
  ) {}
  #next(memo: { from: number; at: number }, needle: string, from: number): number {
    if (memo.from >= 0 && from >= memo.from && (memo.at === -1 || memo.at >= from)) return memo.at;
    const at = this.text.indexOf(needle, from);
    this.work.steps += (at === -1 ? this.text.length : at) - from + 1;
    memo.from = from;
    memo.at = at;
    return at;
  }
  st(from: number): number {
    return this.#next(this.#st, "\u001b\\", from);
  }
  bel(from: number): number {
    return this.#next(this.#bel, "\u0007", from);
  }
}

function sequenceEnd(
  text: string,
  at: number,
  ends: Terminators,
): { end: number; sgr: string | null } | null {
  const kind = text.charCodeAt(at + 1);
  if (Number.isNaN(kind)) return null;
  if (kind === 0x5b) {
    let i = at + 2;
    while (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x3f) i++;
    const params = text.slice(at + 2, i);
    while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
    ends.work.steps += i - at;
    const final = text.charCodeAt(i);
    if (Number.isNaN(final) || final < 0x40 || final > 0x7e) return null;
    const sgr = final === 0x6d && i === at + 2 + params.length && /^[0-9;]*$/.test(params);
    return { end: i + 1, sgr: sgr ? params : null };
  }
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    const st = ends.st(at + 2);
    const bel = kind === 0x5d ? ends.bel(at + 2) : -1;
    if (bel !== -1 && (st === -1 || bel < st)) return { end: bel + 1, sgr: null };
    if (st !== -1) return { end: st + 2, sgr: null };
    return null;
  }
  if (kind >= 0x20 && kind <= 0x7e) return { end: at + 2, sgr: null };
  return null;
}

/** The tokens of `text` from `start`, and where each ends; `work` counts characters scanned. */
export function* logTokens(
  text: string,
  start = 0,
  work = { steps: 0 },
): Generator<[LogToken, number]> {
  const ends = new Terminators(text, work);
  let from = start;
  let i = start;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (!isControl(code)) {
      i++;
      continue;
    }
    if (i > from) yield [{ kind: "text", text: text.slice(from, i) }, i];
    if (code === ESC) {
      const sequence = sequenceEnd(text, i, ends);
      if (sequence) {
        i = sequence.end;
        yield [
          sequence.sgr !== null
            ? { kind: "sgr", params: sequence.sgr }
            : { kind: "mark", text: ESCAPE_MARK },
          i,
        ];
      } else {
        i++;
        yield [{ kind: "mark", text: ESCAPE_MARK }, i];
      }
    } else {
      i++;
      yield [{ kind: "mark", text: controlMark(code) }, i];
    }
    from = i;
  }
  if (i > from) yield [{ kind: "text", text: text.slice(from, i) }, i];
}

export function plainLogText(text: string): string {
  let out = "";
  for (const [token] of logTokens(text)) if (token.kind !== "sgr") out += token.text;
  return out;
}
