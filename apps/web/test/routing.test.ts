import { isReservedHandle } from "@fyrden/domain";
import { describe, expect, it } from "vitest";
import routes from "../app/routes.js";
import { API_PATHS, API_PREFIXES, dataSuffixRedirect, isApiPath } from "../workers/app.js";

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
      "/unsubscribe",
      "/auth/email/events",
    ])
      expect(isApiPath(path), path).toBe(true);
    for (const path of [
      "/",
      "/settings/tokens",
      "/alice/repo",
      "/alice/repo/tree/main/src",
      "/alice/repo/blob/main/info/refs",
      "/alice/repo/commits",
      "/alice/repo/preview/main/info/refs/",
      "/apis",
      "/authors/x",
      // Handles that start like an API path: their pages are the web's.
      "/mcperson/demo",
      "/mcp-tools/demo/tree/main",
      "/mcpx",
      "/unsubscribe/demo",
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

  it("opens a release's download ending in .data by any GET or HEAD, since no data request targets it", () => {
    const ask = (path: string, method = "GET", mode?: string) =>
      dataSuffixRedirect(
        new Request(`https://fyrden.test${path}?x=1`, {
          method,
          ...(mode && { headers: { "Sec-Fetch-Mode": mode } }),
        }),
      );
    const download = "/ada/demo/releases/download/v1/rc/notes.data";
    for (const [method, mode] of [
      ["GET", "navigate"],
      ["GET", "cors"],
      ["GET", "no-cors"],
      ["GET", undefined],
      ["HEAD", "navigate"],
      ["HEAD", undefined],
    ] as const) {
      const moved = ask(download, method, mode);
      expect(moved?.status, `${method} ${mode}`).toBe(308);
      expect(moved?.headers.get("Location")).toBe(`https://fyrden.test${download}/?x=1`);
    }
    // Spelled as React Router still matches it: any case, or with a segment percent-encoded.
    for (const spelled of [
      "/ada/demo/Releases/Download/v1/notes.data",
      "/ada/demo/%72eleases/download/v1/notes.data",
      "/ada/demo/releases/%64ownload/v1/notes.data",
    ]) {
      expect(ask(spelled, "GET", "cors")?.headers.get("Location"), spelled).toBe(
        `https://fyrden.test${spelled}/?x=1`,
      );
    }
    // Encoded slashes stay inside their segment.
    expect(ask("/ada%2Fdemo/releases/download/notes.data", "GET", "cors")).toBeUndefined();
    // A bad escape: React Router matches the path as it stands, so this does too.
    expect(ask("/ada/demo/releases/download/v1/notes%zz.data", "GET", "cors")?.status).toBe(308);
    expect(ask("/ada/demo/%zzeleases/download/notes.data", "GET", "cors")).toBeUndefined();
    expect(ask("/ada/demo/%72eleases/download/notes%zz.data", "GET", "cors")).toBeUndefined();
    expect(ask(download, "POST", "cors")).toBeUndefined();
    expect(ask("/ada/demo/releases/download/v1/notes.zip", "HEAD")).toBeUndefined();
    // Already moved: the slash ends it, so it can't redirect again.
    expect(ask(`${download}/`, "GET", "cors")).toBeUndefined();
    // Anywhere else a data request can be real, or the path only looks alike.
    for (const elsewhere of [
      "/ada/demo/blob/main/releases/download/v1/notes.data",
      "/ada/demo/releases/tag/v1.data",
      "/releases/download/notes.data",
      "/ada/demo/releases/download.data",
    ]) {
      expect(ask(elsewhere, "GET", "cors"), elsewhere).toBeUndefined();
      expect(ask(elsewhere, "HEAD"), elsewhere).toBeUndefined();
    }
  });

  it("reserves, as handles, every name an API path or a page takes at the top", () => {
    const names = [
      ...API_PREFIXES.map((p) => p.replace(/^\/|\/$/g, "")),
      ...API_PATHS.map((p) => p.slice(1)),
      ...routes.flatMap((r) => (r.path && !r.path.startsWith(":") ? [r.path.split("/")[0]] : [])),
    ].filter((name): name is string => name !== undefined && !name.startsWith("."));
    // The built assets the platform serves before the Worker runs.
    names.push("assets");
    expect(names).toContain("settings");
    for (const name of names) expect(isReservedHandle(name), name).toBe(true);
  });
});
