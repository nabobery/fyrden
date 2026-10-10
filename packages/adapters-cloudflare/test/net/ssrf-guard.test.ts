import {
  ALLOWED_IP_URLS,
  DENIED_CREDENTIAL_URLS,
  DENIED_IP_URLS,
  DENIED_NAME_URLS,
  DENIED_SCHEME_URLS,
} from "@fyrden/testing/ssrf-cases";
import { setupNetwork } from "@msw/cloudflare";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, parseIPv6 } from "../../src/net/ip.js";
import {
  checkOutboundUrl,
  dohResolver,
  guardedFetch,
  type Resolver,
  SsrfError,
} from "../../src/net/ssrf-guard.js";

const records: Record<string, string[]> = {
  "public.example": ["93.184.215.14"],
  "rebind.example": ["93.184.215.14", "10.0.0.5"],
  "v6only.example": ["2606:4700::6810:84e5"],
  "metadata.example": ["169.254.169.254"],
  "mapped.example": ["::ffff:10.0.0.1"],
  "dummy-v6.example": ["2606:4700::6810:84e5", "100:0:0:1::1"],
  "srv6.example": ["5f00::1"],
};
const resolve: Resolver = async (host) => records[host] ?? [];
const policy = {
  ownHosts: ["fyrden.example.com", "fyrden-api.acct.workers.dev"],
  resolve,
  allowHttp: true,
};

describe("checkOutboundUrl", () => {
  it.each(DENIED_IP_URLS)("denies %s", async (url) => {
    expect(await checkOutboundUrl(url, policy)).toEqual({ ok: false, reason: "private_address" });
  });

  it.each(DENIED_NAME_URLS)("denies internal name %s", async (url) => {
    expect(await checkOutboundUrl(url, policy)).toEqual({ ok: false, reason: "internal_name" });
  });

  it.each(DENIED_SCHEME_URLS)("denies scheme of %s", async (url) => {
    expect((await checkOutboundUrl(url, policy)).ok).toBe(false);
  });

  it.each(DENIED_CREDENTIAL_URLS)("denies credentials in %s", async (url) => {
    expect(await checkOutboundUrl(url, policy)).toEqual({ ok: false, reason: "credentials" });
  });

  it.each(ALLOWED_IP_URLS)("allows public address %s", async (url) => {
    expect((await checkOutboundUrl(url, policy)).ok).toBe(true);
  });

  it.each([
    "https://fyrden.example.com/hook",
    "https://FYRDEN.example.com./hook",
    "https://hooks.fyrden.example.com/",
    "https://fyrden-api.acct.workers.dev/api/user",
  ])("denies the deployment's own host %s", async (url) => {
    expect(await checkOutboundUrl(url, policy)).toEqual({ ok: false, reason: "own_host" });
  });

  it("allows a name whose every address is public", async () => {
    expect((await checkOutboundUrl("https://public.example/x", policy)).ok).toBe(true);
    expect((await checkOutboundUrl("https://v6only.example/x", policy)).ok).toBe(true);
  });

  it.each([
    "rebind.example",
    "metadata.example",
    "mapped.example",
    "dummy-v6.example",
    "srv6.example",
  ])("denies %s, which resolves to a private address at check time", async (host) => {
    expect(await checkOutboundUrl(`https://${host}/`, policy)).toEqual({
      ok: false,
      reason: "private_address",
    });
  });

  it("denies names that do not resolve or whose lookup fails", async () => {
    expect(await checkOutboundUrl("https://nothing.example/", policy)).toEqual({
      ok: false,
      reason: "unresolvable",
    });
    const failing = { ...policy, resolve: async () => Promise.reject(new Error("dns down")) };
    expect(await checkOutboundUrl("https://public.example/", failing)).toEqual({
      ok: false,
      reason: "unresolvable",
    });
  });

  it("denies plain http unless the policy allows it", async () => {
    expect(
      await checkOutboundUrl("http://public.example/", { ...policy, allowHttp: false }),
    ).toEqual({
      ok: false,
      reason: "scheme",
    });
  });
});

describe("IPv6 parsing", () => {
  it.each([
    ["::1", [0, 0, 0, 0, 0, 0, 0, 1]],
    ["::ffff:127.0.0.1", [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]],
    ["1:2:3:4:5:6:1.2.3.4", [1, 2, 3, 4, 5, 6, 0x102, 0x304]],
    ["2001:db8::", [0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]],
  ])("parses %s", (text, groups) => {
    expect(parseIPv6(text)).toEqual(groups);
  });

  it.each(["1::2::3", "1:2:3:4:5:6:7:8:9", "12345::", "::g", "1:2:3:4:5:6:7"])(
    "rejects %s",
    (text) => {
      expect(parseIPv6(text)).toBeUndefined();
    },
  );

  it("treats unparseable input as not public", () => {
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

const network = setupNetwork();
beforeAll(() => network.enable());
afterEach(() => network.resetHandlers());
afterAll(() => network.disable());

describe("guardedFetch", () => {
  it("fetches an allowed URL", async () => {
    network.use(http.post("https://public.example/hook", () => HttpResponse.text("ok")));
    const res = await guardedFetch("https://public.example/hook", { method: "POST" }, policy);
    expect(await res.text()).toBe("ok");
  });

  it("refuses to follow a redirect, which could point anywhere", async () => {
    network.use(
      http.get("https://public.example/redirect", () =>
        HttpResponse.text("", { status: 302, headers: { Location: "http://169.254.169.254/" } }),
      ),
    );
    await expect(guardedFetch("https://public.example/redirect", {}, policy)).rejects.toThrow(
      SsrfError,
    );
  });

  it("never sends a request to a denied URL", async () => {
    let called = false;
    network.use(
      http.all("*", () => {
        called = true;
        return HttpResponse.text("should not happen");
      }),
    );
    await expect(guardedFetch("http://127.0.0.1/", {}, policy)).rejects.toThrow(/private_address/);
    expect(called).toBe(false);
  });
});

describe("dohResolver", () => {
  it("returns A and AAAA answers and ignores CNAMEs", async () => {
    network.use(
      http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
        const type = new URL(request.url).searchParams.get("type");
        const answers =
          type === "A"
            ? [
                { type: 5, data: "alias.example." },
                { type: 1, data: "93.184.215.14" },
              ]
            : [{ type: 28, data: "2606:4700::1" }];
        return HttpResponse.json({ Status: 0, Answer: answers });
      }),
    );
    expect(await dohResolver()("public.example")).toEqual(["93.184.215.14", "2606:4700::1"]);
  });

  it("fails when the DoH server errors, which the guard treats as unresolvable", async () => {
    network.use(
      http.get("https://cloudflare-dns.com/dns-query", () =>
        HttpResponse.text("", { status: 502 }),
      ),
    );
    await expect(dohResolver()("public.example")).rejects.toThrow(/502/);
  });
});
