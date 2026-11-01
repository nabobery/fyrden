// Standard Webhooks signatures, as Resend signs its webhooks: checked
// against the spec's own test vector, then each way a request fails.

import { describe, expect, it } from "vitest";
import { verifyWebhook, webhookKey } from "../src/email/webhook-signature.js";

// The Standard Webhooks specification's example
// (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TIMESTAMP = "1614265330";
const BODY = new TextEncoder().encode('{"test": 2432232314}');
const SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const AT = Number(TIMESTAMP) * 1000;

const headers = (fields: Record<string, string>) =>
  new Headers({
    "svix-id": ID,
    "svix-timestamp": TIMESTAMP,
    "svix-signature": SIGNATURE,
    ...fields,
  });

describe("a webhook signature", () => {
  it("verifies the specification's example, among other entries", async () => {
    const key = (await webhookKey(SECRET)) as CryptoKey;
    expect(await verifyWebhook(key, headers({}), BODY, AT)).toBe(true);
    // A rotation's list: an old secret's entry, then ours.
    const other = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    expect(
      await verifyWebhook(key, headers({ "svix-signature": `${other} ${SIGNATURE}` }), BODY, AT),
    ).toBe(true);
    // Within five minutes either way.
    expect(await verifyWebhook(key, headers({}), BODY, AT + 5 * 60_000)).toBe(true);
    expect(await verifyWebhook(key, headers({}), BODY, AT - 5 * 60_000)).toBe(true);
  });

  it("does not verify anything else", async () => {
    const key = (await webhookKey(SECRET)) as CryptoKey;
    const otherKey = (await webhookKey("whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")) as CryptoKey;
    expect(await verifyWebhook(otherKey, headers({}), BODY, AT)).toBe(false);
    expect(
      await verifyWebhook(key, headers({}), new TextEncoder().encode('{"test": 2432232314} '), AT),
    ).toBe(false);
    expect(await verifyWebhook(key, headers({ "svix-id": "msg_other" }), BODY, AT)).toBe(false);
    expect(await verifyWebhook(key, headers({}), BODY, AT + 5 * 60_000 + 1000)).toBe(false);
    expect(await verifyWebhook(key, headers({}), BODY, AT - 5 * 60_000 - 1000)).toBe(false);
    for (const signature of [
      SIGNATURE.replace("v1,", "v2,"),
      SIGNATURE.slice(0, -2),
      SIGNATURE.replace("v1,", ""),
      "",
    ])
      expect(
        await verifyWebhook(key, headers({ "svix-signature": signature }), BODY, AT),
        signature,
      ).toBe(false);
    for (const missing of ["svix-id", "svix-timestamp", "svix-signature"]) {
      const without = headers({});
      without.delete(missing);
      expect(await verifyWebhook(key, without, BODY, AT), missing).toBe(false);
    }
    expect(
      await verifyWebhook(key, headers({ "svix-timestamp": `${TIMESTAMP}.0` }), BODY, AT),
    ).toBe(false);
  });

  it("is keyed only by a whsec_ secret of standard base64", async () => {
    for (const secret of [
      "",
      "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "whsec_",
      "whsec_not base64!",
      "whsec_AAAA",
      `whsec_${"A".repeat(22)}=`,
      `whsec_${"A".repeat(21)}B==`,
    ])
      expect(await webhookKey(secret), secret).toBeNull();
  });
});
