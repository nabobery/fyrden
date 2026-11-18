import { env } from "cloudflare:workers";
import { LOG_ROW_TOO_LARGE, maskRows, type StoredLogLine } from "@fyrden/domain/ci";
import { uniqueId } from "@fyrden/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { LOG_READER_POLICY, type ReadLogLine, readLogLines } from "../src/do/run/log-reader.js";

const utf8 = new TextEncoder();
const encoded = (lines: readonly StoredLogLine[]) =>
  utf8.encode(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

function source(bytes: Uint8Array, cuts = [32768]) {
  let offset = 0;
  let pulls = 0;
  let largestRead = 0;
  let cancelled = false;
  const body = new ReadableStream({
    type: "bytes",
    pull(controller) {
      const request = controller.byobRequest;
      if (!request?.view) throw new Error("reader must use bounded BYOB");
      const view = new Uint8Array(
        request.view.buffer,
        request.view.byteOffset,
        request.view.byteLength,
      );
      largestRead = Math.max(largestRead, view.byteLength);
      const size = Math.min(
        view.byteLength,
        cuts[pulls++ % cuts.length] ?? 1,
        bytes.length - offset,
      );
      if (size === 0) {
        controller.close();
        request.respond(0);
        return;
      }
      view.set(bytes.subarray(offset, offset + size));
      offset += size;
      request.respond(size);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    get largestRead() {
      return largestRead;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function materialize(line: ReadLogLine): StoredLogLine {
  return "omitted" in line ? line : { i: line.i, t: line.t, c: line.c.whole() };
}

async function collect(body: ReadableStream<Uint8Array>): Promise<ReadLogLine[]> {
  const lines = [];
  for await (const line of readLogLines(body)) lines.push(line);
  return lines;
}

const string = fc
  .array(fc.integer({ min: 0, max: 65535 }), { maxLength: 100 })
  .map((units) => String.fromCharCode(...units));
const row = fc.record({
  i: fc.integer({ min: 0, max: 2147483647 }),
  t: fc.option(fc.integer({ min: -8640000000000000, max: 8640000000000000 }), { nil: null }),
  c: string,
});
const omission = fc.record({
  i: fc.integer({ min: 0, max: 2147483647 }),
  omitted: fc.constant(LOG_ROW_TOO_LARGE),
  bytes: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
});

describe("stored log streaming reader", () => {
  it.each([false, true])(
    "cancels a pending BYOB read on abort and releases its lock, cancellation rejects: %s",
    async (rejectCancel) => {
      let started!: () => void;
      const pulling = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled = false;
      let stream!: ReadableByteStreamController;
      const body = new ReadableStream({
        type: "bytes",
        start(controller) {
          stream = controller;
        },
        pull() {
          started();
        },
        cancel() {
          cancelled = true;
          if (rejectCancel) throw new Error("the source cancellation failed");
        },
      });
      const abort = new AbortController();
      const lines = readLogLines(body, abort.signal);
      const pending = lines.next();
      try {
        await pulling;
        abort.abort();
        expect(cancelled).toBe(true);
        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(body.locked).toBe(false);
      } finally {
        if (!cancelled) {
          stream.close();
          stream.byobRequest?.respond(0);
        }
        await pending.catch(() => undefined);
        await lines.return(undefined);
      }
    },
  );

  it("does not emit another buffered row after aborting between yields", async () => {
    const input = source(
      encoded([
        { i: 0, t: null, c: "left" },
        { i: 1, t: null, c: "right" },
      ]),
    );
    const abort = new AbortController();
    const lines = readLogLines(input.body, abort.signal);
    expect((await lines.next()).value?.i).toBe(0);
    abort.abort();
    await expect(lines.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(input.cancelled).toBe(true);
    expect(input.body.locked).toBe(false);
  });

  it("cancels without reading when its signal was already aborted", async () => {
    const input = source(encoded([{ i: 0, t: null, c: "never decoded" }]));
    const abort = new AbortController();
    abort.abort();
    const lines = readLogLines(input.body, abort.signal);
    await expect(lines.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(input.largestRead).toBe(0);
    expect(input.cancelled).toBe(true);
    expect(input.body.locked).toBe(false);
  });

  it("bounds masking expansion including row edges and omission protection", () => {
    const masks = ["ab", "secretxy"].map((value) => ({ value, fromIndex: 0 }));
    fc.assert(
      fc.property(
        fc.array(
          fc.string({
            unit: fc.constantFrom("a", "b", "s", "e", "c", "r", "t", "x", "y", " "),
            maxLength: 100,
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 100 }),
        (rows, gapRemaining) => {
          const masked = maskRows(masks, null, rows, { start: 0, final: true, gapRemaining });
          for (const [i, line] of masked.lines.entries()) {
            const raw = rows[i];
            if (raw === undefined) throw new Error("missing row");
            expect(line.length).toBeLessThanOrEqual(Math.ceil((raw.length * 3) / 2) + 4);
          }
        },
      ),
      { numRuns: 100 },
    );
    const masked = maskRows(masks, null, ["secretx", "y ab ab s", "ecretxy"], {
      start: 0,
      final: true,
    });
    expect(masked.lines[1]).toBe("*** *** *** s");
    const protectedRow = maskRows(masks, null, ["x ab"], {
      start: 0,
      final: true,
      gapRemaining: 1,
    });
    expect(protectedRow.lines).toEqual(["*** ***"]);
  });

  it("reads canonical rows through bounded BYOB reads", async () => {
    const lines = [{ i: 0, t: null, c: "\u0001".repeat(32769) }];
    const input = source(encoded(lines));
    expect((await collect(input.body)).map(materialize)).toEqual(lines);
    expect(input.largestRead).toBeLessThanOrEqual(LOG_READER_POLICY.readBytes);
    expect(input.body.locked).toBe(false);
  });

  it("matches JSON.parse across arbitrary byte boundaries and UTF-16 values", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(row, omission), { minLength: 1, maxLength: 8 }),
        fc.array(fc.integer({ min: 1, max: 67 }), { minLength: 1, maxLength: 15 }),
        async (lines, cuts) => {
          const bytes = encoded(lines);
          const actual = await collect(source(bytes, cuts).body);
          expect(actual.map(materialize)).toEqual(
            lines.map((line) => JSON.parse(JSON.stringify(line))),
          );
          for (let n = 0; n < actual.length; n++) {
            const decoded = actual[n];
            if (decoded && !("omitted" in decoded)) {
              expect(decoded.encodedBytes).toBe(utf8.encode(JSON.stringify(lines[n])).length);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("handles every string escape, empty rows, surrogate pairs and lone surrogates", async () => {
    const lines = [
      "",
      '\b\t\n\f\r\u0000\u001f\\"/',
      "é中🙂",
      "\ud800",
      "\udfff",
      "a\ud800b\udfff",
    ].map((c, i) => ({ i, t: i === 0 ? null : -1234567890123, c }));
    expect((await collect(source(encoded(lines), [1]).body)).map(materialize)).toEqual(lines);
    const alternate = utf8.encode('{"i":0,"t":null,"c":"\\/\\u0041\\uD83D\\uDE42"}');
    expect((await collect(source(alternate, [1]).body)).map(materialize)).toEqual([
      { i: 0, t: null, c: "/A🙂" },
    ]);
  });

  it("reads a multi-megabyte escaped row without a whole-text conversion", async () => {
    const length = 4 * 1024 * 1024;
    const input = source(
      encoded([
        { i: 7, t: 123, c: "\u0001".repeat(length) },
        { i: 8, t: null, c: "last" },
      ]),
    );
    const reader = readLogLines(input.body);
    const fromCharCode = String.fromCharCode;
    const conversions: number[] = [];
    const conversion = vi.spyOn(String, "fromCharCode").mockImplementation((...units) => {
      if (units.length > 1) conversions.push(units.length);
      return fromCharCode(...units);
    });
    let first: ReadLogLine | undefined;
    try {
      first = (await reader.next()).value;
    } finally {
      conversion.mockRestore();
    }
    if (!first || "omitted" in first) throw new Error("expected a row");
    expect(first.c.length).toBe(length);
    expect(conversions).toHaveLength(length / LOG_READER_POLICY.segmentUnits);
    expect(Math.max(...conversions)).toBe(LOG_READER_POLICY.segmentUnits);
    expect(first.encodedBytes).toBe(length * 6 + utf8.encode('{"i":7,"t":123,"c":""}').length);
    expect(() => first.c.whole()).toThrow("small-row limit");
    expect(() => first.c.slice(0, 32769)).toThrow("slice limit");
    for (let offset = 0; offset < length; offset += 32768) {
      expect(first.c.slice(offset, Math.min(offset + 32768, length))).toBe(
        "\u0001".repeat(Math.min(32768, length - offset)),
      );
    }
    expect(materialize((await reader.next()).value as ReadLogLine)).toEqual({
      i: 8,
      t: null,
      c: "last",
    });
    expect((await reader.next()).done).toBe(true);
    expect(input.largestRead).toBe(32768);
    expect(input.body.locked).toBe(false);
  });

  it("joins whole text only through the encoded small-row boundary", async () => {
    const overhead = utf8.encode('{"i":0,"t":null,"c":""}').length;
    for (const delta of [0, 1]) {
      const text = "a".repeat(LOG_READER_POLICY.smallRowBytes - overhead + delta);
      const [line] = await collect(source(encoded([{ i: 0, t: null, c: text }])).body);
      if (!line || "omitted" in line) throw new Error("expected a row");
      expect(line.encodedBytes).toBe(LOG_READER_POLICY.smallRowBytes + delta);
      if (delta === 0) expect(line.c.whole()).toBe(text);
      else expect(() => line.c.whole()).toThrow("small-row limit");
    }
  });

  it("accepts the decoded-row limit and rejects the first excess unit", async () => {
    const text = "a".repeat(LOG_READER_POLICY.maxDecodedUnits);
    const [line] = await collect(source(encoded([{ i: 0, t: null, c: text }])).body);
    if (!line || "omitted" in line) throw new Error("expected a row");
    expect(line.c.length).toBe(LOG_READER_POLICY.maxDecodedUnits);
    expect(line.c.slice(line.c.length - 10, line.c.length)).toBe("a".repeat(10));
    const excessive = source(encoded([{ i: 0, t: null, c: `${text}a` }]));
    await expect(collect(excessive.body)).rejects.toThrow(/^invalid stored log$/);
    expect(excessive.cancelled).toBe(true);
    expect(excessive.body.locked).toBe(false);
  });

  it("reads multiple segmented rows without retaining the previous parser buffer", async () => {
    const lines = ["a", "b", "c"].map((text, i) => ({ i, t: null, c: text.repeat(65537) }));
    const actual = await collect(source(encoded(lines), [127, 32768, 31]).body);
    expect(actual.map(materialize)).toEqual(lines);
    for (const [i, line] of actual.entries()) {
      if ("omitted" in line) throw new Error("expected a row");
      expect(line.c.slice(32760, 32780)).toBe(lines[i]?.c.slice(32760, 32780));
    }
  });

  it("supports bounded BYOB on actual R2 bodies in workerd", async () => {
    const key = uniqueId("log-reader");
    const lines = [
      { i: 0, t: null, c: "🙂\u0001".repeat(40000) },
      { i: 1, omitted: LOG_ROW_TOO_LARGE, bytes: 99999999 },
    ] satisfies StoredLogLine[];
    await env.CI.put(key, encoded(lines));
    const object = await env.CI.get(key);
    if (!object) throw new Error("missing test object");
    const actual = await collect(object.body);
    expect(actual[0] && !("omitted" in actual[0]) ? actual[0].c.slice(32760, 32780) : null).toBe(
      lines[0]?.c?.slice(32760, 32780),
    );
    expect(actual[1]).toEqual(lines[1]);
    expect(object.body.locked).toBe(false);
  });

  it("refuses a source without bounded BYOB support", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoded([{ i: 0, t: null, c: "row" }]));
        controller.close();
      },
    });
    await expect(collect(body)).rejects.toThrow();
    expect(body.locked).toBe(false);
  });

  it("cancels and releases an unfinished stream when the consumer stops", async () => {
    const input = source(
      encoded([
        { i: 0, t: null, c: "first" },
        { i: 1, t: null, c: "second" },
      ]),
    );
    for await (const _line of readLogLines(input.body)) break;
    expect(input.cancelled).toBe(true);
    expect(input.body.locked).toBe(false);
  });

  it.each([
    '{"i":-1,"t":null,"c":"secret"}',
    '{"i":9007199254740992,"t":null,"c":"secret"}',
    '{"i":0,"t":"secret","c":"secret"}',
    '{"i":0,"t":1e999,"c":"secret"}',
    '{"i":0,"omitted":"row_too_large","bytes":0}',
    '{"i":0,"t":null,"c":"secret\\x20"}',
    '{"i":0,"t":null,"c":"secret\\u00zz"}',
    '{"i":0,"t":null,"c":"secret\n"}',
    '{"i":0,"t":null,"c":"secret"}garbage',
    '{"i":0,"t":null,"c":"secret',
    '{"i":0,"omitted":"secret","bytes":10}',
    '{"i":0,"omitted":"row_too_large","bytes":-1}',
  ])("rejects corrupt records without disclosing their content: case %#", async (text) => {
    const input = source(utf8.encode(text), [1]);
    await expect(collect(input.body)).rejects.toThrow(/^invalid stored log$/);
    expect(input.body.locked).toBe(false);
  });

  it.each([[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2]])(
    "rejects invalid UTF-8: case %#",
    async (...invalid) => {
      const prefix = utf8.encode('{"i":0,"t":null,"c":"');
      const suffix = utf8.encode('"}');
      const bytes = new Uint8Array(prefix.length + invalid.length + suffix.length);
      bytes.set(prefix);
      bytes.set(invalid, prefix.length);
      bytes.set(suffix, prefix.length + invalid.length);
      await expect(collect(source(bytes, [1]).body)).rejects.toThrow(/^invalid stored log$/);
    },
  );
});
