// A tree's path pages for the finder: passed through as the viewer, and never parsed, which would
// spend the request's CPU on what the browser reads anyway.

import { describe, expect, it, vi } from "vitest";
import { loader } from "../app/routes/repo.paths.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";

function get(answer: () => Response, query = "?ref=main&per_page=10000") {
  const { context, calls } = fakeApi(answer);
  const request = new Request(`${ORIGIN}/ada/my%20repo/paths${query}`, {
    headers: { Cookie: "s=viewer" },
  });
  const response = loader({
    request,
    context,
    params: { owner: "ada", repo: "my repo" },
    // biome-ignore lint/suspicious/noExplicitAny: the generated argument's other fields go unread
  } as any);
  return { response, calls };
}

describe("a tree's path pages", () => {
  it("asks the API as the viewer, for what the page named and no more", async () => {
    const { response, calls } = get(
      () => json({}),
      "?ref=feat%2Fa%26b&cursor=c%2B1&per_page=10&evil=1",
    );
    await response;
    const call = calls[0] as Request;
    const url = new URL(call.url);
    expect(url.pathname).toBe("/api/repos/ada/my%20repo/paths");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ref: "feat/a&b",
      cursor: "c+1",
      per_page: "10",
    });
    expect(call.headers.get("Cookie")).toBe("s=viewer");
    expect(call.method).toBe("GET");
  });

  it("hands on the API's body untouched, without reading it", async () => {
    const json_ = vi.spyOn(JSON, "parse");
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
    expect(json_).not.toHaveBeenCalled();
    json_.mockRestore();
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("hands on a refusal with its body: `repo_empty` and `busy` share a status", async () => {
    const { response } = get(() => json({ code: "busy" }, 409, { "Retry-After": "2" }));
    const res = await response;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "busy" });
    expect(res.headers.get("Retry-After")).toBe("2");
  });
});
