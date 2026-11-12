// A release asset's upload from the browser, driven against a fake fetch: the
// session through the page's own route, parts straight to the API two at a
// time with their exact bytes, a failed part retried three times and a
// rate-limited one after the time it was told, Retry sending only what is
// missing, and completion keyed once per request: the same key to retry it,
// a new one only when its outcome was never learnt. Waits are recorded, not
// slept.

import { describe, expect, it } from "vitest";
import {
  abandonUpload,
  newUpload,
  partUrl,
  runUpload,
  type UploadDeps,
  type UploadProgress,
} from "../app/lib/asset-upload.js";

const AT = { owner: "ada", repo: "demo", releaseId: 7 };
const ROUTE = "/ada/demo/releases/uploads";
const ID = "01HZZZZZZZZZZZZZZZZZZZZZZZ";
const PART = 5;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const session = (fields: Record<string, unknown> = {}) => ({
  id: ID,
  release_id: AT.releaseId,
  name: "a.zip",
  content_type: "application/zip",
  size: 12,
  part_size: PART,
  part_count: 3,
  state: "receiving",
  parts_url: "ignored",
  expires_at: 1,
  ...fields,
});

const ASSET = {
  id: 3,
  name: "a.zip",
  content_type: "application/zip",
  size: 12,
  uploader: { id: "u" },
  created_at: 1,
  updated_at: 1,
  download_url: "ignored",
};

type Reply = Response | Error | ((request: Request) => Promise<Response> | Response);

/**
 * A fetch answering by request: `parts[n]` in turn for part n (default: its etag), and `route`
 * in turn for the page's route (default: a session, then completed). Records every request.
 */
function server(replies: { parts?: Record<number, Reply[]>; route?: Reply[] } = {}, size = 12) {
  const sent: { request: Request; body: string }[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const keys = (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })();
  const waits: number[] = [];
  const answer = async (reply: Reply, request: Request) =>
    reply instanceof Error
      ? Promise.reject(reply)
      : typeof reply === "function"
        ? reply(request)
        : reply;
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(new URL(String(input), "https://fyrden.test"), init);
    const body = init?.body instanceof Blob ? await init.body.text() : await request.clone().text();
    sent.push({ request, body });
    const path = new URL(request.url).pathname;
    const part = /\/parts\/(\d+)$/.exec(path);
    if (part) {
      const n = Number(part[1]);
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        // Lets the other part start: the concurrency is what's measured.
        await Promise.resolve();
        const reply = replies.parts?.[n]?.shift();
        return reply ? await answer(reply, request) : json({ part_number: n, etag: `e${n}` });
      } finally {
        inFlight--;
      }
    }
    expect(path).toBe(ROUTE);
    const reply = replies.route?.shift();
    if (reply) return answer(reply, request);
    const intent = JSON.parse(body).intent;
    return intent === "begin"
      ? json(session({ size }), 201)
      : json(session({ size, state: "completed", asset: ASSET }));
  };
  const deps: UploadDeps = {
    fetch,
    wait: async (ms) => {
      waits.push(ms);
    },
    newKey: keys,
  };
  const routeCalls = () =>
    sent
      .filter((s) => new URL(s.request.url).pathname === ROUTE)
      .map((s) => JSON.parse(s.body) as Record<string, unknown>);
  const partCalls = () => sent.filter((s) => /\/parts\/\d+$/.test(s.request.url));
  return { deps, sent, waits, routeCalls, partCalls, mostInFlight: () => mostInFlight };
}

const file = (text = "aaaaabbbbbcc", type = "application/zip") =>
  new File([text], "a.zip", { type });

describe("an asset's upload", () => {
  it("begins through the page's route, sends each part's exact bytes two at a time, and completes with their etags in order", async () => {
    const fake = server();
    const progress: UploadProgress[] = [];
    const upload = newUpload(AT, file(), { replace: false });
    const result = await runUpload(upload, fake.deps, { onProgress: (p) => progress.push(p) });
    expect(result).toEqual({ ok: true, asset: ASSET });
    const [begin, complete] = fake.routeCalls();
    expect(begin).toEqual({
      intent: "begin",
      release_id: 7,
      name: "a.zip",
      size: 12,
      content_type: "application/zip",
      replace: false,
      key: "00000000-0000-4000-8000-000000000001",
    });
    expect(complete).toEqual({
      intent: "complete",
      upload_id: ID,
      parts: [
        { part_number: 1, etag: "e1" },
        { part_number: 2, etag: "e2" },
        { part_number: 3, etag: "e3" },
      ],
      key: "00000000-0000-4000-8000-000000000002",
    });
    const parts = fake.partCalls();
    expect(parts.map((p) => [p.request.method, new URL(p.request.url).pathname, p.body])).toEqual([
      ["PUT", partUrl(AT, ID, 1), "aaaaa"],
      ["PUT", partUrl(AT, ID, 2), "bbbbb"],
      ["PUT", partUrl(AT, ID, 3), "cc"],
    ]);
    for (const p of parts) expect(p.request.headers.get("X-Fyrden-Session")).toBe("1");
    expect(fake.mostInFlight()).toBe(2);
    expect(partUrl(AT, ID, 2)).toBe(`/api/repos/ada/demo/releases/assets/uploads/${ID}/parts/2`);
    expect(progress.at(-1)).toEqual({ sent: 12, size: 12, state: "done" });
    expect(progress.map((p) => p.sent)).toEqual(
      [...progress.map((p) => p.sent)].sort((a, b) => a - b),
    );
    expect(fake.waits).toEqual([]);
  });

  it("says it replaces, and leaves out a type the API wouldn't take", async () => {
    const fake = server();
    await runUpload(
      newUpload(AT, file("x".repeat(12), "text/html; charset=utf-8"), { replace: true }),
      fake.deps,
    );
    expect(fake.routeCalls()[0]).toMatchObject({ replace: true });
    expect(fake.routeCalls()[0]).not.toHaveProperty("content_type");
  });

  it("refuses an empty file and a name the API refuses, before asking for anything", async () => {
    const fake = server();
    expect(
      await runUpload(newUpload(AT, new File([], "e.bin"), { replace: false }), fake.deps),
    ).toMatchObject({
      ok: false,
      kind: "fatal",
      message: expect.stringContaining("empty"),
    });
    expect(
      await runUpload(newUpload(AT, new File(["x"], "a‮txt.exe"), { replace: false }), fake.deps),
    ).toMatchObject({ ok: false, kind: "fatal" });
    expect(fake.sent).toEqual([]);
  });

  it("retries a failed part three times, then stops; Retry sends only what is missing", async () => {
    const down = () => json({ code: "part_not_stored", detail: "again" }, 400);
    const fake = server({
      parts: { 2: [new TypeError("offline"), down(), json({}, 502), down()] },
    });
    const upload = newUpload(AT, file(), { replace: false });
    const first = await runUpload(upload, fake.deps);
    expect(first).toMatchObject({ ok: false, kind: "retryable" });
    // Four tries of part 2: the first and three retries.
    expect(fake.partCalls().filter((p) => p.request.url.endsWith("/parts/2"))).toHaveLength(4);
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin"]);

    const before = fake.partCalls().length;
    const second = await runUpload(upload, fake.deps);
    expect(second).toEqual({ ok: true, asset: ASSET });
    expect(
      fake
        .partCalls()
        .slice(before)
        .map((p) => new URL(p.request.url).pathname),
    ).toEqual([partUrl(AT, ID, 2)]);
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin", "complete"]);
  });

  it("waits as long as a rate-limited part is told, without spending a retry on it", async () => {
    const limited = () => json({ code: "rate_limited" }, 429, { "Retry-After": "7" });
    const fake = server({ parts: { 1: [limited(), limited(), limited(), limited()] } });
    expect(await runUpload(newUpload(AT, file(), { replace: false }), fake.deps)).toMatchObject({
      ok: true,
    });
    expect(fake.waits).toEqual([7000, 7000, 7000, 7000]);
  });

  it("stops at a part the API refuses for good, and frees the session", async () => {
    const gone = () => json({ code: "upload_not_found", detail: "No such upload session." }, 404);
    const fake = server({ parts: { 1: [gone()] } });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps);
    expect(result).toMatchObject({ ok: false, kind: "fatal", message: "No such upload session." });
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin", "abort"]);
  });

  it("completes again with the same key while it is completing or the API is briefly unable", async () => {
    const fake = server({
      route: [
        json(session(), 201),
        json(session({ state: "completing" })),
        json({ code: "quota_unavailable", detail: "later" }, 503, { "Retry-After": "2" }),
        json({ code: "idempotency_key_in_use", detail: "running" }, 409),
        json({ code: "release_asset_transferring", detail: "moving" }, 409),
        new TypeError("offline"),
        json(session({ state: "completed", asset: ASSET })),
      ],
    });
    expect(await runUpload(newUpload(AT, file(), { replace: false }), fake.deps)).toEqual({
      ok: true,
      asset: ASSET,
    });
    const keys = fake
      .routeCalls()
      .slice(1)
      .map((c) => c.key);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(1);
    expect(fake.waits).toContain(2000);
  });

  it("asks again with a new key, and the same parts, when the first one's outcome was never learnt", async () => {
    const fake = server({
      route: [
        json(session(), 201),
        json({ code: "idempotent_outcome_unknown", detail: "unknown" }, 409),
        json(session({ state: "completed", asset: ASSET })),
      ],
    });
    expect(await runUpload(newUpload(AT, file(), { replace: false }), fake.deps)).toMatchObject({
      ok: true,
    });
    const [, first, second] = fake.routeCalls();
    expect(first?.key).not.toBe(second?.key);
    expect(second?.parts).toEqual(first?.parts);
  });

  it("keeps a completion's key for Retry after it gave up, and takes a new one only for new parts", async () => {
    const busy = () => json(session({ state: "completing" }));
    const fake = server({ route: [json(session(), 201), ...Array.from({ length: 30 }, busy)] });
    const upload = newUpload(AT, file(), { replace: false });
    expect(await runUpload(upload, fake.deps)).toMatchObject({ ok: false, kind: "retryable" });
    const tried = fake.routeCalls().filter((c) => c.intent === "complete");
    expect(new Set(tried.map((c) => c.key)).size).toBe(1);
    expect(await runUpload(upload, fake.deps)).toMatchObject({ ok: true });
    const last = fake.routeCalls().at(-1);
    expect(last?.key).toBe(tried[0]?.key);
  });

  it("says to start again when the session was signed in afresh, and when the upload ended", async () => {
    const wrongToken = server({
      route: [json(session(), 201), json({ code: "wrong_token", detail: "Another token." }, 409)],
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), wrongToken.deps);
    expect(result).toMatchObject({ ok: false, kind: "fatal" });
    expect(result.ok ? "" : result.message).toMatch(/signed in again/i);

    const ended = server({
      route: [json(session(), 201), json(session({ state: "aborted" }))],
    });
    expect(await runUpload(newUpload(AT, file(), { replace: false }), ended.deps)).toMatchObject({
      ok: false,
      kind: "fatal",
    });
  });

  it("passes on a refusal at the start, and a sign-in needed", async () => {
    const taken = server({
      route: [json({ code: "asset_name_taken", detail: "a.zip is taken." }, 422)],
    });
    expect(await runUpload(newUpload(AT, file(), { replace: false }), taken.deps)).toEqual({
      ok: false,
      kind: "fatal",
      message: "a.zip is taken.",
    });
    const out = server({ route: [json({ code: "invalid_token" }, 401)] });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), out.deps);
    expect(result).toMatchObject({ ok: false, kind: "fatal" });
    expect(result.ok ? "" : result.message).toMatch(/sign in/i);
  });

  it("stops when cancelled, and ends the session", async () => {
    const stop = new AbortController();
    const fake = server({
      parts: {
        1: [
          (request) =>
            new Promise<Response>((_, fail) => {
              stop.abort();
              request.signal.addEventListener("abort", () =>
                fail(new DOMException("", "AbortError")),
              );
              if (request.signal.aborted) fail(new DOMException("", "AbortError"));
            }),
        ],
      },
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toEqual({ ok: false, kind: "cancelled", message: "Cancelled." });
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin", "abort"]);
  });

  it("ends a stopped upload's session when it is let go, and asks nothing when it has none", async () => {
    const fake = server({ parts: { 2: Array.from({ length: 4 }, () => json({}, 502)) } });
    const upload = newUpload(AT, file(), { replace: false });
    expect(await runUpload(upload, fake.deps)).toMatchObject({ kind: "retryable" });
    await abandonUpload(upload, fake.deps);
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin", "abort"]);
    expect(fake.routeCalls()[1]).toEqual({ intent: "abort", upload_id: ID });
    await abandonUpload(upload, fake.deps);
    expect(fake.routeCalls()).toHaveLength(2);
  });

  it("keeps the session through a completion's unexpected failure, retrying it with its key until its outcome is known", async () => {
    const fake = server({
      route: [
        json(session(), 201),
        json({ code: "internal_error", detail: "Something failed." }, 500),
        new Response("bad gateway", { status: 502 }),
        json({ code: "idempotent_outcome_unknown", detail: "unknown" }, 409),
        json(session({ state: "completed", asset: ASSET })),
      ],
    });
    expect(await runUpload(newUpload(AT, file(), { replace: false }), fake.deps)).toEqual({
      ok: true,
      asset: ASSET,
    });
    const calls = fake.routeCalls();
    expect(calls.map((c) => c.intent)).toEqual([
      "begin",
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
    const keys = calls.slice(1).map((c) => c.key);
    // The same key until the API says the outcome is unknown, then a new one.
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    expect(keys[3]).not.toBe(keys[2]);
  });

  it("is cancelled, and ends its session, even after another part had already failed", async () => {
    const stop = new AbortController();
    let failedFirst: () => void = () => {};
    const otherFailed = new Promise<void>((done) => {
      failedFirst = done;
    });
    const fake = server({
      parts: {
        // Answered with no etag: that part stops the upload, retryable.
        1: [
          () => {
            failedFirst();
            return json({ part_number: 1 });
          },
        ],
        // Still sending when Cancel comes.
        2: [
          (request) =>
            new Promise<Response>((_, fail) => {
              void otherFailed
                // One turn of the event loop: the failed part's answer is read and its
                // error recorded first, the order a person's late Cancel comes in.
                .then(() => new Promise((turned) => setImmediate(turned)))
                .then(() => stop.abort());
              request.signal.addEventListener("abort", () =>
                fail(new DOMException("", "AbortError")),
              );
            }),
        ],
      },
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toEqual({ ok: false, kind: "cancelled", message: "Cancelled." });
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin", "abort"]);
  });

  it("says when it finished before a Cancel could end it", async () => {
    const stop = new AbortController();
    const fake = server({
      route: [
        json(session(), 201),
        // The completion lands on the server; its answer is still on its way when Cancel comes.
        (request) =>
          new Promise<Response>((_, fail) => {
            request.signal.addEventListener("abort", () =>
              fail(new DOMException("", "AbortError")),
            );
            stop.abort();
          }),
        json({ code: "upload_completed", detail: "The upload made its asset already." }, 409),
      ],
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toMatchObject({ ok: false, kind: "fatal" });
    expect(result.ok ? "" : result.message).toMatch(
      /finished uploading before it could be cancelled/,
    );
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin", "complete", "abort"]);
  });

  it("doesn't say cancelled when ending the session couldn't be confirmed", async () => {
    const stop = new AbortController();
    const fake = server({
      parts: {
        1: [
          (request) =>
            new Promise<Response>((_, fail) => {
              request.signal.addEventListener("abort", () =>
                fail(new DOMException("", "AbortError")),
              );
              stop.abort();
            }),
        ],
      },
      route: [json(session(), 201), new TypeError("offline")],
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toMatchObject({ ok: false, kind: "fatal" });
    expect(result.ok ? "" : result.message).toMatch(/may not have ended/);
  });

  it("doesn't take a refusal that hides why for an ended session", async () => {
    for (const refusal of [
      json({ code: "repo_not_found", detail: "No repository ada/demo was found." }, 404),
      json({ code: "upload_not_found", detail: "No such upload session." }, 404),
      new Response("not found", { status: 404 }),
    ]) {
      const stop = new AbortController();
      const fake = server({
        parts: {
          1: [
            (request) =>
              new Promise<Response>((_, fail) => {
                request.signal.addEventListener("abort", () =>
                  fail(new DOMException("", "AbortError")),
                );
                stop.abort();
              }),
          ],
        },
        route: [json(session(), 201), refusal],
      });
      const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
        signal: stop.signal,
      });
      expect(result).toMatchObject({ ok: false, kind: "fatal" });
      expect(result.ok ? "" : result.message).toMatch(/may not have ended/);
    }
  });

  it("ends a session the API began while a Cancel was on its way", async () => {
    const stop = new AbortController();
    const fake = server({
      route: [
        // The API makes the session; the Cancel comes before the page reads the answer.
        (request) => {
          stop.abort();
          if (request.signal.aborted) throw new DOMException("", "AbortError");
          return json(session(), 201);
        },
      ],
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toEqual({ ok: false, kind: "cancelled", message: "Cancelled." });
    expect(fake.routeCalls()).toEqual([
      expect.objectContaining({ intent: "begin" }),
      { intent: "abort", upload_id: ID },
    ]);
    expect(fake.partCalls()).toEqual([]);
  });

  it("says cancelled when a Cancel came while the start was refused", async () => {
    const stop = new AbortController();
    const fake = server({
      route: [
        () => {
          stop.abort();
          return json({ code: "too_many_uploads", detail: "Too many." }, 409);
        },
      ],
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toEqual({ ok: false, kind: "cancelled", message: "Cancelled." });
    expect(fake.routeCalls().map((c) => c.intent)).toEqual(["begin"]);
  });

  it("waits for nothing once cancelled", async () => {
    const stop = new AbortController();
    const fake = server({
      parts: {
        1: [
          () => {
            stop.abort();
            return json({ code: "internal" }, 503);
          },
        ],
      },
    });
    const result = await runUpload(newUpload(AT, file(), { replace: false }), fake.deps, {
      signal: stop.signal,
    });
    expect(result).toEqual({ ok: false, kind: "cancelled", message: "Cancelled." });
    expect(fake.waits).toEqual([]);
  });

  it("lets Retry begin again when the repository had too many uploads open", async () => {
    const fake = server({
      route: [
        json(
          {
            code: "too_many_uploads",
            detail: "The repository has 20 uploads open. Finish or abort one first.",
          },
          409,
        ),
      ],
    });
    const upload = newUpload(AT, file(), { replace: false });
    expect(await runUpload(upload, fake.deps)).toEqual({
      ok: false,
      kind: "retryable",
      message: "The repository has 20 uploads open. Finish or abort one first.",
    });
    expect(await runUpload(upload, fake.deps)).toMatchObject({ ok: true });
    const calls = fake.routeCalls();
    expect(calls.map((c) => c.intent)).toEqual(["begin", "begin", "complete"]);
    // The refusal was the first key's answer, which the API keeps: a new start, a new key.
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
  });

  it("starts again with the same key when the start's answer never came, so the API answers the session it made", async () => {
    const fake = server({ route: [new TypeError("network")] });
    const upload = newUpload(AT, file(), { replace: false });
    await expect(runUpload(upload, fake.deps)).rejects.toThrow("network");
    expect(await runUpload(upload, fake.deps)).toMatchObject({ ok: true });
    const [first, again, complete] = fake.routeCalls();
    expect([first?.intent, again?.intent, complete?.intent]).toEqual([
      "begin",
      "begin",
      "complete",
    ]);
    expect(again?.key).toBe(first?.key);
    // Learnt, the session's key is done with; a later start makes its own.
    expect(complete?.key).not.toBe(first?.key);
    expect(upload.beginKey).toBeNull();
  });

  it("keeps a session whose ending wasn't confirmed, so ending it can be asked again", async () => {
    const stop = new AbortController();
    const fake = server({
      parts: {
        1: [
          (request) =>
            new Promise<Response>((_, fail) => {
              request.signal.addEventListener("abort", () =>
                fail(new DOMException("", "AbortError")),
              );
              stop.abort();
            }),
        ],
      },
      route: [json(session(), 201), new TypeError("offline")],
    });
    const upload = newUpload(AT, file(), { replace: false });
    const result = await runUpload(upload, fake.deps, { signal: stop.signal });
    expect(result.ok ? "" : result.message).toMatch(/may not have ended/);
    expect(upload.session?.id).toBe(ID);
    // Asked again, online: ended, and let go.
    expect(await abandonUpload(upload, fake.deps)).toEqual({
      ok: false,
      kind: "cancelled",
      message: "Cancelled.",
    });
    expect(fake.routeCalls().slice(1)).toEqual([
      { intent: "abort", upload_id: ID },
      { intent: "abort", upload_id: ID },
    ]);
    expect(upload.session).toBeNull();
  });

  it("asks to start and to end so that the request outlives the page, parts and completion not", async () => {
    const stop = new AbortController();
    const fake = server({ parts: { 2: Array.from({ length: 4 }, () => json({}, 502)) } });
    const upload = newUpload(AT, file(), { replace: false });
    await runUpload(upload, fake.deps);
    await abandonUpload(upload, fake.deps);
    const cancelled = server({
      parts: {
        1: [
          () => {
            stop.abort();
            return json({ code: "internal" }, 503);
          },
        ],
      },
    });
    await runUpload(newUpload(AT, file(), { replace: false }), cancelled.deps, {
      signal: stop.signal,
    });
    const done = server();
    await runUpload(newUpload(AT, file(), { replace: false }), done.deps);
    const kept = (sent: { request: Request; body: string }[]) =>
      sent.map((s) => [JSON.parse(s.body || "{}").intent ?? "part", s.request.keepalive]);
    expect(kept(fake.sent.filter((s) => !/parts/.test(s.request.url)))).toEqual([
      ["begin", true],
      ["abort", true],
    ]);
    expect(kept(cancelled.sent.filter((s) => !/parts/.test(s.request.url)))).toEqual([
      ["begin", true],
      ["abort", true],
    ]);
    expect(kept(done.sent.filter((s) => !/parts/.test(s.request.url)))).toEqual([
      ["begin", true],
      ["complete", false],
    ]);
    expect(done.partCalls().map((p) => p.request.keepalive)).toEqual([false, false, false]);
  });

  it("keeps the start's key while the start it lost is still running, so Retry gets its session", async () => {
    const fake = server({
      route: [
        new TypeError("network"),
        json({ code: "idempotency_key_in_use", detail: "Still running." }, 409, {
          "Retry-After": "5",
        }),
      ],
    });
    const upload = newUpload(AT, file(), { replace: false });
    await expect(runUpload(upload, fake.deps)).rejects.toThrow("network");
    expect(await runUpload(upload, fake.deps)).toMatchObject({ ok: false, kind: "retryable" });
    expect(await runUpload(upload, fake.deps)).toMatchObject({ ok: true });
    const begins = fake.routeCalls().filter((c) => c.intent === "begin");
    expect(begins).toHaveLength(3);
    expect(new Set(begins.map((c) => c.key)).size).toBe(1);
  });
});
