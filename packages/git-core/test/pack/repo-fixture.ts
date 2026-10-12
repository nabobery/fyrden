import type { GitSandbox } from "../../testing/git-cli.js";

/** A small seeded PRNG (mulberry32), so fixture repos are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RepoShape {
  readonly seed: number;
  readonly commits: number;
  readonly files: number;
  /** Adds one binary file of this many random bytes, changed in every commit. */
  readonly binaryBytes?: number;
}

/**
 * Builds a history with `git fast-import` in one call: text files that
 * change a few lines per commit (so pack-objects finds deltas, and chains
 * grow with the commit count), an optional binary file, and an annotated
 * tag on the tip. Branch `main`.
 */
export async function buildRepo(sandbox: GitSandbox, shape: RepoShape): Promise<void> {
  const rand = prng(shape.seed);
  const word = () => Math.floor(rand() * 1e9).toString(36);
  const files: string[][] = [];
  for (let f = 0; f < shape.files; f++) {
    files.push(Array.from({ length: 20 + Math.floor(rand() * 60) }, () => `${word()} ${word()}`));
  }
  let binary = new Uint8Array(shape.binaryBytes ?? 0).map(() => Math.floor(rand() * 256));
  const parts: (string | Uint8Array)[] = [];
  const data = (bytes: Uint8Array | string) => {
    const body = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
    parts.push(`data ${body.length}\n`, body, "\n");
  };
  let mark = 1;
  let previousCommit = 0;
  for (let c = 0; c < shape.commits; c++) {
    const changed = c === 0 ? files.map((_, i) => i) : [Math.floor(rand() * files.length)];
    if (c > 0 && rand() < 0.5) changed.push(Math.floor(rand() * files.length));
    const blobMarks = new Map<string, number>();
    for (const f of new Set(changed)) {
      const lines = files[f] as string[];
      if (c > 0) {
        const at = Math.floor(rand() * lines.length);
        if (rand() < 0.3 && lines.length > 5) lines.splice(at, 1);
        else if (rand() < 0.5) lines.splice(at, 0, `${word()} inserted ${c}`);
        else lines[at] = `${word()} changed ${c}`;
      }
      parts.push(`blob\nmark :${mark}\n`);
      data(`${lines.join("\n")}\n`);
      blobMarks.set(`dir${f % 3}/file${f}.txt`, mark++);
    }
    if (binary.length > 0) {
      binary = binary.slice();
      for (let i = 0; i < 8; i++)
        binary[Math.floor(rand() * binary.length)] = Math.floor(rand() * 256);
      parts.push(`blob\nmark :${mark}\n`);
      data(binary);
      blobMarks.set("assets/data.bin", mark++);
    }
    parts.push(`commit refs/heads/main\nmark :${mark}\n`);
    parts.push(`committer Fyrden Test <test@fyrden.invalid> ${1767225600 + c * 60} +0000\n`);
    data(`commit ${c}\n`);
    if (previousCommit > 0) parts.push(`from :${previousCommit}\n`);
    for (const [path, blob] of blobMarks) parts.push(`M 100644 :${blob} ${path}\n`);
    parts.push("\n");
    previousCommit = mark++;
  }
  parts.push("tag v1\nfrom refs/heads/main\n");
  parts.push("tagger Fyrden Test <test@fyrden.invalid> 1767225600 +0000\n");
  data("release v1\n");
  const chunks = parts.map((p) => (typeof p === "string" ? new TextEncoder().encode(p) : p));
  const input = new Uint8Array(chunks.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    input.set(chunk, at);
    at += chunk.length;
  }
  await sandbox.git(["init", "-q", "-b", "main"]);
  await sandbox.git(["fast-import", "--quiet"], { input });
}

export interface PackObjectsOptions {
  readonly window?: number;
  readonly depth?: number;
  /** Use OFS_DELTA (git's default for fetch); otherwise every delta is a REF_DELTA. */
  readonly ofsDelta?: boolean;
  readonly thin?: boolean;
  /** rev-list arguments for `--revs` on stdin (default: all refs). */
  readonly revs?: readonly string[];
}

/** `git pack-objects --stdout` over the sandbox repo, recomputing every delta. */
export async function packObjects(
  sandbox: GitSandbox,
  options: PackObjectsOptions = {},
): Promise<Uint8Array> {
  const args = [
    "pack-objects",
    "--stdout",
    "-q",
    "--revs",
    "--no-reuse-delta",
    "--no-reuse-object",
  ];
  args.push(`--window=${options.window ?? 10}`, `--depth=${options.depth ?? 50}`);
  if (options.ofsDelta) args.push("--delta-base-offset");
  if (options.thin) args.push("--thin");
  if (!options.revs) args.push("--all");
  return sandbox.gitBytes(args, { input: options.revs ? `${options.revs.join("\n")}\n` : "" });
}
