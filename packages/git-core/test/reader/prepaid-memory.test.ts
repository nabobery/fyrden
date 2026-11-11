import { describe, expect, it } from "vitest";
import { PackError } from "../../src/pack/errors.js";
import { reservePackMemory } from "../../src/pack/memory.js";
import { createPrepaidMemory, PrepaidMemoryExceeded } from "../../src/reader/prepaid-memory.js";

/*
 * A reader whose memory was all paid for before it opened: its reservations
 * take nothing further, never wait, and one the proof didn't foresee is an
 * error that isn't mistaken for a pack this server can't hold.
 */

describe("createPrepaidMemory", () => {
  it("grants up to its limit exactly, without waiting, and counts releases", async () => {
    const memory = createPrepaidMemory(100);
    const a = await memory.reserve(60);
    const b = await memory.reserve(40);
    expect(memory.held()).toBe(100);
    expect(memory.peak()).toBe(100);
    a.release();
    a.release();
    expect(memory.held()).toBe(40);
    const c = await memory.reserve(60);
    expect(memory.held()).toBe(100);
    b.release();
    c.release();
    expect(memory.held()).toBe(0);
    expect(memory.peak()).toBe(100);
  });

  it("settles a grant without yielding to anything else", async () => {
    const memory = createPrepaidMemory(100);
    const order: string[] = [];
    const granted = memory.reserve(1).then(() => order.push("granted"));
    const other = Promise.resolve()
      .then(() => undefined)
      .then(() => undefined)
      .then(() => order.push("later"));
    await Promise.all([granted, other]);
    expect(order).toEqual(["granted", "later"]);
  });

  it("refuses one byte past its limit, with its own error, holding nothing more", async () => {
    const memory = createPrepaidMemory(100);
    const a = await memory.reserve(100);
    await expect(memory.reserve(1)).rejects.toBeInstanceOf(PrepaidMemoryExceeded);
    expect(() => memory.tryReserve(1)).toThrow(PrepaidMemoryExceeded);
    expect(memory.held()).toBe(100);
    a.release();
    expect(memory.tryReserve(100)?.bytes).toBe(100);
  });

  it("isn't turned into a pack refusal by reservePackMemory", async () => {
    const memory = createPrepaidMemory(100);
    const error = await reservePackMemory(memory, 101, "a delta program").catch((e) => e);
    expect(error).toBeInstanceOf(PrepaidMemoryExceeded);
    expect(error).toMatchObject({
      name: "PrepaidMemoryExceeded",
      message: "a reservation of 101 bytes passes the 100 bytes paid for",
    });
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).not.toBeInstanceOf(PackError);
  });

  it("keeps the port's RangeError for a bad size", async () => {
    const memory = createPrepaidMemory(100);
    await expect(memory.reserve(0)).rejects.toBeInstanceOf(RangeError);
    await expect(memory.reserve(1.5)).rejects.toBeInstanceOf(RangeError);
    expect(() => memory.tryReserve(-1)).toThrow(/bad reservation of -1 bytes/);
  });

  it("refuses a limit that isn't a positive whole number", () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expect(() => createPrepaidMemory(limit)).toThrow(`bad prepaid memory limit ${limit}`);
    }
  });

  it("refuses at once on an aborted signal", async () => {
    const memory = createPrepaidMemory(100);
    const reason = new Error("gone");
    await expect(memory.reserve(1, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(memory.held()).toBe(0);
  });
});
