// A repository webhook's delivery and its redelivery, against fyrden-api
// under `wrangler dev`, through public entry points only: a receiver in
// this process takes a pull request's delivery, the delivery log shows it,
// and a redelivery comes with the same `webhook-id` and body and a fresh
// Standard Webhooks signature, which the test verifies itself.
//
// The server posts only to https URLs at public addresses (every repository
// is private, and loopback and private addresses are refused), so the
// receiver must be reached through a public https URL that forwards to it,
// such as a tunnel: set FYRDEN_E2E_WEBHOOK_URL to that URL and
// FYRDEN_E2E_WEBHOOK_PORT to the local port it forwards to. Without them
// the test is skipped.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Account, eventually, type Forge, Git, seededRepo, startForge } from "./forge.js";

const RECEIVER_URL = process.env.FYRDEN_E2E_WEBHOOK_URL;
const RECEIVER_PORT = Number(process.env.FYRDEN_E2E_WEBHOOK_PORT ?? "0");
const REPO = "hooked";

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

let forge: Forge;
let owner: Account;
let git: Git;
let work = "";
let receiver: Server | undefined;
const received: Received[] = [];

/**
 * Verifies a Standard Webhooks signature: one of the space-separated
 * `v1,<base64>` values is the HMAC-SHA256 of `<id>.<timestamp>.<body>` with
 * the secret's bytes (base64 after `whsec_`).
 */
function verify(secret: string, message: Received): boolean {
  const id = String(message.headers["webhook-id"]);
  const timestamp = String(message.headers["webhook-timestamp"]);
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), message.body]))
    .digest();
  return String(message.headers["webhook-signature"])
    .split(" ")
    .some((part) => {
      const [version, value] = part.split(",");
      if (version !== "v1" || value === undefined) return false;
      const given = Buffer.from(value, "base64");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

describe.skipIf(!RECEIVER_URL || !RECEIVER_PORT)("webhook redelivery (wrangler dev)", () => {
  beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      });
    });
    await new Promise<void>((listening) =>
      receiver?.listen(RECEIVER_PORT, "127.0.0.1", () => listening()),
    );
    forge = await startForge("hooks");
    owner = forge.admin;
    git = new Git(forge, owner);
    work = await seededRepo(forge, owner, git, REPO, { "README.md": "hooked\n" });
  }, 180_000);

  afterAll(async () => {
    await forge?.stop();
    await new Promise((closed) => (receiver ? receiver.close(closed) : closed(undefined)));
  });

  const at = () => ({ owner: owner.handle, repo: REPO });

  /** The deliveries the receiver took of `event`. */
  const of = (event: string) => received.filter((r) => r.headers["x-fyrden-event"] === event);

  it("delivers a pull request's event signed, logs it, and redelivers it signed afresh", {
    timeout: 180_000,
  }, async () => {
    const hook = await owner.api.call("repos.hooks.create", {
      ...at(),
      config: { url: RECEIVER_URL as string },
      events: ["pull_request"],
    });
    expect(hook.secret).toMatch(/^whsec_/);

    await git.ok(["checkout", "-q", "-b", "hooked"], work);
    await git.commit(work, { "change.txt": "change\n" }, "change");
    await git.ok(["push", "-q", "origin", "hooked"], work);
    const pull = await owner.api.call("pulls.create", {
      ...at(),
      title: "Hooked",
      head: "hooked",
      base: "main",
    });

    const first = await eventually("the pull request's delivery", async () =>
      of("pull_request").at(0),
    );
    expect(verify(hook.secret, first)).toBe(true);
    // A body changed in transit would not verify.
    expect(verify(hook.secret, { ...first, body: Buffer.from(`${first.body} `) })).toBe(false);
    const id = String(first.headers["webhook-id"]);
    expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
    const firstAt = Number(first.headers["webhook-timestamp"]);
    expect(Math.abs(firstAt - Date.now() / 1000)).toBeLessThan(300);
    const payload = JSON.parse(first.body.toString()) as {
      event: string;
      action: string;
      number: number;
    };
    expect(payload).toMatchObject({ event: "pull_request", action: "opened", number: pull.number });

    // The delivery log shows it done, with its body and its one attempt.
    const logged = await eventually("the delivery done in the log", async () => {
      const page = await owner.api.call("repos.hooks.deliveries.list", {
        ...at(),
        hook_id: hook.id,
      });
      const delivery = page.deliveries.find((d) => d.id === id);
      return delivery?.state === "done" ? delivery : undefined;
    });
    expect(logged).toMatchObject({ event: "pull_request", action: "opened", attempts: 1 });
    const detail = await owner.api.call("repos.hooks.deliveries.get", {
      ...at(),
      hook_id: hook.id,
      delivery_id: id,
    });
    expect(detail.request.payload).toEqual(JSON.parse(first.body.toString()));
    expect(detail.attempts_made.map((a) => a.status_code)).toEqual([200]);

    // A later second, so the fresh signature's timestamp differs.
    await eventually("the next second", async () =>
      Math.floor(Date.now() / 1000) > firstAt ? true : undefined,
    );
    const redelivered = await owner.api.call("repos.hooks.deliveries.redeliver", {
      ...at(),
      hook_id: hook.id,
      delivery_id: id,
    });
    expect(redelivered.id).toBe(id);
    const second = await eventually("the redelivery", async () => of("pull_request").at(1));
    expect(second.headers["webhook-id"]).toBe(id);
    expect(second.body.equals(first.body)).toBe(true);
    expect(Number(second.headers["webhook-timestamp"])).toBeGreaterThan(firstAt);
    expect(second.headers["webhook-signature"]).not.toBe(first.headers["webhook-signature"]);
    expect(verify(hook.secret, second)).toBe(true);
    const after = await eventually("the redelivery in the log", async () => {
      const again = await owner.api.call("repos.hooks.deliveries.get", {
        ...at(),
        hook_id: hook.id,
        delivery_id: id,
      });
      return again.state === "done" && again.attempts === 2 ? again : undefined;
    });
    expect(after.attempts_made.map((a) => a.status_code)).toEqual([200, 200]);
  });
});
