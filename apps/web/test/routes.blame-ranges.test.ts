// Blame's ranges for the browser: one API call per request, at the commit and path the URL
// names, passed through unread with its status, Retry-After and body.

import { describe, expect, it, vi } from "vitest";
import { loader } from "../app/routes/repo.blame-ranges.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";

const COMMIT = "c".repeat(40);

function get(
  answer: () => Response,
  path = `/ada/demo/blame-ranges/${COMMIT}/src/my%20file.ts/`,
  query = "",
) {
  const { context, calls } = fakeApi(answer);
  const response = loader({
    request: new Request(`${ORIGIN}${path}${query}`, { headers: { Cookie: "s=viewer" } }),
    context,
    params: { owner: "ada", repo: "demo" },
    // biome-ignore lint/suspicious/noExplicitAny: the generated argument's other fields go unread
  } as any);
  return { response, calls };
}

describe("blame's ranges for the browser", () => {
  it("asks blame as the viewer, at the URL's commit and path, with only what the page may pass", async () => {
    const { response, calls } = get(
      () => json({}),
      undefined,
      "?continuation=t%2B1&per_page=5000&line_start=1&line_end=9&ref=main&path=other&evil=1",
    );
    await response;
    expect(calls).toHaveLength(1);
    const call = calls[0] as Request;
    const url = new URL(call.url);
    expect(url.pathname).toBe("/api/repos/ada/demo/blame");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      path: "src/my file.ts",
      ref: COMMIT,
      continuation: "t+1",
      per_page: "5000",
      line_start: "1",
      line_end: "9",
    });
    expect(call.headers.get("Cookie")).toBe("s=viewer");
    expect(call.method).toBe("GET");
  });

  it("reads a name ending in .data through the slash its URL ends with", async () => {
    const { response, calls } = get(() => json({}), `/ada/demo/blame-ranges/${COMMIT}/notes.data/`);
    await response;
    expect(new URL((calls[0] as Request).url).searchParams.get("path")).toBe("notes.data");
  });

  it("hands on the API's body untouched, without reading it", async () => {
    const parse = vi.spyOn(JSON, "parse");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("not { json, and that is fine"));
        controller.close();
      },
    });
    const { response } = get(
      () => new Response(body, { headers: { "Content-Type": "application/json" } }),
    );
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("not { json, and that is fine");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it.each([
    [503, "blame_busy", { "Retry-After": "1" }],
    [409, "blame_restarted", {}],
    [422, "object_limit", {}],
    [404, "repo_not_found", {}],
  ])("hands on a %i %s with its body and wait", async (status, code, headers) => {
    const { response } = get(() =>
      json({ status, code, retry_after: 1 }, status, headers as Record<string, string>),
    );
    const res = await response;
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code });
    expect(res.headers.get("Retry-After")).toBe(
      (headers as Record<string, string>)["Retry-After"] ?? null,
    );
  });
});
