// Chunked pack uploads: the session operations (`uploads.*`) and the part
// route, end to end through the Worker into the repository object and R2.
// A completed session is indexed, checked and committed as a push is.
import {
  createExecutionContext,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ORPHAN_REAPER_JOB_ID, UPLOAD_TTL_MS } from "@fyrden/adapters-cloudflare/git";
import { hashToken } from "@fyrden/domain";
import { oidToHex } from "@fyrden/git-core";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { PART_RESERVATION_MS } from "../src/git/chunked/session.js";
import { CHUNKED_TUNING_DEFAULTS } from "../src/git/chunked/tuning.js";
import { basic, ORIGIN } from "./helpers/git-http.js";
import { fromHex } from "./helpers/git-oracle.js";
import { principalWithToken } from "./helpers/principals.js";
import { type PushTarget, pushTarget } from "./helpers/push.js";
import { inRepo } from "./helpers/repo-git.js";

const fx = inject("pushFixtures");
const cx = inject("chunkedFixtures");
const MAIN = "refs/heads/main";
const MiB = 1024 * 1024;
/** R2's smallest part but the last: the big fixture then has two parts. */
const FIVE_MIB = { GIT_UPLOAD_PART_BYTES: String(5 * MiB) };

afterEach(() => {
  vi.useRealTimers();
});

interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test assertions over JSON
  json: any;
}

async function call(request: Request, vars: Record<string, string> = {}): Promise<Reply> {
  const ctx = createExecutionContext();
  const response = await createApp().fetch(request, { ...env, ...vars }, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  const json = (response.headers.get("Content-Type") ?? "").includes("json");
  return { status: response.status, json: json ? JSON.parse(text) : text };
}

function apiPath(target: PushTarget, rest = ""): string {
  const [, owner, repo] = target.path.split("/");
  return `${ORIGIN}/api/repos/${owner}/${(repo as string).replace(/\.git$/, "")}/uploads${rest}`;
}

function api(
  target: PushTarget,
  method: string,
  rest: string,
  body?: unknown,
  options: { token?: string; vars?: Record<string, string> } = {},
): Promise<Reply> {
  return call(
    new Request(apiPath(target, rest), {
      method,
      headers: {
        Authorization: `Bearer ${options.token ?? target.owner.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    options.vars,
  );
}

function putPart(
  target: PushTarget,
  partsUrl: string,
  n: number,
  bytes: Uint8Array | ReadableStream<Uint8Array>,
  options: { token?: string; length?: number } = {},
): Promise<Reply> {
  const length = options.length ?? (bytes instanceof Uint8Array ? bytes.length : 0);
  return call(
    new Request(`${ORIGIN}${partsUrl}/${n}`, {
      method: "PUT",
      headers: {
        Authorization: basic(options.token ?? target.owner.token),
        "Content-Length": String(length),
      },
      body: bytes,
      ...(bytes instanceof Uint8Array ? {} : { duplex: "half" }),
    } as RequestInit),
  );
}

const create = (
  target: PushTarget,
  pack: Uint8Array,
  updates: { ref: string; old: string | null; new: string | null }[],
  vars?: Record<string, string>,
) => api(target, "POST", "", { size: pack.length, ref_updates: updates }, vars ? { vars } : {});

async function repoState(target: PushTarget) {
  return inRepo(target.repo.stub, async ({ git }) => {
    const scratch = await env.GIT.list({ prefix: `net/${git.networkId()}/scratch/` });
    const refs = Object.fromEntries(
      [...git.refStore.readRefsSync().refs].map(([name, oid]) => [name, oidToHex(oid)]),
    );
    return { refs, scratch: scratch.objects.map((o) => o.key) };
  });
}

/** Creates, uploads in one part and completes; returns the completion. */
async function pushChunked(
  target: PushTarget,
  pack: Uint8Array,
  updates: { ref: string; old: string | null; new: string | null }[],
): Promise<Reply> {
  const session = await create(target, pack, updates);
  expect(session.status).toBe(201);
  expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
  return api(target, "POST", `/${session.json.id}/complete`);
}

describe("chunked upload", () => {
  it("uploads a pack in one part and commits its ref updates as a push", async () => {
    const target = await pushTarget();
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    expect(session.status).toBe(201);
    expect(session.json).toMatchObject({
      state: "receiving",
      size: pack.length,
      part_size: CHUNKED_TUNING_DEFAULTS.partBytes,
      part_count: 1,
      parts_received: [],
    });
    expect(session.json.parts_url).toBe(`${target.path}/uploads/${session.json.id}/parts`);

    const part = await putPart(target, session.json.parts_url, 1, pack);
    expect(part).toEqual({
      status: 200,
      json: { part: 1, parts_received: [1], part_count: 1 },
    });
    const done = await api(target, "POST", `/${session.json.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      state: "committed",
      parts_received: [1],
      refs: [{ ref: MAIN, status: "ok" }],
    });
    expect(await repoState(target)).toEqual({ refs: { [MAIN]: fx.c2 }, scratch: [] });

    // The outcome stays readable, and completing again changes nothing.
    const again = await api(target, "POST", `/${session.json.id}/complete`);
    expect(again.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });
    const read = await api(target, "GET", `/${session.json.id}`);
    expect(read.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });
  });

  it("applies a thin pack on top of a branch by compare-and-set, and refuses a stale old value", async () => {
    const target = await pushTarget();
    expect(
      (await pushChunked(target, fromHex(fx.packC2), [{ ref: MAIN, old: null, new: fx.c2 }])).json
        .state,
    ).toBe("committed");
    const thin = await pushChunked(target, fromHex(fx.packC3ThinOnC2), [
      { ref: MAIN, old: fx.c2, new: fx.c3 },
    ]);
    expect(thin.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });

    const stale = await pushChunked(target, fromHex(fx.packC4OnC1), [
      { ref: MAIN, old: fx.c2, new: fx.c4 },
    ]);
    expect(stale.json.state).toBe("rejected");
    expect(stale.json.refs).toEqual([
      { ref: MAIN, status: "rejected", reason: expect.any(String) },
    ]);
    expect(await repoState(target)).toEqual({ refs: { [MAIN]: fx.c3 }, scratch: [] });
  });

  // A 5.5 MiB pack indexed in workerd: allow for a loaded machine.
  it("takes parts out of order, survives a failed part and replaces a part sent again", {
    timeout: 60_000,
  }, async () => {
    const target = await pushTarget();
    const pack = fromHex(cx.bigPack);
    const session = await create(
      target,
      pack,
      [{ ref: MAIN, old: null, new: cx.bigCommit }],
      FIVE_MIB,
    );
    expect(session.json).toMatchObject({ part_size: 5 * MiB, part_count: 2 });
    const url = session.json.parts_url;
    const first = pack.subarray(0, 5 * MiB);
    const second = pack.subarray(5 * MiB);

    expect((await putPart(target, url, 2, second)).json.parts_received).toEqual([2]);
    // A body that fails mid-way stores nothing; the client sends the part again.
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    });
    const failed = await putPart(target, url, 1, failing, { length: first.length });
    expect(failed.status).toBe(400);
    expect(failed.json.code).toBe("part_not_stored");
    const progress = await api(target, "GET", `/${session.json.id}`);
    expect(progress.json).toMatchObject({ state: "receiving", parts_received: [2] });

    // Part 1 with the wrong bytes, then again with the right ones: the last upload counts.
    expect((await putPart(target, url, 1, new Uint8Array(first.length).fill(7))).status).toBe(200);
    expect((await putPart(target, url, 1, first)).json.parts_received).toEqual([1, 2]);

    const done = await api(target, "POST", `/${session.json.id}/complete`);
    expect(done.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });
    expect(await repoState(target)).toEqual({ refs: { [MAIN]: cx.bigCommit }, scratch: [] });
  });

  // Two uploads of the same part: R2 stores one, then the other, and the
  // records must name the bytes R2 holds. A (wrong bytes) is stored first and
  // records last; B (the right bytes) is a second request in between.
  it("serializes replacements of a part: a second upload waits until the first records its etag", async () => {
    const target = await pushTarget();
    const { principalId } = target.owner;
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    const id: string = session.json.id;
    const stub = target.repo.stub;

    const a = await stub.chunkedPartTarget(id, principalId, 1, pack.length);
    if (!a.ok) throw new Error(a.error);
    const stored = await env.GIT.resumeMultipartUpload(a.key, a.multipartId).uploadPart(
      a.partNumber,
      new Uint8Array(pack.length).fill(7),
    );
    // B while A has not recorded: told to come back, nothing stored.
    const b = await putPart(target, session.json.parts_url, 1, pack);
    expect(b.status).toBe(409);
    expect(b.json.code).toBe("part_in_progress");
    // Nor can the upload be completed while a part is in flight.
    const early = await api(target, "POST", `/${id}/complete`);
    expect(early.status).toBe(409);
    expect(early.json.code).toBe("parts_in_progress");

    expect((await stub.recordChunkedPart(id, principalId, 1, stored.etag, a.token)).ok).toBe(true);
    // B again: it replaces A's part, and its etag is the one recorded.
    expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
    const done = await api(target, "POST", `/${id}/complete`);
    expect(done.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });
    expect(await repoState(target)).toEqual({ refs: { [MAIN]: fx.c2 }, scratch: [] });
  });

  it("refuses the late record of an upload whose reservation expired and was taken over", async () => {
    const target = await pushTarget();
    const { principalId } = target.owner;
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    const id: string = session.json.id;
    const stub = target.repo.stub;

    const a = await stub.chunkedPartTarget(id, principalId, 1, pack.length);
    if (!a.ok) throw new Error(a.error);
    // A stalls past its reservation; B takes the part over and records it.
    const clock = (offset: number) =>
      inRepo(stub, ({ git }) => {
        (git.context as { now: () => number }).now = () => Date.now() + offset;
      });
    await clock(PART_RESERVATION_MS + 1);
    expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
    // A's bytes land after B's, but on A's own R2 part number: B's stays as recorded.
    const stored = await env.GIT.resumeMultipartUpload(a.key, a.multipartId).uploadPart(
      a.partNumber,
      new Uint8Array(pack.length).fill(7),
    );
    const late = await stub.recordChunkedPart(id, principalId, 1, stored.etag, a.token);
    expect(late).toMatchObject({ ok: false, status: 409, code: "part_superseded" });
    // (Back to the Worker's clock: the commit checks how recent its re-authorization is.)
    await clock(0);
    const done = await api(target, "POST", `/${id}/complete`);
    expect(done.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });
  });

  it("keeps a taken-over part intact when completion comes before the expired upload's record", async () => {
    const target = await pushTarget();
    const { principalId } = target.owner;
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    const id: string = session.json.id;
    const stub = target.repo.stub;

    const a = await stub.chunkedPartTarget(id, principalId, 1, pack.length);
    if (!a.ok) throw new Error(a.error);
    const clock = (offset: number) =>
      inRepo(stub, ({ git }) => {
        (git.context as { now: () => number }).now = () => Date.now() + offset;
      });
    // A stalls past its reservation; B takes the part over and records it.
    await clock(PART_RESERVATION_MS + 1);
    expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
    await clock(0);
    // A's bytes land now, but its record is still on its way when the client completes.
    await env.GIT.resumeMultipartUpload(a.key, a.multipartId).uploadPart(
      a.partNumber,
      new Uint8Array(pack.length).fill(7),
    );
    const done = await api(target, "POST", `/${id}/complete`);
    expect(done.json).toMatchObject({ state: "committed", refs: [{ ref: MAIN, status: "ok" }] });
    // A's record, last: refused, and the committed push is untouched.
    const late = await stub.recordChunkedPart(id, principalId, 1, "etag-of-a", a.token);
    expect(late.ok).toBe(false);
    expect(await repoState(target)).toEqual({ refs: { [MAIN]: fx.c2 }, scratch: [] });
  });

  it("gives each takeover its own R2 part number, a failed upload's back, and refuses past the spares", async () => {
    const target = await pushTarget();
    const { principalId } = target.owner;
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    const id: string = session.json.id;
    const stub = target.repo.stub;
    // Two R2 part numbers per part, as a session of 5,000 parts has.
    await inRepo(stub, ({ git }) => {
      const record = git.uploads.commandsOf(id) as { session: object };
      git.uploads.recordCommands(id, { ...record, session: { ...record.session, stride: 2 } });
    });
    const clock = (offset: number) =>
      inRepo(stub, ({ git }) => {
        (git.context as { now: () => number }).now = () => Date.now() + offset;
      });
    const reserve = async () => {
      const t = await stub.chunkedPartTarget(id, principalId, 1, pack.length);
      if (!t.ok) return t.code;
      return t;
    };
    const a = await reserve();
    expect(a).toMatchObject({ partNumber: 1 });
    await clock(PART_RESERVATION_MS + 1);
    const b = await reserve();
    expect(b).toMatchObject({ partNumber: 2 });
    if (typeof b === "string") throw new Error(b);
    // B's upload fails: its number is handed back.
    await stub.releaseChunkedPart(id, principalId, 1, b.token);
    const c = await reserve();
    expect(c).toMatchObject({ partNumber: 2 });
    await clock(2 * (PART_RESERVATION_MS + 1));
    expect(await reserve()).toBe("part_retries_exhausted");
  });

  it("refuses a part of the wrong length or number, and completion before every part", {
    timeout: 60_000,
  }, async () => {
    const target = await pushTarget();
    const pack = fromHex(cx.bigPack);
    const session = await create(
      target,
      pack,
      [{ ref: MAIN, old: null, new: cx.bigCommit }],
      FIVE_MIB,
    );
    const url = session.json.parts_url;
    const short = await putPart(target, url, 1, pack.subarray(0, 5 * MiB - 1));
    expect(short.status).toBe(422);
    expect(short.json.code).toBe("wrong_part_size");
    expect((await putPart(target, url, 3, pack.subarray(0, 10))).json.code).toBe("invalid_part");
    expect((await putPart(target, url, 0, pack.subarray(0, 10))).json.code).toBe("invalid_part");
    const unsized = await call(
      new Request(`${ORIGIN}${url}/1`, {
        method: "PUT",
        headers: { Authorization: basic(target.owner.token) },
        body: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit),
    );
    expect(unsized.status).toBe(411);

    expect((await putPart(target, url, 2, pack.subarray(5 * MiB))).status).toBe(200);
    const early = await api(target, "POST", `/${session.json.id}/complete`);
    expect(early.status).toBe(409);
    expect(early.json.code).toBe("parts_missing");
    expect(early.json.detail).toContain("1");
  });

  it("aborts: the multipart upload and scratch objects go, later parts are refused", async () => {
    const target = await pushTarget();
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    const aborted = await api(target, "DELETE", `/${session.json.id}`);
    expect(aborted.json).toMatchObject({ state: "rejected", parts_received: [] });
    const late = await putPart(target, session.json.parts_url, 1, pack);
    expect(late.status).toBe(409);
    expect(late.json.code).toBe("upload_closed");
    expect(await repoState(target)).toEqual({ refs: {}, scratch: [] });
    expect((await api(target, "POST", `/${session.json.id}/complete`)).json.state).toBe("rejected");
  });

  it("leaves an expired session to the reaper, which aborts its multipart upload", async () => {
    const target = await pushTarget();
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
    const multipart = await inRepo(target.repo.stub, ({ git }) =>
      git.uploads.multipartOf(session.json.id),
    );
    expect(multipart?.key).toMatch(/\/scratch\/[0-9A-Z]{26}\/pack$/);

    let now = Date.now() + UPLOAD_TTL_MS + 1_000;
    vi.setSystemTime(now);
    // (The test token has expired too, so ask the object directly.)
    const late = await inRepo(target.repo.stub, (repo) =>
      repo.chunkedPartTarget(session.json.id, target.owner.principalId, 1, pack.length),
    );
    expect(late).toMatchObject({ ok: false, code: "upload_expired" });
    for (let i = 0; i < 50; i++) {
      await runDurableObjectAlarm(target.repo.stub);
      const state = await inRepo(
        target.repo.stub,
        ({ git }) => git.jobs.get(ORPHAN_REAPER_JOB_ID)?.state,
      );
      if (state === "done") break;
      now += 2_000;
      vi.setSystemTime(now);
    }
    const left = await inRepo(target.repo.stub, ({ git }) =>
      git.context.storage.sql
        .exec("SELECT count(*) AS n FROM uploads WHERE upload_id = ?", session.json.id)
        .one(),
    );
    expect(left.n).toBe(0);
    expect((await repoState(target)).scratch).toEqual([]);
    const resumed = env.GIT.resumeMultipartUpload(
      (multipart as { key: string }).key,
      (multipart as { multipartId: string }).multipartId,
    );
    await expect(resumed.uploadPart(2, new Uint8Array(16))).rejects.toThrow(/does not exist/);
  });

  it("serves a session only to its principal, and completes only with the token that started it", async () => {
    const target = await pushTarget();
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    const stranger = await principalWithToken("user", "git");
    const part = await putPart(target, session.json.parts_url, 1, pack, { token: stranger.token });
    expect(part.status).toBe(404);
    expect(
      (await api(target, "GET", `/${session.json.id}`, undefined, { token: stranger.token }))
        .status,
    ).toBe(404);

    expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
    const store = (await import("@fyrden/adapters-cloudflare/auth")).D1TokenStore;
    const { createIdFactory, secureRandomBytes } = await import("@fyrden/domain");
    const second = await new store(env.DIRECTORY, {
      clock: () => Date.now(),
      newId: createIdFactory(() => Date.now(), secureRandomBytes),
      randomBytes: secureRandomBytes,
    }).mint({
      principalId: target.owner.principalId,
      type: "pat",
      scopes: [],
      ttlMs: 60_000,
      audit: { actorId: target.owner.principalId },
    });
    const other = await api(target, "POST", `/${session.json.id}/complete`, undefined, {
      token: second.token,
    });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe("wrong_token");
  });

  it("never commits for a token revoked before the commit", async () => {
    const target = await pushTarget();
    const pack = fromHex(fx.packC2);
    const session = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }]);
    expect((await putPart(target, session.json.parts_url, 1, pack)).status).toBe(200);
    const hash = await hashToken(target.owner.token);
    await env.DIRECTORY.prepare("UPDATE tokens SET revoked_at = ? WHERE token_hash = ?")
      .bind(Date.now(), hash)
      .run();
    const done = await api(target, "POST", `/${session.json.id}/complete`);
    expect(done.status).toBe(401);
    expect(await repoState(target)).toMatchObject({ refs: {} });
  });

  it("rejects a pack that fails the push checks, and cleans up", async () => {
    const target = await pushTarget();
    await pushChunked(target, fromHex(fx.packC2), [{ ref: MAIN, old: null, new: fx.c2 }]);
    const done = await pushChunked(target, fromHex(fx.packLoneWithoutTree), [
      { ref: "refs/heads/lone", old: null, new: fx.lone },
    ]);
    expect(done.json.state).toBe("rejected");
    expect(done.json.error).toBeTruthy();
    expect(await repoState(target)).toEqual({ refs: { [MAIN]: fx.c2 }, scratch: [] });
  });

  it("checks the session request", async () => {
    const target = await pushTarget();
    const pack = fromHex(fx.packC2);
    const lone = await create(target, pack, [{ ref: "refs/heads/\ud800", old: null, new: fx.c2 }]);
    expect(lone.status).toBe(422);
    expect(lone.json.detail).toContain("ref name must be valid UTF-8");
    const deletes = await create(target, pack, [{ ref: MAIN, old: fx.c2, new: null }]);
    expect(deletes.json.code).toBe("no_pack_needed");
    const big = await create(target, pack, [{ ref: MAIN, old: null, new: fx.c2 }], {
      GIT_UPLOAD_MAX_BYTES: "100",
    });
    expect(big.json.code).toBe("upload_too_large");
    const bad = await create(target, pack, [{ ref: "refs/heads/a..b", old: null, new: fx.c2 }]);
    // Ref names are checked by the push path, per ref, as git checks them.
    expect(bad.status).toBe(201);
    expect((await putPart(target, bad.json.parts_url, 1, pack)).status).toBe(200);
    const done = await api(target, "POST", `/${bad.json.id}/complete`);
    expect(done.json.state).toBe("rejected");
    expect(done.json.refs[0]).toMatchObject({ ref: "refs/heads/a..b", status: "rejected" });
  });
});
