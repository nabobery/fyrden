import { describe, expect, it } from "vitest";
import { signInUrl } from "../app/lib/api.server.js";
import { pageLinks, pageQuery } from "../app/lib/pages.js";

const url = new URL("https://fyrden.test/settings/agents?grants=G1&agents=A1");

describe("a listing's pages", () => {
  it("asks the API for the page the URL names, by its own parameter", () => {
    expect(pageQuery(url, "agents")).toBe("per_page=100&cursor=A1");
    expect(pageQuery(new URL("https://fyrden.test/"), "cursor")).toBe("per_page=100");
  });

  it("links the next and the first page, keeping the other listings' pages", () => {
    expect(pageLinks(url, "agents", "A2")).toEqual({
      next: "/settings/agents?grants=G1&agents=A2",
      first: "/settings/agents?grants=G1",
    });
    expect(pageLinks(url, "grants", null)).toEqual({
      next: null,
      first: "/settings/agents?agents=A1",
    });
    expect(pageLinks(new URL("https://fyrden.test/"), "cursor", null)).toEqual({
      next: null,
      first: null,
    });
  });

  it("links the page itself from a navigation's data request", () => {
    // React Router hands the loader its data request's URL: a suffix, and the loaders to run.
    for (const [data, page] of [
      [
        "https://fyrden.test/ada/demo/pulls.data?cursor=C1&_routes=routes%2Frepo.pulls",
        "/ada/demo/pulls",
      ],
      ["https://fyrden.test/ada/demo/tree/main/_.data?cursor=C1", "/ada/demo/tree/main/"],
    ] as const)
      expect(pageLinks(new URL(data), "cursor", "C2"), data).toEqual({
        next: `${page}?cursor=C2`,
        first: page,
      });
  });
});

describe("signing in from a navigation's data request", () => {
  it("comes back to the page, not its data", () => {
    const request = new Request(
      "https://fyrden.test/ada/demo/issues/7.data?after=3&_routes=routes%2Frepo.issue",
    );
    expect(signInUrl(request)).toBe(
      `/auth/sign-in?return_to=${encodeURIComponent("/ada/demo/issues/7?after=3")}`,
    );
  });
});
