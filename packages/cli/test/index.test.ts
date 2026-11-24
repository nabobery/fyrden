import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  asksForHelp,
  CI_RESOURCES,
  checkEmailKey,
  DISCRETIONARY_RESOURCES,
  emailDeploy,
  envDeployOptions,
  main,
  parseDeployArgs,
  validAllowance,
} from "../src/index.ts";

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
    expect(parseDeployArgs(["--plan", "free", "--internal-calls", "5000"])).toBeUndefined();
    for (const bad of ["999", "10000001", "5e3", "-5000", "1000.5", "lots", ""])
      expect(parseDeployArgs(["--internal-calls", bad])).toBeUndefined();
    expect(parseDeployArgs(["--internal-calls"])).toBeUndefined();
    expect(
      parseDeployArgs(["--internal-calls", "2000", "--internal-calls", "3000"]),
    ).toBeUndefined();
  });
});

describe("parseDeployArgs: CI", () => {
  it("takes the runner switch on or off, on either plan", () => {
    expect(parseDeployArgs(["--ci-runners", "on", "--plan", "free"])).toEqual({
      plan: "free",
      ci: { runners: "on" },
    });
    expect(parseDeployArgs(["--ci-runners", "off"])).toEqual({
      plan: "paid",
      ci: { runners: "off" },
    });
    for (const bad of ["On", "yes", "1", ""])
      expect(parseDeployArgs(["--ci-runners", bad])).toBeUndefined();
  });

  it("takes a fleet cap from 0 to 999,999 on Free only (Paid caps no fleet)", () => {
    expect(parseDeployArgs(["--plan", "free", "--ci-fleet", "0"])).toEqual({
      plan: "free",
      ci: { fleet: 0 },
    });
    expect(parseDeployArgs(["--plan", "free", "--ci-fleet", "999999"])).toEqual({
      plan: "free",
      ci: { fleet: 999_999 },
    });
    expect(parseDeployArgs(["--ci-fleet", "3"])).toBeUndefined();
    for (const bad of ["1000000", "-1", "02", "2.5", "two", ""])
      expect(parseDeployArgs(["--plan", "free", "--ci-fleet", bad])).toBeUndefined();
  });

  it("takes a daily allowance and a longest job on Free only, as the API reads them", () => {
    expect(
      parseDeployArgs([
        "--plan",
        "free",
        "--ci-daily",
        "worker_requests=9000,r2_class_b=100",
        "--ci-max-job-minutes",
        "7200",
      ]),
    ).toEqual({
      plan: "free",
      ci: { daily: "worker_requests=9000,r2_class_b=100", maxJobMinutes: 7_200 },
    });
    expect(parseDeployArgs(["--ci-daily", "worker_requests=9000"])).toBeUndefined();
    expect(parseDeployArgs(["--ci-max-job-minutes", "60"])).toBeUndefined();
    for (const bad of ["queue=1", "worker_requests=1,worker_requests=2", "worker_requests=-1", ""])
      expect(parseDeployArgs(["--plan", "free", "--ci-daily", bad])).toBeUndefined();
    for (const bad of ["0", "7201", "60.5", "sixty", ""])
      expect(parseDeployArgs(["--plan", "free", "--ci-max-job-minutes", bad])).toBeUndefined();
  });

  it("takes how long finished runs are kept, on either plan, as the API reads it", () => {
    expect(parseDeployArgs(["--ci-run-retention-days", "30"])).toEqual({
      plan: "paid",
      ci: { runRetentionDays: 30 },
    });
    expect(parseDeployArgs(["--plan", "free", "--ci-run-retention-days", "400"])).toEqual({
      plan: "free",
      ci: { runRetentionDays: 400 },
    });
    expect(parseDeployArgs(["--ci-run-retention-days", "7"])?.ci).toEqual({ runRetentionDays: 7 });
    // Leading zeros read as the API reads them.
    expect(parseDeployArgs(["--ci-run-retention-days", "007"])?.ci).toEqual({
      runRetentionDays: 7,
    });
    for (const bad of ["0", "6", "401", "1000", "30.5", "-30", "thirty", ""])
      expect(parseDeployArgs(["--ci-run-retention-days", bad])).toBeUndefined();
  });

  it("takes when CI was switched on, as the API reads it, only with runners on", () => {
    expect(parseDeployArgs(["--ci-since", "2026-11-22T09:00:00Z"])).toEqual({
      plan: "paid",
      ci: { since: "2026-11-22T09:00:00Z" },
    });
    expect(
      parseDeployArgs(["--plan", "free", "--ci-runners", "on", "--ci-since", "1795320500180"]),
    ).toEqual({ plan: "free", ci: { runners: "on", since: "1795320500180" } });
    expect(parseDeployArgs(["--plan", "free", "--ci-since", "1795320500180"])).toBeUndefined();
    expect(
      parseDeployArgs(["--ci-runners", "off", "--ci-since", "2026-11-22T09:00:00Z"]),
    ).toBeUndefined();
    for (const bad of ["2026-11-22", "2026-11-22T09:00:00", "yesterday", "-5", ""])
      expect(parseDeployArgs(["--ci-since", bad])).toBeUndefined();
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
      email: {
        provider: "resend",
        from: "Fyrden <n@notify.example>",
        secretsFile: "/s.json",
        sending: false,
        limits: {},
      },
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
    for (const from of [
      "nobody",
      "n@example",
      "n@.example",
      "n@example.",
      "n@a@b.example",
      "Name<n@x.example>",
      "<n@x.example>",
      "N <a> <n@x.example>",
      "Name <n@x.example",
      "n x@y.example",
      // Long and invalid at its end: refused at once (a backtracking pattern took polynomial time).
      `n@${"!.".repeat(20_000)} `,
    ])
      expect(
        parseDeployArgs(["--email", "resend", "--email-from", from, "--email-secrets-file", "s"]),
        from.slice(0, 40),
      ).toBeUndefined();
  });

  it("takes the sending switch and the allowance's limits only with a provider, when they fit", () => {
    const email = [
      "--email",
      "resend",
      "--email-from",
      "n@notify.example",
      "--email-secrets-file",
      "/s.json",
    ];
    expect(
      parseDeployArgs([
        ...email,
        "--email-sending",
        "on",
        "--email-daily-limit",
        "50000",
        "--email-monthly-limit",
        "1000000",
        "--email-reserve",
        "500",
      ]),
    ).toMatchObject({
      email: { sending: true, limits: { daily: 50_000, monthly: 1_000_000, reserve: 500 } },
    });
    expect(parseDeployArgs([...email, "--email-sending", "off"])).toMatchObject({
      email: { sending: false },
    });
    expect(parseDeployArgs([...email, "--email-daily-limit", "0"])).toMatchObject({
      email: { limits: { daily: 0 } },
    });
    for (const extra of [
      ["--email-sending", "yes"],
      ["--email-daily-limit", "5"],
      ["--email-daily-limit", "200", "--email-monthly-limit", "100"],
      ["--email-reserve", "100"],
      ["--email-daily-limit", "-1"],
      ["--email-daily-limit", "1e3"],
    ])
      expect(parseDeployArgs([...email, ...extra]), extra.join(" ")).toBeUndefined();
    expect(parseDeployArgs([...email, "--public-origin", "https://git.example"])).toMatchObject({
      email: { publicOrigin: "https://git.example" },
    });
    for (const [given, canonical] of [
      ["https://Git.Example", "https://git.example"],
      ["https://git.example:443", "https://git.example"],
      ["https://git.example:8443", "https://git.example:8443"],
      ["https://git.example/", "https://git.example"],
    ] as const)
      expect(parseDeployArgs([...email, "--public-origin", given])).toMatchObject({
        email: { publicOrigin: canonical },
      });
    for (const bad of [
      "http://git.example",
      "https://git.example/x",
      "https://git.example:99999",
      "https://u:p@git.example",
      "git",
    ])
      expect(parseDeployArgs([...email, "--public-origin", bad]), bad).toBeUndefined();
    expect(parseDeployArgs(["--public-origin", "https://git.example"])).toBeUndefined();
    expect(parseDeployArgs(["--email-sending", "on"])).toBeUndefined();
    expect(parseDeployArgs(["--email-daily-limit", "10"])).toBeUndefined();
  });

  it("sends email only with the webhook's secret and a key that reads the suppression list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fyrden-email-"));
    const file = join(dir, "secrets.json");
    const args = {
      provider: "resend" as const,
      from: "n@notify.example",
      secretsFile: file,
      sending: true,
      limits: {},
    };
    const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const asked: string[] = [];
    const answering = (status: number) =>
      (async (url: string) => {
        asked.push(url);
        return new Response("{}", { status });
      }) as unknown as typeof fetch;
    await writeFile(file, JSON.stringify({ RESEND_API_KEY: "re_test12345" }));
    await expect(emailDeploy(args, answering(200))).rejects.toThrow(/RESEND_WEBHOOK_SECRET/);
    expect(await emailDeploy({ ...args, sending: false }, answering(200))).toMatchObject({
      apiKey: "re_test12345",
      sending: false,
    });
    expect(asked).toEqual([]);
    for (const bad of [
      "nope",
      `whsec_${"A".repeat(33)}`,
      "whsec_AAAA",
      "whsec_not base64!",
      `whsec_${"A".repeat(22)}=`,
      `whsec_${"A".repeat(22)}`,
      `whsec_${"A".repeat(21)}B==`,
      `whsec_${"A".repeat(32)}==`,
    ]) {
      await writeFile(
        file,
        JSON.stringify({ RESEND_API_KEY: "re_test12345", RESEND_WEBHOOK_SECRET: bad }),
      );
      await expect(emailDeploy({ ...args, sending: false }), bad).rejects.toThrow(
        /RESEND_WEBHOOK_SECRET is not a webhook signing secret/,
      );
    }
    await writeFile(
      file,
      JSON.stringify({ RESEND_API_KEY: "re_test12345", RESEND_WEBHOOK_SECRET: secret }),
    );
    expect(await emailDeploy(args, answering(200))).toMatchObject({
      webhookSecret: secret,
      sending: true,
    });
    expect(asked).toEqual(["https://api.resend.com/suppressions?limit=1"]);
    await expect(emailDeploy(args, answering(401))).rejects.toThrow(/full-access key/);
    await expect(emailDeploy(args, answering(403))).rejects.toThrow(/full-access key/);
    await expect(emailDeploy(args, answering(500))).rejects.toThrow(/answered 500/);
    await expect(
      checkEmailKey("re_test12345", (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch),
    ).rejects.toThrow(/could not reach Resend/);
    await rm(dir, { recursive: true });
  });

  it("adds watchers to events' audiences only when asked", () => {
    expect(parseDeployArgs(["--watch-audiences", "on"])).toEqual({
      plan: "paid",
      watchAudiences: true,
    });
    expect(parseDeployArgs(["--watch-audiences", "off"])).toEqual({ plan: "paid" });
    expect(parseDeployArgs(["--watch-audiences", "yes"])).toBeUndefined();
    expect(parseDeployArgs(["--read-model-maintenance", "on"])).toEqual({
      plan: "paid",
      readModelMaintenance: true,
    });
    expect(parseDeployArgs(["--read-model-maintenance", "off"])).toEqual({ plan: "paid" });
    expect(parseDeployArgs(["--read-model-maintenance", "yes"])).toBeUndefined();
  });

  it("turns live hints on only when asked, with a socket allowance that fits", () => {
    expect(parseDeployArgs(["--live", "on"])).toEqual({ plan: "paid", live: {} });
    expect(parseDeployArgs(["--live", "on", "--live-sockets", "500"])).toEqual({
      plan: "paid",
      live: { sockets: 500 },
    });
    expect(parseDeployArgs(["--live", "off"])).toEqual({ plan: "paid" });
    for (const args of [
      ["--live", "yes"],
      ["--live-sockets", "10"],
      ["--live", "off", "--live-sockets", "10"],
      ["--live", "on", "--live-sockets", "0"],
      ["--live", "on", "--live-sockets", "100001"],
    ])
      expect(parseDeployArgs(args), args.join(" ")).toBeUndefined();
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

  it("reads a CI daily allowance as the API does: discretionary work's resources, Worker requests and R2 reads", () => {
    expect(validAllowance("worker_requests=15000,do_requests=0,r2_class_b=5", CI_RESOURCES)).toBe(
      true,
    );
    expect(validAllowance("worker_requests=15000", DISCRETIONARY_RESOURCES)).toBe(false);
    for (const bad of [
      "",
      "rows=5",
      "worker_requests=",
      "worker_requests=1e4",
      "worker_requests=-1",
      "worker_requests=5;do_requests=1",
      "worker_requests=5,worker_requests=6",
    ])
      expect(validAllowance(bad, CI_RESOURCES), bad).toBe(false);
  });
});

describe("the command", () => {
  it("runs under Node as it is, as CI runs it (no syntax Node's type stripping lacks)", () => {
    const run = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, "../src/index.ts"), "--help"],
      {
        encoding: "utf8",
      },
    );
    expect(run.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
    expect(run.stdout).toMatch(/^usage:/);
  });
});
