import { isReservedHandle } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import routes from "../app/routes.js";
import { API_PREFIXES, dataSuffixRedirect, isApiPath } from "../workers/app.js";

describe("the web Worker's routing", () => {
  it("hands the API's paths to fyrden-api and keeps its own pages", () => {
    for (const path of [
      "/api/user",
      "/mcp",
      "/oauth/token",
      "/auth/sign-in",
      "/.well-known/oauth-authorization-server",
      "/v0/admin/bootstrap",
      "/alice/repo.git/info/refs",
      "/alice/repo/info/refs",
      "/alice/repo.git/git-upload-pack",
      "/alice/repo/git-receive-pack",
      "/alice/repo/uploads/01ARZ3NDEKTSV4RRFFQ69G5FAV/parts/1",
    ])
      expect(isApiPath(path), path).toBe(true);
    for (const path of [
      "/",
      "/settings/tokens",
      "/alice/repo",
      "/alice/repo/tree/main/src",
      "/alice/repo/blob/main/info/refs",
      "/alice/repo/commits",
      "/apis",
      "/authors/x",
      // Handles that start like an API path: their pages are the web's.
      "/mcperson/demo",
      "/mcp-tools/demo/tree/main",
      "/mcpx",
    ])
      expect(isApiPath(path), path).toBe(false);
  });

  it("opens a page whose path ends in .data with a trailing slash, leaving data requests alone", () => {
    const navigate = (path: string, mode = "navigate") =>
      dataSuffixRedirect(
        new Request(`https://fyrden.test${path}?x=1`, { headers: { "Sec-Fetch-Mode": mode } }),
      );
    const moved = navigate("/ada/demo/blob/main/notes.data");
    expect(moved?.status).toBe(308);
    expect(moved?.headers.get("Location")).toBe(
      "https://fyrden.test/ada/demo/blob/main/notes.data/?x=1",
    );
    expect(navigate("/ada/demo.data")?.headers.get("Location")).toBe(
      "https://fyrden.test/ada/demo.data/?x=1",
    );
    // React Router's own data requests are fetches.
    expect(navigate("/ada/demo/blob/main/notes.data", "cors")).toBeUndefined();
    expect(navigate("/ada/demo")).toBeUndefined();
  });

  it("reserves, as handles, every name an API path or a page takes at the top", () => {
    const names = [
      ...API_PREFIXES.map((p) => p.replace(/^\/|\/$/g, "")),
      ...routes.flatMap((r) => (r.path && !r.path.startsWith(":") ? [r.path.split("/")[0]] : [])),
    ].filter((name): name is string => name !== undefined && !name.startsWith("."));
    // The built assets the platform serves before the Worker runs.
    names.push("assets");
    expect(names).toContain("settings");
    for (const name of names) expect(isReservedHandle(name), name).toBe(true);
  });
});
