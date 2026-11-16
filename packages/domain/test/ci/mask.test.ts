// Masking of CI log rows: the variants a value covers, `::add-mask::`
// parsing, the matcher over rows joined with no separator, the carry between
// requests, the settled boundary and the caps.
import { describe, expect, it } from "vitest";
import {
  buildVariants,
  type LogMask,
  MASK_MAX_TEXT_BYTES,
  MASK_MAX_VALUES,
  maskRows,
  parseAddMask,
} from "../../src/ci/index.js";

const utf8 = new TextEncoder();
/** Standard padded base64 of the string's UTF-8 bytes, through the platform's encoder. */
const b64 = (text: string): string => btoa(String.fromCharCode(...utf8.encode(text)));
const texts = (value: string): string[] => buildVariants(value).map((variant) => variant.text);

/** A job token's shape: long enough to cross row boundaries. */
const TOKEN = "fyrden_job_Q8x2LmN4pR7sT1vW3yZ5bC6dF9gH0jK";
const jobToken: LogMask = { value: TOKEN, fromIndex: 0 };
const mask = (masks: readonly LogMask[], rows: readonly string[], options = {}) =>
  maskRows(masks, null, rows, { start: 0, ...options });

describe("buildVariants", () => {
  it("covers nothing for a value under 2 chars", () => {
    expect(buildVariants("")).toEqual([]);
    expect(buildVariants("x")).toEqual([]);
  });

  it("registers a 2-char value once, row-local", () => {
    expect(buildVariants("ab")).toEqual([{ text: "ab", crosses: false }]);
  });

  it("adds no base64 form under 8 chars", () => {
    expect(texts("abcdefg")).toEqual(["abcdefg"]);
  });

  it("marks variants of 8 or more chars as crossing row boundaries", () => {
    const variants = buildVariants("abcdefgh");
    expect(variants[0]).toEqual({ text: "abcdefgh", crosses: true });
    for (const variant of variants) expect(variant.crosses).toBe(variant.text.length >= 8);
  });

  it("covers the value without CR and LF and each trimmed line longer than 1 char", () => {
    const value = "  first-line  \r\nx\nsecond";
    const got = texts(value);
    expect(got).toContain(value);
    expect(got).toContain("  first-line  xsecond");
    expect(got).toContain("first-line");
    expect(got).toContain("second");
    expect(got).not.toContain("x");
  });

  it("encodes base64 at the three byte alignments, as found inside longer encodings", () => {
    for (const value of ["abcdefgh", "s3cr3t-value-0123456789", "pässwörd-ünïcode"]) {
      const bytes = utf8.encode(value).length;
      const got = texts(value);
      for (const shift of [0, 1, 2]) {
        const encoded = b64("x".repeat(shift) + value);
        const lead = Math.ceil((8 * shift) / 6);
        const keep = Math.floor((8 * (shift + bytes)) / 6);
        const form = encoded.slice(lead, keep);
        expect(got).toContain(form);
        // Whatever precedes the value at this alignment and whatever follows it.
        for (const before of ["", "abc", "abcabc", "ÿÿÿ"]) {
          for (const after of ["", "z", "zz", "zzz"]) {
            expect(b64(before + "x".repeat(shift) + value + after)).toContain(form);
          }
        }
      }
      expect(got).toContain(b64(value));
    }
  });

  it("matches fixed base64 vectors", () => {
    const got = texts("abcdefgh");
    expect(got).toContain("YWJjZGVmZ2");
    expect(got).toContain("FiY2RlZmdo");
    expect(got).toContain("hYmNkZWZna");
    expect(got).toContain("YWJjZGVmZ2g=");
  });

  it("escapes as a JSON string, plain and HTML-safe", () => {
    expect(texts('a"b\\c')).toContain('a\\"b\\\\c');
    expect(texts("a\u0001b")).toContain("a\\u0001b");
    expect(texts("a\tb")).toContain("a\\tb");
    const html = texts("<a&b>");
    expect(html).toContain("<a&b>");
    expect(html).toContain("\\u003ca\\u0026b\\u003e");
  });

  it.each([
    { value: "a!b", uri: "a%21b", query: "a%21b", path: "a%21b" },
    { value: "'()*", uri: "%27%28%29%2A", query: "%27%28%29%2A", path: "%27%28%29%2A" },
    { value: "a b", uri: "a%20b", query: "a+b", path: "a%20b" },
    {
      value: "aé😀",
      uri: "a%C3%A9%F0%9F%98%80",
      query: "a%C3%A9%F0%9F%98%80",
      path: "a%C3%A9%F0%9F%98%80",
    },
    { value: "a/b+c", uri: "a%2Fb%2Bc", query: "a%2Fb%2Bc", path: "a%2Fb+c" },
    { value: "a;b=c", uri: "a%3Bb%3Dc", query: "a%3Bb%3Dc", path: "a%3Bb=c" },
    { value: "$&+:=@", uri: "%24%26%2B%3A%3D%40", query: "%24%26%2B%3A%3D%40", path: "$&+:=@" },
    { value: "a,b?c", uri: "a%2Cb%3Fc", query: "a%2Cb%3Fc", path: "a%2Cb%3Fc" },
    { value: "Az09-._~", uri: "Az09-._~", query: "Az09-._~", path: "Az09-._~" },
  ])("escapes $value as Go's URL escapers do", ({ value, uri, query, path }) => {
    const got = texts(value);
    expect(got).toContain(uri);
    expect(got).toContain(query);
    expect(got).toContain(path);
  });

  it("escapes as a workflow command value", () => {
    expect(texts("50%\r\nnext")).toContain("50%25%0D%0Anext");
    expect(texts("50%x")).toContain("50%25x");
  });

  it("registers each text once", () => {
    const got = texts("plain-value");
    expect(new Set(got).size).toBe(got.length);
    expect(got.filter((text) => text === "plain-value")).toHaveLength(1);
  });
});

describe("parseAddMask", () => {
  it.each([
    ["::add-mask::abc", "abc"],
    ["::add-mask::a b c ", "a b c "],
    ["::add-mask::abc\r", "abc"],
    ["::add-mask::abc\rdef", "abc"],
    // Workflow-command data is unescaped in one pass, as the runner does before registering.
    ["::add-mask::abc%25def", "abc%def"],
    ["::add-mask::alpha%0Abeta", "alpha\nbeta"],
    ["::add-mask::a%0Db", "a\rb"],
    ["::add-mask::%250A", "%0A"],
    ["::add-mask::%0a%2", "%0a%2"],
    ["::add-mask::", ""],
    [" ::add-mask::abc", null],
    ["::add-mask ::abc", null],
    ["::add-mask key=v::abc", null],
    ["::ADD-MASK::abc", null],
    ["echo ::add-mask::abc", null],
    ["", null],
  ])("%j → %j", (row, value) => {
    expect(parseAddMask(row)).toBe(value);
  });
});

describe("maskRows", () => {
  it("masks a value in a row", () => {
    const result = mask([jobToken], [`echo ${TOKEN} done`, "clean"]);
    expect(result.lines).toEqual(["echo *** done", "clean"]);
    expect(result.settled).toBe(2);
    expect(result.added).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it("merges overlapping and touching matches into one ***", () => {
    const masks = [
      { value: "abcdef12", fromIndex: 0 },
      { value: "ef12ghij", fromIndex: 0 },
      { value: "KLMNOPQR", fromIndex: 0 },
    ];
    expect(mask(masks, ["xabcdef12ghijKLMNOPQRx"]).lines).toEqual(["x***x"]);
  });

  it("masks a value split across two rows in both", () => {
    const rows = [`pre ${TOKEN.slice(0, 10)}`, `${TOKEN.slice(10)} post`];
    expect(mask([jobToken], rows).lines).toEqual(["pre ***", "*** post"]);
  });

  it("masks a value split anywhere, leaving at most 3 leading chars that settled early", () => {
    for (let at = 1; at < TOKEN.length; at++) {
      const rows = [`pre ${TOKEN.slice(0, at)}`, `${TOKEN.slice(at)} post`];
      const lines = mask([jobToken], rows).lines;
      expect(lines[1]).toBe("*** post");
      expect(lines[0]).toBe(at <= 3 ? `pre ${TOKEN.slice(0, at)}` : "pre ***");
    }
  });

  it("masks a multi-line value printed as rows", () => {
    const value = "line-one-AAAA\nline-two-BBBB";
    const rows = ["x line-one-AAAA", "line-two-BBBB y"];
    expect(mask([{ value, fromIndex: 0 }], rows).lines).toEqual(["x ***", "*** y"]);
  });

  it("masks base64 wrapped at 76 columns", () => {
    const value = `${TOKEN}-and-some-more-secret-text`;
    const encoded = b64(value);
    expect(encoded.length).toBeGreaterThan(76);
    const rows = [encoded.slice(0, 76), encoded.slice(76), "after"];
    expect(mask([{ value, fromIndex: 0 }], rows).lines).toEqual(["***", "***", "after"]);
  });

  it("masks encoded forms inside JSON and a URL", () => {
    const value = 'p@ss "word" & more/1';
    const json = JSON.stringify({ secret: value });
    const url = `https://h/?q=${encodeURIComponent(value)}`;
    const lines = mask([{ value, fromIndex: 0 }], [json, url]).lines;
    expect(lines[0]).toBe('{"secret":"***"}');
    expect(lines[1]).toBe("https://h/?q=***");
  });

  it("masks an add-mask value from its own row on, never before", () => {
    const value = "SECRET-VALUE-1";
    const rows = [
      `before ${value}`,
      `::add-mask::${value}`,
      `after ${value}`,
      `split ${value.slice(0, 7)}`,
      `${value.slice(7)} end`,
    ];
    const result = mask([], rows);
    expect(result.lines).toEqual([
      `before ${value}`,
      "::add-mask::***",
      "after ***",
      "split ***",
      "*** end",
    ]);
    expect(result.added).toEqual([{ value, index: 1 }]);
  });

  it("does not count a match of a new value that starts before its row", () => {
    // An earlier value's partial match carries "abcdefg" into the command row, where the
    // new value "abcdefg:" would complete on the row's first ':'.
    const masks = [{ value: "xyabcdefgZZZ", fromIndex: 0 }];
    const result = mask(masks, ["xyabcdefg", "::add-mask::abcdefg:", "abcdefg: y"]);
    expect(result.lines).toEqual(["xyabcdefg", "::add-mask::***", "*** y"]);
  });

  it("keeps an earlier value's partial match across a row that registers a value", () => {
    const masks = [{ value: "token-12::add-mask::zz", fromIndex: 0 }];
    const result = mask(masks, ["x token-12", "::add-mask::zz", "after"]);
    expect(result.lines).toEqual(["x ***", "***", "after"]);
    expect(result.added).toEqual([{ value: "zz", index: 1 }]);
  });

  it("registers the unescaped add-mask value and masks the raw command data", () => {
    const result = mask([], ["::add-mask::abc%25def", "abc%def"]);
    expect(result.lines).toEqual(["::add-mask::***", "***"]);
    expect(result.added).toEqual([{ value: "abc%def", index: 0 }]);
  });

  it("registers the lines of an escaped multi-line add-mask value", () => {
    const result = mask([], ["::add-mask::alpha%0Abeta", "alpha", "beta", "alphabeta"]);
    expect(result.lines).toEqual(["::add-mask::***", "***", "***", "***"]);
    expect(result.added).toEqual([{ value: "alpha\nbeta", index: 0 }]);
  });

  it("settles every row when a resumed carry meets no text", () => {
    const masks = [{ value: "abcdefgh", fromIndex: 0 }];
    const forced = mask(masks, ["abcd"], { force: true });
    expect(forced.lines).toEqual(["***"]);
    const carry = forced.carryAt(1);
    expect(carry).toMatchObject({ length: 4 });
    for (const rows of [[], [""], ["", ""]]) {
      expect(maskRows(masks, carry, rows, { start: 1 }).settled).toBe(rows.length);
      expect(maskRows(masks, carry, rows, { start: 1, force: true }).settled).toBe(rows.length);
    }
  });

  it("does work per input char bounded by a constant whatever the number of masks", () => {
    // Values sharing a prefix fan out from one trie node; an unmatched char after the
    // prefix must not cost one comparison per sibling.
    for (const [prefix, input] of [
      ["a", "aZ"],
      ["abcdefg", "abcdefgZ"],
    ] as const) {
      const text = input.repeat(4096 / input.length);
      const lookups = (count: number): number => {
        const masks = Array.from({ length: count }, (_, i) => ({
          value: prefix + String.fromCharCode(0x100 + i),
          fromIndex: 0,
        }));
        const work = { lookups: 0 };
        maskRows(masks, null, [text], { start: 0, work });
        return work.lookups;
      };
      const one = lookups(1);
      const many = lookups(MASK_MAX_VALUES);
      expect(one).toBeGreaterThan(0);
      expect(one).toBeLessThanOrEqual(6 * text.length);
      expect(many).toBeLessThanOrEqual(6 * text.length);
    }
  });

  it("registers an add-mask value at its absolute row index", () => {
    const result = maskRows([], null, ["x", "::add-mask::abcdefgh"], { start: 40 });
    expect(result.added).toEqual([{ value: "abcdefgh", index: 41 }]);
  });

  it("masks the command row of a value too short to register", () => {
    const result = mask([], ["::add-mask::x", "x marks"]);
    expect(result.lines).toEqual(["::add-mask::***", "x marks"]);
    expect(result.added).toEqual([]);
  });

  it("does not register the same value twice", () => {
    const result = mask(
      [{ value: "abcdefgh", fromIndex: 0 }],
      ["::add-mask::abcdefgh", "::add-mask::other-value", "::add-mask::other-value"],
    );
    expect(result.added).toEqual([{ value: "other-value", index: 1 }]);
    expect(result.lines).toEqual(["::add-mask::***", "::add-mask::***", "::add-mask::***"]);
  });

  it("does not match a short value across a row boundary", () => {
    const result = mask([], ["::add-mask::OK", "say O", "K now", "OK"]);
    expect(result.lines).toEqual(["::add-mask::***", "say O", "K now", "***"]);
    expect(result.settled).toBe(4);
  });

  it("settles rows before an in-progress partial of 4 or more chars", () => {
    const rows = ["a", "b", `x ${TOKEN.slice(0, 6)}`];
    const result = mask([jobToken], rows);
    expect(result.settled).toBe(2);
    expect(result.carryAt(3)).toMatchObject({ length: 6 });
    expect(result.carryAt(2)).toBeNull();
    expect(result.lines).toEqual(rows);
  });

  it("holds every row a long partial spans", () => {
    const rows = ["a", `x ${TOKEN.slice(0, 4)}`, TOKEN.slice(4, 5), "", TOKEN.slice(5, 9)];
    expect(mask([jobToken], rows).settled).toBe(1);
  });

  it("settles a row ending in a 1 to 3 char partial and masks the rest through the carry", () => {
    for (let at = 1; at <= 3; at++) {
      const first = mask([jobToken], ["a", `x ${TOKEN.slice(0, at)}`]);
      expect(first.settled).toBe(2);
      expect(first.lines).toEqual(["a", `x ${TOKEN.slice(0, at)}`]);
      expect(first.carryAt(2)).toMatchObject({ length: at });
      const next = maskRows([jobToken], first.carryAt(2), [`${TOKEN.slice(at)} y`], { start: 2 });
      expect(next.lines).toEqual(["*** y"]);
    }
  });

  it("masks a trailing partial of 4 or more chars when forced, and keeps the carry", () => {
    const forced = mask([jobToken], ["ok", `x ${TOKEN.slice(0, 6)}`], { force: true });
    expect(forced.lines).toEqual(["ok", "x ***"]);
    expect(forced.settled).toBe(1);
    const carry = forced.carryAt(2);
    expect(carry).toMatchObject({ length: 6 });
    const next = maskRows([jobToken], carry, [`${TOKEN.slice(6)} y`, "z"], { start: 2 });
    expect(next.lines).toEqual(["*** y", "z"]);
  });

  it("does not mask a forced partial under 4 chars", () => {
    const forced = mask([jobToken], [`x ${TOKEN.slice(0, 3)}`], { force: true });
    expect(forced.lines).toEqual([`x ${TOKEN.slice(0, 3)}`]);
  });

  it("masks no partial on a final call and settles every row", () => {
    const rows = ["ok", `x ${TOKEN.slice(0, 6)}`];
    const result = mask([jobToken], rows, { final: true });
    expect(result.lines).toEqual(rows);
    expect(result.settled).toBe(2);
  });

  it("resumes from the carry: a row starting with the rest of the value is masked", () => {
    const first = mask([jobToken], [`x ${TOKEN.slice(0, 20)}`], { force: true });
    const next = maskRows([jobToken], first.carryAt(1), [`${TOKEN.slice(20)}!`], { start: 1 });
    expect(next.lines).toEqual(["***!"]);
  });

  it("ignores a carry that names no registered variant", () => {
    const result = maskRows([jobToken], { mask: 3, variant: 0, length: 5 }, [TOKEN.slice(5)], {
      start: 1,
    });
    expect(result.lines).toEqual([TOKEN.slice(5)]);
    expect(result.carryAt(0)).toBeNull();
  });

  it("resumes from the carry at the committed boundary, not the end of the request", () => {
    const value = "abababab";
    const masks = [{ value, fromIndex: 0 }];
    const rows = [...Array.from({ length: 49 }, () => "#"), "abab"];
    const first = mask(masks, rows);
    expect(first.settled).toBe(49);
    expect(first.carryAt(49)).toBeNull();
    expect(first.carryAt(50)).toMatchObject({ length: 4 });
    const resend = ["abab", "Z"];
    expect(maskRows(masks, first.carryAt(49), resend, { start: 49 }).lines).toEqual(resend);
    // The end-of-request carry would replay the held row on top of itself and invent a match.
    expect(maskRows(masks, first.carryAt(50), resend, { start: 49 }).lines).toEqual(["***", "Z"]);
  });

  it("reports a carry for every row boundary", () => {
    const result = mask([jobToken], ["a", TOKEN.slice(0, 5), TOKEN.slice(5, 12)]);
    expect(result.carryAt(0)).toBeNull();
    expect(result.carryAt(1)).toBeNull();
    expect(result.carryAt(2)).toMatchObject({ mask: 0, length: 5 });
    expect(result.carryAt(3)).toMatchObject({ mask: 0, length: 12 });
    expect(() => result.carryAt(4)).toThrow(RangeError);
  });

  it("keeps rows with no mask unchanged", () => {
    const rows = ["", "plain", "  ", "é😀"];
    expect(mask([], rows).lines).toEqual(rows);
  });
});

describe("mask caps", () => {
  const values = (count: number): LogMask[] =>
    Array.from({ length: count }, (_, i) => ({ value: `value-${i}`, fromIndex: 0 }));

  it("registers the 256th value and drops the 257th, still masking its command row", () => {
    expect(MASK_MAX_VALUES).toBe(256);
    const result = mask(values(255), [
      "::add-mask::last-allowed",
      "::add-mask::one-too-many",
      "one-too-many last-allowed",
    ]);
    expect(result.added).toEqual([{ value: "last-allowed", index: 0 }]);
    expect(result.dropped).toEqual([{ index: 1, reason: "values" }]);
    expect(result.lines).toEqual(["::add-mask::***", "::add-mask::***", "one-too-many ***"]);
  });

  it("drops a value past 16 KiB of value text, still masking its command row", () => {
    expect(MASK_MAX_TEXT_BYTES).toBe(16 * 1024);
    const big = "s".repeat(MASK_MAX_TEXT_BYTES + 1);
    const result = mask([], [`::add-mask::${big}`, big.slice(0, 20)]);
    expect(result.added).toEqual([]);
    expect(result.dropped).toEqual([{ index: 0, reason: "bytes" }]);
    expect(result.lines).toEqual(["::add-mask::***", big.slice(0, 20)]);
  });

  it("counts UTF-8 bytes of every registered value against the text cap", () => {
    const existing = { value: "é".repeat(8000), fromIndex: 0 };
    const fits = "a".repeat(MASK_MAX_TEXT_BYTES - 16_000);
    const result = mask([existing], [`::add-mask::${fits}`, "::add-mask::bb"]);
    expect(result.added).toEqual([{ value: fits, index: 0 }]);
    expect(result.dropped).toEqual([{ index: 1, reason: "bytes" }]);
  });

  it("keeps reserved room out of both caps when registering", () => {
    const reserve = { values: 3, bytes: 300 };
    const byCount = mask(values(252), ["::add-mask::fits-last", "::add-mask::over-count"], {
      reserve,
    });
    expect(byCount.added).toEqual([{ value: "fits-last", index: 0 }]);
    expect(byCount.dropped).toEqual([{ index: 1, reason: "values" }]);
    const fits = "a".repeat(MASK_MAX_TEXT_BYTES - 300);
    const byBytes = mask([], [`::add-mask::${fits}`, "::add-mask::bb"], { reserve });
    expect(byBytes.added).toEqual([{ value: fits, index: 0 }]);
    expect(byBytes.dropped).toEqual([{ index: 1, reason: "bytes" }]);
    // Masks already given are never dropped, reserve or not.
    expect(mask(values(256), ["value-255"], { reserve }).lines).toEqual(["***"]);
  });

  it("counts reserved masks inside the reserve, so one appearing never changes what registers", () => {
    const token = `fyrden_job_${"A".repeat(36)}`;
    const reserve = { values: 8, bytes: 8 * token.length };
    const fits = `K-${"X".repeat(MASK_MAX_TEXT_BYTES - reserve.bytes - 4)}-Z`;
    const over = `${fits}!`;
    for (const value of [fits, over]) {
      const rows = [`::add-mask::${value}`, `v=${value}`, "end!"];
      const before = mask([], rows, { reserve });
      const after = mask([{ value: token, fromIndex: 0, reserved: true }], rows, { reserve });
      expect(after.added).toEqual(before.added);
      expect(after.dropped).toEqual(before.dropped);
      expect(after.lines).toEqual(before.lines);
      expect(after.settled).toEqual(before.settled);
    }
    expect(mask([], [`::add-mask::${fits}`], { reserve }).added).toHaveLength(1);
    expect(mask([], [`::add-mask::${over}`], { reserve }).dropped).toEqual([
      { index: 0, reason: "bytes" },
    ]);
    // Eight reserved values leave 248 for rows, with or without them present.
    const tokens = Array.from({ length: 8 }, (_, i) => ({
      value: `fyrden_job_${String(i).repeat(36)}`,
      fromIndex: 0,
      reserved: true,
    }));
    const rows = Array.from({ length: 249 }, (_, i) => `::add-mask::row-value-${i}`);
    for (const given of [[], tokens]) {
      const result = mask(given, rows, { reserve });
      expect(result.added).toHaveLength(248);
      expect(result.dropped).toEqual([{ index: 248, reason: "values" }]);
    }
  });

  it("registers only the lines of a value over 4 KiB", () => {
    const big = `${"Z".repeat(4096)}-tail`;
    const result = mask([{ value: big, fromIndex: 0 }], [big, b64(big)]);
    expect(result.lines).toEqual(["***", b64(big)]);
  });
});
