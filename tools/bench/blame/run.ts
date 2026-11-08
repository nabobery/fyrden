/**
 * What a blame slice's work costs in local workerd, and what its memory does
 * there. Prints a table for each, for the counted work's weights and limit and
 * for the churn check. Nothing here is a deployed measurement.
 *
 *   FYRDEN_BENCH=1 node tools/bench/blame/run.ts [--only=cpu,memory,retention,fixed]
 *
 * Works wherever `ps` does: CPU comes from `performance.now()` inside the
 * isolate, and memory from the workerd process's resident size, sampled from
 * outside while a case runs.
 */
// biome-ignore-all lint/suspicious/noConsole: a benchmark reports on the console
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPack } from "../../../packages/git-core/test/pack/pack-builder.ts";
import {
  bundle,
  loadEsbuild,
  workerdBinary,
  workerdVersion,
} from "../code-rendering/src/toolchain.ts";
import { Workerd } from "../code-rendering/src/workerd.ts";

if (process.env.FYRDEN_BENCH !== "1") {
  console.log("Benchmark skipped: set FYRDEN_BENCH=1 to run it (it prints times).");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = new Set(
  (args.find((a) => a.startsWith("--only="))?.slice(7) ?? "cpu,memory").split(","),
);
const compatibilityDate = "2026-10-01"; // apps/api/wrangler.jsonc
const MiB = 1024 * 1024;

function config(dir: string, exposeGc: boolean): string {
  const path = join(dir, exposeGc ? "gc.capnp" : "config.capnp");
  writeFileSync(
    path,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .bench)],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],
  ${exposeGc ? 'v8Flags = ["--expose-gc"],' : ""}
);
const bench :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "${compatibilityDate}",
);
`,
  );
  return path;
}

const rssKiB = (pid: number) =>
  new Promise<number>((resolve) => {
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
      resolve(error ? 0 : Number(stdout.trim()));
    });
  });

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

interface HeapUsage {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize: number;
  backingStorageSize: number;
}

/** The workerd inspector's protocol, for the one question this asks. */
class Inspector {
  #nextId = 1;
  readonly #waiting = new Map<number, (result: HeapUsage) => void>();

  readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const { id, result } = JSON.parse(String(event.data)) as { id?: number; result?: HeapUsage };
      if (id === undefined) return;
      this.#waiting.get(id)?.(result as HeapUsage);
      this.#waiting.delete(id);
    });
  }

  static connect(port: number): Promise<Inspector> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/main`);
      socket.addEventListener("open", () => resolve(new Inspector(socket)));
      socket.addEventListener("error", () => reject(new Error("no inspector")));
    });
  }

  heap(): Promise<HeapUsage> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method: "Runtime.getHeapUsage" }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function get<T>(w: Workerd, path: string, name: string): Promise<T> {
  const cut = name.indexOf("&");
  const plain = cut < 0 ? name : name.slice(0, cut);
  const query = cut < 0 ? "" : name.slice(cut);
  const url = `${w.url}/${path}?name=${encodeURIComponent(plain)}${query}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path} ${name}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** Runs a request while sampling resident size, and gives its high-water. */
async function watched<T>(
  w: Workerd,
  name: string,
  path = "memory",
): Promise<{ result: T; high: number }> {
  let high = 0;
  let done = false;
  const sampler = (async () => {
    while (!done) high = Math.max(high, await rssKiB(w.pid));
  })();
  const result = await get<T>(w, path, name);
  done = true;
  await sampler;
  return { result, high };
}

const work = mkdtempSync(join(tmpdir(), "fyrden-blame-bench-"));
process.on("exit", () => {
  Workerd.killAll();
  rmSync(work, { recursive: true, force: true });
});

const dir = join(work, "worker");
mkdirSync(dir);
await bundle(loadEsbuild(), {
  entry: join(HERE, "src/worker.ts"),
  outfile: join(dir, "worker.js"),
  platform: "node",
  conditions: ["workerd", "worker"],
  external: ["node:*"],
});
const binary = workerdBinary();
console.log(
  `workerd ${workerdVersion()}, Node ${process.version}, ${process.platform} ${process.arch}`,
);

interface CaseRow {
  name: string;
  ms: number;
  runs: number;
  units: number;
  msPerRun: number;
  nsPerUnit: number;
}

if (only.has("cpu")) {
  console.log("\n## CPU per primitive (wall time inside one idle isolate)\n");
  console.log("| Case | ms a run | Units a run | ns a unit | Runs |");
  console.log("|---|---:|---:|---:|---:|");
  const names = await Workerd.with(binary, config(dir, false), (w) => get<string[]>(w, "list", ""));
  for (const name of names) {
    // A process each: a case's garbage and JIT state don't reach the next.
    await Workerd.with(binary, config(dir, false), async (w) => {
      const row = await get<CaseRow>(w, "case", name);
      console.log(
        `| ${name} | ${row.msPerRun.toFixed(3)} | ${row.units} | ${row.nsPerUnit.toFixed(3)} | ${row.runs} |`,
      );
    });
  }
}

if (only.has("resets")) {
  console.log("\n## Resident size of the cases that reset deployed, MiB above an idle process\n");
  console.log("| Case | Setup alone, high-water | N runs, high-water | N |");
  console.log("|---|---:|---:|---:|");
  for (const [name, runs] of [
    ["state: decode and check, 2 MiB of pairs and ranges", 700],
    ["apply: densest, one-byte copies from offset 0, two bytes an opcode", 15],
    ["inflate: 16 random symbols, all literals through Huffman codes", 100],
    ["align: 100,000 lines, no line in common", 15],
  ] as const) {
    await Workerd.with(binary, config(dir, false), async (w) => {
      await get(w, "list", "");
      const idle = await rssKiB(w.pid);
      const setup = await watched(w, `${name}&runs=0`, "case");
      const ran = await watched(w, `${name}&runs=${runs}`, "case");
      const above = (kib: number) => ((kib - idle) / 1024).toFixed(1);
      console.log(`| ${name} | ${above(setup.high)} | ${above(ran.high)} | ${runs} |`);
    });
  }
  await Workerd.with(binary, config(dir, false), async (w) => {
    await get(w, "list", "");
    const idle = await rssKiB(w.pid);
    const name = "state: decode and check, 2 MiB of pairs and ranges";
    const { high } = await watched(w, `${name}&runs=700`, "case");
    console.log(`\nThe state case with no request before it: ${((high - idle) / 1024).toFixed(1)}`);
  });
  console.log("\n## One state decoded over and over, and how often it yields\n");
  console.log("| Decodes | Yields to a macrotask every | High-water, MiB above idle |");
  console.log("|---:|---:|---:|");
  for (const [runs, yieldEvery] of [
    [1, 0],
    [7, 0],
    [70, 0],
    [700, 0],
    [700, 16],
    [700, 1],
  ] as const) {
    await Workerd.with(binary, config(dir, false), async (w) => {
      await get(w, "list", "");
      const idle = await rssKiB(w.pid);
      const { high } = await watched(w, `stateChurn&runs=${runs}&yieldEvery=${yieldEvery}`);
      console.log(`| ${runs} | ${yieldEvery || "never"} | ${((high - idle) / 1024).toFixed(1)} |`);
    });
  }
  console.log("\n## The blame reader, and how often it yields\n");
  console.log("| Objects | Reads | Yields to a macrotask every | High-water, MiB above prepared |");
  console.log("|---:|---:|---:|---:|");
  for (const [size, count, rounds] of [
    [1024, 16_000, 2],
    [16 * 1024, 2600, 3],
    [256 * 1024, 160, 3],
    [MiB, 40, 3],
  ] as const) {
    for (const yieldEvery of [0, 16, 1]) {
      await Workerd.with(binary, config(dir, false), async (w) => {
        const entries = Array.from({ length: count }, (_, k) => {
          const data = new Uint8Array(size);
          new DataView(data.buffer).setUint32(0, k);
          return { kind: "blob" as const, data };
        });
        const pack = buildPack(entries);
        const head = new Float64Array(count + 1);
        new DataView(head.buffer).setFloat64(0, count);
        head.set(pack.offsets, 1);
        const prepared = await fetch(`${w.url}/prepare`, {
          method: "POST",
          body: Buffer.concat([new Uint8Array(head.buffer), pack.bytes]),
        });
        if (!prepared.ok) throw new Error(await prepared.text());
        const before = await rssKiB(w.pid);
        const { high } = await watched(w, `churn&rounds=${rounds}&yieldEvery=${yieldEvery}`);
        console.log(
          `| ${size} | ${count * rounds} | ${yieldEvery || "never"} | ${((high - before) / 1024).toFixed(1)} |`,
        );
      });
    }
  }
}

if (only.has("memory")) {
  console.log("\n## What workerd's zlib hands back\n");
  await Workerd.with(binary, config(dir, true), async (w) => {
    const shapes = await get<{ size: number; buffer: number; offset: number }[]>(
      w,
      "memory",
      "shapes",
    );
    for (const { size, buffer, offset } of shapes) {
      console.log(`${size} bytes: buffer ${buffer}, offset ${offset}`);
    }
    console.log(`gc exposed: ${(await get<{ gc: string }>(w, "memory", "noop")).gc}`);
  });
  console.log("\n## Churn with no forced collection, MiB above the prepared process\n");
  console.log(
    "V8's view comes from the inspector's `Runtime.getHeapUsage`, asked while the case runs; the isolate answers at a macrotask, so it yields every 16 reads, as R2 reads would. Resident size also holds what the allocator kept.\n",
  );
  console.log(
    "| Objects | Reads | Prepared: resident | Largest JS heap used | Largest backing stores | Largest of both | Resident high-water | Resident after a forced collection |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [size, count, rounds] of [
    [16 * 1024, 2600, 3],
    [1024, 16_000, 2],
    [MiB, 40, 3],
    [4 * MiB, 6, 8],
  ] as const) {
    const port = await freePort();
    await Workerd.with(
      binary,
      config(dir, true),
      async (w) => {
        const entries = Array.from({ length: count }, (_, k) => {
          const data = new Uint8Array(size);
          new DataView(data.buffer).setUint32(0, k);
          return { kind: "blob" as const, data };
        });
        const pack = buildPack(entries);
        const head = new Float64Array(count + 1);
        new DataView(head.buffer).setFloat64(0, count);
        head.set(pack.offsets, 1);
        const prepared = await fetch(`${w.url}/prepare`, {
          method: "POST",
          body: Buffer.concat([new Uint8Array(head.buffer), pack.bytes]),
        });
        if (!prepared.ok) throw new Error(await prepared.text());
        await get(w, "memory", "collect");
        const inspector = await Inspector.connect(port);
        const base = await inspector.heap();
        const before = await rssKiB(w.pid);
        const peaks = { used: 0, backing: 0, both: 0 };
        let running = true;
        const asking = (async () => {
          while (running) {
            const now = await inspector.heap();
            peaks.used = Math.max(peaks.used, now.usedSize - base.usedSize);
            peaks.backing = Math.max(
              peaks.backing,
              now.backingStorageSize - base.backingStorageSize,
            );
            peaks.both = Math.max(
              peaks.both,
              now.usedSize + now.backingStorageSize - base.usedSize - base.backingStorageSize,
            );
          }
        })();
        const { high } = await watched(w, `churn&rounds=${rounds}&yieldEvery=16`);
        running = false;
        await asking;
        await get(w, "memory", "collect");
        const collected = await rssKiB(w.pid);
        inspector.close();
        const above = (kib: number) => ((kib - before) / 1024).toFixed(1);
        const mib = (bytes: number) => (bytes / MiB).toFixed(1);
        console.log(
          `| ${count} of ${size} B | ${count * rounds} | ${(before / 1024).toFixed(1)} | ${mib(peaks.used)} | ${mib(peaks.backing)} | ${mib(peaks.both)} | ${above(high)} | ${above(collected)} |`,
        );
      },
      [`--inspector-addr=127.0.0.1:${port}`],
    );
  }
}

// Every case once with a fixed count: what a run timed from outside relies on.
if (only.has("fixed")) {
  const names = await Workerd.with(binary, config(dir, false), (w) => get<string[]>(w, "list", ""));
  for (const name of names) {
    await Workerd.with(binary, config(dir, false), async (w) => {
      const row = await get<CaseRow>(w, "case", `${name}&runs=1`);
      if (row.runs !== 1) throw new Error(`${name}: asked for 1 run, ran ${row.runs}`);
    });
  }
  console.log(`\n${names.length} cases ran once with a fixed count`);
}

// What the delta-base cache's 8 MiB charge retains here.
if (only.has("retention")) {
  console.log("\n## What a full delta-base cache retains, after forced collection\n");
  console.log(
    "V8's count through the inspector, against a new reader after a warming pass, so compiled code is out of it and the recent-locations map is in. The charge is 8 MiB, at object size plus 512 bytes.\n",
  );
  console.log(
    "| Object | Reads | Entries charged | JS heap, MiB | Backing stores, MiB | Both, MiB |",
  );
  console.log("|---:|---:|---:|---:|---:|---:|");
  for (const size of [1, 64, 1024, 4096, 16 * 1024, 64 * 1024]) {
    const port = await freePort();
    await Workerd.with(
      binary,
      config(dir, true),
      async (w) => {
        const entriesCharged = Math.floor((8 * MiB) / (size + 512));
        const count = Math.min(Math.ceil(entriesCharged * 1.5), 40_000);
        const pack = buildPack(
          Array.from({ length: count }, (_, k) => {
            const data = new Uint8Array(size);
            const view = new DataView(data.buffer);
            if (size >= 4) view.setUint32(0, k);
            else view.setUint8(0, k & 0xff);
            return { kind: "blob" as const, data };
          }),
        );
        const head = new Float64Array(count + 1);
        new DataView(head.buffer).setFloat64(0, count);
        head.set(pack.offsets, 1);
        const prepared = await fetch(`${w.url}/prepare`, {
          method: "POST",
          body: Buffer.concat([new Uint8Array(head.buffer), pack.bytes]),
        });
        if (!prepared.ok) throw new Error(await prepared.text());
        const inspector = await Inspector.connect(port);
        const settle = async () => {
          // Twice, each its own request: what the first finds dead is swept by the second.
          await get(w, "memory", "collect");
          await get(w, "memory", "collect");
        };
        // A first pass and a new reader, so the baseline holds the code it compiled.
        await get(w, "memory", "churn&rounds=1&yieldEvery=16");
        await get(w, "memory", "drop");
        const again = await fetch(`${w.url}/prepare`, {
          method: "POST",
          body: Buffer.concat([new Uint8Array(head.buffer), pack.bytes]),
        });
        if (!again.ok) throw new Error(await again.text());
        await settle();
        const base = await inspector.heap();
        await get(w, "memory", "churn&rounds=1&yieldEvery=16");
        await settle();
        const after = await inspector.heap();
        inspector.close();
        const heap = after.usedSize - base.usedSize;
        const backing = after.backingStorageSize - base.backingStorageSize;
        const mib = (bytes: number) => (bytes / MiB).toFixed(2);
        console.log(
          `| ${size} | ${count} | ${entriesCharged} | ${mib(heap)} | ${mib(backing)} | ${mib(heap + backing)} |`,
        );
      },
      [`--inspector-addr=127.0.0.1:${port}`],
    );
  }
}
