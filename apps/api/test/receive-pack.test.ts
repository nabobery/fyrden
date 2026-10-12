// Pushes through the Worker into the repository object, with packs real git
// made: the body goes to R2 with one PUT, the object indexes it and the
// Worker answers with git's report.
import { env } from "cloudflare:workers";
import { gzipSync } from "node:zlib";
import { oidToHex } from "@fyrden/git-core";
import { beforeEach, describe, expect, inject, it } from "vitest";
import { type PushTarget, postPush, pushTarget } from "./helpers/push.js";
import { pushBody, ZERO } from "./helpers/push-fixtures.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const MAIN = "refs/heads/main";

async function refsOf(target: PushTarget): Promise<Record<string, string>> {
  return inRepo(target.repo.stub, ({ git }) => {
    const out: Record<string, string> = {};
    for (const [name, oid] of git.refStore.readRefsSync().refs) out[name] = oidToHex(oid);
    return out;
  });
}

const okReport = (...refs: string[]) => ["unpack ok\n", ...refs.map((r) => `ok ${r}\n`), "0000"];

let target: PushTarget;
beforeEach(async () => {
  target = await pushTarget();
});

async function pushC2(t = target) {
  const reply = await postPush(
    t,
    pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
  );
  expect(reply.report).toEqual(okReport(MAIN));
}

describe("receive-pack through the Worker", () => {
  it("creates a branch from a new repository's first push", async () => {
    const reply = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
    );
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe("application/x-git-receive-pack-result");
    expect(reply.report).toEqual(okReport(MAIN));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2 });
    const state = await inRepo(target.repo.stub, async ({ git }) => ({
      live: git.registry.inState("live").length,
      verified: (await git.commitGraph.read([fx.c1, fx.c2].map(hexOid), "verified")).map(
        (row) => row !== undefined,
      ),
      uploads: git.context.storage.sql
        .exec<{ state: string }>("SELECT state FROM uploads")
        .toArray()
        .map((r) => r.state),
    }));
    expect(state).toEqual({ live: 1, verified: [true, true], uploads: ["committed"] });
    // The scratch body is gone once the push has committed.
    const scratch = await env.GIT.list({ prefix: "net/" });
    expect(scratch.objects.filter((o) => o.key.includes("/scratch/"))).toEqual([]);
  });

  it("resolves a thin pack against the repository with a completion pack in the same unit", async () => {
    await pushC2();
    const reply = await postPush(
      target,
      pushBody([{ old: fx.c2, new: fx.c3, ref: MAIN }], { pack: fx.packC3ThinOnC2 }),
    );
    expect(reply.report).toEqual(okReport(MAIN));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c3 });
    const kinds = await inRepo(target.repo.stub, ({ git }) =>
      git.registry
        .inState("live")
        .map((p) => p.kind)
        .sort(),
    );
    expect(kinds).toEqual(["completion", "receive", "receive"]);
  });

  it("force-pushes, deletes a branch and pushes an annotated tag", async () => {
    await pushC2();
    const force = await postPush(
      target,
      pushBody(
        [
          { old: fx.c2, new: fx.c4, ref: MAIN },
          { old: ZERO, new: fx.c2, ref: "refs/heads/keep" },
        ],
        { pack: fx.packC4OnC1 },
      ),
    );
    expect(force.report).toEqual(okReport(MAIN, "refs/heads/keep"));
    const tag = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.tag, ref: "refs/tags/v1" }], { pack: fx.packTagOnC2 }),
    );
    expect(tag.report).toEqual(okReport("refs/tags/v1"));
    const del = await postPush(
      target,
      pushBody([{ old: fx.c2, new: ZERO, ref: "refs/heads/keep" }], {
        caps: ["report-status", "delete-refs"],
      }),
    );
    expect(del.report).toEqual(okReport("refs/heads/keep"));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c4, "refs/tags/v1": fx.tag });
  });

  it("creates a branch at an existing commit with an empty pack", async () => {
    await pushC2();
    const reply = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c1, ref: "refs/heads/old" }], { pack: fx.packEmpty }),
    );
    expect(reply.report).toEqual(okReport("refs/heads/old"));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2, "refs/heads/old": fx.c1 });
  });

  it("fails every ref of an atomic push when one is refused", async () => {
    await pushC2();
    const reply = await postPush(
      target,
      pushBody(
        [
          { old: fx.c2, new: fx.c3, ref: MAIN },
          { old: ZERO, new: fx.c3, ref: "refs/heads/bad..name" },
        ],
        { pack: fx.packC3ThinOnC2, caps: ["report-status", "side-band-64k", "atomic"] },
      ),
    );
    expect(reply.report).toEqual([
      "unpack ok\n",
      `ng ${MAIN} atomic push failure\n`,
      "ng refs/heads/bad..name funny refname\n",
      "0000",
    ]);
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2 });
    const live = await inRepo(target.repo.stub, ({ git }) => git.registry.inState("live").length);
    expect(live).toBe(1);
  });

  it("refuses a stale compare-and-set with git's reason and keeps the other ref", async () => {
    await pushC2();
    const reply = await postPush(
      target,
      pushBody(
        [
          { old: fx.c1, new: fx.c3, ref: MAIN },
          { old: ZERO, new: fx.c3, ref: "refs/heads/next" },
        ],
        { pack: fx.packC3ThinOnC2, caps: ["report-status"] },
      ),
    );
    expect(reply.report).toEqual([
      "unpack ok\n",
      `ng ${MAIN} incorrect old value provided\n`,
      "ok refs/heads/next\n",
      "0000",
    ]);
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2, "refs/heads/next": fx.c3 });
  });

  it("accepts push options", async () => {
    const reply = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], {
        pack: fx.packC2,
        pushOptions: ["ci.skip", "topic=x"],
      }),
    );
    expect(reply.report).toEqual(okReport(MAIN));
  });

  it("stores a body sent without a length (chunked)", async () => {
    const reply = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
      { chunked: true },
    );
    expect(reply.report).toEqual(okReport(MAIN));
  });

  it("answers a malformed request with git's error and stores nothing", async () => {
    // A command without a ref name.
    const line = `${ZERO} ${fx.c2}\0side-band-64k\n`;
    const pkt = `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    const reply = await postPush(target, new TextEncoder().encode(`${pkt}0000PACK`));
    expect(reply.status).toBe(200);
    const text = new TextDecoder().decode(reply.bytes);
    expect(text.charCodeAt(4)).toBe(3);
    expect(text).toContain("protocol error");
    const uploads = await inRepo(target.repo.stub, ({ git }) =>
      git.context.storage.sql
        .exec<{ state: string }>("SELECT state FROM uploads")
        .toArray()
        .map((r) => r.state),
    );
    expect(uploads).toEqual(["rejected"]);
    expect(await refsOf(target)).toEqual({});
  });

  it("answers a lone flush with an empty response", async () => {
    const reply = await postPush(target, new TextEncoder().encode("0000"));
    expect(reply.status).toBe(200);
    expect(reply.bytes.length).toBe(0);
  });

  it("indexes across several calls and the alarm when the budget is small", async () => {
    const reply = await postPush(
      target,
      pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 }),
      {
        vars: { GIT_PUSH_INDEX_BUDGET_MS: "0", GIT_PUSH_POLL_MS: "20", GIT_PUSH_MAX_POLL_MS: "20" },
      },
    );
    expect(reply.report).toEqual(okReport(MAIN));
    // Keepalives on side-band 1 came before the report.
    expect(reply.bytes.subarray(0, 5)).toEqual(new Uint8Array([0x30, 0x30, 0x30, 0x35, 0x01]));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2 });
  });
});

// JGit sends every receive-pack request with `Content-Encoding: gzip`, and
// git's http-backend inflates it (`inflate_request` in http-backend.c).
describe("receive-pack with an encoded body", () => {
  const gzipped = { "Content-Encoding": "gzip" };

  it("inflates a gzip body, indexes the pack and commits", async () => {
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const reply = await postPush(target, gzipSync(body), { headers: gzipped });
    expect(reply.status).toBe(200);
    expect(reply.report).toEqual(okReport(MAIN));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2 });
  });

  it("accepts x-gzip and a gzip body sent without a length", async () => {
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const reply = await postPush(target, gzipSync(body), {
      headers: { "Content-Encoding": "x-gzip" },
      chunked: true,
    });
    expect(reply.report).toEqual(okReport(MAIN));
    expect(await refsOf(target)).toEqual({ [MAIN]: fx.c2 });
  });

  it("refuses a body that is not valid gzip with git's error, and moves no ref", async () => {
    const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
    const reply = await postPush(target, body, { headers: gzipped });
    expect(reply.status).toBe(200);
    expect(new TextDecoder().decode(reply.bytes)).toMatch(
      /^[0-9a-f]{4}ERR the push body is not valid gzip/,
    );
    const uploads = await inRepo(target.repo.stub, ({ git }) =>
      git.context.storage.sql
        .exec<{ state: string }>("SELECT state FROM uploads")
        .toArray()
        .map((r) => r.state),
    );
    expect(uploads).toEqual(["rejected"]);
    expect(await refsOf(target)).toEqual({});
  });

  for (const encoding of ["deflate", "br", "compress", "gzip, br"]) {
    it(`refuses Content-Encoding '${encoding}' before any upload`, async () => {
      const body = pushBody([{ old: ZERO, new: fx.c2, ref: MAIN }], { pack: fx.packC2 });
      const reply = await postPush(target, body, { headers: { "Content-Encoding": encoding } });
      expect(reply.status).toBe(415);
      expect(new TextDecoder().decode(reply.bytes)).toContain(
        `Unsupported Content-Encoding '${encoding}'`,
      );
      const uploads = await inRepo(target.repo.stub, ({ git }) =>
        git.context.storage.sql.exec("SELECT state FROM uploads").toArray(),
      );
      expect(uploads).toEqual([]);
    });
  }
});

function hexOid(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16)) as never;
}
