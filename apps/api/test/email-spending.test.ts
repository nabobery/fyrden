// The provider allowance's configuration and periods: email off at a daily
// limit of 0 or limits that do not fit together, days and months by UTC.

import { afterEach, describe, expect, it, vi } from "vitest";
import { emailSending } from "../src/email/provider.js";
import {
  EMAIL_LIMIT_DEFAULTS,
  emailLimits,
  periodsOf,
  secondsUntilRoom,
} from "../src/email/spending.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the email allowance", () => {
  it("is Resend Free's unless set, and what the deployment sets when it fits", () => {
    expect(emailLimits({})).toEqual(EMAIL_LIMIT_DEFAULTS);
    expect(
      emailLimits({
        FYRDEN_EMAIL_DAILY_LIMIT: "50000",
        FYRDEN_EMAIL_MONTHLY_LIMIT: "1000000",
        FYRDEN_EMAIL_RESERVE: "500",
      }),
    ).toEqual({ daily: 50_000, monthly: 1_000_000, reserve: 500 });
    expect(emailLimits({ FYRDEN_EMAIL_DAILY_LIMIT: "5", FYRDEN_EMAIL_RESERVE: "0" })).toEqual({
      daily: 5,
      monthly: 3_000,
      reserve: 0,
    });
  });

  it("turns email off at 0 a day, and when the limits do not fit, saying so once", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(emailLimits({ FYRDEN_EMAIL_DAILY_LIMIT: "0" })).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    for (const vars of [
      { FYRDEN_EMAIL_DAILY_LIMIT: "5" },
      { FYRDEN_EMAIL_DAILY_LIMIT: "200", FYRDEN_EMAIL_MONTHLY_LIMIT: "100" },
      { FYRDEN_EMAIL_DAILY_LIMIT: "-1" },
      { FYRDEN_EMAIL_DAILY_LIMIT: "1e3" },
      { FYRDEN_EMAIL_RESERVE: "100" },
    ]) {
      expect(emailLimits({})).not.toBeNull();
      errors.mockClear();
      expect(emailLimits(vars), JSON.stringify(vars)).toBeNull();
      expect(emailLimits(vars)).toBeNull();
      expect(errors, JSON.stringify(vars)).toHaveBeenCalledTimes(1);
    }
  });

  it("counts by UTC day and month, and says when the spent one ends", () => {
    const lastMinute = Date.UTC(2026, 11, 31, 23, 59, 0);
    expect(periodsOf(lastMinute)).toEqual({
      day: Math.floor(lastMinute / 86_400_000),
      month: 2026 * 12 + 11,
    });
    expect(periodsOf(lastMinute + 60_000).month).toBe(2027 * 12);
    expect(secondsUntilRoom(lastMinute, "day")).toBe(60);
    expect(secondsUntilRoom(lastMinute, "month")).toBe(60);
    expect(secondsUntilRoom(Date.UTC(2026, 1, 1), "month")).toBe(28 * 24 * 60 * 60);
  });
});

describe("sending", () => {
  const configured = {
    FYRDEN_EMAIL_SENDING: "on",
    FYRDEN_EMAIL_PROVIDER: "resend",
    FYRDEN_EMAIL_FROM: "Fyrden <n@notify.example>",
    RESEND_API_KEY: "re_test12345",
    RESEND_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  };

  it("is on only with the provider, a usable callback secret and usable limits", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(emailSending(configured)).toBe(true);
    expect(
      emailSending({ ...configured, RESEND_WEBHOOK_SECRET: `whsec_${"A".repeat(22)}==` }),
    ).toBe(true);
    for (const [name, value] of [
      ["FYRDEN_EMAIL_SENDING", "off"],
      ["RESEND_WEBHOOK_SECRET", undefined],
      ["RESEND_WEBHOOK_SECRET", `whsec_${"A".repeat(33)}`],
      ["RESEND_WEBHOOK_SECRET", "whsec_AAAA"],
      // Padding missing or partial, or bits the encoding would not give back: not canonical.
      ["RESEND_WEBHOOK_SECRET", `whsec_${"A".repeat(22)}=`],
      ["RESEND_WEBHOOK_SECRET", `whsec_${"A".repeat(22)}`],
      ["RESEND_WEBHOOK_SECRET", `whsec_${"A".repeat(21)}B==`],
      ["RESEND_WEBHOOK_SECRET", `whsec_${"A".repeat(32)}==`],
      ["RESEND_API_KEY", undefined],
      ["FYRDEN_EMAIL_DAILY_LIMIT", "0"],
      ["FYRDEN_EMAIL_DAILY_LIMIT", "5"],
    ] as const)
      expect(emailSending({ ...configured, [name]: value }), `${name}=${value}`).toBe(false);
  });
});
