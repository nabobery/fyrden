import { describe, expect, it } from "vitest";
import { parseRepairArgs, repairEffects } from "../src/commands/effects.ts";

const NOW = 1_800_000_000_000;
const URL_ = "https://api.fyrden.test";

describe("effects repair", () => {
  it("takes the API's URL, a sink and a date not in the future, and --yes to change anything", () => {
    expect(
      parseRepairArgs(["--url", URL_, "--sink", "feed", "--since", "2027-01-14T00:00:00Z"], NOW, {
        FYRDEN_TOKEN: "t",
      }),
    ).toEqual({
      url: URL_,
      token: "t",
      sink: "feed",
      since: Date.parse("2027-01-14T00:00:00Z"),
      confirmed: false,
    });
    const env = { FYRDEN_TOKEN: "t" };
    const parse = (args: string[]) => parseRepairArgs(args, NOW, env);
    expect(
      parse(["--since", "2027-01-14", "--sink", "webhooks", "--url", URL_, "--yes"]),
    ).toMatchObject({ sink: "webhooks", confirmed: true });
    expect(parse(["--url", URL_, "--sink", "events", "--since", "2027-01-14"])).toHaveProperty(
      "error",
    );
    expect(parse(["--url", URL_, "--sink", "feed", "--since", "soon"])).toHaveProperty("error");
    expect(parse(["--url", URL_, "--sink", "feed"])).toHaveProperty("error");
    expect(parse(["--url", URL_, "--sink", "feed", "--since", "2099-01-01"])).toHaveProperty(
      "error",
    );
    expect(
      parse(["--url", URL_, "--sink", "feed", "--since", "2027-01-14", "--force"]),
    ).toHaveProperty("error");
    // The API's URL, an origin over https (http only for a local one).
    expect(parse(["--sink", "feed", "--since", "2027-01-14"])).toHaveProperty("error");
    expect(parse(["--url", "ftp://x", "--sink", "feed", "--since", "2027-01-14"])).toHaveProperty(
      "error",
    );
    expect(
      parse(["--url", "http://api.fyrden.test", "--sink", "feed", "--since", "2027-01-14"]),
    ).toHaveProperty("error");
    expect(
      parse(["--url", "http://localhost:8787", "--sink", "feed", "--since", "2027-01-14"]),
    ).toMatchObject({ url: "http://localhost:8787" });
    // A token a header could not carry is refused before any request, without repeating it.
    const malformed = parseRepairArgs(
      ["--url", URL_, "--sink", "feed", "--since", "2027-01-14"],
      NOW,
      { FYRDEN_TOKEN: "secret\ninjected" },
    );
    expect(malformed).toHaveProperty("error");
    expect(JSON.stringify(malformed)).not.toMatch(/secret/);
    // An administrator's token, from the environment only (never an argument).
    expect(
      parseRepairArgs(["--url", URL_, "--sink", "feed", "--since", "2027-01-14"], NOW, {}),
    ).toHaveProperty("error");
  });

  it("asks the API to count without --yes, and to reopen with it", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const answers = [
      { eligible: 3, oldest: NOW - 86_400_000, reopened: 0 },
      { eligible: 1_002, oldest: NOW - 86_400_000, reopened: 1_000 },
    ];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json(answers.shift());
    }) as unknown as typeof fetch;
    const lines: string[] = [];
    const run = (confirmed: boolean) =>
      repairEffects({
        args: { url: `${URL_}/`, token: "tok", sink: "feed", since: NOW - 172_800_000, confirmed },
        fetch: fetcher,
        log: (line) => lines.push(line),
      });
    expect(await run(false)).toBe(0);
    expect(lines.at(-1)).toMatch(/dry run/);
    expect(lines.join("\n")).toMatch(/^3 failed feed effect\(s\)/);
    expect(await run(true)).toBe(1_000);
    expect(lines.at(-1)).toMatch(/run again for the other 2/);
    expect(sent.map((s) => s.url)).toEqual([
      `${URL_}/api/admin/effects/repair`,
      `${URL_}/api/admin/effects/repair`,
    ]);
    expect(sent.map((s) => JSON.parse(String(s.init.body)))).toEqual([
      { sink: "feed", since: NOW - 172_800_000, dry_run: true },
      { sink: "feed", since: NOW - 172_800_000, dry_run: false },
    ]);
    expect(sent[0]?.init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer tok", "Content-Type": "application/json" },
    });
  });

  it("reports what the API refused, without the token", async () => {
    const fetcher = (async () =>
      Response.json(
        { status: 503, code: "read_model_maintenance", detail: "under maintenance" },
        { status: 503 },
      )) as unknown as typeof fetch;
    const failed = repairEffects({
      args: { url: URL_, token: "secret-token", sink: "feed", since: 0, confirmed: true },
      fetch: fetcher,
      log: () => {},
    });
    await expect(failed).rejects.toThrow(/503 read_model_maintenance: under maintenance/);
    await expect(failed).rejects.not.toThrow(/secret-token/);
  });

  it("reports a transport failure without the token", async () => {
    const fetcher = (async () => {
      throw new TypeError("fetch failed for Bearer secret-token");
    }) as unknown as typeof fetch;
    const failed = repairEffects({
      args: { url: URL_, token: "secret-token", sink: "feed", since: 0, confirmed: false },
      fetch: fetcher,
      log: () => {},
    });
    await expect(failed).rejects.toThrow(/could not reach https:\/\/api\.fyrden\.test/);
    await expect(failed).rejects.not.toThrow(/secret-token/);
  });
});
