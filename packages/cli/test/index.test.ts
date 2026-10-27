import { describe, expect, it, vi } from "vitest";
import { asksForHelp, envDeployOptions, main, parseDeployArgs } from "../src/index.ts";

describe("command line", () => {
  it.each([
    [["deploy", "--help"]],
    [["deploy", "-h"]],
    [["destroy", "--help"]],
    [["destroy", "--yes", "--help"]],
    [["doctor", "--help"]],
    [["--help"]],
    [["help"]],
    [["deploy", "help"]],
  ])("answers %j with the usage and changes nothing", async (argv) => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Returns before looking for a checkout or running wrangler.
      expect(await main(argv)).toBe(0);
      expect(out.mock.calls[0]?.[0]).toMatch(/^usage:/);
    } finally {
      out.mockRestore();
    }
  });

  it.each([
    [["deploy", "--plan"]],
    [["deploy", "--plan", "pro"]],
    [["deploy", "--plna", "free"]],
    [["deploy", "free"]],
    [["doctor", "--fix"]],
    [["destroy", "--force"]],
    [["launch"]],
  ])("refuses %j without running anything", async (argv) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await main(argv)).toBe(2);
    } finally {
      err.mockRestore();
    }
  });

  it("leaves a remote or branch named help to push", () => {
    expect(asksForHelp(["push", "origin", "help"])).toBe(false);
    expect(asksForHelp(["push", "help", "main"])).toBe(false);
    expect(asksForHelp(["push", "--help"])).toBe(true);
    expect(asksForHelp(["deploy", "help"])).toBe(true);
  });

  it("accepts exactly the deploy plans", () => {
    expect(parseDeployArgs([])).toEqual({ plan: "paid" });
    expect(parseDeployArgs(["--plan", "free"])).toEqual({ plan: "free" });
    expect(parseDeployArgs(["--plan", "paid"])).toEqual({ plan: "paid" });
    expect(parseDeployArgs(["--plan", "free", "--plan", "paid"])).toBeUndefined();
    expect(parseDeployArgs(["--plan"])).toBeUndefined();
  });

  it("accepts a Paid deployment's internal calls, from 1,000 to 10,000,000", () => {
    expect(parseDeployArgs(["--plan", "paid", "--internal-calls", "10000"])).toEqual({
      plan: "paid",
      internalCalls: 10_000,
    });
    expect(parseDeployArgs(["--internal-calls", "1000", "--plan", "paid"])).toEqual({
      plan: "paid",
      internalCalls: 1_000,
    });
    expect(parseDeployArgs(["--internal-calls", "10000000"])).toEqual({
      plan: "paid",
      internalCalls: 10_000_000,
    });
    // Free cannot raise its 1,000.
    expect(parseDeployArgs(["--plan", "free", "--internal-calls", "5000"])).toBeUndefined();
    for (const bad of ["999", "10000001", "5e3", "-5000", "1000.5", "lots", ""])
      expect(parseDeployArgs(["--internal-calls", bad])).toBeUndefined();
    expect(parseDeployArgs(["--internal-calls"])).toBeUndefined();
    expect(
      parseDeployArgs(["--internal-calls", "2000", "--internal-calls", "3000"]),
    ).toBeUndefined();
  });
});

describe("envDeployOptions", () => {
  it.each([
    ["missing", undefined],
    ["empty (an unset GitHub secret)", ""],
  ])("never generates a bootstrap secret in CI when the preset is %s", (_, preset) => {
    const options = envDeployOptions({ CI: "true", FYRDEN_BOOTSTRAP_SECRET: preset });
    expect(options.presetBootstrapSecret).toBeUndefined();
    expect(options.randomSecret).toBeUndefined();
  });

  it("uses a preset secret in CI", () => {
    expect(envDeployOptions({ CI: "1", FYRDEN_BOOTSTRAP_SECRET: "s" }).presetBootstrapSecret).toBe(
      "s",
    );
  });

  it("generates one locally, where the operator sees it", () => {
    const options = envDeployOptions({}, () => "generated");
    expect(options.randomSecret?.()).toBe("generated");
  });

  it("treats an empty CLOUDFLARE_ACCOUNT_ID as unset", () => {
    expect(envDeployOptions({ CLOUDFLARE_ACCOUNT_ID: "" }).envAccountId).toBeUndefined();
    expect(envDeployOptions({ CLOUDFLARE_ACCOUNT_ID: "a1" }).envAccountId).toBe("a1");
  });

  it("takes an email provider whole, or none", () => {
    const email = ["--email", "resend", "--email-from", "Fyrden <n@notify.example>"];
    expect(parseDeployArgs([...email, "--email-secrets-file", "/s.json"])).toEqual({
      plan: "paid",
      email: { provider: "resend", from: "Fyrden <n@notify.example>", secretsFile: "/s.json" },
    });
    expect(
      parseDeployArgs([
        "--email",
        "resend",
        "--email-from",
        "n@notify.example",
        "--email-secrets-file",
        "s",
      ]),
    ).toMatchObject({ email: { from: "n@notify.example" } });
    // In part, another provider, or a sending address that is not one: no deploy.
    expect(parseDeployArgs(email)).toBeUndefined();
    expect(parseDeployArgs(["--email-secrets-file", "/s.json"])).toBeUndefined();
    expect(
      parseDeployArgs([
        "--email",
        "smtp",
        "--email-from",
        "n@x.example",
        "--email-secrets-file",
        "s",
      ]),
    ).toBeUndefined();
    expect(
      parseDeployArgs(["--email", "resend", "--email-from", "nobody", "--email-secrets-file", "s"]),
    ).toBeUndefined();
  });

  it("accepts a daily allowance for discretionary work, resource by resource, on either plan", () => {
    expect(
      parseDeployArgs(["--plan", "free", "--discretionary", "do_rows_written=5000,queue_ops=500"]),
    ).toEqual({ plan: "free", discretionary: "do_rows_written=5000,queue_ops=500" });
    expect(parseDeployArgs(["--discretionary", "do_requests=0"])).toEqual({
      plan: "paid",
      discretionary: "do_requests=0",
    });
    for (const bad of [
      "",
      "rows=5",
      "do_rows_written=",
      "do_rows_written=1e4",
      "do_rows_written=-1",
      "do_rows_written=5;queue_ops=1",
      "do_rows_written=5,do_rows_written=6",
    ])
      expect(parseDeployArgs(["--discretionary", bad]), bad).toBeUndefined();
  });
});
