// `wrangler dev` for an end-to-end test: started on ports the OS reports
// free, which another suite running in parallel may still take before this
// one binds them; a start that fails on a port already in use is tried
// again on fresh ports.
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

/** Starts tried at most, a port taken meanwhile each time. */
const ATTEMPTS = 3;
const PORT_TAKEN = /Address already in use|EADDRINUSE/;

export interface WranglerDev {
  readonly child: ChildProcess;
  /** The HTTP port, on 127.0.0.1. */
  readonly port: number;
  /** Resolves when the process has exited and its output pipes have closed. */
  readonly closed: Promise<void>;
}

/**
 * Starts `wrangler dev <args>` on 127.0.0.1 with an HTTP and an inspector
 * port of its own, resolving once it says it is ready. Everything it
 * writes (a failed start's output included) goes to `onOutput`.
 */
export async function startWranglerDev(options: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly onOutput: (text: string) => void;
  readonly timeoutMs?: number;
}): Promise<WranglerDev> {
  for (let attempt = 1; ; attempt++) {
    const [port, inspectorPort] = (await freePorts(2)) as [number, number];
    const child = spawn(
      process.execPath,
      [
        wranglerBin,
        "dev",
        ...options.args,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        // Its own inspector port: servers each probing up from 9229 can pick the same one.
        "--inspector-port",
        String(inspectorPort),
      ],
      {
        cwd: options.cwd,
        env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
      },
    );
    const closed = new Promise<void>((done) => child.once("close", () => done()));
    let output = "";
    const started = await new Promise<"ready" | "port_taken" | Error>((settle) => {
      const timer = setTimeout(
        () => settle(new Error(`wrangler dev did not start:\n${output}`)),
        options.timeoutMs ?? 60_000,
      );
      const onData = (d: Buffer) => {
        const text = String(d);
        output += text;
        options.onOutput(text);
        if (/Ready on/.test(output)) {
          clearTimeout(timer);
          settle("ready");
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      // On `close`, not `exit`: the last of its output (the bind error) can come after `exit`.
      child.once("close", (code) => {
        clearTimeout(timer);
        settle(
          PORT_TAKEN.test(output) && attempt < ATTEMPTS
            ? "port_taken"
            : new Error(`wrangler dev exited (${code}):\n${output}`),
        );
      });
    });
    if (started === "ready") return { child, port, closed };
    if (started instanceof Error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      throw started;
    }
    await closed;
  }
}

/** `count` distinct ports free on 127.0.0.1 at the time of asking. */
async function freePorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    const ports: number[] = [];
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((listening, fail) => {
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => listening());
      });
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port was given");
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  }
}
