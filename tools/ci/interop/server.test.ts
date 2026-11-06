// The interop server starts on fresh ports when the first it picked are taken.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { freePorts } from "../e2e/wrangler-dev.ts";
import { startServer } from "./server.ts";

/** A listener on 127.0.0.1 holding a port the OS chose, until the test ends. */
async function heldPort(): Promise<number> {
  const server: Server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  onTestFinished(() => {
    server.close();
  });
  return (server.address() as { port: number }).port;
}

it("starts the interop server on fresh ports when the first ones are taken", async () => {
  const taken = await heldPort();
  const takenInspector = await heldPort();
  // The held pair only on the first call; later calls ask the OS afresh, as the helper does.
  let calls = 0;
  let chosen: number[] = [];
  const pickPorts = async (): Promise<[number, number]> => {
    calls++;
    chosen = calls === 1 ? [taken, takenInspector] : await freePorts(2);
    return chosen as [number, number];
  };
  const persistTo = await mkdtemp(join(tmpdir(), "interop-port-"));
  onTestFinished(() => rm(persistTo, { recursive: true, force: true }));

  const server = await startServer({
    persistTo,
    pickPorts,
  });
  onTestFinished(() => server.stop());

  expect(calls).toBeGreaterThan(1);
  expect(server.origin).toBe(`http://127.0.0.1:${chosen[0]}`);
  expect(server.output()).toMatch(/Address already in use/);
}, 180_000);
