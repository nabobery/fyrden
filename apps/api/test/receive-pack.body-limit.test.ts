// Push body limits. Cloudflare refuses a request body above the plan's
// limit (104,857,600 bytes on Free and Pro, measured on Workers Free
// 2026-10-10) with its own 413 before the Worker runs, so nothing is stored
// and refs cannot move; that is observable only on a deployed Worker. Here:
// the Worker's own limit (configurable) refuses with a message git prints,
// before any upload exists, and leaves nothing behind.
import { env } from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import { describe, expect, inject, it } from "vitest";
import { PUSH_TUNING_DEFAULTS, pushTuning } from "../src/git/push/tuning.js";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";
const LIMIT = 1_000;
const vars = { GIT_PUSH_MAX_BODY_BYTES: String(LIMIT) };

async function leftovers(target: PushTarget) {
  return inRepo(target.repo.stub, async ({ git }) => {
    const uploads = git.context.storage.sql
      .exec<{ state: string }>("SELECT state FROM uploads")
      .toArray()
      .map((r) => r.state);
    const scratch = await env.GIT.list({ prefix: `net/${git.networkId()}/scratch/` });
    const packs = git.registry.inState("live").length + git.registry.inState("indexing").length;
    return {
      uploads,
      scratch: scratch.objects.length,
      packs,
      refs: git.refStore.readRefsSync().refs.size,
    };
  });
}

describe("receive-pack body limit", () => {
  it("defaults to Cloudflare's measured Free and Pro limit", () => {
    expect(PUSH_TUNING_DEFAULTS.maxBodyBytes).toBe(104_857_600);
    expect(pushTuning({}).maxBodyBytes).toBe(104_857_600);
    expect(pushTuning({ GIT_PUSH_MAX_BODY_BYTES: "5" }).maxBodyBytes).toBe(5);
    expect(pushTuning({ GIT_PUSH_MAX_BODY_BYTES: "lots" }).maxBodyBytes).toBe(104_857_600);
  });

  it("refuses a declared length over the limit on side-band 3, before any upload", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    expect(body.length).toBeGreaterThan(LIMIT);
    const reply = await postPush(target, body, { vars });
    expect(reply.status).toBe(200);
    const text = new TextDecoder().decode(reply.bytes);
    expect(text.slice(4)).toMatch(/^.the push is larger than this server accepts/);
    expect(text.charCodeAt(4)).toBe(3);
    expect(text).toContain(`(${LIMIT} bytes)`);
    expect(text.endsWith("0000")).toBe(true);
    expect(await leftovers(target)).toEqual({ uploads: [], scratch: 0, packs: 0, refs: 0 });
  });

  it("refuses with an ERR packet when the push did not ask for side-band", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], {
      pack: fx.packC2,
      caps: ["report-status"],
    });
    const reply = await postPush(target, body, { vars });
    expect(new TextDecoder().decode(reply.bytes)).toMatch(
      /^[0-9a-f]{4}ERR the push is larger than this server accepts in one request \(1000 bytes\)/,
    );
    expect(await leftovers(target)).toEqual({ uploads: [], scratch: 0, packs: 0, refs: 0 });
  });

  it("refuses a body without a length once it passes the limit, and cleans up the upload", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const reply = await postPush(target, body, { vars, chunked: true });
    const text = new TextDecoder().decode(reply.bytes);
    expect(text.charCodeAt(4)).toBe(3);
    expect(text).toContain("the push is larger than");
    expect(await leftovers(target)).toEqual({
      uploads: ["rejected"],
      scratch: 0,
      packs: 0,
      refs: 0,
    });
  });

  it("accepts a body of exactly the limit", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const reply = await postPush(target, body, {
      vars: { GIT_PUSH_MAX_BODY_BYTES: String(body.length) },
    });
    expect(reply.report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
  });

  it("applies the limit to a gzip body's inflated size, and cleans up the upload", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const limit = body.length + 1_000;
    // Zeros after the pack compress well: under the limit on the wire, far over it inflated.
    const padded = new Uint8Array(body.length + 256 * 1024);
    padded.set(body);
    const gz = gzipSync(padded);
    expect(gz.length).toBeLessThan(limit);
    const reply = await postPush(target, gz, {
      vars: { GIT_PUSH_MAX_BODY_BYTES: String(limit) },
      headers: { "Content-Encoding": "gzip" },
    });
    expect(reply.status).toBe(200);
    const text = new TextDecoder().decode(reply.bytes);
    expect(text.charCodeAt(4)).toBe(3);
    expect(text).toContain(
      `the push is larger than this server accepts in one request (${limit} bytes)`,
    );
    expect(await leftovers(target)).toEqual({
      uploads: ["rejected"],
      scratch: 0,
      packs: 0,
      refs: 0,
    });
  });

  it("bounds a gzip body's inflated size by its own, smaller limit (32 MiB by default)", () => {
    expect(PUSH_TUNING_DEFAULTS.maxGzipBodyBytes).toBe(32 * 1024 * 1024);
    expect(pushTuning({ GIT_PUSH_MAX_GZIP_BODY_BYTES: "5" }).maxGzipBodyBytes).toBe(5);
  });

  // The inflated body is held in the Worker before it is stored (its length is
  // unknown until the end), so a compressed push gets a limit that leaves the
  // isolate's 128 MiB room: a small request inflating past it is refused as
  // soon as it passes the limit.
  it("refuses a small gzip body that inflates past the default gzip limit, and cleans up", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const padded = new Uint8Array(PUSH_TUNING_DEFAULTS.maxGzipBodyBytes + 1);
    padded.set(body);
    const gz = gzipSync(padded);
    expect(gz.length).toBeLessThan(64 * 1024);
    const reply = await postPush(target, gz, { headers: { "Content-Encoding": "gzip" } });
    expect(reply.status).toBe(200);
    const text = new TextDecoder().decode(reply.bytes);
    expect(text.charCodeAt(4)).toBe(3);
    expect(text).toContain(
      `a compressed push inflates to more than this server accepts (${PUSH_TUNING_DEFAULTS.maxGzipBodyBytes} bytes)`,
    );
    expect(await leftovers(target)).toEqual({
      uploads: ["rejected"],
      scratch: 0,
      packs: 0,
      refs: 0,
    });
  });

  it("accepts a gzip body whose inflated size is exactly the limit", async () => {
    const target = await pushTarget();
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const reply = await postPush(target, gzipSync(body), {
      vars: { GIT_PUSH_MAX_BODY_BYTES: String(body.length) },
      headers: { "Content-Encoding": "gzip" },
    });
    expect(reply.report).toEqual(["unpack ok\n", `ok ${MAIN}\n`, "0000"]);
  });
});
