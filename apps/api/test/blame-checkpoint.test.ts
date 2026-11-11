// A blame checkpoint's envelope: the state's bytes are trusted only inside
// one that names this repository, restore generation, commit, path, engine
// version and run generation, with a hash over all of it. decodeBlameState
// can tell that bytes hold together, not whose they are.
import { describe, expect, it } from "vitest";
import {
  BlameCheckpointRefused,
  type CheckpointIdentity,
  openCheckpoint,
  sealCheckpoint,
} from "../src/do/repo/blame-checkpoint.js";

const IDENTITY: CheckpointIdentity = {
  repoId: "rep_01HZZZZZZZZZZZZZZZZZZZZZZZ",
  epochGen: 3,
  commit: "a".repeat(40),
  path: "src/café.ts",
  engineVersion: 1,
  generation: 7,
};
const STATE = Uint8Array.from({ length: 300 }, (_, k) => (k * 7) % 256);
const MAX = 1 << 20;

/** A copy of `bytes` with one bit of the byte at `at` flipped. */
function flipped(bytes: Uint8Array, at: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[at] = (copy[at] as number) ^ 1;
  return copy;
}

/** The reason `openCheckpoint` refuses, or "opened". */
async function refusal(bytes: Uint8Array, identity = IDENTITY, max = MAX): Promise<string> {
  try {
    await openCheckpoint(identity, bytes, max);
    return "opened";
  } catch (error) {
    if (error instanceof BlameCheckpointRefused) return error.reason;
    throw error;
  }
}

describe("blame checkpoint envelope", () => {
  it("gives back the state it sealed, for the same identity", async () => {
    const sealed = await sealCheckpoint(IDENTITY, STATE);
    expect(await openCheckpoint(IDENTITY, sealed, MAX)).toEqual(STATE);
  });

  it("refuses a checkpoint sealed for anything else, field by field", async () => {
    const sealed = await sealCheckpoint(IDENTITY, STATE);
    const others: Partial<CheckpointIdentity>[] = [
      { repoId: "rep_01HYYYYYYYYYYYYYYYYYYYYYYY" },
      { epochGen: 4 },
      { commit: "b".repeat(40) },
      { path: "src/cafe.ts" },
      { engineVersion: 2 },
      { generation: 8 },
    ];
    for (const other of others)
      expect([other, await refusal(sealed, { ...IDENTITY, ...other })]).toEqual([
        other,
        "identity",
      ]);
  });

  it("refuses bytes changed after sealing, in the state or in the hash", async () => {
    const sealed = await sealCheckpoint(IDENTITY, STATE);
    expect(await refusal(flipped(sealed, sealed.length - 1))).toBe("hash");
    expect(await refusal(flipped(sealed, sealed.length - STATE.length - 1))).toBe("hash");
  });

  it("refuses every cut-short checkpoint, and nothing gets past as another error", async () => {
    const sealed = await sealCheckpoint(IDENTITY, Uint8Array.of(1, 2, 3));
    for (let length = 0; length < sealed.length; length++) {
      const reason = await refusal(sealed.subarray(0, length));
      expect([length, ["malformed", "hash"].includes(reason)]).toEqual([length, true]);
    }
  });

  it("refuses one over the size it may be before reading it", async () => {
    const sealed = await sealCheckpoint(IDENTITY, STATE);
    expect(await refusal(sealed, IDENTITY, sealed.length - 1)).toBe("too_large");
    expect(await refusal(sealed, IDENTITY, sealed.length)).toBe("opened");
  });

  it("refuses another format or version", async () => {
    const sealed = await sealCheckpoint(IDENTITY, STATE);
    expect(await refusal(flipped(sealed, 0))).toBe("malformed");
    const version = Uint8Array.from(sealed);
    version[4] = 99;
    expect(await refusal(version)).toBe("malformed");
  });
});
