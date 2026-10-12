import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { PackBuilder } from "../../src/pack-write/pack-builder.js";
import { type PackSizeReport, packSizeReport } from "../../src/pack-write/size-report.js";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { parseBytes } from "../pack/parse-helpers.js";
import { buildRepo } from "../pack/repo-fixture.js";
import { budget, memorySink, objectsOf, zlib } from "./support.js";

/*
 * Clone wire size with and without deltas: for each repository, the pack
 * `git pack-objects` writes for a full clone (a fresh delta search with
 * git's default window and depth, as after a repack: fast-import's own
 * deltas are poor) against the pack the writer produces with every object
 * whole (a regenerated pack without delta reuse). Reports numbers and
 * asserts nothing about them, so it only runs on request:
 *
 *   FYRDEN_BENCH=1 npx vitest run test/pack-write/clone-size.report.test.ts
 */

const sandboxes: GitSandbox[] = [];
afterAll(() => Promise.all(sandboxes.map((s) => s.dispose())));

const thisRepo = fileURLToPath(new URL("../../../../", import.meta.url));

async function repos(): Promise<[string, GitSandbox][]> {
  const own = await createGitSandbox();
  sandboxes.push(own);
  await own.git(["clone", "-q", "--bare", "--no-local", thisRepo, "."]);
  const text = await createGitSandbox();
  sandboxes.push(text);
  await buildRepo(text, { seed: 41, commits: 600, files: 80 });
  const binary = await createGitSandbox();
  sandboxes.push(binary);
  await buildRepo(binary, { seed: 42, commits: 150, files: 20, binaryBytes: 64 * 1024 });
  return [
    ["this repository (2 commits, real files)", own],
    ["synthetic text, 600 commits x 80 files", text],
    ["synthetic, 150 commits, 64 KiB binary edited each commit", binary],
  ];
}

function line(name: string, r: PackSizeReport): string {
  const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
  const types = (["commit", "tree", "blob", "tag"] as const)
    .map((t) => {
      const x = r.byType[t];
      return `${t} ${x.whole.count}w/${x.delta.count}d ${kib(x.whole.bytes + x.delta.bytes)}`;
    })
    .join(", ");
  return `  ${name}: ${kib(r.packBytes)} (${r.objects} objects; ${r.delta.count} deltas) [${types}]`;
}

describe.runIf(process.env.FYRDEN_BENCH)("clone wire size, deltas vs none", () => {
  it("reports both sizes for three repositories", { timeout: 600_000 }, async () => {
    const out: string[] = [];
    for (const [name, repo] of await repos()) {
      const deltified = await repo.gitBytes(
        [
          "pack-objects",
          "--stdout",
          "-q",
          "--revs",
          "--all",
          "--delta-base-offset",
          "--no-reuse-delta",
        ],
        { input: "" },
      );
      const { pack } = await parseBytes(deltified);
      const withDeltas = packSizeReport(pack.entries);
      pack.release();

      const { objects } = await objectsOf(deltified);
      const sink = memorySink();
      const builder = await PackBuilder.start(objects.length, { sink, zlib, memory: budget() });
      for (const o of objects) await builder.addObject(o.type, o.data, o.oid);
      (await builder.finish()).release();
      const whole = await parseBytes(sink.bytes());
      const withoutDeltas = packSizeReport(whole.pack.entries);
      whole.pack.release();

      const ratio = withoutDeltas.packBytes / withDeltas.packBytes;
      out.push(`${name}: whole/deltified = ${ratio.toFixed(2)}x`);
      out.push(line("git pack-objects", withDeltas));
      out.push(line("writer, all whole", withoutDeltas));
      expect(withoutDeltas.objects).toBe(withDeltas.objects);
    }
    console.info(out.join("\n"));
  });
});
