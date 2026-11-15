import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostArch, RUNNER_SHA256, runnerBinary, runnerVersion } from "../runner/binary.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the pinned runner binaries", () => {
  it("pins a SHA-256 for each version and architecture", () => {
    for (const byArch of Object.values(RUNNER_SHA256))
      for (const digest of Object.values(byArch)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("takes only a pinned version, 6.0.0 by default", () => {
    expect(runnerVersion(undefined)).toBe("6.0.0");
    expect(runnerVersion("5.4.1")).toBe("5.4.1");
    expect(() => runnerVersion("6.0.1")).toThrow(/not pinned/);
    expect(() => runnerVersion("constructor")).toThrow(/not pinned/);
  });

  it("maps the host's architecture to the release's", () => {
    expect(hostArch("x64")).toBe("amd64");
    expect(hostArch("arm64")).toBe("arm64");
    expect(() => hostArch("ia32")).toThrow(/no pinned/);
  });

  it("refuses a download that does not match its pin, and keeps nothing", async () => {
    dir = await mkdtemp(join(tmpdir(), "runner-binary-"));
    const asked: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response("not the runner");
    }) as typeof fetch;
    await expect(
      runnerBinary("6.0.0", "amd64", { cacheDir: dir, fetch: fakeFetch }),
    ).rejects.toThrow(/SHA-256 [0-9a-f]{64}, pinned 62ecab22.*refused/);
    expect(asked).toEqual([
      "https://gitea.com/gitea/runner/releases/download/v6.0.0/gitea-runner-6.0.0-linux-amd64",
    ]);
    expect(existsSync(join(dir, "6.0.0")) ? await readdir(join(dir, "6.0.0")) : []).toEqual([]);
  });
});
