import {
  createSha1Hasher,
  encodeTag,
  hashObject as hashWith,
  type ObjectType,
  type Oid,
  oidToHex,
} from "@fyrden/git-core";
import { describe, expect, it } from "vitest";
import { MAX_TAG_CHAIN, type PeelReader, peelAll, peelOid } from "../src/git/peel.js";
import { requestedProtocolVersion } from "../src/git/protocol.js";

describe("requestedProtocolVersion", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["version=2", 2],
    ["version=1", 1],
    ["version=0", 0],
    ["object-format=sha1:version=2", 2],
    ["version=2:version=1", 2],
    ["version=1:version=2", 2],
    ["version=3", 0],
    ["version=02", 0],
    ["Version=2", 0],
    ["version=2 ", 0],
  ] as const)("%j asks for version %i", (header, version) => {
    expect(requestedProtocolVersion(header)).toBe(version);
  });
});

const hashObject = (type: ObjectType, body: Uint8Array) => hashWith(createSha1Hasher, type, body);

type Stored = { type: ObjectType; bytes: Uint8Array };

async function store(objects: Stored[]): Promise<{ oids: Oid[]; reader: PeelReader }> {
  const byHex = new Map<string, Stored>();
  const oids: Oid[] = [];
  for (const object of objects) {
    const oid = await hashObject(object.type, object.bytes);
    byHex.set(oidToHex(oid), object);
    oids.push(oid);
  }
  const reader: PeelReader = {
    readHeader: async (oid) => byHex.get(oidToHex(oid)),
    readObject: async (oid) => byHex.get(oidToHex(oid)),
  };
  return { oids, reader };
}

const tagOf = (object: Oid, type: ObjectType, name = "t"): Stored => ({
  type: "tag",
  bytes: encodeTag({
    object,
    type,
    name: new TextEncoder().encode(name),
    tagger: null,
    headers: [],
    message: new TextEncoder().encode("m\n"),
  }),
});

describe("peelOid", () => {
  it("peels a chain of tags to the first object declared as not a tag", async () => {
    const { oids } = await store([{ type: "blob", bytes: new TextEncoder().encode("x") }]);
    const blob = oids[0] as Oid;
    const inner = await store([tagOf(blob, "blob")]);
    const innerOid = inner.oids[0] as Oid;
    const outer = await store([
      { type: "blob", bytes: new TextEncoder().encode("x") },
      tagOf(blob, "blob"),
      tagOf(innerOid, "tag"),
    ]);
    expect(oidToHex((await peelOid(outer.reader, outer.oids[2] as Oid)) as Oid)).toBe(
      oidToHex(blob),
    );
    expect(await peelOid(outer.reader, blob)).toBeUndefined();
  });

  it("gives no value for a missing object, a missing tag in the chain or a broken tag", async () => {
    const missing = new Uint8Array(20).fill(7) as Oid;
    const { oids, reader } = await store([
      tagOf(missing, "tag"),
      { type: "tag", bytes: new TextEncoder().encode("not a tag\n") },
    ]);
    expect(await peelOid(reader, missing)).toBeUndefined();
    expect(await peelOid(reader, oids[0] as Oid)).toBeUndefined();
    expect(await peelOid(reader, oids[1] as Oid)).toBeUndefined();
  });

  it("does not follow a chain longer than the limit", async () => {
    const objects: Stored[] = [];
    let target = new Uint8Array(20).fill(1) as Oid;
    let type: ObjectType = "commit";
    for (let i = 0; i <= MAX_TAG_CHAIN; i++) {
      const tag = tagOf(target, type, `t${i}`);
      objects.push(tag);
      target = await hashObject("tag", tag.bytes);
      type = "tag";
    }
    const { oids, reader } = await store(objects);
    expect(await peelOid(reader, oids[MAX_TAG_CHAIN - 1] as Oid)).toBeDefined();
    expect(await peelOid(reader, oids[MAX_TAG_CHAIN] as Oid)).toBeUndefined();
  });
});

describe("peelAll", () => {
  it("never opens the reader when every oid is a known commit", async () => {
    let opened = 0;
    const peeled = await peelAll(
      [new Uint8Array(20).fill(1) as Oid],
      (list) => list.map(() => true),
      async () => {
        opened++;
        return undefined;
      },
    );
    expect(peeled.size).toBe(0);
    expect(opened).toBe(0);
  });

  it("opens the reader once and closes it", async () => {
    const { oids, reader } = await store([tagOf(new Uint8Array(20).fill(3) as Oid, "commit")]);
    let opened = 0;
    let closed = 0;
    const peeled = await peelAll(
      [oids[0] as Oid, oids[0] as Oid, new Uint8Array(20).fill(9) as Oid],
      (list) => list.map(() => false),
      async () => {
        opened++;
        return { reader, close: () => closed++ };
      },
    );
    expect([opened, closed, peeled.size]).toEqual([1, 1, 1]);
  });
});
