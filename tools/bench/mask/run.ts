/**
 * What a task's kept log-mask matchers retain in local workerd, against the
 * estimate `MaskMatcherCache.bytes` reserves from the run's memory pool. For
 * each mask shape, small ones and those at the caps: V8's heap and backing
 * stores through the inspector after forced collection, with copies of the
 * cache held (enough for 4 MiB, at least two), less the same with them
 * dropped, divided by the copies. The estimate must be at or above the
 * retained size in every shape. Nothing here is a deployed measurement.
 *
 *   FYRDEN_BENCH=1 node tools/bench/mask/run.ts
 */
// biome-ignore-all lint/suspicious/noConsole: a benchmark reports on the console
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVariants } from "../../../packages/domain/src/ci/mask.ts";
import {
  bundle,
  loadEsbuild,
  workerdBinary,
  workerdVersion,
} from "../code-rendering/src/toolchain.ts";
import { Workerd } from "../code-rendering/src/workerd.ts";
import { SHAPES } from "./src/shapes.ts";

if (process.env.FYRDEN_BENCH !== "1") {
  console.log("Benchmark skipped: set FYRDEN_BENCH=1 to run it (it prints sizes).");
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const compatibilityDate = "2026-10-01"; // apps/api/wrangler.jsonc

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
  backingStorageSize: number;
}

function inspector(port: number): Promise<{ heap(): Promise<HeapUsage>; close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/main`);
    let next = 1;
    const waiting = new Map<number, (usage: HeapUsage) => void>();
    socket.addEventListener("message", (event) => {
      const { id, result } = JSON.parse(String(event.data)) as { id?: unknown; result?: HeapUsage };
      if (typeof id !== "number" || result === undefined) return;
      const done = waiting.get(id);
      if (typeof done !== "function") return;
      waiting.delete(id);
      done(result);
    });
    socket.addEventListener("error", () => reject(new Error("no inspector")));
    socket.addEventListener("open", () =>
      resolve({
        heap: () =>
          new Promise((done) => {
            const id = next++;
            waiting.set(id, done);
            socket.send(JSON.stringify({ id, method: "Runtime.getHeapUsage" }));
          }),
        close: () => socket.close(),
      }),
    );
  });
}

function counts(masks: readonly { value: string; fromIndex: number }[]) {
  const prefixes = [new Set<string>(), new Set<string>()];
  let patterns = 0;
  let units = 0;
  for (const { value, fromIndex } of masks) {
    units += value.length;
    for (const variant of buildVariants(value)) {
      units += variant.text.length;
      if (fromIndex >= 1) continue;
      patterns++;
      const set = prefixes[variant.crosses ? 0 : 1] as Set<string>;
      for (let i = 1; i <= variant.text.length; i++) set.add(variant.text.slice(0, i));
    }
  }
  return { nodes: 2 + (prefixes[0]?.size ?? 0) + (prefixes[1]?.size ?? 0), patterns, units };
}

const work = mkdtempSync(join(tmpdir(), "fyrden-mask-bench-"));
process.on("exit", () => {
  Workerd.killAll();
  rmSync(work, { recursive: true, force: true });
});
const dir = join(work, "worker");
mkdirSync(dir);
await bundle(loadEsbuild(), {
  entry: join(HERE, "src/worker.ts"),
  outfile: join(dir, "worker.js"),
  platform: "neutral",
  conditions: ["workerd", "worker"],
  external: ["node:*"],
});
const config = join(dir, "config.capnp");
writeFileSync(
  config,
  `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = .bench)],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],
  v8Flags = ["--expose-gc"],
);
const bench :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "${compatibilityDate}",
);
`,
);
console.log(
  `workerd ${workerdVersion()}, Node ${process.version}, ${process.platform} ${process.arch}\n`,
);
console.log(
  "| Shape | Masks | Trie nodes | Patterns | UTF-16 units | Copies | Attempts | Estimate, KiB | Retained a copy, KiB | Estimate ÷ retained |",
);
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
const binary = workerdBinary();
for (const [name, shape] of Object.entries(SHAPES)) {
  const port = await freePort();
  let copies = 1;
  await Workerd.with(
    binary,
    config,
    async (w) => {
      const get = async <T>(path: string): Promise<T> => {
        const response = await fetch(
          `${w.url}/${path}?name=${encodeURIComponent(name)}&copies=${copies}`,
        );
        if (!response.ok) throw new Error(`${path}: ${await response.text()}`);
        return response.json() as Promise<T>;
      };
      // Twice, each its own request: what the first finds dead is swept by the second.
      const settle = async () => {
        await get("collect");
        await get("collect");
      };
      // Copies enough that the heap's noise (tens of KiB between collections) stays small.
      copies = 1;
      const one = await get<{ bytes: number }>("build");
      await get("drop");
      copies = Math.max(2, Math.ceil((4 * 1024 * 1024) / one.bytes));
      const probe = await inspector(port);
      // Builds and drops first, so the baseline holds the code they compile and optimize, and an
      // inspector query, so it holds the inspector's state: neither is the cache's.
      for (let warm = 0; warm < 10; warm++) {
        await get("build");
        await get("drop");
        await settle();
        await probe.heap();
      }
      // A collection may leave garbage from before the baseline until a later one, which reads
      // as a negative size: such a reading is taken again, at most three times in all.
      let built = { masks: 0, bytes: 0 };
      let retained = 0;
      let attempts = 0;
      while (attempts < 3 && retained <= 0) {
        attempts++;
        await get("drop");
        await settle();
        const base = await probe.heap();
        built = await get<{ masks: number; bytes: number }>("build");
        await settle();
        const held = await probe.heap();
        retained =
          (held.usedSize - base.usedSize + (held.backingStorageSize - base.backingStorageSize)) /
          copies;
      }
      probe.close();
      const c = counts(shape());
      const kib = (bytes: number) => (bytes / 1024).toFixed(1);
      console.log(
        `| ${name} | ${built.masks} | ${c.nodes} | ${c.patterns} | ${c.units} | ${copies} | ${attempts} | ${kib(built.bytes)} | ${kib(retained)} | ${(built.bytes / retained).toFixed(2)} |`,
      );
    },
    [`--inspector-addr=127.0.0.1:${port}`],
  );
}
