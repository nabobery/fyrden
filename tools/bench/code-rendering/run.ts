/**
 * Where should highlighted file views render? Measures highlighting and
 * rendering to HTML in workerd (the web Worker's runtime) and in Node (a
 * stand-in for a browser's main thread), the bundle cost of each path and
 * the isolate's memory, and writes results.json and results.md next to
 * this file. See README.md for the method and the conclusions.
 *
 *   FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts [--quick] [--only=workerd,node,bundle]
 *
 * Times are printed only under FYRDEN_BENCH=1 (AGENTS.md); without it the
 * script says so and exits.
 */
// biome-ignore-all lint/suspicious/noConsole: a benchmark reports on the console
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measureBundles } from "./src/bundle-size.ts";
import { type Fixture, makeFixtures } from "./src/fixtures.ts";
import type { Mode } from "./src/render.ts";
import { largestWithin, type Summary, summarize } from "./src/stats.ts";
import {
  bundle,
  loadEsbuild,
  packageVersion,
  ROOT,
  workerdBinary,
  workerdVersion,
} from "./src/toolchain.ts";
import { Workerd, writeConfig } from "./src/workerd.ts";

if (process.env.FYRDEN_BENCH !== "1") {
  console.log("Benchmark skipped: set FYRDEN_BENCH=1 to run it (it prints times).");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const only = new Set(
  (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "workerd,node,bundle").split(","),
);
/** Samples per measurement: cold ones each start a fresh workerd or Node process. */
const RUNS = quick
  ? { cold: 3, warm: 5, warmLarge: 3, firstScreen: 3 }
  : { cold: 12, warm: 30, warmLarge: 12, firstScreen: 10 };
const MODES: Mode[] = ["highlights", "file"];
const BUDGET_MS = 10;
const compatibilityDate = "2026-10-01"; // apps/web/wrangler.jsonc

const work = mkdtempSync(join(tmpdir(), "fyrden-code-rendering-"));
const esbuild = loadEsbuild();
const log = (message: string) => console.error(`[bench] ${message}`);
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;
const isLarge = (f: Fixture) => f.bytes >= 256 * 1024;

const fixtureDir = join(work, "fixtures");
mkdirSync(fixtureDir);
const fixtures = makeFixtures(ROOT, fixtureDir, esbuild);
log(`${fixtures.length} fixtures in ${fixtureDir}`);

// ---------------------------------------------------------------- workerd

interface WorkerdRow {
  fixture: string;
  mode: Mode;
  bytes: number;
  htmlBytes: number;
  spans: number;
  cold: { total: Summary; load: Summary; render: Summary; peakRssDeltaKiB: Summary };
  warm: {
    perCall: Summary;
    batchedMeanMs: number;
    processCpuPerRequestMs: number;
    peakRssKiB: number;
  };
}

async function workerdSection() {
  const dir = join(work, "workerd");
  await bundle(esbuild, {
    entry: join(HERE, "src/worker.ts"),
    outfile: join(dir, "worker.js"),
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    withoutShiki: true,
  });
  const config = writeConfig(dir, compatibilityDate);
  // The same Worker with Shiki bundled in (as @pierre/diffs is, left alone): startup only.
  const fullDir = join(work, "workerd-with-shiki");
  await bundle(esbuild, {
    entry: join(HERE, "src/worker.ts"),
    outfile: join(fullDir, "worker.js"),
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
  });
  const fullConfig = writeConfig(fullDir, compatibilityDate);
  const emptyDir = join(work, "workerd-empty");
  mkdirSync(emptyDir);
  writeFileSync(
    join(emptyDir, "worker.js"),
    `export default { fetch() { return Response.json({ ok: true }); } };\n`,
  );
  const emptyConfig = writeConfig(emptyDir, compatibilityDate);
  const binary = workerdBinary();

  // Startup: the bench Worker (renderer bundled, loaded lazily) against an empty one.
  const startup = { bench: [] as number[], withShiki: [] as number[], empty: [] as number[] };
  for (let i = 0; i < RUNS.cold; i++) {
    for (const [key, cfg] of [
      ["bench", config],
      ["withShiki", fullConfig],
      ["empty", emptyConfig],
    ] as const) {
      const w = await Workerd.start(binary, cfg);
      await w.noop();
      startup[key].push(w.startMs);
      await w.stop();
    }
  }

  const rows: WorkerdRow[] = [];
  for (const fixture of fixtures) {
    const text = readFileSync(fixture.path, "utf8");
    for (const mode of MODES) {
      const query = { mode, name: fixture.name, lang: fixture.lang };
      const cold = { total: [] as number[], load: [] as number[], render: [] as number[] };
      const rss: number[] = [];
      let last = { htmlBytes: 0, spans: 0 };
      for (let i = 0; i < RUNS.cold; i++) {
        const w = await Workerd.start(binary, config);
        await w.noop();
        const before = w.stats();
        const r = await w.render({ ...query, reps: 1 }, text);
        const after = w.stats();
        await w.stop();
        cold.total.push(r.totalMs);
        cold.load.push(r.loadMs);
        cold.render.push(r.renderMs);
        rss.push(after.vmHwmKiB - before.vmHwmKiB);
        last = r;
      }

      const w = await Workerd.start(binary, config);
      for (let i = 0; i < 3; i++) await w.render({ ...query, reps: 1 }, text);
      const samples = isLarge(fixture) ? RUNS.warmLarge : RUNS.warm;
      const perCall: number[] = [];
      const cpuBefore = w.stats().cpuTicks;
      for (let i = 0; i < samples; i++)
        perCall.push((await w.render({ ...query, reps: 1 }, text)).renderMs);
      const cpuAfter = w.stats().cpuTicks;
      // workerd's clock ticks in whole ms: a batch of calls gives a sub-ms mean.
      const median = summarize(perCall).median;
      const reps = Math.min(500, Math.max(1, Math.ceil(50 / Math.max(median, 0.1))));
      let batched = 0;
      for (let i = 0; i < 3; i++) batched += (await w.render({ ...query, reps }, text)).renderMs;
      const peak = w.stats().vmHwmKiB;
      await w.stop();

      const row: WorkerdRow = {
        fixture: fixture.id,
        mode,
        bytes: fixture.bytes,
        htmlBytes: last.htmlBytes,
        spans: last.spans,
        cold: {
          total: summarize(cold.total),
          load: summarize(cold.load),
          render: summarize(cold.render),
          peakRssDeltaKiB: summarize(rss),
        },
        warm: {
          perCall: summarize(perCall),
          batchedMeanMs: round(batched / (3 * reps), 3),
          // Clock ticks are 10 ms; the whole process's CPU (HTTP and body included) over the samples.
          processCpuPerRequestMs: round(((cpuAfter - cpuBefore) * 10) / samples, 1),
          peakRssKiB: peak,
        },
      };
      rows.push(row);
      log(
        `workerd ${fixture.id} ${mode}: cold median ${row.cold.total.median} ms, warm median ${row.warm.perCall.median} ms (mean ${row.warm.batchedMeanMs})`,
      );
    }
  }
  return {
    startup: {
      bench: summarize(startup.bench),
      withShiki: summarize(startup.withShiki),
      empty: summarize(startup.empty),
    },
    bundleBytes: {
      bench: statSync(join(dir, "worker.js")).size,
      withShiki: statSync(join(fullDir, "worker.js")).size,
    },
    rows,
  };
}

// ------------------------------------------------------------------- Node

function nodeRun(script: string, command: object): Record<string, unknown> {
  const result = spawnSync(process.execPath, [script, JSON.stringify(command)], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (result.status !== 0) throw new Error(`node bench failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) as string);
}

async function nodeSection() {
  const script = join(work, "node", "node-bench.mjs");
  await bundle(esbuild, {
    entry: join(HERE, "src/node-bench.ts"),
    outfile: script,
    platform: "node",
    conditions: [],
  });
  const rows = [];
  for (const fixture of fixtures) {
    for (const mode of MODES) {
      const command = { mode, path: fixture.path, name: fixture.name, lang: fixture.lang };
      const cold = { total: [] as number[], load: [] as number[], render: [] as number[] };
      for (let i = 0; i < RUNS.cold; i++) {
        const r = nodeRun(script, { kind: "cold", ...command }) as Record<string, number>;
        cold.total.push(r.totalMs as number);
        cold.load.push(r.loadMs as number);
        cold.render.push(r.renderMs as number);
      }
      const samples = isLarge(fixture) ? RUNS.warmLarge : RUNS.warm;
      const warm = nodeRun(script, { kind: "warm", samples, ...command }) as { times: number[] };
      const row = {
        fixture: fixture.id,
        mode,
        bytes: fixture.bytes,
        cold: {
          total: summarize(cold.total),
          load: summarize(cold.load),
          render: summarize(cold.render),
        },
        warm: summarize(warm.times),
      };
      rows.push(row);
      log(
        `node ${fixture.id} ${mode}: cold median ${round(row.cold.total.median)} ms, warm median ${round(row.warm.median)} ms`,
      );
    }
  }

  // The first screen (60 lines) of a large file, without highlighting all of it.
  const firstScreen = [];
  for (const id of ["ts-256k", "ts-1024k"]) {
    const fixture = fixtures.find((f) => f.id === id) as Fixture;
    const { runs } = nodeRun(script, {
      kind: "first-screen",
      path: fixture.path,
      lang: fixture.lang,
      lines: 60,
      samples: RUNS.firstScreen,
    }) as { runs: Record<string, number>[] };
    const pick = (key: string) => summarize(runs.map((r) => r[key] as number));
    const cold = [];
    for (let i = 0; i < RUNS.cold; i++)
      cold.push(
        nodeRun(script, {
          kind: "first-screen-cold",
          path: fixture.path,
          lang: fixture.lang,
          lines: 60,
        }) as Record<string, number>,
      );
    firstScreen.push({
      fixture: id,
      bytes: fixture.bytes,
      lines: fixture.lines,
      wholeFileTokens: pick("wholeMs"),
      streamFirstScreen: pick("streamMs"),
      streamCharsPushed: runs[0]?.streamCharsPushed,
      liveFirstScreen: pick("liveMs"),
      liveFlushRest: pick("liveFlushMs"),
      coldImportPlusStreamFirstScreen: summarize(cold.map((c) => c.totalMs as number)),
      coldImportOnly: summarize(cold.map((c) => c.importMs as number)),
    });
    log(`node first screen ${id} done`);
  }
  return { rows, firstScreen };
}

// ----------------------------------------------------------------- report

const results: Record<string, unknown> = {
  date: new Date().toISOString().slice(0, 10),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, node: process.version },
  versions: {
    workerd: workerdVersion(),
    "@pierre/diffs": packageVersion("@pierre/diffs"),
    "@pierre/highlights": packageVersion("@pierre/highlights"),
  },
  runs: RUNS,
  fixtures: fixtures.map(({ path: _path, ...f }) => f),
};

try {
  if (only.has("workerd")) results.workerd = await workerdSection();
  if (only.has("node")) results.node = await nodeSection();
  if (only.has("bundle")) results.bundle = await measureBundles(esbuild, work);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const kib = (bytes: number) => round(bytes / 1024, 1);
const lines: string[] = [];
lines.push(
  `# Code rendering benchmark: results`,
  "",
  `Generated by \`run.ts\` on ${results.date} at ${String(results.commit).slice(0, 12)}; ` +
    `${(results.machine as { cpu: string }).cpu}, ${(results.machine as { cores: number }).cores} cores, Node ${process.version}, ` +
    `workerd ${(results.versions as { workerd: string }).workerd}. Times in ms; n samples each. See README.md for the method.`,
  "",
);

const ladder = (rows: { fixture: string; bytes: number }[], pick: (r: never) => number) =>
  rows
    .filter((r) => r.fixture.startsWith("ts-"))
    .map((r) => ({ kib: r.bytes / 1024, ms: pick(r as never) }));

if (results.workerd) {
  const { startup, rows, bundleBytes } = results.workerd as {
    startup: Record<string, Summary>;
    bundleBytes: { bench: number; withShiki: number };
    rows: WorkerdRow[];
  };
  lines.push(
    "## workerd (the web Worker's runtime, local)",
    "",
    `Startup (workerd spawned until its socket listens, wall, median of ${startup.bench?.n}): the bench Worker without Shiki ` +
      `(${kib(bundleBytes.bench)} KiB of JS) ${round(startup.bench?.median ?? 0)} ms, with Shiki (${kib(bundleBytes.withShiki)} KiB) ` +
      `${round(startup.withShiki?.median ?? 0)} ms, an empty Worker ${round(startup.empty?.median ?? 0)} ms.`,
    "",
    "| fixture | KiB | mode | cold median | cold p95 | of which load | warm median | warm p95 | warm mean (batched) | ms/KiB warm | process CPU/request | HTML KiB | styled spans | cold peak RSS +KiB |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const r of rows)
    lines.push(
      `| ${r.fixture} | ${kib(r.bytes)} | ${r.mode} | ${r.cold.total.median} | ${r.cold.total.p95} | ${r.cold.load.median} | ${r.warm.perCall.median} | ${r.warm.perCall.p95} | ${r.warm.batchedMeanMs} | ${round(r.warm.batchedMeanMs / (r.bytes / 1024), 3)} | ${r.warm.processCpuPerRequestMs} | ${kib(r.htmlBytes)} | ${r.spans} | ${r.cold.peakRssDeltaKiB.median} |`,
    );
  lines.push("", "Largest TypeScript file within 10 ms (interpolated on the ladder):", "");
  for (const mode of MODES) {
    const mine = rows.filter((r) => r.mode === mode);
    for (const [label, pick] of [
      ["warm median", (r: WorkerdRow) => r.warm.perCall.median],
      ["warm p95", (r: WorkerdRow) => r.warm.perCall.p95],
      ["cold median", (r: WorkerdRow) => r.cold.total.median],
      ["cold p95", (r: WorkerdRow) => r.cold.total.p95],
    ] as const) {
      const fit = largestWithin(ladder(mine, pick as never), BUDGET_MS);
      lines.push(
        `- ${mode}, ${label}: ${fit.kib === null ? "none (the smallest step, 1 KiB, is over)" : `${round(fit.kib, 1)} KiB${fit.beyondLadder ? " (the whole ladder fits)" : ""}`}`,
      );
    }
  }
  lines.push("");
}

if (results.node) {
  const { rows, firstScreen } = results.node as {
    rows: {
      fixture: string;
      mode: Mode;
      bytes: number;
      cold: Record<string, Summary>;
      warm: Summary;
    }[];
    firstScreen: Record<string, Summary | number | string>[];
  };
  lines.push(
    "## Node (stand-in for a browser's main thread)",
    "",
    "| fixture | KiB | mode | cold median | cold p95 | of which load | warm median | warm p95 | ms/KiB warm |",
    "|---|---:|---|---:|---:|---:|---:|---:|---:|",
  );
  for (const r of rows)
    lines.push(
      `| ${r.fixture} | ${kib(r.bytes)} | ${r.mode} | ${round(r.cold.total?.median ?? 0)} | ${round(r.cold.total?.p95 ?? 0)} | ${round(r.cold.load?.median ?? 0)} | ${round(r.warm.median)} | ${round(r.warm.p95)} | ${round(r.warm.median / (r.bytes / 1024), 3)} |`,
    );
  lines.push(
    "",
    "First screen (60 lines) of a large file, warm (median / p95):",
    "",
    "| fixture | KiB | lines | whole file `codeToTokens` | StreamTokenizer first screen | LiveTokenizer first screen | LiveTokenizer `flush()` of the rest | cold: import + stream first screen | cold: import alone |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  const mp = (s: unknown) => `${round((s as Summary).median)} / ${round((s as Summary).p95)}`;
  for (const f of firstScreen)
    lines.push(
      `| ${f.fixture} | ${kib(f.bytes as number)} | ${f.lines} | ${mp(f.wholeFileTokens)} | ${mp(f.streamFirstScreen)} | ${mp(f.liveFirstScreen)} | ${mp(f.liveFlushRest)} | ${mp(f.coldImportPlusStreamFirstScreen)} | ${mp(f.coldImportOnly)} |`,
    );
  lines.push("");
}

if (results.bundle) {
  const b = results.bundle as Awaited<ReturnType<typeof measureBundles>>;
  const s = (x: { bytes: number; gzipBytes: number }) =>
    `${kib(x.bytes)} KiB (gzip ${kib(x.gzipBytes)} KiB)`;
  const up = (u: { totalKiB: number; gzipKiB: number }) =>
    `${u.totalKiB} KiB, gzip ${u.gzipKiB} KiB (+${round(u.totalKiB - b.server.webOnly.totalKiB)} KiB, gzip +${round(u.gzipKiB - b.server.webOnly.gzipKiB)} KiB)`;
  lines.push(
    "## Bundles",
    "",
    "Web Worker upload, `wrangler deploy --dry-run --outdir` (wrangler's own figures):",
    "",
    `- apps/web as built: ${b.server.webOnly.totalKiB} KiB, gzip ${b.server.webOnly.gzipKiB} KiB`,
    `- with the file renderer, as bundled by default (Shiki included): ${up(b.server.withRenderer.upload)}; the renderer module ${s(b.server.withRenderer.rendererModule)}`,
    `- with the file renderer, Shiki left out: ${up(b.server.withRendererNoShiki.upload)}; the renderer module ${s(b.server.withRendererNoShiki.rendererModule)}`,
    `- Highlights' .wasm (in both): ${s(b.server.withRenderer.wasmModule)}`,
    "",
    "Browser (esbuild, split at dynamic imports, minified, React external):",
    "",
    `- \`FileDiff\` (the pull request page's), loaded before drawing: ${s(b.client.fileDiffInitial)}`,
    `- \`File\` (a file view), loaded before drawing: ${s(b.client.fileInitial)}; of it not shared with \`FileDiff\`: ${s(b.client.fileInitialNotInFileDiff)}; everything it may load on demand (Highlights, and every Shiki grammar and theme): ${s(b.client.fileLazy)}, of which the Highlights chunks a file view fetches: ${s(b.client.fileHighlightsChunks)}`,
    `- the client build already ships: JS ${s(b.client.shippedJs)}, WebAssembly ${s(b.client.shippedWasm)}; worker chunks: ${b.client.workerChunks.map((w) => `${w.name} ${s(w)}`).join(", ")}`,
    "",
  );
}

writeFileSync(join(HERE, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(join(HERE, "results.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
