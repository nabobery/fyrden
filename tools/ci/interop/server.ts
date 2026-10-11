// fyrden-api under `wrangler dev` for the interoperability suites: fresh
// local storage in a temporary directory, one bootstrapped user, and the
// whole output kept so the suite can check that no token was logged.
import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mentionsToken } from "@fyrden/domain";

/**
 * The checkout whose Worker is served. FYRDEN_INTEROP_ROOT points the suite
 * at another copy, e.g. one with a deliberately planted bug.
 */
export const repoRoot = resolve(
  process.env.FYRDEN_INTEROP_ROOT ?? join(import.meta.dirname, "../../.."),
);
const apiDir = join(repoRoot, "apps/api");
const apiConfig = join(apiDir, "wrangler.jsonc");
const wranglerBin = join(
  dirname(createRequire(import.meta.url).resolve("wrangler/package.json")),
  "bin",
  "wrangler.js",
);

export interface ServerOptions {
  /** Directory for the local D1, R2 and Durable Object state. */
  readonly persistTo: string;
  /** FYRDEN_PLAN for the run: "free" (the default) or "paid". */
  readonly plan?: "free" | "paid";
  /** Extra `--var` values, e.g. a small push body limit. */
  readonly vars?: Readonly<Record<string, string>>;
}

export interface Server {
  readonly origin: string;
  /** The bootstrapped user's handle. */
  readonly handle: string;
  /** `http://<host>/<handle>/<name>.git`, without credentials. */
  repoUrl(name: string): string;
  /**
   * Mints another token for the user. Rate limits count per token, so each
   * case gets its own and cases cannot starve each other.
   */
  mintToken(): Promise<string>;
  /** Creates a repository through the REST API, as the holder of `token`. */
  createRepo(name: string, token: string): Promise<void>;
  /** Lines the Worker or wrangler printed that contain a token. */
  tokenLines(): string[];
  /** Everything wrangler printed so far. */
  output(): string;
  /**
   * Resolves true once `until` holds for the output, or false after
   * `timeoutMs` (or when wrangler exits first). wrangler dev logs each
   * request after its response, asynchronously, so a case that reads the
   * access log waits for the records it expects.
   */
  waitForOutput(until: (output: string) => boolean, timeoutMs?: number): Promise<boolean>;
  /**
   * Stops wrangler: SIGTERM, then SIGKILL if it has not exited within
   * 10 seconds. Resolves only once the process has closed, so its storage can
   * be removed; rejects if it never does.
   */
  stop(): Promise<void>;
}

/** How long stop() waits after SIGTERM, then after SIGKILL. */
const TERM_GRACE_MS = 10_000;
const KILL_GRACE_MS = 5_000;
/** Default bound for waitForOutput. */
const OUTPUT_WAIT_MS = 10_000;

const within = (promise: Promise<void>, ms: number): Promise<boolean> =>
  new Promise((done) => {
    const timer = setTimeout(() => done(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      done(true);
    });
  });

interface Exit {
  code: number | null;
  output: string;
}

function runNode(args: string[], cwd: string): Promise<Exit> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, output }));
  });
}

export async function startServer(options: ServerOptions): Promise<Server> {
  const migrate = await runNode(
    [
      wranglerBin,
      "d1",
      "migrations",
      "apply",
      "DIRECTORY",
      "--local",
      "--persist-to",
      options.persistTo,
      "-c",
      apiConfig,
    ],
    apiDir,
  );
  if (migrate.code !== 0) throw new Error(`D1 migrations failed:\n${migrate.output}`);

  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const origin = `http://127.0.0.1:${port}`;
  const bootstrapSecret = `interop-${crypto.randomUUID()}`;
  const vars = { FYRDEN_PLAN: options.plan ?? "free", ...options.vars };
  const dev: ChildProcess = spawn(
    process.execPath,
    [
      wranglerBin,
      "dev",
      "-c",
      apiConfig,
      "--persist-to",
      options.persistTo,
      "--var",
      `BOOTSTRAP_SECRET:${bootstrapSecret}`,
      ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      // Its own inspector port, so it can run beside other suites' servers.
      "--inspector-port",
      String(port + 1),
    ],
    {
      cwd: apiDir,
      env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    },
  );
  let output = "";
  const closed = new Promise<void>((done) => dev.once("close", () => done()));
  const exited = () => dev.exitCode !== null || dev.signalCode !== null;
  /** Called on every chunk of output and when wrangler closes. */
  const watchers = new Set<() => void>();
  const onData = (d: Buffer) => {
    output += d;
    for (const watch of watchers) watch();
  };
  dev.stdout?.on("data", onData);
  dev.stderr?.on("data", onData);
  void closed.then(() => {
    for (const watch of watchers) watch();
  });

  const waitForOutput = (until: (output: string) => boolean, timeoutMs = OUTPUT_WAIT_MS) =>
    new Promise<boolean>((done) => {
      const finish = (met: boolean) => {
        clearTimeout(timer);
        watchers.delete(watch);
        done(met);
      };
      const watch = () => {
        if (until(output)) finish(true);
        else if (exited()) finish(false);
      };
      const timer = setTimeout(() => finish(until(output)), timeoutMs);
      watchers.add(watch);
      watch();
    });

  const stop = async () => {
    if (!exited()) dev.kill("SIGTERM");
    if (await within(closed, TERM_GRACE_MS)) return;
    dev.kill("SIGKILL");
    if (!(await within(closed, KILL_GRACE_MS)))
      throw new Error(`wrangler dev (pid ${dev.pid}) did not exit after SIGTERM and SIGKILL`);
  };

  // From here on, any failure stops wrangler before it reaches the caller,
  // which never gets a handle to stop it with.
  try {
    let failed: unknown;
    const started = waitForOutput((text) => /Ready on/.test(text), 60_000);
    const onExit = (code: number | null) => {
      failed = new Error(`wrangler dev exited (${code}):\n${output}`);
    };
    dev.once("exit", onExit);
    const ready = await started;
    dev.off("exit", onExit);
    if (failed) throw failed;
    if (!ready) throw new Error(`wrangler dev did not start:\n${output}`);

    const handle = `interop${Date.now().toString(36)}`;
    const boot = await fetch(`${origin}/v0/admin/bootstrap`, {
      method: "POST",
      headers: { "X-Fyrden-Bootstrap-Secret": bootstrapSecret, "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    if (boot.status !== 201)
      throw new Error(`bootstrap failed: ${boot.status} ${await boot.text()}`);
    const { token: adminToken, user } = (await boot.json()) as {
      token: string;
      user: { id: string };
    };
    return {
      origin,
      handle,
      repoUrl: (name) => `${origin}/${handle}/${name}.git`,
      async mintToken() {
        // wrangler dev occasionally drops a request under load ("Network
        // connection lost"); a fresh idempotency key per attempt, because a
        // replay of a token mint returns no token.
        for (let attempt = 1; ; attempt++) {
          const res = await fetch(`${origin}/api/admin/users/${user.id}/tokens`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({ type: "pat", expires_in_days: 1 }),
          });
          if (res.status === 201) return ((await res.json()) as { token: string }).token;
          const detail = `${res.status} ${await res.text()}`;
          if (res.status < 500 || attempt === 3)
            throw new Error(`minting a token failed: ${detail}`);
        }
      },
      async createRepo(name, token) {
        const res = await fetch(`${origin}/api/user/repos`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({ name }),
        });
        if (res.status !== 201) {
          throw new Error(`creating ${name} failed: ${res.status} ${await res.text()}`);
        }
      },
      tokenLines: () => output.split("\n").filter(mentionsToken),
      output: () => output,
      waitForOutput,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
