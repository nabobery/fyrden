import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isNetworkId, newPackId, packObjectKey } from "../../src/git/keys.js";
import { newNetworkId } from "./harness.js";

const hostile = fc.oneof(
  fc.string(),
  fc.constantFrom(
    "",
    "..",
    "../net_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "net_01ARZ3NDEKTSV4RRFFQ69G5FAV/../x",
    "net_01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
    "net_01arz3ndektsv4rrffq69g5fav",
    "NET_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "rep_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "01ARZ3NDEKTSV4RRFFQ69G5FA%2F",
    "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
    "01ARZ3NDEKTSV4RRFFQ69G5FAU",
  ),
);

describe("R2 key hygiene", () => {
  it("builds keys only from a valid network id and pack id", () => {
    const networkId = newNetworkId();
    const packId = newPackId();
    expect(packObjectKey(networkId, packId, "pack")).toBe(`net/${networkId}/p/${packId}.pack`);
    expect(packObjectKey(networkId, packId, "idx")).toBe(`net/${networkId}/p/${packId}.idx`);
  });

  it("refuses any network id that is not a network ULID", () => {
    const packId = newPackId();
    fc.assert(
      fc.property(hostile, (text) => {
        if (isNetworkId(text)) return;
        expect(() => packObjectKey(text, packId, "pack")).toThrow(RangeError);
      }),
      { numRuns: 500 },
    );
  });

  it("refuses any pack id that is not a ULID", () => {
    const networkId = newNetworkId();
    fc.assert(
      fc.property(hostile, (text) => {
        if (/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(text)) return;
        expect(() => packObjectKey(networkId, text, "pack")).toThrow(RangeError);
      }),
      { numRuns: 500 },
    );
  });

  it("never lets a built key leave its network's pack prefix", () => {
    fc.assert(
      fc.property(hostile, hostile, (network, pack) => {
        let key: string;
        try {
          key = packObjectKey(network, pack, "pack");
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          return;
        }
        expect(key).toMatch(
          /^net\/net_[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-7][0-9A-HJKMNP-TV-Z]{25}\.pack$/,
        );
      }),
      { numRuns: 500 },
    );
  });

  it("refuses an unknown file kind", () => {
    expect(() => packObjectKey(newNetworkId(), newPackId(), "../x" as "pack")).toThrow(RangeError);
  });
});
