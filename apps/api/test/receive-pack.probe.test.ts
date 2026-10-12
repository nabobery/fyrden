// Before a push body larger than its http.postBuffer (1 MiB by default), git
// first POSTs a 4-byte flush packet ("0000") to check that the request will
// be accepted (credentials, redirects) and ignores the answer's body. That
// probe is not a push: the Worker answers it alone.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { postPush, pushTarget } from "./helpers/push.js";
import { logs } from "./setup/log-capture.js";

/** A `REPO` binding that records every stub created through it. */
function countingRepo(): { REPO: Env["REPO"]; stubs: string[] } {
  const stubs: string[] = [];
  const REPO = new Proxy(env.REPO, {
    get(target, property) {
      const value = (target as unknown as Record<PropertyKey, unknown>)[property];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        stubs.push(String(property));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { REPO, stubs };
}

describe("git's receive-pack probe", () => {
  it("is answered by the Worker with an empty 200, without the repository object, and not logged as a push", async () => {
    const target = await pushTarget();
    const { REPO, stubs } = countingRepo();
    const reply = await postPush(target, new TextEncoder().encode("0000"), {
      bindings: { REPO },
    });
    expect(reply.status).toBe(200);
    expect(reply.contentType).toBe("application/x-git-receive-pack-result");
    expect(reply.bytes).toEqual(new Uint8Array(0));
    expect(stubs).toEqual([]);
    expect(logs.entries().filter((e) => e.msg === "git.push")).toEqual([]);
  });

  it("still requires write access", async () => {
    const target = await pushTarget();
    const reply = await postPush(target, new TextEncoder().encode("0000"), {
      token: "fyr_pat_not-a-real-token",
    });
    expect(reply.status).toBe(401);
  });

  it("treats any other short body as a push request (refused by the push path)", async () => {
    const target = await pushTarget();
    const { REPO, stubs } = countingRepo();
    const reply = await postPush(target, new TextEncoder().encode("0001"), {
      bindings: { REPO },
    });
    expect(reply.status).toBe(200);
    expect(stubs.length).toBeGreaterThan(0);
  });
});
