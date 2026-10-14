import { describe, expect, it } from "vitest";
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
});
