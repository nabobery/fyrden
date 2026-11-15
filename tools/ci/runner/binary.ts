// The pinned gitea/runner release binaries: downloaded once into a cache
// directory and checked against the SHA-256 written here, never against a
// checksum file fetched at run time.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RunnerVersion = "6.0.0" | "5.4.1";
export type RunnerArch = "amd64" | "arm64";

/**
 * SHA-256 of each release binary. Verified: each release's published
 * `checksums.txt`, https://gitea.com/gitea/runner/releases/download/v6.0.0/checksums.txt
 * and https://gitea.com/gitea/runner/releases/download/v5.4.1/checksums.txt
 * (read 2026-11-15; the arm64 values were also measured against the
 * downloaded binaries, and both files' signatures checked, 2026-11-13).
 */
export const RUNNER_SHA256: Readonly<Record<RunnerVersion, Readonly<Record<RunnerArch, string>>>> =
  {
    "6.0.0": {
      amd64: "62ecab223535968ba3fa46cf32f8f50279f0664ba14c6d3848c2f02210f9828e",
      arm64: "bfc1d40cd706ee174196e1f435de1400fde1d31dd71bb87b03bb2327e4681b24",
    },
    "5.4.1": {
      amd64: "7c4b1bd1fbc0d0dfb5a09bfa70b89e550a0af15fc90a911df7ccaeb348143508",
      arm64: "3ba021458e7a7ea4e8b685451caaea77de0e1aeaca1448d2501c46ec270eae1e",
    },
  };

export function runnerVersion(value: string | undefined): RunnerVersion {
  const version = value ?? "6.0.0";
  if (!Object.hasOwn(RUNNER_SHA256, version))
    throw new Error(
      `RUNNER_VERSION ${version} is not pinned (${Object.keys(RUNNER_SHA256).join(", ")})`,
    );
  return version as RunnerVersion;
}

/** The Linux architecture a container on this host runs natively. */
export function hostArch(arch: string = process.arch): RunnerArch {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`no pinned runner binary for ${arch}`);
}

export const binaryName = (version: RunnerVersion, arch: RunnerArch) =>
  `gitea-runner-${version}-linux-${arch}`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The path of the checked binary in `cacheDir` (by default
 * `$FYRDEN_RUNNER_CACHE`, else `~/.cache/fyrden-runner`), downloaded first
 * when it is missing or does not match. A download that does not match is
 * refused and never kept.
 */
export async function runnerBinary(
  version: RunnerVersion,
  arch: RunnerArch,
  options: { cacheDir?: string; fetch?: typeof fetch } = {},
): Promise<string> {
  const cacheDir =
    options.cacheDir ??
    process.env.FYRDEN_RUNNER_CACHE ??
    join(homedir(), ".cache", "fyrden-runner");
  const expected = RUNNER_SHA256[version][arch];
  const name = binaryName(version, arch);
  const path = join(cacheDir, version, name);
  const cached = await readFile(path).catch(() => undefined);
  if (cached && sha256(cached) === expected) return path;

  const url = `https://gitea.com/gitea/runner/releases/download/v${version}/${name}`;
  const res = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const actual = sha256(body);
  if (actual !== expected)
    throw new Error(`${name}: SHA-256 ${actual}, pinned ${expected}; the download is refused`);
  await mkdir(join(cacheDir, version), { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  try {
    await writeFile(partial, body, { mode: 0o755 });
    await chmod(partial, 0o755);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return path;
}
