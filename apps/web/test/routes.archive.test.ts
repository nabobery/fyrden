// The repository page's archive buttons: the archive's bytes, as the API's
// tarball and zipball routes serve them; while it is built, a page that
// asks again.

import { describe, expect, it } from "vitest";
import { loader } from "../app/routes/repo.archive.js";
import { fakeApi, json, ORIGIN } from "./helpers/context.js";

type Args = Parameters<typeof loader>[0];

const load = (format: string, query: string, answer: () => Response) => {
  const { context, calls } = fakeApi(answer);
  const request = new Request(`${ORIGIN}/ada/demo/archive/${format}${query}`);
  const args = { request, context, params: { owner: "ada", repo: "demo", format } };
  return { response: loader(args as unknown as Args), calls };
};

describe("an archive download", () => {
  it("is the API's tarball or zipball of the ref, with its headers", async () => {
    const tar = load(
      "tar.gz",
      "?ref=feature/x%20y",
      () =>
        new Response("bytes", {
          headers: {
            "Content-Type": "application/gzip",
            "Content-Disposition": 'attachment; filename="ada-demo-1234567.tar.gz"',
          },
        }),
    );
    const res = await tar.response;
    expect(new URL(tar.calls[0]?.url ?? "").pathname).toBe(
      "/api/repos/ada/demo/tarball/feature/x%20y",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("ada-demo-1234567.tar.gz");
    expect(await res.text()).toBe("bytes");
    const zip = load("zip", "", () => new Response("z"));
    await zip.response;
    expect(new URL(zip.calls[0]?.url ?? "").pathname).toBe("/api/repos/ada/demo/zipball");
  });

  it("asks again, after the API's wait, while the archive is built", async () => {
    const building = load("zip", "?ref=main", () =>
      json({ state: "building", commit: "a".repeat(40), bytes: 0 }, 202, { "Retry-After": "5" }),
    );
    const res = await building.response;
    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("5");
    // Asks again for the commit being built, not the branch, which may move on.
    expect(res.headers.get("Refresh")).toBe(`5; url=/ada/demo/archive/zip?ref=${"a".repeat(40)}`);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(await res.text()).toContain("being prepared");
  });
});
