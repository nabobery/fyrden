import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { oidFromHex } from "../../src/object/oid.js";
import type { Capability } from "../../src/protocol/capabilities.js";
import { PktLineReader } from "../../src/protocol/pktline.js";
import {
  encodeV2CommandRequest,
  parseFetchArgs,
  parseLsRefsArgs,
  readV2CommandRequest,
  type V2Advertised,
  type V2CommandRequest,
} from "../../src/protocol/v2-command.js";
import { oidArb } from "../object/arbitraries.js";
import { bin, expectCode, pkt, str } from "./helpers.js";

const A = "a776c30ab4d5ecc43f0fd7746c73095827c929d6";
const B = "cc1cd4c840ceffbb546d10d2db8a47b5c76d6e5a";
const ADVERTISED: V2Advertised = {
  commands: ["ls-refs", "fetch"],
  capabilities: ["agent", "server-option", "object-format"],
};
const CLIENT_CAPS = `${pkt("agent=git/2.53.0-Darwin")}${pkt("object-format=sha1")}`;

/** git 2.53's `git clone --depth 1` requests, as captured from its upload-pack stdin. */
const GIT_LS_REFS = `${pkt("command=ls-refs\n")}${CLIENT_CAPS}0001${pkt("peel\n")}${pkt("symrefs\n")}${pkt("unborn\n")}${pkt("ref-prefix refs/heads/\n")}${pkt("ref-prefix refs/tags/\n")}${pkt("ref-prefix HEAD\n")}0000`;
const GIT_FETCH = `${pkt("command=fetch")}${CLIENT_CAPS}0001${pkt("thin-pack\n")}${pkt("no-progress\n")}${pkt("include-tag\n")}${pkt("ofs-delta\n")}${pkt("deepen 1\n")}${pkt(`want ${A}\n`)}${pkt(`want ${A}\n`)}${pkt("done\n")}0000`;

const read = (input: string, advertised = ADVERTISED) =>
  readV2CommandRequest(new PktLineReader(bin(input)), advertised);

describe("readV2CommandRequest", () => {
  it("reads git's ls-refs request", async () => {
    const request = await read(GIT_LS_REFS);
    expect(request?.command).toBe("ls-refs");
    expect(request?.capabilities).toEqual([
      { name: "agent", value: "git/2.53.0-Darwin" },
      { name: "object-format", value: "sha1" },
    ]);
    expect(request?.args.map(str)).toEqual([
      "peel",
      "symrefs",
      "unborn",
      "ref-prefix refs/heads/",
      "ref-prefix refs/tags/",
      "ref-prefix HEAD",
    ]);
  });

  it("reads git's fetch request, whose command line has no LF", async () => {
    const request = await read(GIT_FETCH);
    expect(request?.command).toBe("fetch");
    expect(request?.args).toHaveLength(8);
  });

  it("reads several requests from one connection, one at a time", async () => {
    const reader = new PktLineReader(bin(`${GIT_LS_REFS}${GIT_FETCH}0000`));
    expect((await readV2CommandRequest(reader, ADVERTISED))?.command).toBe("ls-refs");
    expect((await readV2CommandRequest(reader, ADVERTISED))?.command).toBe("fetch");
    expect(await readV2CommandRequest(reader, ADVERTISED)).toBeUndefined();
  });

  it("reads a command without arguments, ended by a flush instead of a delim", async () => {
    expect(await read(`${pkt("command=ls-refs\n")}0000`)).toEqual({
      command: "ls-refs",
      capabilities: [],
      args: [],
    });
  });

  it("accepts the command line after capability lines", async () => {
    expect(
      (await read(`${pkt("agent=x")}${pkt("command=fetch\n")}0001${pkt("done")}0000`))?.command,
    ).toBe("fetch");
  });

  it("treats a flush or the end of input before any line as the end of the session", async () => {
    expect(await read("0000")).toBeUndefined();
    expect(await read("")).toBeUndefined();
  });

  // t5704-protocol-violations: "extra delim packet in v2 ls-refs args" and "... fetch args".
  it.each(["ls-refs", "fetch"])(
    "rejects an extra delim packet in %s arguments",
    async (command) => {
      await expectCode(
        () => read(`${pkt(`command=${command}`)}${pkt("object-format=sha1")}00010001`),
        "unexpected-packet",
      );
    },
  );

  it.each([
    [
      "an unadvertised capability",
      `${pkt("command=fetch")}${pkt("session-id=1")}0000`,
      "unknown-capability",
    ],
    [
      "a command used as a capability",
      `${pkt("command=fetch")}${pkt("ls-refs")}0000`,
      "unknown-capability",
    ],
    ["an unknown line", `${pkt("command=fetch")}${pkt("hello there")}0000`, "unknown-capability"],
    ["an unadvertised command", `${pkt("command=object-info")}0000`, "unknown-command"],
    ["a command with a value", `${pkt("command=fetch=1")}0000`, "unknown-command"],
    ["a capability as a command", `${pkt("command=agent")}0000`, "unknown-command"],
    ["two commands", `${pkt("command=fetch")}${pkt("command=ls-refs")}0000`, "duplicate-command"],
    ["no command", `${pkt("agent=x")}0000`, "no-command"],
    ["no command before the delim", `${pkt("agent=x")}0001${pkt("done")}0000`, "no-command"],
    [
      "SHA-256",
      `${pkt("command=fetch")}${pkt("object-format=sha256")}0000`,
      "object-format-mismatch",
    ],
    ["a NUL in a capability", `${pkt("command=fetch")}${pkt("agent=a\0b")}0000`, "bad-capability"],
    ["a response-end packet", `${pkt("command=fetch")}0002`, "unexpected-packet"],
    ["a response-end in the arguments", `${pkt("command=fetch")}00010002`, "unexpected-packet"],
    ["a request without its flush", `${pkt("command=fetch")}0001${pkt("done")}`, "truncated"],
    ["a request without its delim or flush", `${pkt("command=fetch")}`, "truncated"],
  ] as const)("rejects %s", async (_name, input, code) => {
    await expectCode(() => read(input), code);
  });
});

describe("encodeV2CommandRequest", () => {
  it("writes LF-terminated lines, which git's upload-pack reads", () => {
    const request: V2CommandRequest = {
      command: "ls-refs",
      capabilities: [
        { name: "agent", value: "fyrden/1" },
        { name: "object-format", value: "sha1" },
      ],
      args: [bin("peel"), bin("ref-prefix refs/heads/")],
    };
    expect(str(encodeV2CommandRequest(request))).toBe(
      `${pkt("command=ls-refs\n")}${pkt("agent=fyrden/1\n")}${pkt("object-format=sha1\n")}0001${pkt("peel\n")}${pkt("ref-prefix refs/heads/\n")}0000`,
    );
  });

  it("refuses a request that cannot be read back", () => {
    const ok: V2CommandRequest = { command: "fetch", capabilities: [], args: [] };
    expect(() => encodeV2CommandRequest({ ...ok, command: "a b" })).toThrow(RangeError);
    expect(() =>
      encodeV2CommandRequest({ ...ok, capabilities: [{ name: "a", value: "\n" }] }),
    ).toThrow(RangeError);
    expect(() => encodeV2CommandRequest({ ...ok, args: [bin("a\nb")] })).toThrow(RangeError);
  });

  it("round-trips any request", async () => {
    const key = fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/);
    const capArb: fc.Arbitrary<Capability> = fc.oneof(
      key.filter((k) => k !== "command" && k !== "object-format").map((name) => ({ name })),
      fc
        .tuple(key, fc.string({ maxLength: 12 }))
        .filter(
          ([k, v]) =>
            k !== "command" && k !== "object-format" && !v.includes("\n") && !v.includes("\0"),
        )
        .map(([name, value]) => ({ name, value })),
    );
    const argArb = fc.uint8Array({ maxLength: 40 }).filter((b) => !b.includes(0x0a));
    await fc.assert(
      fc.asyncProperty(
        key,
        fc.array(capArb, { maxLength: 5 }),
        fc.array(argArb, { maxLength: 5 }),
        async (command, capabilities, args) => {
          fc.pre(capabilities.every((c) => c.name !== command));
          const request = { command, capabilities, args };
          const advertised = { commands: [command], capabilities: capabilities.map((c) => c.name) };
          const reader = new PktLineReader(encodeV2CommandRequest(request));
          expect(await readV2CommandRequest(reader, advertised)).toEqual(request);
        },
      ),
    );
  });
});

describe("parseLsRefsArgs", () => {
  it("reads git's arguments", () => {
    const args = parseLsRefsArgs(
      ["peel", "symrefs", "unborn", "ref-prefix refs/heads/", "ref-prefix HEAD"].map(bin),
    );
    expect(args).toEqual({
      peel: true,
      symrefs: true,
      unborn: true,
      refPrefixes: [bin("refs/heads/"), bin("HEAD")],
    });
  });

  it("defaults every flag to off", () => {
    expect(parseLsRefsArgs([])).toEqual({
      peel: false,
      symrefs: false,
      unborn: false,
      refPrefixes: [],
    });
  });

  it("drops all prefixes when there are too many, as git does (prefixes only narrow the listing)", () => {
    const args = parseLsRefsArgs(["ref-prefix a", "ref-prefix b", "ref-prefix c"].map(bin), {
      maxRefPrefixes: 2,
    });
    expect(args.refPrefixes).toEqual([]);
  });

  it.each(["peeled", "ref-prefix", "symrefs ", "PEEL", "filter blob:none"])(
    "rejects %j",
    async (arg) => {
      await expectCode(() => parseLsRefsArgs([bin(arg)]), "unexpected-argument");
    },
  );
});

describe("parseFetchArgs", () => {
  it("reads git's clone --depth 1 arguments, without duplicate wants", async () => {
    const request = await read(GIT_FETCH);
    expect(parseFetchArgs(request?.args ?? [])).toEqual({
      wants: [oidFromHex(A)],
      haves: [],
      done: true,
      thinPack: true,
      noProgress: true,
      includeTag: true,
      ofsDelta: true,
      shallow: [],
      deepen: 1,
      deepenRelative: false,
      deepenSince: undefined,
      deepenNot: [],
    });
  });

  it("reads haves, shallow lines and the other deepen forms", () => {
    const args = parseFetchArgs(
      [
        `shallow ${B}`,
        `want ${A}`,
        `have ${B}`,
        `have ${A.toUpperCase()}`,
        "deepen-since 1767225600",
        "deepen-not refs/heads/old",
        "deepen-relative",
      ].map(bin),
    );
    expect(args.shallow).toEqual([oidFromHex(B)]);
    expect(args.haves).toEqual([oidFromHex(B), oidFromHex(A)]);
    expect(args.deepenSince).toBe(1767225600);
    expect(args.deepenNot).toEqual([bin("refs/heads/old")]);
    expect(args.deepenRelative).toBe(true);
    expect(args.done).toBe(false);
  });

  it.each([
    ["a short want", `want ${A.slice(1)}`, "malformed-line"],
    ["a want with trailing text", `want ${A} x`, "malformed-line"],
    ["a non-hex have", `have ${"x".repeat(40)}`, "malformed-line"],
    ["a bad shallow", `shallow ${A}0`, "malformed-line"],
    ["deepen 0", "deepen 0", "bad-argument"],
    ["a negative deepen", "deepen -1", "bad-argument"],
    ["a hex deepen", "deepen 0x10", "bad-argument"],
    ["an overflowing deepen", "deepen 2147483648", "bad-argument"],
    ["an empty deepen", "deepen ", "bad-argument"],
    ["a bad deepen-since", "deepen-since yesterday", "bad-argument"],
    ["an unsafe deepen-since", "deepen-since 99999999999999999999", "bad-argument"],
    ["an empty deepen-not", "deepen-not ", "bad-argument"],
    ["an unadvertised filter", "filter blob:none", "unexpected-argument"],
    ["an unadvertised want-ref", "want-ref refs/heads/main", "unexpected-argument"],
    ["an unadvertised sideband-all", "sideband-all", "unexpected-argument"],
    ["an unadvertised wait-for-done", "wait-for-done", "unexpected-argument"],
    ["an unadvertised packfile-uris", "packfile-uris https", "unexpected-argument"],
    ["an unknown argument", "frobnicate", "unexpected-argument"],
  ] as const)("rejects %s", async (_name, arg, code) => {
    await expectCode(() => parseFetchArgs([bin(arg)]), code);
  });

  it("rejects deepen together with deepen-since or deepen-not, as git does", async () => {
    await expectCode(() => parseFetchArgs(["deepen 1", "deepen-since 5"].map(bin)), "bad-argument");
    await expectCode(
      () => parseFetchArgs(["deepen-not main", "deepen 2"].map(bin)),
      "bad-argument",
    );
  });

  it("enforces the want, have, shallow and deepen-not limits", async () => {
    const lines = (word: string, n: number) => Array.from({ length: n }, () => bin(`${word} ${A}`));
    await expectCode(() => parseFetchArgs(lines("want", 3), { maxWants: 2 }), "too-many-wants");
    await expectCode(() => parseFetchArgs(lines("have", 3), { maxHaves: 2 }), "too-many-haves");
    await expectCode(
      () => parseFetchArgs(lines("shallow", 3), { maxShallow: 2 }),
      "too-many-shallows",
    );
    await expectCode(
      () => parseFetchArgs(lines("deepen-not", 3), { maxDeepenNot: 2 }),
      "too-many-arguments",
    );
    expect(parseFetchArgs(lines("want", 2), { maxWants: 2 }).wants).toHaveLength(1);
  });

  it("parses any list of well-formed wants and haves, dropping repeats", () => {
    fc.assert(
      fc.property(
        fc.array(oidArb, { maxLength: 10 }),
        fc.array(oidArb, { maxLength: 10 }),
        (wants, haves) => {
          const hex = (o: Uint8Array) => Buffer.from(o).toString("hex");
          const args = [
            ...wants.map((w) => bin(`want ${hex(w)}`)),
            ...haves.map((h) => bin(`have ${hex(h)}`)),
          ];
          const parsed = parseFetchArgs(args);
          expect(parsed.wants.map(hex)).toEqual([...new Set(wants.map(hex))]);
          expect(parsed.haves.map(hex)).toEqual([...new Set(haves.map(hex))]);
        },
      ),
    );
  });
});
