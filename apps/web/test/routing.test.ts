import { describe, expect, it } from "vitest";
import { isApiPath } from "../workers/app.js";

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
    ])
      expect(isApiPath(path), path).toBe(false);
  });
});
