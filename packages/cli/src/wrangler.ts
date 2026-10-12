import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  /** Extra environment for this call (e.g. CLOUDFLARE_ACCOUNT_ID). */
  env?: Record<string, string>;
}

export interface WranglerRunner {
  run(args: string[], options?: RunOptions): Promise<RunResult>;
}

/** Runs the wrangler version pinned in this repo (never a global install). */
export function nodeWranglerRunner(defaultCwd: string): WranglerRunner {
  // The package exports only package.json besides its API; resolve the bin through it.
  const pkg = createRequire(import.meta.url).resolve("wrangler/package.json");
  const bin = join(dirname(pkg), "bin", "wrangler.js");
  return {
    run(args, options = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [bin, ...args], {
          cwd: options.cwd ?? defaultCwd,
          env: {
            ...process.env,
            ...options.env,
            WRANGLER_SEND_METRICS: "false",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => {
          stdout += d;
        });
        child.stderr.on("data", (d: Buffer) => {
          stderr += d;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        // wrangler may exit without reading its input; the exit code reports that.
        child.stdin.on("error", () => {});
        child.stdin.end(options.input ?? "");
      });
    },
  };
}

/**
 * Account features that must be switched on once in the Cloudflare dashboard
 * before Fyrden can use them. wrangler reports each with its own error code.
 */
const SETUP_HINTS: readonly (readonly [RegExp, string])[] = [
  [
    /code: 10042\b/,
    "R2 is not enabled on this account: enable it in the Cloudflare dashboard (R2 Object Storage), then rerun.",
  ],
  [
    /code: 10089\b/,
    "Workers Analytics Engine is not enabled on this account: enable it in the Cloudflare dashboard (Workers & Pages > Analytics Engine), then rerun.",
  ],
];

export class WranglerError extends Error {
  override name = "WranglerError";
  /** What the operator has to do, when the failure is a known account setup step. */
  readonly hint: string | undefined;
  constructor(args: string[], result: RunResult) {
    // stderr can echo config but never a secret: secrets go in a file whose
    // path, not content, is on the command line.
    const output = (result.stderr || result.stdout).trim();
    const hint = SETUP_HINTS.find(([code]) => code.test(output))?.[1];
    super(
      `${hint ? `${hint}\n` : ""}wrangler ${args.join(" ")} failed (${result.code}): ${output.slice(-2000)}`,
    );
    this.hint = hint;
  }
}

export async function wrangler(runner: WranglerRunner, args: string[], options?: RunOptions) {
  const result = await runner.run(args, options);
  if (result.code !== 0) throw new WranglerError(args, result);
  return result.stdout;
}
