// Webhook secrets: signatures as Standard Webhooks says (both secrets while
// one replaces the other), and the key secrets are sealed with brought in,
// rotated and refused when malformed.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RepoDO } from "../src/do/RepoDO.js";
import { secretKeys, signature } from "../src/webhooks/secrets.js";
import { api, json } from "./helpers/api.js";
import { inRepo } from "./helpers/repo-git.js";
import { webhookTest } from "./helpers/webhooks.js";

const t = webhookTest();

describe("webhooks", () => {
  it("sign with the Standard Webhooks test vector, and with both secrets while one is replaced", async () => {
    const body = new TextEncoder().encode('{"test": 2432232314}');
    const message = { id: "msg_p5jXN8AQM9LWM0D4loKWxJek", timestamp: 1614265330, body };
    expect(await signature(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], message)).toBe(
      "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    );
    const hook = (await t.createHook()).body;
    const rotated = await json<{ secret: string }>(
      api("POST", `${t.path}/hooks/${hook.id}/secret`, t.owner.token),
    );
    expect(rotated.body.secret).not.toBe(hook.secret);
    const both = await t.stub().hookForDelivery(hook.id);
    expect(both.kind === "hook" && both.secrets).toEqual([rotated.body.secret, hook.secret]);
    await api("DELETE", `${t.path}/hooks/${hook.id}/secret/previous`, t.owner.token);
    const one = await t.stub().hookForDelivery(hook.id);
    expect(one.kind === "hook" && one.secrets).toEqual([rotated.body.secret]);
  });

  it("are sealed with a new key brought in beside the old one, then opened by it alone", async () => {
    const hook = (await t.createHook()).body;
    const next = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const original = (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY as string;
    const vars = (r: RepoDO) =>
      (r as unknown as { env: { WEBHOOKS_KEY?: string; WEBHOOKS_KEY_NEXT?: string } }).env;
    try {
      // The new key beside the old one: everything sealed again with it.
      await inRepo(t.stub(), (r: RepoDO) => {
        vars(r).WEBHOOKS_KEY_NEXT = next;
      });
      expect(await t.stub().resealHookSecrets(50)).toEqual({
        resealed: 1,
        remaining: 0,
        unreadable: 0,
      });
      // Then the new key alone: the secret still opens.
      await inRepo(t.stub(), (r: RepoDO) => {
        vars(r).WEBHOOKS_KEY = next;
        delete vars(r).WEBHOOKS_KEY_NEXT;
      });
      const opened = await t.stub().hookForDelivery(hook.id);
      expect(opened.kind === "hook" && opened.secrets).toEqual([hook.secret]);
    } finally {
      await inRepo(t.stub(), (r: RepoDO) => {
        vars(r).WEBHOOKS_KEY = original;
        delete vars(r).WEBHOOKS_KEY_NEXT;
      });
    }
  });

  it("seal nothing under a malformed next key, the old one still opening", async () => {
    const keys = await secretKeys({
      WEBHOOKS_KEY: (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY,
      WEBHOOKS_KEY_NEXT: btoa("x".repeat(31)),
    });
    expect(keys.current).toBeUndefined();
    expect(keys.misconfigured).toContain("WEBHOOKS_KEY_NEXT");
    expect(keys.byId.size).toBe(1);
    // One after the other, nothing else changing: absent, then empty, then absent again.
    const valid = (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY;
    expect((await secretKeys({ WEBHOOKS_KEY: valid })).current).toBeDefined();
    expect(
      (await secretKeys({ WEBHOOKS_KEY: valid, WEBHOOKS_KEY_NEXT: "" })).current,
    ).toBeUndefined();
    expect((await secretKeys({ WEBHOOKS_KEY: valid })).current).toBeDefined();
    for (const empty of [{ WEBHOOKS_KEY_NEXT: "" }, { WEBHOOKS_KEY: "" }]) {
      const set = await secretKeys({
        WEBHOOKS_KEY: (env as { WEBHOOKS_KEY?: string }).WEBHOOKS_KEY,
        ...empty,
      });
      expect(set.current).toBeUndefined();
      expect(set.misconfigured).toBeDefined();
    }
  });

  it("drop a replaced secret past its week, so a key rotation finds nothing unreadable", async () => {
    const hook = (await t.createHook()).body;
    const rotated = await json<{ secret: string }>(
      api("POST", `${t.path}/hooks/${hook.id}/secret`, t.owner.token),
    );
    // The previous secret's week is over, and the key that sealed it is gone.
    await inRepo(t.stub(), (r: RepoDO) => {
      const sql = r.git.context.storage.sql;
      const [current, previous] = JSON.parse(
        sql.exec<{ secrets: string }>("SELECT secrets FROM webhooks").one().secrets,
      );
      sql.exec(
        "UPDATE webhooks SET secrets = ?",
        JSON.stringify([current, { ...previous, keyId: "0000000000000000", until: 1 }]),
      );
    });
    expect(await t.stub().resealHookSecrets(50)).toMatchObject({ unreadable: 0 });
    const left = await inRepo(t.stub(), (r: RepoDO) =>
      JSON.parse(
        r.git.context.storage.sql.exec<{ secrets: string }>("SELECT secrets FROM webhooks").one()
          .secrets,
      ),
    );
    expect(left).toHaveLength(1);
    const opened = await t.stub().hookForDelivery(hook.id);
    expect(opened.kind === "hook" && opened.secrets).toEqual([rotated.body.secret]);
  });
});
