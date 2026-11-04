# Where should highlighted file views render?

File contents, blame and history pages will show files with `@pierre/diffs`'
file renderer, highlighted by `@pierre/highlights`. This benchmark asks
whether that should run in the web Worker (workerd) or in the browser.

**Recommendation: render in the browser.** The server sends the file as
plain text (readable without JavaScript, as Markdown is today), and the
browser draws it with the renderer's `File` component and Highlights. Do not
run the file renderer in the web Worker on Workers Free, and not by default
on Paid either. The rest of this page gives the numbers behind that.

Every number below was **measured** by `run.ts` on 2026-11-04 at
6206d9db1b06. The machine was a 4-core Intel Xeon at 2.10 GHz, running
workerd 1.20261023.1 (the version wrangler 4.154.0 pins), Node v24.15.0,
`@pierre/diffs` 1.6.1 and `@pierre/highlights` 0.2.0. The complete tables
are in [results.md](results.md) and the raw data is in
[results.json](results.json).

## Run it

From a clean checkout, after `pnpm install --frozen-lockfile`:

```sh
FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts            # about 4 minutes here
FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts --quick    # fewer samples
FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts --only=workerd,node,bundle
```

The script rewrites `results.json` and `results.md` in this directory. The
bundle step also builds `apps/web`, which writes `apps/web/build`; that
directory is ignored by git. Without `FYRDEN_BENCH=1` the script prints that
it was skipped and exits, because only benchmarks may print times
(AGENTS.md, rule 7). It is not part of any test suite.

Nothing is added to the workspace. The renderer packages are resolved from
`apps/web/node_modules`, and esbuild, workerd and wrangler are the versions
apps/web's pinned wrangler already uses (`src/toolchain.ts`).

## Method

**Fixtures** (`src/fixtures.ts`) are built from the files `git ls-files` lists,
so a checkout of the same commit reproduces them:

- **TypeScript:** a ladder from 1 KiB to 1 MiB (1, 2, 4, 8, 16, 32, 64, 100,
  128, 256, 512 and 1024 KiB). Each step is a prefix of the repository's
  own sources concatenated in path order, cut at a line end. Declaration
  files and generated code are left out.
- **JSON:** the largest tracked JSON file (18 KiB), plus 100 KiB of the
  tracked file list as pretty-printed JSON.
- **Markdown:** AGENTS.md (6 KiB), plus 100 KiB of `docs/**/*.md`.
- **Minified JavaScript:** a single line of 10 KiB and one of 100 KiB, made
  by minifying the TypeScript sources with esbuild.

**Two render modes** are measured (`src/render.ts`):

- `highlights`: `codeToHtml` from `@pierre/highlights`, with GitHub high
  contrast light and dark themes. This is the floor: it turns tokens into a
  `<pre>` and does nothing else.
- `file`: `preloadFile` from `@pierre/diffs/ssr`, the file renderer's
  server-side entry. It uses Highlights with the options apps/web's diff
  renderer uses: the same themes and `tokenizeMaxLineLength` 1000. This is
  the mode the product would actually run.

Both modes are loaded by dynamic import. A cold call therefore includes
evaluating the modules, instantiating the WebAssembly and resolving the
themes. The "of which load" column shows that loading part on its own.

### Server (workerd)

`src/worker.ts` is bundled with esbuild using workerd's export conditions
(the ones wrangler and the Cloudflare Vite plugin use). Highlights' `.wasm`
is kept as a compiled Wasm module. Shiki is left out of the server bundle;
"Bundle cost" below explains why.

The bundle runs in the `workerd` binary directly, from a capnp config
(`src/workerd.ts`). This is the same runtime that `wrangler dev`, the Vite
plugin and the Workers Vitest pool use. apps/web's own tests run in plain
Node, not in the Workers pool, so there was no web test setup to reuse.

- **Cold:** each sample starts a new workerd process, which means a fresh
  isolate with nothing compiled and nothing cached. It sends one `/noop`
  request, then exactly one render. Each cell has 12 samples.
- **Warm:** one process per cell. It runs 3 discarded renders first, then
  30 timed ones (12 for the 256 KiB and larger files).
- **Clock:** time is measured inside the isolate with `performance.now()`
  around the render, after the request body has been read. Local workerd
  advances this clock during synchronous work, but only at 1 ms resolution
  (checked with a 79 ms loop, which read 79 ms). Deployed Workers freeze the
  clock until I/O, so this can only be measured locally.
- **Sub-millisecond means:** the "warm mean (batched)" column runs enough
  renders in one request to fill about 50 ms, then divides. That gives a
  mean below 1 ms where the per-call clock reads 0 or 1.
- **Cross-check:** the "process CPU/request" column is the whole process's
  user and system CPU from `/proc`, over the warm samples. It also counts
  HTTP handling and the body upload, and the kernel counts it in 10 ms ticks.
- **Memory:** the peak resident memory of the workerd process (`VmHWM`) after
  the render, minus its value just before it.

### Browser stand-in (Node)

Node is a **stand-in** for a browser's main thread. It runs the same V8 and
the same packages, with the browser build of Highlights (WebAssembly
inlined). It has no DOM, no layout and no paint, so real page cost is higher
than these figures.

`src/node-bench.ts` is bundled and runs in a fresh process for each cold
sample (12 per cell). Warm samples run as for workerd.

The first-screen test takes the first 60 lines of a 256 KiB and a 1 MiB
file and compares three ways to get them:

- `codeToTokens` on the whole file;
- `StreamTokenizer`, fed 16 KiB chunks until 60 lines are complete;
- `LiveTokenizer`, given the whole document with `renderRange: [0, 60]`,
  then paused. Its `flush()` is timed separately, to show what the deferred
  rest costs.

### Bundle cost (`src/bundle-size.ts`)

- **Server:** `pnpm --filter @fyrden/web build`, then `wrangler deploy
  --dry-run --outdir`. The upload is measured three ways, each with
  wrangler's own "Total Upload" figures:
  1. apps/web as built;
  2. the same build plus the file renderer, bundled the default way and
     loaded on demand by one path;
  3. the same as (2), with Shiki left out.
- **Browser:** esbuild bundles `File` and `FileDiff` from
  `@pierre/diffs/react`, split at dynamic imports the way Vite splits them,
  minified, with React left out. For each, the report gives what loads
  before drawing and what loads on demand. It also gives the size of the
  apps/web client build as it already ships.

## Results

### 1. Server CPU (workerd), against Workers Free's 10 ms

Times are in ms. "Cold" is the first call in a fresh isolate, including
loading. "Warm" is per call.

| file | mode | cold median / p95 | warm median / p95 | warm mean | HTML out |
|---|---|---:|---:|---:|---:|
| TS 1 KiB | file | 23 / 34 | 1 / 1 | 0.20 | 64 KiB |
| TS 16 KiB | file | 34 / 46 | 3 / 4 | 2.45 | 358 KiB |
| TS 64 KiB | file | 53 / 70 | 9 / 15 | 8.56 | 1.1 MiB |
| TS 100 KiB | file | 61 / 78 | 11 / 21 | 10.7 | 1.7 MiB |
| TS 256 KiB | file | 102 / 145 | 39 / 55 | 41.8 | 4.4 MiB |
| TS 1 MiB | file | 306 / 400 | 396 / 470 | 269 | 17.8 MiB |
| JSON 100 KiB | file | 57 / 78 | 16 / 26 | 21 | 2.0 MiB |
| Markdown 100 KiB | file | 36 / 47 | 4 / 13 | 4.5 | 586 KiB |
| minified JS 100 KiB (one line) | file | 29 / 41 | 3 / 7 | 2.6 | 149 KiB |
| TS 100 KiB | highlights | 9 / 13 | 2 / 3 | 2.68 | 562 KiB |
| TS 1 MiB | highlights | 51 / 69 | 22 / 32 | 24 | 5.9 MiB |

What this shows:

- **Cost per KiB.** The file renderer costs about 0.11 to 0.26 ms per KiB
  warm for TypeScript and JSON, and 0.05 for Markdown. `codeToHtml` alone
  costs about 0.02. Highlighting is a small part of the time: most of it is
  the renderer building and serialising its HTML tree.
- **Largest TypeScript file within 10 ms with the file renderer.** Warm,
  82 KiB by median and 46 KiB by p95. Cold, **none**: even 1 KiB takes
  23 ms. About 13 ms of that is loading the modules, and about 10 ms is the
  first render (theme resolution, code not yet optimised).
- **Largest within 10 ms with `codeToHtml` alone.** Warm, 461 KiB by median
  and 311 KiB by p95. Cold, about 109 KiB by median. The p95 fit comes out
  at 3.6 KiB only because one 4 KiB sample read 11 ms; leaving that sample
  out, the cold p95 stays within 10 ms up to 32 KiB. Highlighting alone is
  cheap, but it is not the file renderer the views need.
- **The file renderer's HTML is about 18 times its input.** A 1 KiB file
  already produces 64 KiB, mostly the renderer's stylesheet and icon sprite
  repeated in every render. A 1 MiB file produces 17.8 MiB.
- **Lines past 1000 characters are left plain** by `tokenizeMaxLineLength`.
  That is why minified JavaScript is cheap in `file` mode and produces a
  single styled span.
- **Warm can be slower than cold for 1 MiB** (median 396 ms against 306 ms).
  Repeated 1 MiB renders keep the heap large and collection grows. The
  batched mean is 269 ms.

### 2. Browser stand-in (Node) and the first screen

Without a DOM, the costs are close to workerd's. TypeScript at 100 KiB:
`file` takes 81 ms cold and 19 ms warm (median), `highlights` 19 ms cold and
2.1 ms warm. At 1 MiB, `file` takes 348 ms warm (median).

Drawing the whole of a large file in one go would therefore freeze the main
thread for hundreds of milliseconds. The renderer avoids that by
tokenising in its worker pool and keeping only a window of lines in the
DOM, as the pull request page already does.

**The first screen does not need the whole file.** For the first 60 lines
of the 1 MiB file (27,129 lines), median / p95 in ms:

| method | 1 MiB file |
|---|---:|
| `codeToTokens`, whole file | 29.2 / 36.4 |
| `StreamTokenizer`, first screen (one 16 KiB chunk) | **0.75 / 1.0** |
| `LiveTokenizer`, first screen (`renderRange: [0, 60]`) | 7.6 / 10.0 |
| `LiveTokenizer`, `flush()` of the rest | 34 / 54 |
| fresh process: import Highlights + `StreamTokenizer` first screen | 16.5 / 19.4 (8.0 of it the import) |

`StreamTokenizer` gives the first screen in under a millisecond whatever the
file size, because it only reads what it has been pushed so far.
`LiveTokenizer` takes the whole document up front, so its first screen costs
grow with the file: 3.6 ms at 256 KiB and 7.6 ms at 1 MiB. In exchange it
keeps the document editable and finishes the rest in background batches.

So yes: either tokenizer lets the browser show the first screen highlighted
before the rest is done. Whether the `File` component itself tokenises lazily
is not measured here (see below).

### 3. Bundle cost

Web Worker upload, as wrangler reports it (`Total Upload`):

| build | uncompressed | gzip |
|---|---:|---:|
| apps/web as built | 1,438 KiB | 310 KiB |
| plus the file renderer, bundled the default way | 13,072 KiB (+11,633) | 2,272 KiB (+1,962) |
| plus the file renderer, Shiki left out | 2,444 KiB (+1,006) | 505 KiB (+194) |

Bundled the default way, `@pierre/diffs` brings all of Shiki with it: every
grammar, both regex engines and every theme. It reaches Shiki only through
dynamic imports that the Highlights path never takes, but a Worker uploads
every module whether or not it runs.

Shiki can be left out by replacing those dynamic imports with modules that
throw (the `withoutShiki` esbuild plugin in `src/toolchain.ts`). All the
workerd numbers above come from that build: every render completed, so the
Highlights path never reached Shiki. A real server build would need the same
alias in the web app's Vite config.

Startup time follows bundle size. From spawning workerd until its socket
listens (median):

| Worker | startup |
|---|---:|
| empty | 28 ms |
| renderer, Shiki left out (1.1 MB of JS) | 50 ms |
| renderer with Shiki (11.7 MB) | 202 ms |

Cloudflare's limits page gives these limits for Workers:

- **script size:** 3 MB on Free and 10 MB on Paid, both after compression;
- **CPU per invocation:** 10 ms on Free; Paid's default is far higher;
- **memory:** 128 MB per isolate.

**None of these were verified in this session:**
developers.cloudflare.com was not reachable from it. The repository already
cites the 128 MB figure as verified
(`packages/adapters-cloudflare/src/git/memory-budget.ts`). Check the size
limits on <https://developers.cloudflare.com/workers/platform/limits/>
before relying on them.

On those figures, the default bundle (2.27 MB gzip) fits under Free's 3 MB
with little room left for growth. The build without Shiki (0.5 MB gzip)
fits comfortably on both plans.

**Browser.** `File` comes from the same module as the pull request page's
`FileDiff`. A file view adds **0.2 KiB** before drawing, on top of what the
pull request page already loads (394 KiB, 108 KiB gzip, shared). To
highlight, it fetches the Highlights chunks on demand: 510 KiB, 190 KiB
gzip, with the WebAssembly inlined. The pull request page already uses
those chunks, so a browser that has visited one has them cached.

### 4. Memory

Peak resident memory of the workerd process during one cold render, minus
the peak before it (median of 12):

| file | `file` mode | `highlights` mode |
|---|---:|---:|
| TS 256 KiB | +60 MiB | +20 MiB |
| TS 512 KiB | +102 MiB | +27 MiB |
| TS 1 MiB | **+190 MiB** | +40 MiB |

This is the whole process, not the isolate on its own. It includes heap that
V8 grew but did not give back, so it is an upper bound on the isolate's
working set. Under a memory cap V8 would collect sooner. Even so, rendering
a 1 MiB file with the file renderer is very likely over a 128 MB isolate, and
512 KiB is close to it. `codeToHtml` alone stays at about 40 MiB.

## Recommendation, and what decides it

**Browser.** The server sends plain text lines, and the browser draws the
file with `File`, highlighted in the renderer's worker pool.

1. **Workers Free cannot run the file renderer on the server.** A cold
   isolate takes at least 23 ms (p95 34 ms) for a 1 KiB file, and any
   request can land on a cold isolate. Warm, only files under about 46 KiB
   (p95) fit in 10 ms.
2. **Paid could run it, but the cost is high:**
   - about 0.2 ms of CPU per KiB;
   - about 18 KiB of HTML sent per KiB of source;
   - memory near or over 128 MB from about 512 KiB;
   - a server bundle about 1 MB larger even with Shiki removed by an alias,
     and 11.6 MB larger without one.
3. **The browser costs almost nothing extra:** 0.2 KiB before drawing, plus
   the Highlights chunks the pull request page already uses. The first
   screen can be tokenised in under 1 ms (`StreamTokenizer`) whatever the
   file size.

**One split is possible, but not recommended now.** On Paid, the server
could pre-highlight small files with `codeToHtml` alone (not the file
renderer), so the first paint arrives coloured. Cold p95 stays within
10 ms up to about 32 KiB, and warm p95 up to about 311 KiB. The browser
would still have to load `File` for blame's gutter, line selection and
comments. That means two render paths to keep visually identical, for a
first-paint gain the stream tokenizer already gives the browser. Revisit
only if a measured first paint on real pages says otherwise.

## Not measured

- **Deployed Workers.** These are local workerd numbers on one machine.
  Cloudflare's CPU accounting and hardware may differ, and the clock this
  benchmark relies on is frozen in production. A deployed probe, reporting
  CPU through the web Worker's existing `tail()` metrics, would confirm the
  ratios.
- **The isolate's own heap peak.** Only the process's peak resident memory
  was read.
- **A real browser main thread.** DOM building, layout and paint are not
  included; Node stands in. Also not measured: the `File` component's own
  scheduling (worker pool, virtualised window), and whether it tokenises
  only the visible window.
- **Blame and history.** Blame's per-line annotations, and the history list
  (which needs no highlighting), were not rendered. Annotations add DOM per
  line, which favours the browser's virtualised window further.
- **Shiki as a fallback.** The app falls back to Shiki where Highlights
  cannot load. The Shiki highlighter was not timed, and it would bring back
  the 11.6 MB on a server path.
- **Startup CPU against Cloudflare's startup limit.** Only wall time from
  spawn until listening was measured, not CPU, and not in production.
