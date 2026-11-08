/*
 * The inputs of the alignment vectors, by experiment. Each input is one
 * character per byte. What's expected of each comes from the oracle, written
 * once to `vectors/` by `align-vectors.generate.test.ts`, and committed: the
 * fast tests don't run git.
 */

export interface AlignCase {
  readonly id: string;
  readonly old: string;
  readonly new: string;
  /** New lines the experiment records as the child's, from 1; rechecked against the oracle when generating. */
  readonly recorded?: readonly number[];
}

/** Each word is one line ending in a line feed. `8x` is `x` indented 8; `""` is an empty line. */
export function lines(...words: readonly string[]): string {
  return words.map((word) => `${indented(word)}\n`).join("");
}

function indented(word: string): string {
  const match = /^(\d+)([a-z]\w*)$/.exec(word);
  return match ? " ".repeat(Number(match[1])) + match[2] : word;
}

function times<T>(n: number, make: (k: number) => T): T[] {
  return Array.from({ length: n }, (_, k) => make(k));
}

const words = (text: string) => text.split(" ").map((w) => (w === '""' ? "" : w));
const pair = (id: string, old: string, new_: string, recorded?: readonly number[]): AlignCase => ({
  id,
  old: lines(...words(old)),
  new: lines(...words(new_)),
  ...(recorded ? { recorded } : {}),
});
const raw = (id: string, old: string, new_: string, recorded?: readonly number[]): AlignCase => ({
  id,
  old,
  new: new_,
  ...(recorded ? { recorded } : {}),
});

/** Lines of six bytes that don't repeat, to make a tail. */
const tailOf = (n: number) => times(n, (k) => `t${String(k).padStart(4, "0")}`);
/** Doubles the middle of `top ... bot`: the inserted group can sit in several places. */
const doubled = (id: string, before: string[], middle: string[], after: string[]): AlignCase => ({
  id,
  old: lines(...before, ...middle, ...after),
  new: lines(...before, ...middle, ...middle, ...after),
});

const lineRules: AlignCase[] = [
  raw("C-FINAL-1", "a\nb", "a\nb\nc\n", [2, 3]),
  raw("C-FINAL-2", "a\nb\n", "a\nb", [2]),
  raw("C-CRLF", "a\r\nb\r\n", "a\nb\r\n", [1]),
  raw("C-CR", "a\rb\nc\n", "a\rb\nc\nd\n", [3]),
  raw("C-EMPTY-1", "", "", []),
  raw("C-EMPTY-2", "", "\n", [1]),
  raw("C-EMPTY-3", "x\n", "", []),
  raw("C-NUL", "a\0b\nc\n", "a\0b\nd\n", [2]),
  raw("C-BYTES", "\xff\xfe\nc\n", "\xff\xfe\nd\n", [2]),
  raw("C-SPACE", "a \n", "a\n", [1]),
];

const search: AlignCase[] = [
  pair("REP-1", "a b", "a b a b", [3, 4]),
  pair("REP-2", "a b a", "a b a b a", [4, 5]),
  pair("REP-3", "c b a c", "a c c b c b", [1, 2, 6]),
  pair("REP-4", "b a a c a", "c b a", [2]),
  pair("SEARCH-1", "a b", "b a"),
  pair("SEARCH-2", "a a b", "b a"),
  pair("SEARCH-4", "a b c", "c a c b"),
  pair("SEARCH-5", "c b a c", "a c c b c b"),
  pair("SEARCH-6", "a", "b a a b"),
  pair("SLIDE-ORDER", "a a b", "b a b b"),
  pair("SLIDE-OTHER", "a a", "b a"),
  pair("SLIDE-TIE", "a", "a a"),
];

/** A real file, and a new version that keeps little but its blank lines and braces. */
export const CROWD_FILE = [
  'import { type Oid, oidToHex } from "../object/oid.js";',
  "",
  "/** Objects a walk was asked for that no pack in the reader's view holds. */",
  "export class MissingObjectError extends Error {",
  '  override readonly name = "MissingObjectError";',
  "  readonly oids: readonly Oid[];",
  "",
  "  constructor(oids: readonly Oid[]) {",
  '    const shown = oids.slice(0, 3).map(oidToHex).join(", ");',
  "    super(",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a line of the file, as text
  '      `missing object${oids.length === 1 ? "" : "s"} ${shown}${oids.length > 3 ? ", ..." : ""}`,',
  "    );",
  "    this.oids = oids;",
  "  }",
  "}",
];
export const CROWD_FILE_NEXT = [
  CROWD_FILE[0] as string,
  "  }",
  "",
  "  }",
  "",
  "",
  "  }",
  "  }",
  "",
];

const crowded: AlignCase[] = [
  pair("CROWD-1", "a b c d e f g h", "b b b b"),
  pair("CROWD-2", "a b c d e f h", "b b b b"),
  ...[7, 8, 31, 32, 127, 128].flatMap((m) =>
    [3, 4, 5, 7, 8, 9, 15, 16, 17, 31, 32, 33].map((c) => ({
      id: `CROWD-LIMIT-${m}-${c}`,
      old: lines(...times(m, (k) => `u${k}`), "s", ...times(m, (k) => `v${k}`)),
      new: lines(...times(c, () => "s")),
    })),
  ),
  ...times(13, (l) =>
    times(13, (r) => ({
      id: `CROWD-FLANK-${l}-${r}`,
      old: lines(...times(l, (k) => `u${k}`), "s", ...times(r, (k) => `v${k}`)),
      new: lines(...times(8, () => "s")),
    })),
  ).flat(),
  ...[1, 2, 5, 10, 20, 31, 32, 40].flatMap((m) =>
    [3 * m + 5, 3 * m + 6, 3 * m + 7].map((r) => ({
      id: `CROWD-WALK-${m}-${r}`,
      old: lines("u0", "s", ...times(m, () => "s"), ...times(r, (k) => `v${k}`)),
      new: lines(...times(64, () => "s")),
    })),
  ),
  ...[30, 31, 60].flatMap((m) =>
    [26, 27, 28].map((r) => ({
      id: `CROWD-WALK-END-${m}-${r}`,
      old: lines(
        ...times(5, (k) => `w${k}`),
        ...times(m, () => "s"),
        ...times(70, (k) => `u${k}`),
        "s",
        ...times(r, (k) => `v${k}`),
      ),
      new: lines(...times(64, () => "s")),
    })),
  ),
  ...[23, 24, 25].map((r) => ({
    id: `CROWD-WALK-END-PREFIX-${r}`,
    old: lines(
      "p",
      ...times(30, () => "s"),
      ...times(70, (k) => `u${k}`),
      "s",
      ...times(r, (k) => `v${k}`),
    ),
    new: lines("p", ...times(64, () => "s")),
  })),
  pair("FILTER-EDGE", "a a b a a", "b a c d e a f g h i"),
  // A crowded run ending at a common end counts in full, whatever its length.
  { id: "CROWD-AT-PREFIX-FILE", old: lines(...CROWD_FILE), new: lines(...CROWD_FILE_NEXT) },
  {
    id: "CROWD-AT-PREFIX-1",
    old: lines("p", "q", "", "    }", "a", "b", "c", "d", "", "e", "f", "g"),
    new: lines("p", "q", "}", "", "", "  }", "", "  }", "", "  }", "", ""),
  },
  ...[3, 4, 5].map((below) => ({
    id: `CROWD-AT-PREFIX-RUN-1-${below}`,
    old: lines("p", "s", ...times(6, (k) => `u${k}`), "s", ...times(below, (k) => `v${k}`), "z"),
    new: lines("p", "y", ...times(6, () => "s"), "z"),
  })),
  ...[6, 7, 8].map((below) => ({
    id: `CROWD-AT-SUFFIX-RUN-1-${below}`,
    old: lines("p", ...times(below, (k) => `v${k}`), "s", ...times(6, (k) => `u${k}`), "s", "z"),
    new: lines("p", ...times(6, () => "s"), "y", "z"),
  })),
];

const tail: AlignCase[] = [
  {
    id: "TAIL-1",
    old: lines("top", "x", "", ...tailOf(341)),
    new: lines("top", "x", "", "y", "", ...tailOf(341)),
    recorded: [3, 4],
  },
  {
    id: "TAIL-2",
    old: lines("top", "x", "", ...tailOf(342)),
    new: lines("top", "x", "", "y", "", ...tailOf(342)),
    recorded: [4, 5],
  },
  {
    id: "TAIL-3",
    old: lines("top", "", "a", ...tailOf(170)),
    new: lines("top", "", "a", "", "a", ...tailOf(170)),
    recorded: [2, 3],
  },
  {
    id: "TAIL-4",
    old: lines("top", "", "a", ...tailOf(171)),
    new: lines("top", "", "a", "", "a", ...tailOf(171)),
    recorded: [3, 4],
  },
];

const INDENTS = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24];
const indentation: AlignCase[] = [
  { ...doubled("IND-1", ["top"], ["8x", "3y"], ["bot", "bot"]), recorded: [3, 4] },
  { ...doubled("IND-2", ["top"], ["8x", "4y"], ["bot", "bot"]), recorded: [4, 5] },
  { ...doubled("IND-3", ["top"], ["2x", "4y"], ["bot", "bot"]), recorded: [4, 5] },
  { ...doubled("IND-4", ["top"], ["x", "4y"], ["bot", "bot"]), recorded: [2, 3] },
  { ...doubled("IND-5", ["top"], ["4x", "2y"], ["8z", "8z"]), recorded: [3, 4] },
  ...INDENTS.flatMap((x) =>
    INDENTS.map((y) => doubled(`IND-SUM-${x}-${y}`, ["top"], [`${x}x`, `${y}y`], ["bot", "bot"])),
  ),
  ...["\t", " \t", "  \t ", "\t\t"].flatMap((lead, kind) =>
    times(20, (n) => ({
      id: `IND-TAB-${kind}-${n}`,
      old: `top\n${lead}x\n${" ".repeat(n)}y\nbot\nbot\n`,
      new: `top\n${lead}x\n${" ".repeat(n)}y\n${lead}x\n${" ".repeat(n)}y\nbot\nbot\n`,
    })),
  ),
  ...["\r  ", " \r ", "\f    "].flatMap((lead, kind) =>
    times(4, (n) => ({
      id: `IND-CR-${kind}-${n}`,
      old: `top\n${lead}x\n${" ".repeat(n)}y\nbot\nbot\n`,
      new: `top\n${lead}x\n${" ".repeat(n)}y\n${lead}x\n${" ".repeat(n)}y\nbot\nbot\n`,
    })),
  ),
  ...[80, 90, 95, 98, 99, 100].map((y) =>
    doubled(`IND-CAP-${y}`, ["top"], [`${2 * y - 1}x`, `${y}y`], ["bot", "bot"]),
  ),
];

const blanks: AlignCase[] = [
  { ...doubled("BLK-1", ["top", ""], ["8x", "3y"], ["bot", "bot"]), recorded: [5, 6] },
  pair("BLK-3", 'a "" b c ""', 'a "" d c "" b c ""', [3, 4, 5]),
  {
    id: "BLK-2",
    old: lines("f()", "{", "4a", "}", "", "h()", "{", "4b", "}"),
    new: lines("f()", "{", "4a", "}", "", "g()", "{", "4c", "}", "", "h()", "{", "4b", "}"),
  },
  ...[" ", "\t", " \t ", "\r", "\f", "\v"].map((blank, kind) => ({
    id: `BLK-WS-${kind}`,
    old: `top\n${blank}\n        x\n   y\nbot\nbot\n`,
    new: `top\n${blank}\n        x\n   y\n        x\n   y\nbot\nbot\n`,
  })),
  ...times(40, (k) => ({
    id: `BLK-RUN-${k + 1}`,
    old: lines("top", ...times(k + 1, () => ""), "8x", "3y", "bot", "bot"),
    new: lines("top", ...times(k + 1, () => ""), "8x", "3y", "8x", "3y", "bot", "bot"),
  })),
  ...times(30, (k) => ({
    id: `BLK-RUN-BELOW-${k + 1}`,
    old: lines("top", "a", ...times(k + 1, () => ""), "b"),
    new: lines("top", "a", ...times(k + 1, () => ""), "a", ...times(k + 1, () => ""), "b"),
  })),
];

const fileEnds: AlignCase[] = [
  pair("EOF-1", 'top "" a', 'top "" a "" a', [4, 5]),
  pair("EOF-2", 'top "" a z', 'top "" a "" a z', [3, 4]),
  { ...doubled("EOF-3", ["top"], ["x", "4y"], []), recorded: [4, 5] },
  ...times(6, (k) => ({
    id: `SLIDE-WINDOW-EQUAL-${k + 1}`,
    old: lines("top", "", ...times(k + 1, () => "a")),
    new: lines("top", "", ...times(k + 2, () => "a")),
  })),
  ...times(4, (k) => ({
    id: `SLIDE-WINDOW-PERIOD-${k + 1}`,
    old: lines("top", "", ...times(k + 1, () => ["a", "b"]).flat(), "z"),
    new: lines("top", "", ...times(k + 2, () => ["a", "b"]).flat(), "z"),
  })),
  ...[2, 3, 50, 99, 100, 101, 102, 120].map((size) => {
    const group = times(size, (k) => `g${k}`);
    return {
      id: `SLIDE-WINDOW-SIZE-${size}`,
      old: lines("top", "", ...group, "z"),
      new: lines("top", "", ...group, ...group, "z"),
    };
  }),
];

/** Every named experiment that's about one parent and one child. */
export const NAMED_CASES: readonly AlignCase[] = [
  ...lineRules,
  ...search,
  ...crowded,
  ...tail,
  ...indentation,
  ...blanks,
  ...fileEnds,
];

/** Every file of up to `max` lines over `alphabet`, as line lists, shortest first. */
function* filesOver(alphabet: readonly string[], max: number): Generator<string> {
  for (let n = 0; n <= max; n++) {
    const count = alphabet.length ** n;
    for (let k = 0; k < count; k++) {
      let rest = k;
      let out = "";
      for (let at = 0; at < n; at++) {
        out = `${alphabet[rest % alphabet.length]}\n${out}`;
        rest = Math.floor(rest / alphabet.length);
      }
      yield out;
    }
  }
}

/** The exhaustive tables: two lines to 6, three lines to 4. */
export function* exhaustivePairs(): Generator<[string, string]> {
  for (const [alphabet, max] of [
    [["a", "b"], 6],
    [["a", "b", "c"], 4],
  ] as const) {
    const files = [...filesOver(alphabet, max)];
    for (const old of files) for (const new_ of files) yield [old, new_];
  }
}

function prng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/** Random edits of a random file: inserts, deletes and moves of whole blocks, some of them repeats. */
function edited(rand: () => number, file: string[], fresh: () => string): string[] {
  const out = [...file];
  const edits = 1 + Math.floor(rand() * 5);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (out.length + 1));
    const size = 1 + Math.floor(rand() * 6);
    const kind = rand();
    if (kind < 0.4) out.splice(at, 0, ...times(size, fresh));
    else if (kind < 0.7) out.splice(at, size);
    else if (out.length > 0) {
      const from = Math.floor(rand() * out.length);
      out.splice(at, 0, ...out.slice(from, from + size));
    }
  }
  return out;
}

/** Seeded pairs for regressions: repeats, indentation, blanks and long tails. */
export function seededPairs(
  seed: number,
  count: number,
): { id: string; old: string; new: string }[] {
  const rand = prng(seed);
  const indents = [0, 2, 4, 8];
  const pairs: { id: string; old: string; new: string }[] = [];
  for (let k = 0; k < count; k++) {
    const kind = k % 4;
    let fresh: () => string;
    let size: number;
    if (kind === 0) {
      const alphabet = 2 + Math.floor(rand() * 12);
      fresh = () => `w${Math.floor(rand() * alphabet)}`;
      size = 1 + Math.floor(rand() * 200);
    } else if (kind === 1) {
      // Code-shaped: indentation and blank lines, words from a small set.
      fresh = () =>
        rand() < 0.2
          ? ""
          : `${" ".repeat(indents[Math.floor(rand() * indents.length)] as number)}w${Math.floor(rand() * 8)}`;
      size = 1 + Math.floor(rand() * 120);
    } else if (kind === 2) {
      let unique = 0;
      fresh = () => `u${unique++}`;
      size = 1 + Math.floor(rand() * 300);
    } else {
      fresh = () => `w${Math.floor(rand() * 40)}`;
      size = 1 + Math.floor(rand() * 40);
    }
    const before = times(size, fresh);
    const after = edited(rand, before, fresh);
    // Every fourth pair ends in a long common tail, near a multiple of the cut.
    const tailBytes =
      kind === 3 ? 1024 * (1 + Math.floor(rand() * 3)) + Math.floor(rand() * 16) - 8 : 0;
    let tailText = "";
    while (tailText.length < tailBytes) tailText += `${fresh()}\n`;
    tailText = tailText.slice(0, tailBytes);
    const text = (file: string[]) => (file.length > 0 ? `${file.join("\n")}\n` : "") + tailText;
    pairs.push({ id: `SEEDED-${seed}-${k}`, old: text(before), new: text(after) });
  }
  return pairs;
}

/**
 * Generators for the search, each aimed at counted limits in align.ts:
 * gone, walks: crowded classes, CROWD_WALK, CROWD_NEEDED and CROWD_WEIGHT.
 * limits: the crowded limit's powers of two. small, both, code, stripped, blocks: repeated
 * lines in the search and its ties. slides, midblanks, blanks: scoring, CLOSE_CALL and
 * BLANK_RUN. wide: MAX_SCORED_INDENT and TAB, blank or not. window: MAX_SLIDE_WINDOW.
 * tails: TAIL_BLOCK. rounds: MAX_SEARCH_ROUNDS. bytes: line ends and odd bytes.
 * MAX_ALIGN_WORK isn't reached by any: it takes files near 100,000 lines, so fixed
 * cases cover it.
 */
export const CROWDED_FAMILIES: Readonly<
  Record<string, (rand: () => number, fresh: () => string) => [string, string]>
> = {
  gone(rand, fresh) {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const symbols = ["A", "B", "C"].slice(0, int(1, 3));
    const share = oneOf(rand, [0.1, 0.2, 0.3, 0.5]);
    const size = oneOf(rand, [int(3, 15), int(3, 15), int(16, 30), int(60, 70)]);
    const head = times(rand() < 0.5 ? int(1, 3) : 0, fresh);
    const tail = times(rand() < 0.5 ? int(1, 3) : 0, fresh);
    const old = times(size, () => (rand() < share ? oneOf(rand, symbols) : fresh()));
    const most = oneOf(rand, [4, 4, 5, 8, 16]);
    const next = symbols.flatMap((symbol) => times(int(1, most + 1), () => symbol));
    for (let k = next.length - 1; k > 0; k--) {
      const j = int(0, k);
      [next[k], next[j]] = [next[j] as string, next[k] as string];
    }
    return [lines(...head, ...old, ...tail), lines(...head, ...next, ...tail)];
  },
  small(rand) {
    const symbols = "abcd".slice(0, 2 + Math.floor(rand() * 3)).split("");
    const side = () => {
      const text = lines(...times(Math.floor(rand() * 41), () => oneOf(rand, symbols)));
      return rand() < 0.1 ? text.slice(0, -1) : text;
    };
    return [side(), side()];
  },
  code(rand, fresh) {
    const size = 5 + Math.floor(rand() * 76);
    const share = oneOf(rand, [0.2, 0.4, 0.7]);
    const kinds = CODE_LINES.slice(0, 2 + Math.floor(rand() * (CODE_LINES.length - 1)));
    const old = times(size, () => (rand() < share ? oneOf(rand, kinds) : fresh()));
    const next: string[] = [];
    for (const line of old) {
      const choice = rand();
      if (choice < 0.3) continue;
      if (choice < 0.5) next.push(oneOf(rand, CODE_LINES));
      if (choice < 0.6) {
        next.push(fresh());
        continue;
      }
      next.push(line);
    }
    return [lines(...old), lines(...next)];
  },
  stripped(rand, fresh) {
    const size = 8 + Math.floor(rand() * 33);
    const old = times(size, () => (rand() < 0.3 ? oneOf(rand, CODE_LINES.slice(0, 4)) : fresh()));
    const kept = old.slice(0, Math.floor(rand() * 3));
    const added = times(3 + Math.floor(rand() * 22), () => oneOf(rand, CODE_LINES.slice(0, 3)));
    return [lines(...old), lines(...kept, ...added)];
  },
  limits(rand, fresh) {
    const size = oneOf(rand, [15, 16, 17, 63, 64, 65, 255, 256, 257]);
    const limit = size < 16 ? 4 : size < 64 ? 8 : size < 256 ? 16 : 32;
    const old = times(size, () => (rand() < 0.15 ? "S" : fresh()));
    const next = times(oneOf(rand, [limit - 1, limit, limit + 1]), () => "S");
    return rand() < 0.5 ? [lines(...old), lines(...next)] : [lines(...next), lines(...old)];
  },
  walks(rand, fresh) {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const limit = oneOf(rand, [8, 16, 32]);
    const size = int(90, 700);
    const share = oneOf(rand, [0.01, 0.03, 0.08, 0.2, 0.5]);
    const head = times(oneOf(rand, [0, 0, 1, 3]), fresh);
    const tail = times(oneOf(rand, [0, 0, 1, 3]), fresh);
    const old = times(size, () => (rand() < share ? "S" : fresh()));
    const kept = times(oneOf(rand, [0, 0, 1, 2]), fresh);
    for (const line of kept) old[int(0, size - 1)] = line;
    const next = [...times(int(limit, limit * 3), () => "S"), ...kept];
    return [lines(...head, ...old, ...tail), lines(...head, ...next, ...tail)];
  },
  slides(rand, fresh) {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const kinds = times(int(2, 8), () => oneOf(rand, CODE_LINES));
    const old = times(int(3, 60), () => (rand() < 0.75 ? oneOf(rand, kinds) : fresh()));
    const share = oneOf(rand, [0.05, 0.15, 0.4]);
    const next = old.filter(() => rand() >= share);
    if (rand() < 0.5) {
      next.splice(int(0, next.length), 0, ...times(int(1, 6), () => oneOf(rand, kinds)));
    }
    return [lines(...old), lines(...next)];
  },
  blanks(rand, fresh) {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const old: string[] = [];
    for (let k = int(2, 8); k > 0; k--) {
      old.push(
        ...times(oneOf(rand, [0, 1, 2, 19, 20, 21, 25]), () => oneOf(rand, ["", "", " ", "\t"])),
      );
      old.push(oneOf(rand, [fresh(), "  x", "    y", "}"]));
    }
    const share = oneOf(rand, [0.03, 0.1, 0.3]);
    return [lines(...old), lines(...old.filter(() => rand() >= share))];
  },
  blocks(rand, fresh) {
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const block = times(int(3, 12), () => (rand() < 0.5 ? oneOf(rand, CODE_LINES) : fresh()));
    const old: string[] = [];
    for (let k = int(2, 12); k > 0; k--) old.push(...block, ...(rand() < 0.3 ? [fresh()] : []));
    const next: string[] = [];
    for (const line of old) {
      const choice = rand();
      if (choice < 0.05) continue;
      if (choice < 0.1) next.push(fresh());
      next.push(line);
    }
    return [lines(...old), lines(...next)];
  },
  midblanks(rand) {
    // Blank runs of every length, in several shapes, around indented lines.
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const kinds = ["", " ", "  ", "   ", "\t", " \t", "\r", " \r\t", "\t\r", "      "];
    const shapes = times(int(1, 6), () => oneOf(rand, kinds));
    const texts = ["  x", "  y", "x", "    z", "}", "\tw"];
    const old: string[] = [];
    for (let k = int(1, 6); k > 0; k--) {
      old.push(...times(int(0, 26), () => oneOf(rand, shapes)), oneOf(rand, texts));
    }
    if (rand() < 0.3) old.push(...times(int(0, 26), () => oneOf(rand, shapes)));
    const share = oneOf(rand, [0.03, 0.1, 0.3, 0.6]);
    return [lines(...old), lines(...old.filter(() => rand() >= share))];
  },
  bytes(rand) {
    // Mixed line endings and odd bytes: any small alphabet of these.
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const tokens = [
      "",
      " ",
      "\t",
      "\r",
      " \r\t",
      "\f",
      "\v",
      "  }",
      "\t }",
      " \t\tx",
      "\r  x",
      "\t\r y",
      "\x00",
      "\xff\xfe",
      "x\r",
      "    x",
      "x",
      "y",
      "\x85",
      "\xef\xbb\xbf",
    ];
    const alphabet = times(int(2, 8), () => oneOf(rand, tokens));
    const next = () => oneOf(rand, alphabet);
    let old: string[];
    let new_: string[];
    if (rand() < 0.2) {
      old = times(int(0, 109), next);
      new_ = times(int(0, 109), next);
    } else {
      old = times(int(0, 99), next);
      new_ = [...old];
      for (let k = int(1, 6); k > 0; k--) {
        const at = int(0, new_.length);
        const size = int(1, 15);
        if (rand() < 0.4) new_.splice(at, size);
        else new_.splice(at, 0, ...times(size, next));
      }
    }
    const encode = (side: readonly string[]) =>
      side
        .map(
          (line, k) =>
            line + (k === side.length - 1 && rand() < 0.3 ? "" : rand() < 0.4 ? "\r\n" : "\n"),
        )
        .join("");
    return [encode(old), encode(new_)];
  },
  wide(rand, fresh) {
    // Indentation at the scoring limit: 190 to 210 columns, in spaces, tabs and both, blank or not.
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const indent = () => {
      const kind = int(0, 2);
      if (kind === 0) return " ".repeat(oneOf(rand, [0, 1, 2, 4, 8, int(190, 210)]));
      if (kind === 1) return "\t".repeat(oneOf(rand, [0, 1, 2, int(23, 27)]));
      return " ".repeat(int(185, 199)) + "\t".repeat(int(0, 2));
    };
    const kinds = times(
      int(2, 6),
      () => indent() + oneOf(rand, ["", "", "x", "}", "y()"]) + (rand() < 0.1 ? "\r" : ""),
    );
    const old = times(int(3, 40), () => (rand() < 0.8 ? oneOf(rand, kinds) : fresh()));
    const share = oneOf(rand, [0.05, 0.2, 0.4]);
    const next = old.filter(() => rand() >= share);
    if (rand() < 0.6)
      next.splice(int(0, next.length), 0, ...times(int(1, 5), () => oneOf(rand, kinds)));
    return [lines(...old), lines(...next)];
  },
  window(rand, fresh) {
    // Slide ranges near the scan's 100-position window: a unit repeated, one copy added or removed.
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const size = int(1, 4);
    const unit = times(size, () => oneOf(rand, ["", "  a", "b", "    c", fresh()]));
    const copies = Math.max(1, Math.round(int(88, 116) / size));
    const head = times(int(0, 3), fresh);
    const tail = times(int(0, 3), fresh);
    const body = times(copies, () => unit).flat();
    const at = int(0, copies) * size;
    const next =
      rand() < 0.5
        ? [...body.slice(0, at), ...unit, ...body.slice(at)]
        : [...body.slice(0, at), ...body.slice(at + size)];
    return [lines(...head, ...body, ...tail), lines(...head, ...next, ...tail)];
  },
  tails(rand, fresh) {
    // Common tails near multiples of 1,024 bytes, where the tail cut gives lines back.
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const alphabet = times(int(2, 6), () => oneOf(rand, ["", "x", "  }", "a".repeat(int(1, 30))]));
    const head = times(int(1, 30), () => oneOf(rand, alphabet));
    const target = 1024 * int(1, 2) + int(-8, 8);
    const tail: string[] = [];
    for (let bytes = 0; bytes < target; ) {
      const line = rand() < 0.5 ? oneOf(rand, alphabet) : fresh();
      tail.push(line);
      bytes += line.length + 1;
    }
    const next = head.filter(() => rand() >= 0.2);
    if (rand() < 0.7)
      next.splice(int(0, next.length), 0, ...times(int(1, 4), () => oneOf(rand, alphabet)));
    return [lines(...head, ...tail), lines(...next, ...tail)];
  },
  rounds(rand, fresh) {
    // Searches near the 256-round limit: unique lines with swaps far apart.
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const count = int(300, 1200);
    const old = times(count, fresh);
    const next = [...old];
    const span = int(30, 200);
    for (let k = int(40, 220); k > 0; k--) {
      const a = int(0, count - span - 1);
      const b = a + int(1, span);
      [next[a], next[b]] = [next[b] as string, next[a] as string];
    }
    return [lines(...old), lines(...next)];
  },
  both(rand, fresh) {
    const side = () =>
      lines(
        ...times(8 + Math.floor(rand() * 53), () =>
          rand() < 0.5 ? oneOf(rand, ["X", "Y"]) : fresh(),
        ),
      );
    return [side(), side()];
  },
};

const CODE_LINES = [
  "",
  "  }",
  "}",
  "    }",
  "  {",
  "{",
  "    return;",
  "// x",
  "  },",
  "#endif",
  "\tbreak;",
  "\t}",
  "\t\t}",
  " ",
  "\t",
  "        }",
  "/*",
  " */",
  "  return x;",
  "else",
  "      y();",
];

function oneOf<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)] as T;
}

/** `count` pairs of a family, the same for a seed. */
export function crowdedPairs(family: string, seed: number, count: number): [string, string][] {
  const make = CROWDED_FAMILIES[family];
  if (!make) throw new Error(`no family ${family}`);
  const rand = prng(seed);
  let unique = 0;
  const fresh = () => `u${unique++}`;
  return Array.from({ length: count }, () => make(rand, fresh));
}

/** A pick that isn't settled moves what's below it: lines of a later group, sliding up to it. */
export const WITNESSES_REACHED_BY_A_REFUSAL: readonly (readonly [string[], string[]])[] = [
  [
    [
      "\tbreak;",
      "        }",
      "    }",
      "        }",
      "    }",
      " ",
      "else",
      "        }",
      "    }",
      "else",
      "    }",
    ],
    [
      "\tbreak;",
      "        }",
      "    }",
      " ",
      "        }",
      "    }",
      "        }",
      "        }",
      "        }",
      "    }",
      " ",
      "else",
      "        }",
      "else",
      "    }",
    ],
  ],
  [
    [
      "  return x;",
      " */",
      "#endif",
      " */",
      "  return x;",
      "  return x;",
      "  return x;",
      "  return x;",
      "  return x;",
    ],
    [
      "  return x;",
      " */",
      "  return x;",
      " */",
      "  return x;",
      "#endif",
      " */",
      "#endif",
      "  return x;",
      "  return x;",
    ],
  ],
];

/** Blank runs at the scan's limit, where the figures are off by more than a close call. */
export const WITNESSES_AT_THE_BLANK_LIMIT: readonly (readonly [string[], string[]])[] = [
  [
    [
      " ",
      "\t",
      " ",
      " ",
      "\t",
      "\t",
      "\t",
      "\t",
      "\t",
      " ",
      "",
      "\t",
      "\t",
      " ",
      "",
      "",
      "",
      "",
      "",
      "",
      "    y",
      "",
      "\t",
      "    y",
      "",
      "\t",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      " ",
      "",
      "\t",
      "",
      "",
      "",
      "\t",
      "",
      "",
      "\t",
    ],
    [
      "",
      "    y",
      "",
      "\t",
      "",
      " ",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "\t",
      "",
      " ",
      "",
      "\t",
      "",
      "",
      "",
      "\t",
      "",
      "",
      "\t",
    ],
  ],
  [
    [
      "  x",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      " ",
      "\t",
      " ",
      "\t",
      "",
      "\t",
      "\t",
      "",
      " ",
      "",
      " ",
      "",
      " ",
      "",
      "    y",
    ],
    ["  x", "", "", "", "", " ", " ", " ", "  x"],
  ],
  [
    [
      "",
      "",
      "",
      "",
      " ",
      "",
      " ",
      " ",
      "",
      "",
      "",
      "",
      "",
      " ",
      " ",
      " ",
      "",
      "",
      "",
      "    y",
      "",
      "    y",
      "",
      "",
      "\t",
      "\t",
      "",
      "",
      "\t",
      "",
      " ",
      " ",
      "\t",
      "",
      " ",
      " ",
      "",
      "\t",
      " ",
      "",
      "",
      " ",
      "",
    ],
    [" ", "", "", "    y", "", "", "\t", "\t", "", "\t", " ", "", " ", "    y"],
  ],
  [
    [
      "  x",
      "\t",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "\t",
      "",
      " ",
      "\t",
      "",
      "\t",
      " ",
      " ",
      " ",
      "\t",
      " ",
      " ",
      " ",
      "\t",
      "    y",
    ],
    ["\t", "", "", "", "", "", "\t", " ", " ", " ", "\t", " "],
  ],
  [
    [
      "",
      "",
      " ",
      "",
      "",
      "",
      " ",
      "\t",
      " ",
      "",
      "",
      "\t",
      "\t",
      "",
      "\t",
      "",
      "\t",
      "",
      " ",
      "",
      "    y",
      "",
      "",
      "    y",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      " ",
      "",
      " ",
      "",
      "\t",
      "\t",
      "",
      "\t",
      "\t",
      " ",
      " ",
      "",
      "\t",
    ],
    [
      " ",
      "",
      "    y",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      " ",
      "",
      " ",
      "",
      "\t",
      "\t",
      "",
      "\t",
      "\t",
      " ",
      "",
      "\t",
    ],
  ],
  [
    [
      "\t",
      " ",
      " ",
      "\t",
      " ",
      "",
      "\t",
      "",
      "\t",
      "",
      " ",
      "\t",
      "\t",
      "",
      "",
      " ",
      "\t",
      " ",
      "",
      "",
      "    y",
      "",
      "",
      "    y",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      " ",
      "",
      "",
      "",
      "",
      "",
    ],
    [
      " ",
      "",
      "",
      "    y",
      "",
      "",
      "",
      "",
      " ",
      "",
      "",
      " ",
      "\t",
      "",
      "\t",
      "\t",
      "",
      "",
      "\t",
      "\t",
      "",
      "",
      "",
      " ",
      "",
      "",
      "",
      "",
      "\t",
      "\t",
      "",
      " ",
      "\t",
      " ",
      "\t",
      "\t",
      "",
      "",
      "",
      " ",
      "",
      "",
      "\t",
      "",
      " ",
      " ",
      " ",
      "",
      "",
      "",
      "",
      "",
      "\t",
      "",
    ],
  ],
  [
    [
      "\t",
      "",
      "\t",
      "\t",
      "",
      "",
      "",
      " ",
      " ",
      " ",
      "",
      "",
      "\t",
      " ",
      "\t",
      " ",
      "\t",
      "",
      "",
      "  x",
      " ",
      "  x",
      " ",
      "",
      "",
      "\t",
      "\t",
      "\t",
      "",
      "",
      " ",
      "",
      "",
      " ",
      " ",
      "",
      "\t",
      "",
      "\t",
      "\t",
      "",
      "",
      "",
    ],
    [
      " ",
      "",
      "",
      "  x",
      " ",
      "",
      " ",
      "\t",
      "\t",
      "\t",
      "",
      "",
      " ",
      "",
      "",
      " ",
      " ",
      "",
      "\t",
      "",
      "\t",
      "\t",
      "",
      "",
      "",
    ],
  ],
  [
    [
      "",
      "",
      "\t",
      "\t",
      "",
      " ",
      " ",
      " ",
      "",
      " ",
      "",
      "",
      " ",
      " ",
      "",
      "",
      "\t",
      "\t",
      "\t",
      "  x",
      " ",
      "  x",
      " ",
      "",
      "",
      " ",
      "\t",
      " ",
      "\t",
      "",
      "\t",
      "\t",
      "",
      " ",
      "",
      "\t",
      " ",
      "",
      "",
      "",
      "",
      "",
      "\t",
    ],
    [
      " ",
      "\t",
      "\t",
      "\t",
      "  x",
      " ",
      "",
      " ",
      " ",
      "",
      "\t",
      "",
      " ",
      "",
      "\t",
      "",
      "\t",
      "\t",
      "",
      " ",
      "",
      "\t",
      " ",
      "",
      "",
    ],
  ],
];

/** A scan that kept the wrong position by 16, past a margin of 13: one blank line, counted above or below. */
export const WITNESSES_PAST_THE_MARGIN: readonly (readonly [string[], string[]])[] = [
  [
    [
      "u0",
      "",
      " ",
      "/*",
      "",
      "/*",
      " ",
      " ",
      "u1",
      " ",
      "u2",
      "",
      "/*",
      " ",
      " ",
      "/*",
      "/*",
      "/*",
      " ",
      " ",
      " ",
      " ",
      " ",
      "/*",
      "/*",
    ],
    [
      "",
      " ",
      "/*",
      "",
      "",
      "/*",
      " ",
      "/*",
      "/*",
      "/*",
      "",
      " ",
      "u0",
      " ",
      "",
      "",
      "/*",
      "",
      "/*",
      "",
      " ",
      "",
      "/*",
      " ",
      " ",
      "u1",
      " ",
      "u2",
      "",
      " ",
      " ",
      "/*",
      "/*",
      "/*",
      " ",
      " ",
      " ",
      "/*",
      "/*",
    ],
  ],
];

/** What a blank line above a split weighs, reduced from a review's generated pair. */
export const WITNESSES_OF_THE_BLANK_WEIGHT: readonly (readonly [string, string])[] = [
  [
    "\t\r\n\r\n\t\r\n \r\t\r\n\r\n\t\n\t\n \r\t\r\n\t\r\n \r\t\n\r  x\n \r\t\r\n\r  x\n\t\n\r\n\t\n\t\n\t\r\n \r\t\r\n\t\n\t\n\r\n\t\n \r\t\n\t\r\n\r\r\n\r  x\r\n",
    " \r\t\n\r  x\n\t\n\t\n\t\r\n",
  ],
  [
    "\n \n\n  \n \n   \n   \n  \n\n    \n  x\n  \n  x\n   \n \n   \n   \n\n  \n   \n   \n \n   \n    \n\n      \n  y\n",
    "    \n  x\n   \n   \n\n",
  ],
];

/** `K` blank lines, an indented line, a blank, the same line, `M` blank lines: one group, two positions. */
export function blankWeightGrid(): [string, string][] {
  const out: [string, string][] = [];
  for (const head of [[], ["z"]]) {
    for (let k = 0; k <= 24; k++) {
      for (let m = 0; m <= 24; m++) {
        const above = times(k, () => " ");
        const below = times(m, () => "   ");
        out.push([
          lines(...head, ...above, "  x", "    ", "  x", ...below, "  y"),
          lines(...head, ...above, "  x", ...below, "  y"),
        ]);
      }
    }
  }
  return out;
}
