// How much of a push body the Worker reads to check its commands before
// storing it: the whole command section, and push options when asked for.

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  COMMAND_SECTION_MAX_BYTES,
  GZIP_COMMAND_READ_BYTES,
  inflatedPrefix,
  readBodyHead,
  sectionsComplete,
} from "../src/git/push/body-head.js";

const encoder = new TextEncoder();
const pkt = (text: string) => `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
const ZERO = "0".repeat(40);
const ONE = "1".repeat(40);
const bytes = (...parts: string[]) => encoder.encode(parts.join(""));

describe("a push body's command sections", () => {
  it("are complete at the flush that ends the commands", () => {
    const first = pkt(`${ZERO} ${ONE} refs/heads/a\0report-status`);
    const second = pkt(`${ZERO} ${ONE} refs/heads/b`);
    expect(sectionsComplete(bytes(first, second, "0000", "PACK"))).toBe(true);
    // Cut short anywhere before that flush: not yet.
    const whole = bytes(first, second, "0000");
    for (let end = 0; end < whole.length; end++)
      expect(sectionsComplete(whole.subarray(0, end)), String(end)).toBe(false);
  });

  it("include the push options when the first command asks for them", () => {
    const first = pkt(`${ZERO} ${ONE} refs/heads/a\0report-status push-options`);
    expect(sectionsComplete(bytes(first, "0000"))).toBe(false);
    expect(sectionsComplete(bytes(first, "0000", pkt("ci.skip"), "0000"))).toBe(true);
  });

  it("find push options asked for after shallow lines, on a line ending with LF", () => {
    const shallow = pkt(`shallow ${ONE}\n`);
    const first = pkt(`${ZERO} ${ONE} refs/heads/a\0report-status push-options\n`);
    expect(sectionsComplete(bytes(shallow, first, "0000"))).toBe(false);
    expect(sectionsComplete(bytes(shallow, first, "0000", pkt("ci.skip\n"), "0000"))).toBe(true);
  });

  it("stop at a length no pkt-line has (the parser refuses it, not this reader)", () => {
    expect(sectionsComplete(bytes("zzzz"))).toBe(true);
    expect(sectionsComplete(bytes("0002"))).toBe(true);
  });
});

describe("a gzip body's start, inflated", () => {
  it("is what a stream cut short inflated so far", () => {
    const commands = bytes(pkt(`${ZERO} ${ONE} refs/heads/a\0report-status`), "0000");
    // Commands, then bytes that do not compress (a pack), cut short.
    const noise = crypto.getRandomValues(new Uint8Array(65_536));
    const whole = gzipSync(new Uint8Array([...commands, ...noise]));
    const prefix = inflatedPrefix(whole.subarray(0, 4_096));
    expect(prefix.subarray(0, commands.length)).toEqual(commands);
  });

  it("is nothing for a body that inflates past the bound, or is not gzip, at once", () => {
    const bomb = gzipSync(new Uint8Array(64 * 1024 * 1024));
    const started = Date.now();
    expect(inflatedPrefix(bomb).length).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(inflatedPrefix(encoder.encode("not gzip")).length).toBe(0);
    expect(COMMAND_SECTION_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe("a body's start, read", () => {
  it("inflates no more than the bound of a gzip body sent as one chunk, and replays it all", async () => {
    const commands = bytes(pkt(`${ZERO} ${ONE} refs/heads/a\0report-status`), "0000");
    const raw = new Uint8Array(commands.length + 2 * 1024 * 1024);
    raw.set(commands);
    for (let at = commands.length; at < raw.length; at += 65_536)
      crypto.getRandomValues(raw.subarray(at, Math.min(at + 65_536, raw.length)));
    const body = gzipSync(raw);
    const oneChunk = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    });
    const read = await readBodyHead(oneChunk, { gzip: true });
    // Inflated from the first 64 KiB only: about as many bytes, the commands first.
    expect(read.commands.subarray(0, commands.length)).toEqual(commands);
    expect(read.commands.length).toBeLessThan(GZIP_COMMAND_READ_BYTES + 1_024);
    const replayed = new Uint8Array(await new Response(read.rest(undefined)).arrayBuffer());
    expect(replayed).toEqual(new Uint8Array(body));
  });
});
