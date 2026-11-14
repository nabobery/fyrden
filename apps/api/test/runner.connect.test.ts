// Connect unary framing for the runner protocol: which requests are refused,
// the error bodies, and bounded body reads.
import { describe, expect, it } from "vitest";
import {
  CONNECT_HTTP_STATUS,
  checkConnectRequest,
  connectError,
  MAX_SMALL_CALL_BYTES,
  MAX_UPDATE_TASK_BYTES,
  protoResponse,
  readPrefix,
  UPDATE_LOG_PREFIX_BYTES,
} from "../src/runner/connect.js";

const ENDPOINT = "https://fyrden.test/api/actions/runner.v1.RunnerService/FetchTask";

function request(init: { method?: string; headers?: Record<string, string> } = {}): Request {
  const method = init.method ?? "POST";
  const headers = { "content-type": "application/proto", ...init.headers };
  if (method === "GET" || method === "HEAD") return new Request(ENDPOINT, { method, headers });
  return new Request(ENDPOINT, { method, headers, body: new Uint8Array([8, 1]) });
}

async function expectConnectError(response: Response | undefined, code: string, status: number) {
  expect(response).toBeDefined();
  expect(response?.status).toBe(status);
  expect(response?.headers.get("content-type")).toBe("application/json");
  const body = (await response?.json()) as { code: string; message: string };
  expect(body.code).toBe(code);
  expect(typeof body.message).toBe("string");
  return body;
}

describe("the request check", () => {
  it("accepts a binary protobuf POST", () => {
    expect(checkConnectRequest(request())).toBeUndefined();
    expect(
      checkConnectRequest(request({ headers: { "content-type": "Application/Proto" } })),
    ).toBeUndefined();
  });

  it("accepts identity encodings", () => {
    const identity = { "content-encoding": "identity", "connect-content-encoding": "identity" };
    expect(checkConnectRequest(request({ headers: identity }))).toBeUndefined();
  });

  it.each([
    ["JSON", "application/json"],
    ["Connect streaming", "application/connect+proto"],
    ["a look-alike", "application/protobuf"],
    ["nothing", ""],
  ])("refuses %s as unimplemented", async (_what, contentType) => {
    const body = await expectConnectError(
      checkConnectRequest(request({ headers: { "content-type": contentType } })),
      "unimplemented",
      501,
    );
    expect(body.message).toBe("only binary protobuf is supported");
  });

  it.each([
    ["content-encoding", "gzip"],
    ["connect-content-encoding", "gzip"],
    ["content-encoding", "br"],
  ])("refuses %s %s as unimplemented", async (header, value) => {
    await expectConnectError(
      checkConnectRequest(request({ headers: { [header]: value } })),
      "unimplemented",
      501,
    );
  });

  it.each(["GET", "PUT", "HEAD"])("refuses %s with 405", (method) => {
    const response = checkConnectRequest(request({ method }));
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("POST");
  });
});

describe("responses", () => {
  const table: [string, number][] = [
    ["canceled", 499],
    ["unknown", 500],
    ["invalid_argument", 400],
    ["deadline_exceeded", 504],
    ["not_found", 404],
    ["already_exists", 409],
    ["permission_denied", 403],
    ["resource_exhausted", 429],
    ["failed_precondition", 400],
    ["aborted", 409],
    ["out_of_range", 400],
    ["unimplemented", 501],
    ["internal", 500],
    ["unavailable", 503],
    ["data_loss", 500],
    ["unauthenticated", 401],
  ];

  it("maps every Connect code to its HTTP status", () => {
    expect(Object.entries(CONNECT_HTTP_STATUS).sort()).toEqual([...table].sort());
  });

  it.each(table)("an error with code %s is Connect JSON with status %i", async (code, status) => {
    const response = connectError(code as keyof typeof CONNECT_HTTP_STATUS, `about ${code}`);
    const body = await expectConnectError(response, code, status);
    expect(body).toEqual({ code, message: `about ${code}` });
  });

  it("a protobuf response", async () => {
    const response = protoResponse(new Uint8Array([8, 152, 1]));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/proto");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([8, 152, 1]));
  });
});

describe("readPrefix", () => {
  /** A body streamed in chunks of `chunk` bytes (byte i is i % 251), counting reads and cancels. */
  function streamed(total: number, chunk: number, headers: Record<string, string> = {}) {
    const seen = { pulls: 0, cancelled: false };
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        seen.pulls++;
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, total - sent);
        controller.enqueue(Uint8Array.from({ length: size }, (_, i) => (sent + i) % 251));
        sent += size;
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    return { input: { headers: new Headers(headers), body }, seen };
  }
  const expected = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

  it.each([
    ["below the cap", 99, 7],
    ["at the cap", 100, 7],
    ["at the cap, in one chunk", 100, 100],
  ])("reads a body %s whole", async (_what, total, chunk) => {
    const { input } = streamed(total, chunk);
    expect(await readPrefix(input, 100)).toEqual({ bytes: expected(total), truncated: false });
  });

  it.each([
    ["by one byte", 101, 7],
    ["in one large chunk", 1000, 1000],
    ["in small chunks", 1000, 3],
  ])("keeps the first maxBytes of a body over the cap %s", async (_what, total, chunk) => {
    const { input, seen } = streamed(total, chunk);
    expect(await readPrefix(input, 100)).toEqual({ bytes: expected(100), truncated: true });
    expect(seen.cancelled).toBe(true);
  });

  it("stops reading an endless body once past the cap", async () => {
    const { input, seen } = streamed(Number.POSITIVE_INFINITY, 4);
    const prefix = await readPrefix(input, 100);
    expect(prefix.truncated).toBe(true);
    expect(prefix.bytes.length).toBe(100);
    expect(seen.cancelled).toBe(true);
    // 25 reads fill the cap, one more shows there is more; the stream may pull ahead by one.
    expect(seen.pulls).toBeLessThanOrEqual(28);
  });

  it("reads a body declared longer than the cap as a prefix", async () => {
    const { input } = streamed(150, 10, { "content-length": "150" });
    expect(await readPrefix(input, 100)).toEqual({ bytes: expected(100), truncated: true });
  });

  it("copies each chunk as it is read, keeping no reference to it", async () => {
    // A source that scribbles over each chunk two pulls later, when the
    // reader has certainly finished with it (pull k follows the read of
    // chunk k - 1, which follows the processing of chunk k - 2). Holding
    // chunks by reference until the end would return the scribbled bytes.
    const sentChunks: Uint8Array[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const k = sentChunks.length;
        const old = sentChunks[k - 2];
        if (old) old.fill(0xff);
        if (k === 300) return controller.close();
        const chunk = Uint8Array.of(k % 251);
        sentChunks.push(chunk);
        controller.enqueue(chunk);
      },
    });
    expect(await readPrefix({ body }, 200)).toEqual({ bytes: expected(200), truncated: true });
  });

  it("returns bytes backed by no more than they hold", async () => {
    const { input } = streamed(16 * 1024, 16 * 1024);
    const prefix = await readPrefix(input, 100);
    expect(prefix.bytes.length).toBe(100);
    expect(prefix.bytes.buffer.byteLength).toBe(100);
  });

  it("reads no body as empty", async () => {
    expect(await readPrefix({ body: null }, 100)).toEqual({
      bytes: new Uint8Array(0),
      truncated: false,
    });
  });

  it("reads a Request's body", async () => {
    expect(await readPrefix(request(), 100)).toEqual({
      bytes: new Uint8Array([8, 1]),
      truncated: false,
    });
  });

  it("caps bodies as the protocol's calls need", () => {
    expect(MAX_SMALL_CALL_BYTES).toBe(64 * 1024);
    expect(MAX_UPDATE_TASK_BYTES).toBe(1.25 * 1024 * 1024);
    expect(UPDATE_LOG_PREFIX_BYTES).toBe(4 * 1024 * 1024);
  });
});
