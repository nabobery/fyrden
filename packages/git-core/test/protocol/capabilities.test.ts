import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { oidFromHex, zeroOid } from "../../src/object/oid.js";
import {
  type Capability,
  encodeCapabilityList,
  encodeRefAdvertisement,
  encodeV2CapabilityAdvertisement,
  findCapability,
  parseCapabilityList,
  readRefAdvertisement,
  readV2CapabilityAdvertisement,
} from "../../src/protocol/capabilities.js";
import { PktLineReader } from "../../src/protocol/pktline.js";
import { bin, expectCode, pkt, str } from "./helpers.js";

const OID = oidFromHex("cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a");
const RECEIVE_CAPS =
  "report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=git/2.53.0-Darwin";

describe("v0/v1 capability lists", () => {
  it("parses a space-separated list with optional values", () => {
    expect(
      parseCapabilityList(
        bin(" report-status-v2 side-band-64k object-format=sha1 agent=git/2.53.0-Darwin"),
      ),
    ).toEqual([
      { name: "report-status-v2" },
      { name: "side-band-64k" },
      { name: "object-format", value: "sha1" },
      { name: "agent", value: "git/2.53.0-Darwin" },
    ]);
  });

  it("splits a value at the first '=' only and allows an empty value", () => {
    expect(parseCapabilityList(bin("symref=HEAD:refs/heads/a=b x="))).toEqual([
      { name: "symref", value: "HEAD:refs/heads/a=b" },
      { name: "x", value: "" },
    ]);
  });

  it("ignores repeated spaces and an empty list", () => {
    expect(parseCapabilityList(bin("  quiet  atomic "))).toEqual([
      { name: "quiet" },
      { name: "atomic" },
    ]);
    expect(parseCapabilityList(new Uint8Array())).toEqual([]);
  });

  it.each([
    ["a control character", "quiet\tatomic"],
    ["a byte above 0x7e", "agent=caf\xe9"],
    ["a NUL", "quiet\0"],
    ["a newline", "quiet\natomic"],
    ["an empty name", "=sha1"],
  ])("rejects %s", async (_name, list) => {
    await expectCode(() => parseCapabilityList(bin(list)), "bad-capability");
  });

  it("finds a capability by name", () => {
    const caps = parseCapabilityList(bin(RECEIVE_CAPS));
    expect(findCapability(caps, "object-format")).toEqual({ name: "object-format", value: "sha1" });
    expect(findCapability(caps, "push-cert")).toBeUndefined();
  });

  it("round-trips through encodeCapabilityList", () => {
    const tokenArb = fc.stringMatching(/^[!-<>-~]{1,10}$/);
    const capArb: fc.Arbitrary<Capability> = fc.oneof(
      tokenArb.map((name) => ({ name })),
      fc
        .tuple(tokenArb, fc.stringMatching(/^[!-~]{0,10}$/))
        .map(([name, value]) => ({ name, value })),
    );
    fc.assert(
      fc.property(fc.array(capArb, { maxLength: 10 }), (caps) => {
        expect(parseCapabilityList(bin(encodeCapabilityList(caps)))).toEqual(caps);
      }),
    );
  });

  it("refuses to encode a capability that cannot be parsed back", () => {
    expect(() => encodeCapabilityList([{ name: "a b" }])).toThrow(RangeError);
    expect(() => encodeCapabilityList([{ name: "a=b" }])).toThrow(RangeError);
    expect(() => encodeCapabilityList([{ name: "a", value: "x y" }])).toThrow(RangeError);
    expect(() => encodeCapabilityList([{ name: "" }])).toThrow(RangeError);
  });
});

describe("receive-pack ref advertisement", () => {
  const caps = parseCapabilityList(bin(RECEIVE_CAPS));

  it("writes git receive-pack's advertisement byte for byte", () => {
    const bytes = encodeRefAdvertisement({
      refs: [{ name: bin("refs/heads/main"), oid: OID }],
      capabilities: caps,
    });
    expect(str(bytes)).toBe(
      `00c5cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a refs/heads/main\0${RECEIVE_CAPS}\n0000`,
    );
  });

  it("writes the version 1 line when asked", () => {
    const bytes = encodeRefAdvertisement({
      refs: [],
      capabilities: [{ name: "quiet" }],
      version: 1,
    });
    expect(str(bytes)).toBe(
      `000eversion 1\n${pkt(`${"0".repeat(40)} capabilities^{}\0quiet\n`)}0000`,
    );
  });

  it("advertises capabilities on a capabilities^{} line when there are no refs", () => {
    const bytes = encodeRefAdvertisement({ refs: [], capabilities: [{ name: "quiet" }] });
    expect(str(bytes)).toBe(`${pkt(`${"0".repeat(40)} capabilities^{}\0quiet\n`)}0000`);
  });

  it("reads an advertisement back, with version, refs and capabilities", async () => {
    const refs = [
      { name: bin("refs/heads/main"), oid: OID },
      { name: bin("refs/tags/v\xff"), oid: OID },
      { name: bin(".have"), oid: OID },
    ];
    for (const version of [0, 1] as const) {
      const bytes = encodeRefAdvertisement({ refs, capabilities: caps, version });
      const parsed = await readRefAdvertisement(new PktLineReader(bytes));
      expect(parsed).toEqual({ version, refs, capabilities: caps });
    }
  });

  it("reads an empty repository's advertisement as no refs", async () => {
    const bytes = encodeRefAdvertisement({ refs: [], capabilities: caps });
    expect(await readRefAdvertisement(new PktLineReader(bytes))).toEqual({
      version: 0,
      refs: [],
      capabilities: caps,
    });
  });

  it.each([
    ["no NUL on the first line", `${pkt(`${OID_HEX()} refs/heads/main\n`)}0000`],
    ["a bad object id", `${pkt(`${"g".repeat(40)} refs/heads/main\0quiet\n`)}0000`],
    ["no space after the id", `${pkt(`${OID_HEX()}-refs/heads/main\0quiet\n`)}0000`],
    ["an empty ref name", `${pkt(`${OID_HEX()} \0quiet\n`)}0000`],
    [
      "a NUL on a later line",
      `${pkt(`${OID_HEX()} refs/heads/main\0quiet\n`)}${pkt(`${OID_HEX()} refs/heads/next\0quiet\n`)}0000`,
    ],
  ])("rejects %s", async (_name, input) => {
    await expectCode(() => readRefAdvertisement(new PktLineReader(bin(input))), "malformed-line");
  });

  it("rejects an advertisement without its flush", async () => {
    const bytes = encodeRefAdvertisement({ refs: [], capabilities: caps }).subarray(0, -4);
    await expectCode(() => readRefAdvertisement(new PktLineReader(bytes)), "truncated");
  });

  it("refuses to encode a ref name with a NUL or LF, or an empty one", () => {
    for (const name of ["a\0b", "a\nb", ""]) {
      expect(() =>
        encodeRefAdvertisement({ refs: [{ name: bin(name), oid: zeroOid() }], capabilities: [] }),
      ).toThrow(RangeError);
    }
  });
});

function OID_HEX(): string {
  return "cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a";
}

describe("protocol v2 capability advertisement", () => {
  const caps: Capability[] = [
    { name: "agent", value: "git/2.53.0-Darwin" },
    { name: "ls-refs", value: "unborn" },
    { name: "fetch", value: "shallow wait-for-done" },
    { name: "server-option" },
    { name: "object-format", value: "sha1" },
  ];
  const GIT_BYTES =
    "000eversion 2\n001cagent=git/2.53.0-Darwin\n0013ls-refs=unborn\n0020fetch=shallow wait-for-done\n0012server-option\n0017object-format=sha1\n0000";

  it("writes git upload-pack's advertisement byte for byte", () => {
    expect(str(encodeV2CapabilityAdvertisement(caps))).toBe(GIT_BYTES);
  });

  it("reads it back", async () => {
    expect(await readV2CapabilityAdvertisement(new PktLineReader(bin(GIT_BYTES)))).toEqual(caps);
  });

  it("reads lines without their LF", async () => {
    const bytes = bin("000dversion 20009quiet0000");
    expect(await readV2CapabilityAdvertisement(new PktLineReader(bytes))).toEqual([
      { name: "quiet" },
    ]);
  });

  it.each([
    ["a missing version line", "0009quiet0000", "malformed-line"],
    ["version 1", "000eversion 1\n0000", "malformed-line"],
    ["a key with a space", `000eversion 2\n${pkt("a b\n")}0000`, "bad-capability"],
    ["an empty key", `000eversion 2\n${pkt("=x")}0000`, "bad-capability"],
    ["a NUL in a value", `000eversion 2\n${pkt("a=\0x")}0000`, "bad-capability"],
    ["a value that is not UTF-8", `000eversion 2\n${pkt("a=\xff")}0000`, "bad-capability"],
    ["a delim packet", "000eversion 2\n0001", "unexpected-packet"],
    ["no flush", "000eversion 2\n0009quiet", "truncated"],
  ] as const)("rejects %s", async (_name, input, code) => {
    await expectCode(() => readV2CapabilityAdvertisement(new PktLineReader(bin(input))), code);
  });

  it("refuses to encode an invalid key or value", () => {
    expect(() => encodeV2CapabilityAdvertisement([{ name: "a b" }])).toThrow(RangeError);
    expect(() => encodeV2CapabilityAdvertisement([{ name: "a", value: "x\ny" }])).toThrow(
      RangeError,
    );
  });
});
