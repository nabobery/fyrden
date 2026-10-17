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
/**
 * How long a stop waits for the processes to exit on SIGTERM before killing
 * them. With the browser's close before it, it fits the e2e `hookTimeout`.
 */
const STOP_GRACE_MS = 10_000;
/** How often a stop looks whether the killed processes are all gone. */
const GONE_POLL_MS = 50;

export interface WranglerDev {
  /** The HTTP port, on 127.0.0.1. */
  readonly port: number;
  /**
   * Ends wrangler and every process it started: SIGTERM, then SIGKILL if
   * any is still running after a grace period. Resolves once they are all
   * gone and the output pipes have closed, so the state can be removed.
   * Calling it again is safe.
   */
  stop(): Promise<void>;
}

/** Signals whose default action ends this process. */
const ENDING_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** The groups `spawnOwned` started and has not stopped yet, by their leader's pid. */
const owned = new Set<number>();

/**
 * Kills the owned groups at once, this process ending. In groups of their
 * own, they would outlive it: an interrupt or a runner's SIGTERM reaches
 * this process's group, not theirs.
 */
function killOwned(): void {
  for (const pid of owned) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}

/** Kills the owned groups, then lets `signal` end this process as it would have. */
function onEndingSignal(signal: NodeJS.Signals): void {
  killOwned();
  owned.clear();
  unwatch();
  // Raised again for its default action, unless another listener handles it.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** One set of listeners for all the owned groups, there while any is. */
function watch(): void {
  process.on("exit", killOwned);
  for (const signal of ENDING_SIGNALS) process.on(signal, onEndingSignal);
}

function unwatch(): void {
  process.off("exit", killOwned);
  for (const signal of ENDING_SIGNALS) process.off(signal, onEndingSignal);
}

/**
 * Spawns `command` as the leader of a process group of its own, with a
 * `stop` (see `WranglerDev.stop`) that signals the whole group, every call
 * answered by the same promise. A group, because wrangler's `bin` script is
 * a launcher: it forwards SIGTERM to the CLI it runs but cannot forward
 * SIGKILL, and the CLI (and workerd under it) share the output pipes, so
 * killing the launcher alone leaves them running and the pipes open.
 */
export function spawnOwned(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  graceMs = STOP_GRACE_MS,
): { child: ChildProcess; stop: () => Promise<void> } {
  const child = spawn(command, args, { ...options, detached: true });
  // On `close`, not `exit`: output can still arrive between the two.
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  /** Sends `signal` to the group: false once none of it is left. */
  const signal = (sig: NodeJS.Signals | 0): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
  };
  // Not left behind if the test run itself ends first.
  const pid = child.pid;
  if (pid !== undefined) {
    if (owned.size === 0) watch();
    owned.add(pid);
  }
  const gone = async () => {
    await closed;
    // A process can outlive the pipes, the launcher's exit or its SIGKILL's delivery.
    while (signal(0)) await new Promise((r) => setTimeout(r, GONE_POLL_MS));
  };
  const stop = async () => {
    if (signal("SIGTERM")) {
      const all = gone();
      let grace: NodeJS.Timeout | undefined;
      const ended = await Promise.race([
        all.then(() => true),
        new Promise<boolean>((give) => {
          grace = setTimeout(() => give(false), graceMs);
        }),
      ]);
      clearTimeout(grace);
      if (!ended) signal("SIGKILL");
      await all;
    }
    await closed;
    if (pid !== undefined && owned.delete(pid) && owned.size === 0) unwatch();
  };
  let stopping: Promise<void> | undefined;
  return {
    child,
    stop: () => {
      stopping ??= stop();
      return stopping;
    },
  };
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
    const { child, stop } = spawnOwned(
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
    if (started === "ready") return { port, stop };
    await stop();
    if (started instanceof Error) throw started;
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
