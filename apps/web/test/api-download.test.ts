// How a download reaches the API through the binding. Raw files and archives
// forward no condition and no range, or a browser's `If-None-Match` would turn
// their 200 into a 304; only a caller that asks for it sends them on.
import { describe, expect, it } from "vitest";
import { ASSET_DOWNLOAD, apiDownload } from "../app/lib/api.server.js";
import { loader as archive } from "../app/routes/repo.archive.js";
import { loader as raw } from "../app/routes/repo.raw.js";
import { fakeApi, ORIGIN } from "./helpers/context.js";

const CONDITIONS = {
  Range: "bytes=0-1",
  "If-Range": '"tag"',
  "If-Match": '"tag"',
  "If-None-Match": '"tag"',
  "If-Modified-Since": "Sat, 07 Nov 2026 12:00:00 GMT",
  "If-Unmodified-Since": "Sat, 07 Nov 2026 12:00:00 GMT",
};
const whole = () =>
  new Response("whole file", {
    headers: { "Content-Type": "application/octet-stream", ETag: '"tag"' },
  });

describe("raw files and archives", () => {
  const routes: [string, string, (context: unknown, request: Request) => Promise<Response>][] = [
    [
      "raw",
      "/ada/demo/raw/main/a.bin",
      (context, request) =>
        Promise.resolve(
          raw({
            request,
            context,
            params: { owner: "ada", repo: "demo", ref: "main", "*": "a.bin" },
          } as unknown as Parameters<typeof raw>[0]),
        ),
    ],
    [
      "archive",
      "/ada/demo/archive/zip?ref=main",
      (context, request) =>
        archive({
          request,
          context,
          params: { owner: "ada", repo: "demo", format: "zip" },
        } as unknown as Parameters<typeof archive>[0]),
    ],
  ];

  it.each(routes)("%s forwards neither conditions nor a range", async (_name, path, load) => {
    const { context, calls } = fakeApi(whole);
    const res = await load(context, new Request(`${ORIGIN}${path}`, { headers: CONDITIONS }));
    for (const name of Object.keys(CONDITIONS)) {
      expect(calls[0]?.headers.get(name), name).toBeNull();
    }
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("whole file");
  });

  it.each(routes)("%s asks with GET, even for HEAD", async (_name, path, load) => {
    const { context, calls } = fakeApi(whole);
    await load(context, new Request(`${ORIGIN}${path}`, { method: "HEAD" }));
    expect(calls[0]?.method).toBe("GET");
  });

  it.each(routes)(
    "%s copies none of what only a resumable download answers",
    async (_name, path, load) => {
      const { context } = fakeApi(
        () =>
          new Response("x", {
            headers: {
              "Content-Range": "bytes 0-0/1",
              "Accept-Ranges": "bytes",
              "Last-Modified": CONDITIONS["If-Modified-Since"],
              "X-Frame-Options": "DENY",
              "Cross-Origin-Resource-Policy": "same-origin",
            },
          }),
      );
      const res = await load(context, new Request(`${ORIGIN}${path}`));
      for (const name of ASSET_DOWNLOAD.expose) {
        expect(res.headers.get(name), name).toBeNull();
      }
    },
  );
});

describe("a download that asks for ASSET_DOWNLOAD", () => {
  type Context = Parameters<typeof apiDownload>[0];
  const asset = async (answer: () => Response, init: RequestInit = {}) => {
    const { context, calls } = fakeApi(answer);
    const request = new Request(`${ORIGIN}/ada/demo/releases/download/v1/a.zip`, init);
    const res = await apiDownload(
      context as unknown as Context,
      request,
      "/repos/ada/demo/releases/download/v1/a.zip",
      ASSET_DOWNLOAD,
    );
    return { res, call: calls[0] };
  };

  it("forwards each condition and the range, beside the session", async () => {
    const { call } = await asset(whole, {
      headers: { ...CONDITIONS, Cookie: "c=1", "X-Other": "no" },
    });
    for (const [name, value] of Object.entries(CONDITIONS)) {
      expect(call?.headers.get(name), name).toBe(value);
    }
    expect(call?.headers.get("Cookie")).toBe("c=1");
    expect(call?.headers.get("X-Fyrden-Session")).toBe("1");
    expect(call?.headers.get("X-Other")).toBeNull();
  });

  it("sends HEAD as HEAD", async () => {
    const { call } = await asset(() => new Response(null, { status: 200 }), { method: "HEAD" });
    expect(call?.method).toBe("HEAD");
  });

  it("gives back a partial answer, its headers and its bytes", async () => {
    const { res } = await asset(
      () =>
        new Response("ab", {
          status: 206,
          headers: {
            "Content-Length": "2",
            "Content-Range": "bytes 0-1/10",
            "Accept-Ranges": "bytes",
            "Last-Modified": CONDITIONS["If-Modified-Since"],
            "X-Frame-Options": "DENY",
            "Cross-Origin-Resource-Policy": "same-origin",
            ETag: '"tag"',
          },
        }),
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("ab");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1/10");
    expect(res.headers.get("Content-Length")).toBe("2");
    for (const name of ASSET_DOWNLOAD.expose) {
      expect(res.headers.get(name), name).not.toBeNull();
    }
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("gives back a 304 with its validator", async () => {
    const { res } = await asset(
      () => new Response(null, { status: 304, headers: { ETag: '"tag"' } }),
    );
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"tag"');
  });

  it.each([
    [412, {}],
    [416, { "Content-Range": "bytes */10" }],
  ])("drops what a %i's body says", async (status, headers) => {
    const { res } = await asset(
      () => new Response("from the API", { status, headers: { ...headers, ETag: '"tag"' } }),
    );
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
    expect(res.headers.get("ETag")).toBe('"tag"');
    for (const [name, value] of Object.entries(headers)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });
});
