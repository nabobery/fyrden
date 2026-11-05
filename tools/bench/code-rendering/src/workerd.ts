/**
 * Runs the bench Worker in workerd, the runtime under `wrangler dev`, its
 * Vite plugin and the Workers Vitest pool, driven directly so each cold
 * sample gets a fresh process (a fresh isolate, nothing compiled or cached)
 * and the process's CPU and memory can be read from /proc.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export interface ProcStats {
  /** User plus system CPU of the whole process, in clock ticks (1/100 s here). */
  cpuTicks: number;
  /** Peak resident memory of the process, in KiB. */
  vmHwmKiB: number;
  vmRssKiB: number;
}

/** Writes the capnp config serving `dir`'s worker.js and any .wasm next to it. */
export function writeConfig(dir: string, compatibilityDate: string): string {
  const modules = [`(name = "worker.js", esModule = embed "worker.js")`];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".wasm")))
    modules.push(`(name = "${basename(file)}", wasm = embed "${basename(file)}")`);
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .bench)],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],
);
const bench :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "${compatibilityDate}",
);
`;
  const path = join(dir, "config.capnp");
  writeFileSync(path, config);
  return path;
}

/** Every workerd process started and not yet stopped, for `Workerd.killAll`. */
const running = new Set<ChildProcess>();

export class Workerd {
  private readonly child: ChildProcess;
  readonly url: string;
  /** Wall time from spawn until the socket listens, in ms. */
  readonly startMs: number;

  private constructor(child: ChildProcess, url: string, startMs: number) {
    this.child = child;
    this.url = url;
    this.startMs = startMs;
  }

  /**
   * Starts workerd and resolves once it reports its socket listening (its
   * control fd). A process that fails to start is killed before the promise
   * rejects.
   */
  static start(binary: string, config: string): Promise<Workerd> {
    const started = performance.now();
    const child = spawn(binary, ["serve", "--control-fd=3", config], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    running.add(child);
    child.once("exit", () => running.delete(child));
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise<Workerd>((resolve, reject) => {
      const fail = (error: Error) => {
        child.kill("SIGKILL");
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", (code) => fail(new Error(`workerd exited (${code}): ${stderr}`)));
      const control = child.stdio[3];
      if (!control || !("on" in control)) return fail(new Error("no control fd"));
      createInterface({ input: control as NodeJS.ReadableStream }).on("line", (line) => {
        try {
          const event = JSON.parse(line) as { event: string; socket: string; port: number };
          if (event.event === "listen" && event.socket === "http")
            resolve(
              new Workerd(child, `http://127.0.0.1:${event.port}`, performance.now() - started),
            );
        } catch (error) {
          fail(error as Error);
        }
      });
    });
  }

  /** Starts workerd, runs `use` with it, and stops it whether `use` succeeds or throws. */
  static async with<T>(
    binary: string,
    config: string,
    use: (w: Workerd) => Promise<T>,
  ): Promise<T> {
    const w = await Workerd.start(binary, config);
    try {
      return await use(w);
    } finally {
      await w.stop();
    }
  }

  /** Kills every workerd still running, synchronously (for an interrupted run). */
  static killAll(): void {
    for (const child of running) child.kill("SIGKILL");
  }

  stats(): ProcStats {
    const pid = this.child.pid;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised command name; utime and stime are fields 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kib = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? NaN);
    return {
      cpuTicks: Number(fields[11]) + Number(fields[12]),
      vmHwmKiB: kib("VmHWM"),
      vmRssKiB: kib("VmRSS"),
    };
  }

  async render(
    query: Record<string, string | number>,
    body: string,
  ): Promise<{
    loadMs: number;
    renderMs: number;
    totalMs: number;
    reps: number;
    htmlBytes: number;
    spans: number;
  }> {
    const params = new URLSearchParams(
      Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
    );
    const response = await fetch(`${this.url}/render?${params}`, { method: "POST", body });
    if (!response.ok) throw new Error(`render failed: ${response.status} ${await response.text()}`);
    return response.json() as never;
  }

  async noop(): Promise<void> {
    const response = await fetch(`${this.url}/noop`);
    await response.arrayBuffer();
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const child = this.child;
      child.removeAllListeners("exit");
      // A process killed by a signal has a signalCode and no exitCode.
      if (child.exitCode !== null || child.signalCode !== null) {
        running.delete(child);
        return resolve();
      }
      child.once("exit", () => {
        running.delete(child);
        resolve();
      });
      child.kill("SIGKILL");
    });
  }
}
