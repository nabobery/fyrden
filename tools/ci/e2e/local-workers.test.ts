// Runs both Workers locally (wrangler dev with two configs, so the web
// Worker's API service binding is real) and smoke-tests the web Worker:
// its page and its /healthz both go through the binding into fyrden-api.
// Needs `pnpm --filter @fyrden/web build` first (turbo does it).
import { join, resolve } from "node:path";
import { generateToken, mentionsToken, secureRandomBytes } from "@fyrden/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSmoke, webChecks } from "../src/smoke.ts";
import { startWranglerDev, type WranglerDev } from "./wrangler-dev.js";

const root = resolve(import.meta.dirname, "../../..");
let port = 0;
let server: WranglerDev | undefined;
// Everything both Workers write, for the whole run.
let output = "";

beforeAll(async () => {
  server = await startWranglerDev({
    args: [
      "-c",
      join(root, "apps/web/build/server/wrangler.json"),
      "-c",
      join(root, "apps/api/wrangler.jsonc"),
    ],
    cwd: join(root, "apps/web"),
    onOutput: (text) => {
      output += text;
    },
  });
  port = server.port;
}, 90_000);

/**
 * What the Workers wrote. `[wrangler:info]` lines are wrangler dev's own
 * local access log, which echoes request URLs and is not Worker output.
 */
const workerLines = (from = 0) =>
  output
    .slice(from)
    .split("\n")
    .filter((line) => !line.startsWith("[wrangler:info]"));

/** Polls the Worker output until `match` appears; fails after `timeoutMs`. */
async function waitForLine(from: number, match: RegExp, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!workerLines(from).some((line) => match.test(line))) {
    if (Date.now() > deadline) throw new Error(`no Worker log line matched ${match}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

afterAll(async () => {
  await server?.stop();
  // Lines printed late, after the test that caused them, are checked too.
  expect(workerLines().filter(mentionsToken)).toEqual([]);
});

describe("fyrden-web and fyrden-api running together", () => {
  it("serves the page and health check through the API service binding", async () => {
    const results = await runSmoke(webChecks(`http://127.0.0.1:${port}/`));
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  it("never logs a token from a URL React Router cannot match", async () => {
    const token = generateToken("pat", secureRandomBytes);
    const before = output.length;
    const res = await fetch(`http://127.0.0.1:${port}/no/such/page/${token}`);
    expect(res.status).toBe(404);
    await res.text();
    // This request's own error line: proves the log was written before checking it.
    await waitForLine(before, /"msg":"web server error".*no\/such\/page/);
    const written = workerLines(before);
    expect(written.filter(mentionsToken).map((l) => l.replaceAll(token, "<TOKEN>"))).toEqual([]);
  });
});
