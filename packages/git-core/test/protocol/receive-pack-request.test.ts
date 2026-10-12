import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { oidFromHex, zeroOid } from "../../src/object/oid.js";
import { PktLineReader, PktLineStreamReader } from "../../src/protocol/pktline.js";
import {
  encodeReceivePackRequest,
  type ReceivePackRequest,
  type ReceivePackRequestOptions,
  readReceivePackRequest,
} from "../../src/protocol/receive-pack-request.js";
import { oidArb } from "../object/arbitraries.js";
import { bin, chunked, collect, concat, expectCode, pkt, str } from "./helpers.js";

const ZERO = "0".repeat(40);
const A = "a776c30ab4d5ecc43f0fd7746c73095827c929d6";
const B = "cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a";
const CAPS =
  " report-status-v2 side-band-64k quiet push-options object-format=sha1 agent=git/2.53.0-Darwin";
const PACK = "PACK\0\0\0\x02\0\0\0\0";
const OPTS: ReceivePackRequestOptions = { pushOptionsAdvertised: true };

/** What git 2.53 sends for `git push -o "opt one" -o x origin main` to an empty repository. */
const GIT_PUSH = `${pkt(`${ZERO} ${A} refs/heads/main\0${CAPS}`)}0000${pkt("opt one")}${pkt("x")}0000${PACK}`;

const read = (input: string, options: ReceivePackRequestOptions = OPTS) =>
  readReceivePackRequest(new PktLineReader(bin(input)), options);

describe("readReceivePackRequest", () => {
  it("reads git's push: commands, capabilities and push options; the pack is left unread", async () => {
    const reader = new PktLineReader(bin(GIT_PUSH));
    const request = await readReceivePackRequest(reader, OPTS);
    expect(request.commands).toEqual([
      { oldOid: zeroOid(), newOid: oidFromHex(A), refName: bin("refs/heads/main") },
    ]);
    expect(request.capabilities.map((c) => c.name)).toEqual([
      "report-status-v2",
      "side-band-64k",
      "quiet",
      "push-options",
      "object-format",
      "agent",
    ]);
    expect(request.pushOptions?.map(str)).toEqual(["opt one", "x"]);
    expect(request.shallow).toEqual([]);
    expect(str(reader.rest())).toBe(PACK);
  });

  it("reads the same request from a chunked stream and hands over the pack", async () => {
    const body = bin(GIT_PUSH);
    for (const cut of [1, 50, 150, body.length - PACK.length - 2]) {
      const reader = new PktLineStreamReader(chunked(body, [cut]));
      const request = await readReceivePackRequest(reader, OPTS);
      expect(request.pushOptions?.map(str)).toEqual(["opt one", "x"]);
      expect(str(await collect(reader.rest()))).toBe(PACK);
    }
  });

  it("reads several commands; only the first carries capabilities", async () => {
    const input = `${pkt(`${A} ${B} refs/heads/main\0 atomic`)}${pkt(`${B} ${ZERO} refs/heads/old\n`)}${pkt(`${ZERO} ${B} refs/tags/v\xff`)}0000`;
    const request = await read(input);
    expect(request.commands.map((c) => str(c.refName))).toEqual([
      "refs/heads/main",
      "refs/heads/old",
      "refs/tags/v\xff",
    ]);
    expect(request.commands[1]?.newOid).toEqual(zeroOid());
    expect(request.capabilities).toEqual([{ name: "atomic" }]);
    expect(request.pushOptions).toBeUndefined();
  });

  it("keeps ref names as bytes, unvalidated", async () => {
    const request = await read(`${pkt(`${ZERO} ${A} refs/heads/a b..c\x80\0`)}0000`);
    expect(request.commands[0]?.refName).toEqual(bin("refs/heads/a b..c\x80"));
  });

  it("accepts upper-case object ids, as git's parse_oid_hex does", async () => {
    const request = await read(`${pkt(`${ZERO} ${A.toUpperCase()} refs/heads/main\0`)}0000`);
    expect(request.commands[0]?.newOid).toEqual(oidFromHex(A));
  });

  it("reads shallow lines sent before the commands by a shallow clone", async () => {
    const request = await read(
      `${pkt(`shallow ${B}\n`)}${pkt(`shallow ${A}`)}${pkt(`${ZERO} ${A} refs/heads/main\0 quiet`)}0000`,
    );
    expect(request.shallow).toEqual([oidFromHex(B), oidFromHex(A)]);
    expect(request.commands).toHaveLength(1);
  });

  it("reads an empty request (only a flush) as no commands", async () => {
    expect(await read("0000")).toEqual({
      shallow: [],
      commands: [],
      capabilities: [],
      pushOptions: undefined,
    });
  });

  it("does not read push options the server did not advertise", async () => {
    const reader = new PktLineReader(bin(GIT_PUSH));
    const request = await readReceivePackRequest(reader, { pushOptionsAdvertised: false });
    expect(request.pushOptions).toBeUndefined();
    expect(str(reader.rest()).startsWith(pkt("opt one"))).toBe(true);
  });

  it("reads push options only when the client asked for them", async () => {
    const reader = new PktLineReader(
      bin(`${pkt(`${ZERO} ${A} refs/heads/main\0 quiet`)}0000${PACK}`),
    );
    expect((await readReceivePackRequest(reader, OPTS)).pushOptions).toBeUndefined();
    expect(str(reader.rest())).toBe(PACK);
  });

  it.each([
    ["a short old id", `${pkt(`${ZERO.slice(1)} ${A} refs/heads/main\0`)}0000`],
    ["a non-hex new id", `${pkt(`${ZERO} ${"z".repeat(40)} refs/heads/main\0`)}0000`],
    ["a missing space", `${pkt(`${ZERO}${A} refs/heads/main\0`)}0000`],
    ["a missing ref name", `${pkt(`${ZERO} ${A}`)}0000`],
    ["an empty ref name", `${pkt(`${ZERO} ${A} \0 quiet`)}0000`],
    [
      "a NUL on a later command",
      `${pkt(`${ZERO} ${A} refs/heads/a\0`)}${pkt(`${ZERO} ${A} refs/heads/b\0 quiet`)}0000`,
    ],
    ["a bad shallow id", `${pkt(`shallow ${A.slice(2)}`)}0000`],
    [
      "a shallow line after a command",
      `${pkt(`${ZERO} ${A} refs/heads/a\0`)}${pkt(`shallow ${A}`)}0000`,
    ],
    ["garbage", `${pkt("hello")}0000`],
  ])("rejects %s", async (_name, input) => {
    await expectCode(() => read(input), "malformed-line");
  });

  it("rejects bad capability lists", async () => {
    await expectCode(
      () => read(`${pkt(`${ZERO} ${A} refs/heads/a\0 quiet\x01`)}0000`),
      "bad-capability",
    );
  });

  it("rejects another object format than SHA-1", async () => {
    await expectCode(
      () => read(`${pkt(`${ZERO} ${A} refs/heads/a\0 object-format=sha256`)}0000`),
      "object-format-mismatch",
    );
  });

  it("rejects push certificates, which are not advertised", async () => {
    await expectCode(
      () => read(`${pkt("push-cert\0 quiet\n")}${pkt("certificate version 0.1\n")}0000`),
      "unsupported",
    );
  });

  it.each([
    ["the commands", `${pkt(`${ZERO} ${A} refs/heads/a\0 quiet`)}`],
    ["the push options", `${pkt(`${ZERO} ${A} refs/heads/a\0 push-options`)}0000${pkt("opt")}`],
    ["a line", `${pkt(`${ZERO} ${A} refs/heads/a\0 quiet`).slice(0, 30)}`],
  ])("rejects a request truncated in %s", async (_name, input) => {
    await expectCode(() => read(input), "truncated");
  });

  it("rejects delim and response-end packets", async () => {
    await expectCode(() => read(`${pkt(`${ZERO} ${A} refs/heads/a\0`)}0001`), "unexpected-packet");
    await expectCode(
      () => read(`${pkt(`${ZERO} ${A} refs/heads/a\0 push-options`)}00000002`),
      "unexpected-packet",
    );
  });

  it("enforces the command, shallow and push-option limits", async () => {
    const cmd = (i: number) =>
      pkt(`${ZERO} ${A} refs/heads/b${i}${i === 0 ? "\0 push-options" : ""}`);
    const three = `${cmd(0)}${cmd(1)}${cmd(2)}00000000`;
    await expectCode(() => read(three, { ...OPTS, maxCommands: 2 }), "too-many-commands");
    expect((await read(three, { ...OPTS, maxCommands: 3 })).commands).toHaveLength(3);
    const shallow = `${pkt(`shallow ${A}`)}${pkt(`shallow ${B}`)}0000`;
    await expectCode(() => read(shallow, { ...OPTS, maxShallow: 1 }), "too-many-shallows");
    const options = `${cmd(0)}0000${pkt("a")}${pkt("b")}0000`;
    await expectCode(() => read(options, { ...OPTS, maxPushOptions: 1 }), "too-many-push-options");
  });
});

describe("encodeReceivePackRequest", () => {
  it("writes what git writes, byte for byte", async () => {
    const reader = new PktLineReader(bin(GIT_PUSH));
    const request = await readReceivePackRequest(reader, OPTS);
    expect(str(encodeReceivePackRequest(request))).toBe(GIT_PUSH.slice(0, -PACK.length));
  });

  it("refuses requests that cannot be read back", () => {
    const cmd = { oldOid: zeroOid(), newOid: zeroOid(), refName: bin("refs/heads/a") };
    const base: ReceivePackRequest = {
      shallow: [],
      commands: [cmd],
      capabilities: [],
      pushOptions: undefined,
    };
    expect(() =>
      encodeReceivePackRequest({ ...base, commands: [{ ...cmd, refName: bin("a\0b") }] }),
    ).toThrow(RangeError);
    expect(() =>
      encodeReceivePackRequest({ ...base, commands: [{ ...cmd, refName: bin("") }] }),
    ).toThrow(RangeError);
    expect(() => encodeReceivePackRequest({ ...base, pushOptions: [bin("a\nb")] })).toThrow(
      RangeError,
    );
    expect(() =>
      encodeReceivePackRequest({ ...base, commands: [], pushOptions: [bin("a")] }),
    ).toThrow(RangeError);
  });

  it("round-trips any request", async () => {
    const refName = fc
      .uint8Array({ minLength: 1, maxLength: 30 })
      .filter((b) => !b.includes(0) && !b.includes(0x0a));
    const command = fc.record({ oldOid: oidArb, newOid: oidArb, refName });
    const option = fc
      .uint8Array({ maxLength: 20 })
      .filter((b) => !b.includes(0) && !b.includes(0x0a));
    const requestArb = fc
      .record({
        shallow: fc.array(oidArb, { maxLength: 3 }),
        commands: fc.array(command, { minLength: 1, maxLength: 5 }),
        quiet: fc.boolean(),
        pushOptions: fc.option(fc.array(option, { maxLength: 4 }), { nil: undefined }),
      })
      .map(
        ({ quiet, ...r }): ReceivePackRequest => ({
          ...r,
          capabilities: [
            ...(quiet ? [{ name: "quiet" }] : []),
            ...(r.pushOptions ? [{ name: "push-options" }] : []),
            { name: "agent", value: "fyrden/test" },
          ],
        }),
      );
    await fc.assert(
      fc.asyncProperty(requestArb, async (request) => {
        const bytes = concat(encodeReceivePackRequest(request), bin(PACK));
        const reader = new PktLineReader(bytes);
        expect(await readReceivePackRequest(reader, OPTS)).toEqual(request);
        expect(str(reader.rest())).toBe(PACK);
      }),
    );
  });
});
