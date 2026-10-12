import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  chompLf,
  delimPkt,
  encodePktLine,
  flushPkt,
  MAX_PKT_DATA_LENGTH,
  MAX_PKT_LINE_LENGTH,
  type PktLine,
  PktLineReader,
  PktLineStreamReader,
  PktLineWriter,
  responseEndPkt,
} from "../../src/protocol/pktline.js";
import { bin, chunked, collect, concat, expectCode, str } from "./helpers.js";

function readAll(bytes: Uint8Array): PktLine[] {
  const reader = new PktLineReader(bytes);
  const out: PktLine[] = [];
  for (let pkt = reader.read(); pkt; pkt = reader.read()) out.push(pkt);
  return out;
}

async function readAllStream(source: AsyncIterable<Uint8Array>): Promise<PktLine[]> {
  const reader = new PktLineStreamReader(source);
  const out: PktLine[] = [];
  for (let pkt = await reader.read(); pkt; pkt = await reader.read()) out.push(pkt);
  return out;
}

/** Comparable form: data as a latin1 string. */
const view = (pkts: PktLine[]) => pkts.map((p) => (p.kind === "data" ? str(p.data) : p.kind));

describe("pkt-line encoding", () => {
  it("writes the examples from gitprotocol-common", () => {
    expect(str(encodePktLine(bin("a\n")))).toBe("0006a\n");
    expect(str(encodePktLine(bin("a")))).toBe("0005a");
    expect(str(encodePktLine("foobar\n"))).toBe("000bfoobar\n");
    expect(str(encodePktLine(new Uint8Array()))).toBe("0004");
  });

  it("writes special packets", () => {
    expect(str(flushPkt())).toBe("0000");
    expect(str(delimPkt())).toBe("0001");
    expect(str(responseEndPkt())).toBe("0002");
  });

  it("writes lowercase hex lengths, as git's set_packet_header does", () => {
    expect(str(encodePktLine(new Uint8Array(0xab - 4))).slice(0, 4)).toBe("00ab");
  });

  it("encodes strings as UTF-8", () => {
    expect(Array.from(encodePktLine("é"))).toEqual([0x30, 0x30, 0x30, 0x36, 0xc3, 0xa9]);
  });

  it("accepts the largest payload (65516 bytes, 65520 in total) and refuses one more", () => {
    expect(encodePktLine(new Uint8Array(MAX_PKT_DATA_LENGTH))).toHaveLength(MAX_PKT_LINE_LENGTH);
    expect(str(encodePktLine(new Uint8Array(MAX_PKT_DATA_LENGTH)).subarray(0, 4))).toBe("fff0");
    expect(() => encodePktLine(new Uint8Array(MAX_PKT_DATA_LENGTH + 1))).toThrow(RangeError);
  });

  it("builds a message with PktLineWriter", () => {
    const w = new PktLineWriter();
    w.text("command=ls-refs").delim().data(bin("peel")).flush().responseEnd();
    expect(str(w.bytes())).toBe("0014command=ls-refs\n00010008peel00000002");
  });
});

describe("PktLineReader", () => {
  it("reads the examples from gitprotocol-common and the special packets", () => {
    expect(view(readAll(bin("0006a\n0005a000bfoobar\n0004000000010002")))).toEqual([
      "a\n",
      "a",
      "foobar\n",
      "",
      "flush",
      "delim",
      "response-end",
    ]);
  });

  it("returns undefined at the end of input on a packet boundary", () => {
    const reader = new PktLineReader(bin("0000"));
    expect(reader.read()).toEqual({ kind: "flush" });
    expect(reader.read()).toBeUndefined();
    expect(reader.read()).toBeUndefined();
  });

  it("accepts upper- and lowercase hex lengths, as git's hexval does", () => {
    expect(view(readAll(bin(`000A${"x".repeat(6)}000a${"y".repeat(6)}`)))).toEqual([
      "xxxxxx",
      "yyyyyy",
    ]);
  });

  it("is 8-bit clean", () => {
    const payload = Uint8Array.from({ length: 256 }, (_, i) => i);
    const [pkt] = readAll(encodePktLine(payload));
    expect(pkt).toEqual({ kind: "data", data: payload });
  });

  it.each([
    ["non-hex digit", "00g4abcd"],
    ["sign", "-004"],
    ["space", " 004"],
    ["0x prefix", "0x05a"],
  ])("rejects a length with a %s", async (_name, input) => {
    await expectCode(() => readAll(bin(input)), "invalid-length");
  });

  it("rejects 0003, the only length below 4 with no meaning", async () => {
    await expectCode(() => readAll(bin("0003")), "invalid-length");
  });

  it("rejects lines longer than 65520 bytes", async () => {
    const line = concat(bin("fff1"), new Uint8Array(65517));
    await expectCode(() => readAll(line), "line-too-long");
    await expectCode(() => readAll(bin("ffff")), "line-too-long");
  });

  it("accepts a line of exactly 65520 bytes", () => {
    const [pkt] = readAll(concat(bin("fff0"), new Uint8Array(65516)));
    expect(pkt?.kind === "data" && pkt.data.length).toBe(65516);
  });

  it.each([
    ["inside the length", "00"],
    ["inside the payload", "0009abc"],
    ["after a complete packet, inside the next length", "0005a000"],
  ])("rejects input truncated %s", async (_name, input) => {
    await expectCode(() => readAll(bin(input)), "truncated");
  });

  it("stops after maxLines packets", async () => {
    const reader = new PktLineReader(bin("000000000000"), { maxLines: 2 });
    reader.read();
    reader.read();
    await expectCode(() => reader.read(), "too-many-lines");
  });

  it("stops before reading past maxBytes", async () => {
    const reader = new PktLineReader(bin("0006a\n0006b\n"), { maxBytes: 8 });
    expect(reader.read()).toEqual({ kind: "data", data: bin("a\n") });
    await expectCode(() => reader.read(), "too-many-bytes");
  });

  it("keeps failing after an error instead of reading on", async () => {
    const reader = new PktLineReader(bin("00g00000"));
    await expectCode(() => reader.read(), "invalid-length");
    await expectCode(() => reader.read(), "invalid-length");
  });

  it("returns the unread bytes after the last packet, such as a pack after a flush", () => {
    const reader = new PktLineReader(bin("0005a0000PACK\0\0\0\x02"));
    reader.read();
    reader.read();
    expect(str(reader.rest())).toBe("PACK\0\0\0\x02");
    expect(reader.offset).toBe(9);
  });
});

describe("PktLineStreamReader", () => {
  it("reads packets split across chunks at every possible point", async () => {
    const bytes = bin("0006a\n0005a000bfoobar\n0004000000010002");
    const expected = view(readAll(bytes));
    for (let cut = 0; cut <= bytes.length; cut++) {
      expect(view(await readAllStream(chunked(bytes, [cut, cut + 3])))).toEqual(expected);
    }
  });

  it("reports truncation, invalid lengths and limits like the buffer reader", async () => {
    await expectCode(() => readAllStream(chunked(bin("0009ab"), [2])), "truncated");
    await expectCode(() => readAllStream(chunked(bin("0003"), [1])), "invalid-length");
    await expectCode(
      () => readAllStream(chunked(concat(bin("fff1"), new Uint8Array(65517)))),
      "line-too-long",
    );
    const reader = new PktLineStreamReader(chunked(bin("0006a\n0006b\n")), { maxBytes: 8 });
    await reader.read();
    await expectCode(() => reader.read(), "too-many-bytes");
    const lines = new PktLineStreamReader(chunked(bin("00000000")), { maxLines: 1 });
    await lines.read();
    await expectCode(() => lines.read(), "too-many-lines");
  });

  it("hands over the rest of the stream after the last packet, unchanged", async () => {
    const pack = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 0xff);
    const body = concat(bin("0005a0000"), pack);
    const reader = new PktLineStreamReader(chunked(body, [3, 7, 11, 5000, 70_000]));
    expect(await reader.read()).toEqual({ kind: "data", data: bin("a") });
    expect(await reader.read()).toEqual({ kind: "flush" });
    expect(await collect(reader.rest())).toEqual(pack);
    expect(reader.bytesRead).toBe(9);
  });

  it("refuses to read packets once the rest has been handed over, or to hand it over twice", async () => {
    const reader = new PktLineStreamReader(chunked(bin("0000")));
    reader.rest();
    await expect(reader.read()).rejects.toThrow(/rest/);
    expect(() => reader.rest()).toThrow(/rest/);
  });

  it("releases the source when the consumer of the rest stops early", async () => {
    let returned = false;
    async function* source() {
      try {
        yield bin("0000PACK");
        yield bin("more");
        yield bin("never read");
      } finally {
        returned = true;
      }
    }
    const reader = new PktLineStreamReader(source());
    await reader.read();
    for await (const chunk of reader.rest()) {
      if (str(chunk) === "more") break;
    }
    expect(returned).toBe(true);
  });

  it("releases the source when it fails", async () => {
    let returned = false;
    async function* source() {
      try {
        yield bin("00");
        yield bin("zz");
        yield bin("never read");
      } finally {
        returned = true;
      }
    }
    await expectCode(() => readAllStream(source()), "invalid-length");
    expect(returned).toBe(true);
  });

  it("passes on errors from the source itself", async () => {
    async function* source(): AsyncGenerator<Uint8Array> {
      yield bin("0005a");
      throw new Error("connection reset");
    }
    const reader = new PktLineStreamReader(source());
    await reader.read();
    await expect(reader.read()).rejects.toThrow("connection reset");
  });

  it("skips empty chunks", async () => {
    async function* source() {
      yield new Uint8Array();
      yield bin("00");
      yield new Uint8Array();
      yield bin("05a");
    }
    expect(view(await readAllStream(source()))).toEqual(["a"]);
  });
});

describe("chompLf", () => {
  it("removes one trailing LF, as git's PACKET_READ_CHOMP_NEWLINE does", () => {
    expect(str(chompLf(bin("a\n")))).toBe("a");
    expect(str(chompLf(bin("a\n\n")))).toBe("a\n");
    expect(str(chompLf(bin("a")))).toBe("a");
    expect(str(chompLf(bin("")))).toBe("");
  });
});

const pktArb: fc.Arbitrary<PktLine> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.uint8Array({ maxLength: 300 }).map((data) => ({ kind: "data", data }) as const),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom<PktLine>(
      { kind: "flush" },
      { kind: "delim" },
      { kind: "response-end" },
    ),
  },
);

function encodeAll(pkts: readonly PktLine[]): Uint8Array {
  const w = new PktLineWriter();
  for (const p of pkts) w.packet(p);
  return w.bytes();
}

describe("pkt-line properties", () => {
  it("decoding an encoded sequence returns it, from a buffer", () => {
    fc.assert(
      fc.property(fc.array(pktArb, { maxLength: 40 }), (pkts) => {
        expect(readAll(encodeAll(pkts))).toEqual(pkts);
      }),
    );
  });

  it("decoding an encoded sequence returns it, from any chunking of a stream", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(pktArb, { maxLength: 20 }),
        fc.array(fc.nat(), { maxLength: 8 }),
        async (pkts, cuts) => {
          const bytes = encodeAll(pkts);
          const at = cuts.map((c) => c % (bytes.length + 1));
          expect(await readAllStream(chunked(bytes, at))).toEqual(pkts);
        },
      ),
    );
  });

  it("re-encoding decoded bytes reproduces them, byte for byte, when lengths are lowercase", () => {
    fc.assert(
      fc.property(fc.array(pktArb, { maxLength: 40 }), (pkts) => {
        const bytes = encodeAll(pkts);
        expect(encodeAll(readAll(bytes))).toEqual(bytes);
      }),
    );
  });
});
