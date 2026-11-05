# Where should highlighted file views render?

File contents, blame and history pages will show files with `@pierre/diffs`'
file renderer, highlighted by `@pierre/highlights`. This benchmark asks
whether that should run in the web Worker (workerd) or in the browser.

**Recommendation: render in the browser.** The server sends the file as
plain text (readable without JavaScript, as Markdown is today), and the
browser draws it with the renderer's `File` component and Highlights. Do not
run the file renderer in the web Worker by default, on Free or on Paid.

What the local measurements say (wall time on one machine, not
Cloudflare's CPU accounting; see "Not measured"):

- **Warm, small files are cheap on the server.** In a warm workerd isolate
  the file renderer takes 0 ms median and 1 ms p95 for a 1 KiB file, and
  1 / 3 ms for 16 KiB (the first run, on a slower machine: 1 / 1 and
  3 / 4 ms). By warm p95 it stays within 10 ms up to about 100 KiB of
  TypeScript here (46 KiB in the first run).
- **A cold isolate is at or over 10 ms even for the smallest file:**
  10 to 11 ms median and 15 to 21 ms p95 for 1 to 8 KiB, about 6 ms of it
  loading the modules (the first run: 23 ms median, 34 ms p95 at 1 KiB).
  Cold samples have wall time only, no CPU figure.
- **The renderer's HTML is about 18 times its input** (64 KiB for a 1 KiB
  file, 17.8 MiB for 1 MiB), and rendering a 1 MiB file raises the workerd
  process's peak RSS by about 190 MiB.
- **In the browser,** a file view's code is 63 KiB (16 KiB gzip) the pull
  request page does not load today; once the pull request page's chunks are
  cached, a file view needs 0.2 KiB more before drawing. In Node (no browser
  was timed), `StreamTokenizer` gives the first 60 lines of a 1 MiB file in
  0.48 ms median, 1.5 ms p95, warm; 7.5 ms median in a fresh process,
  including importing Highlights.

Whether a deployed Worker on Free could render small files within its
10 ms of CPU is **unverified**: these are local wall-clock figures, a
production clock is frozen during CPU work, and Cloudflare's hardware and
CPU accounting differ. The recommendation does not rest on that question
alone: the HTML size, the memory, the cold start and a second render path
to keep identical all point the same way.

## Machines

Every number below was **measured** by `run.ts` on 2026-11-05 at
484dd0c45f41, with workerd 1.20261023.1 (the version wrangler 4.154.0
pins), Node v24.15.0, `@pierre/diffs` 1.6.1 and `@pierre/highlights` 0.2.0.
The machine was Linux arm64 (kernel 6.10.14-linuxkit) in Docker Desktop's
VM on an Apple M4 Mac: 10 CPUs and 8 GiB given to the VM, image
`node:24.15.0-bookworm`. Node reports no CPU model inside the container
(`"cpu": "unknown"` in results.json). A full run took 2 minutes 19 seconds.

The first run (2026-11-04, at 6206d9db1b06, before the fixes in 484dd0c)
was on a 4-core Intel Xeon at 2.10 GHz under Linux x86_64. Its times are
two to three times these: **the absolute figures depend on the machine**,
and neither machine is Cloudflare's. Where this page quotes the first run,
it says so. HTML and bundle sizes are identical on both, and memory within
a few MiB.

The complete tables are in [results.md](results.md) and the raw data is in
[results.json](results.json).

## Run it

From a clean checkout, after `pnpm install --frozen-lockfile`:

```sh
FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts            # about 2 to 4 minutes
FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts --quick    # fewer samples
FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts --only=workerd,node,bundle
```

The workerd section reads each workerd process's CPU and memory from
`/proc`, so it needs Linux. Elsewhere the script refuses before building or
starting anything; `--only=node,bundle` runs the rest. This run used a
container with a fresh clone of the commit and its own `node_modules`, from
the repository root:

```sh
docker run --rm -e COMMIT="$(git rev-parse HEAD)" \
  -v "$(git rev-parse --path-format=absolute --git-common-dir)":/repo.git:ro \
  -v "$PWD/tools/bench/code-rendering":/out \
  node:24.15.0-bookworm bash -euc '
    git config --global --add safe.directory "*"
    git clone -q /repo.git /work && cd /work && git checkout -q "$COMMIT"
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && corepack enable
    pnpm install --frozen-lockfile
    FYRDEN_BENCH=1 node tools/bench/code-rendering/run.ts
    cp tools/bench/code-rendering/results.json tools/bench/code-rendering/results.md /out/'
```

Do not run it under `--platform linux/amd64` on Apple silicon: emulation
distorts the times.

The script rewrites `results.json` and `results.md` in this directory. The
bundle step also builds `apps/web`, which writes `apps/web/build`; that
directory is ignored by git. An interrupted or failed run stops every
workerd it started and removes its temporary directory. Without
`FYRDEN_BENCH=1` the script prints that it was skipped and exits, because
only benchmarks may print times (AGENTS.md, rule 7). It is not part of any
test suite.

The directory is outside every workspace package, so `pnpm typecheck` does
not cover it; `pnpm exec tsc -p tools/bench/code-rendering` does.

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
- **JSON:** the largest tracked JSON file outside `tools/bench/` (so a run
  never renders a previous run's `results.json`; at this commit
  `packages/git-core/test/corpus/protocol-violations/cases.json`, 18 KiB),
  plus 100 KiB of the tracked file list as pretty-printed JSON.
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
  request, then exactly one render. Each cell has 12 samples. A cold
  sample has wall time only: no CPU figure is taken for it.
- **Warm:** one process per cell. It runs 3 discarded renders first, then
  30 timed ones (12 for the 256 KiB, 512 KiB and 1 MiB steps).
- **Clock:** time is measured inside the isolate with `performance.now()`
  around the render, after the request body has been read. Local workerd
  advances this clock during synchronous work, but only at 1 ms resolution
  (checked with a 79 ms loop, which read 79 ms). Deployed Workers freeze the
  clock until I/O, so this can only be measured locally. It is wall time
  on this machine: a stand-in for the CPU time Cloudflare limits, not that
  CPU time itself.
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
  paused, then `flush(60)` so the first screen is finished before it is
  read (the constructor completes only what fits its time budget, and an
  unfinished line reads back as plain text). Its `flush()` of the rest is
  timed separately, to show what the deferred rest costs.

Outside the timing, each tokenizer's first screen is checked line for line
against `codeToTokens` on the whole file (text, colours and font styles);
a mismatch fails the run.

### Bundle cost (`src/bundle-size.ts`)

- **Server:** `pnpm --filter @fyrden/web build`, then `wrangler deploy
  --dry-run --outdir`. The upload is measured three ways, each with
  wrangler's own "Total Upload" figures:
  1. apps/web as built;
  2. the same build plus the file renderer, bundled the default way and
     loaded on demand by one path;
  3. the same as (2), with Shiki left out.
- **Browser:** esbuild bundles `FileDiff` from `@pierre/diffs/react` alone
  (the pull request page today), then `FileDiff` and `File` together (the
  app with file views), split at dynamic imports the way Vite splits them,
  minified, with React left out. For each entry, the report gives what
  loads before drawing and what loads on demand. A file view's cost is
  given two ways: first time, nothing cached (both pages' code before
  drawing, against `FileDiff` alone), and per navigation once the pull
  request page's chunks are cached. It also gives the size of the apps/web
  client build as it already ships.

## Results

### 1. Server time (workerd), against Workers Free's 10 ms

Times are local wall time in ms, at 1 ms resolution. "Cold" is the first
call in a fresh isolate, including loading. "Warm" is per call.

| file | mode | cold median / p95 | warm median / p95 | warm mean | HTML out |
|---|---|---:|---:|---:|---:|
| TS 1 KiB | file | 11 / 21 | 0 / 1 | 0.09 | 64 KiB |
| TS 4 KiB | file | 10 / 15 | 0 / 1 | 0.22 | 120 KiB |
| TS 16 KiB | file | 13 / 27 | 1 / 3 | 0.98 | 358 KiB |
| TS 64 KiB | file | 19 / 29 | 3 / 5 | 3.55 | 1.1 MiB |
| TS 100 KiB | file | 26 / 49 | 5 / 10 | 6.9 | 1.7 MiB |
| TS 256 KiB | file | 59 / 133 | 43 / 74 | 31.5 | 4.4 MiB |
| TS 1 MiB | file | 128 / 174 | 117 / 128 | 117 | 17.8 MiB |
| JSON 100 KiB | file | 29 / 38 | 6 / 13 | 8.6 | 2.0 MiB |
| Markdown 100 KiB | file | 21 / 38 | 2 / 4 | 2.3 | 586 KiB |
| minified JS 100 KiB (one line) | file | 15 / 24 | 1 / 1 | 0.69 | 149 KiB |
| TS 100 KiB | highlights | 4 / 246 | 1 / 1 | 0.99 | 562 KiB |
| TS 1 MiB | highlights | 21 / 86 | 11 / 12 | 16.8 | 5.9 MiB |

With 12 samples, the p95 is the slowest sample, so one stall shows up in
full. This run had a few: one cold `highlights` render of 100 KiB read
246 ms against a median of 4, and one warm 512 KiB `file` render read
2,119 ms against a median of 64 (results.md). Read single p95 cells with
that in mind.

What this shows:

- **Cost per KiB.** Warm, the file renderer costs about 0.05 to 0.15 ms per
  KiB for TypeScript and JSON, and 0.02 to 0.03 for Markdown. `codeToHtml`
  alone costs about 0.01. Highlighting is a small part of the time: most of
  it is the renderer building and serialising its HTML tree. (The first
  run: 0.11 to 0.26, and 0.02.)
- **Largest TypeScript file within 10 ms with the file renderer, locally.**
  Warm, 142 KiB by median and 100 KiB by p95 (the first run: 82 and 46).
  Cold, no size with any margin: no p95 fits, 1 KiB takes 11 ms by median,
  and the 2 and 4 KiB medians sit exactly at 10 ms. About 6 ms of a cold call is loading the modules and the rest is
  the first render (theme resolution, code not yet optimised).
- **Largest within 10 ms with `codeToHtml` alone, locally.** Warm, 939 KiB
  by median and 853 KiB by p95. Cold, about 341 KiB by median. The cold
  p95 fit comes out at 65 KiB only because of single stalls at 100 KiB
  (246 ms) and 128 KiB (63 ms); the 256 KiB step's cold p95 is 13 ms.
  Highlighting alone is cheap, but it is not the file renderer the views
  need.
- **The file renderer's HTML is about 18 times its input.** A 1 KiB file
  already produces 64 KiB, mostly the renderer's stylesheet and icon sprite
  repeated in every render. A 1 MiB file produces 17.8 MiB. These sizes do
  not depend on the machine.
- **Lines past 1000 characters are left plain** by `tokenizeMaxLineLength`.
  That is why minified JavaScript is cheap in `file` mode and produces a
  single styled span.

These thresholds are local wall time on this machine. They moved by about
a factor of two between the two machines measured, and a deployed Worker
was not measured.

### 2. Browser stand-in (Node) and the first screen

No browser was timed. In Node, without a DOM, the costs are close to
workerd's. TypeScript at 100 KiB: `file` takes 35 ms cold and 12 ms warm
(median), `highlights` 8.6 ms cold and 0.9 ms warm. At 1 MiB, `file` takes
152 ms warm (median).

Drawing the whole of a large file in one go would therefore block the main
thread for over 100 ms. The renderer avoids that by tokenising in its
worker pool and keeping only a window of lines in the DOM, as the pull
request page already does.

**The first screen does not need the whole file.** For the first 60 lines
of the 1 MiB file (27,129 lines), median / p95 in ms, warm unless said
otherwise:

| method | 1 MiB file |
|---|---:|
| `codeToTokens`, whole file | 18.6 / 108.8 |
| `StreamTokenizer`, first screen (one 16 KiB chunk) | **0.48 / 1.49** |
| `LiveTokenizer`, first screen (`renderRange: [0, 60]`, then `flush(60)`) | 7.1 / 15.7 |
| `LiveTokenizer`, `flush()` of the rest | 19.8 / 56.9 |
| fresh process: import Highlights + `StreamTokenizer` first screen | 7.5 / 16.2 (4.3 of it the import) |

Each first screen was checked against `codeToTokens` line for line, so
these times are for finished, highlighted lines.

`StreamTokenizer` gives the first screen in about half a millisecond warm
(1.5 ms p95) whatever the file size, because it only reads what it has
been pushed so far; a page that has not loaded Highlights yet takes about
7.5 ms in all, mostly the import. These are Node figures: a browser main
thread adds DOM, layout and paint, and its speed depends on the device.
`LiveTokenizer` takes the whole document up front, so its first screen
costs grow with the file: 2.5 ms at 256 KiB and 7.1 ms at 1 MiB. In
exchange it keeps the document editable and finishes the rest in
background batches.

So either tokenizer lets the browser show the first screen highlighted
before the rest is done. Whether the `File` component itself tokenises
lazily is not measured here (see below).

### 3. Bundle cost

Web Worker upload, as wrangler reports it (`Total Upload`):

| build | uncompressed | gzip |
|---|---:|---:|
| apps/web as built | 1,438 KiB | 310 KiB |
| plus the file renderer, bundled the default way | 13,072 KiB (+11,633) | 2,272 KiB (+1,962) |
| plus the file renderer, Shiki left out | 2,444 KiB (+1,006) | 505 KiB (+194) |

Bundled the default way, the file renderer adds 11,633 KiB, and leaving
Shiki out saves 10,628 KiB of it: `@pierre/diffs` brings all of Shiki with
it (every grammar, both regex engines and every theme). It reaches Shiki
only through dynamic imports that the Highlights path never takes, but a
Worker uploads every module whether or not it runs.

Shiki can be left out by replacing those dynamic imports with modules that
throw (the `withoutShiki` esbuild plugin in `src/toolchain.ts`). All the
workerd numbers above come from that build: every render completed, so the
Highlights path never reached Shiki. A real server build would need the same
alias in the web app's Vite config.

Startup time follows bundle size. From spawning workerd until its socket
listens (local wall time, median):

| Worker | startup |
|---|---:|
| empty | 13 ms |
| renderer, Shiki left out (1.1 MB of JS) | 23 ms |
| renderer with Shiki (11.7 MB) | 101 ms |

Cloudflare's limits page
(<https://developers.cloudflare.com/workers/platform/limits/>, last updated
2026-10-29, **verified** 2026-11-05) gives, for both plans unless noted:

- **Worker size:** 64 MiB uncompressed; there is no compressed size limit;
- **startup:** 1 second to parse and run the global scope;
- **CPU per HTTP request:** 10 ms on Free; 30 seconds by default on Paid,
  configurable up to 5 minutes; there is no wall-time limit;
- **memory:** 128 MB per isolate, JavaScript heap and WebAssembly included.

On those figures, both server builds fit the size limit (13,072 KiB with
Shiki), and the local startup times are far below 1 second (local wall
time, not Cloudflare's startup CPU). The bundle is a cost in upload and
startup, not a blocker.

**Browser.** `File` comes from the same module as the pull request page's
`FileDiff`, and the cost depends on what is already cached (esbuild's
split, minified, React left out; before drawing):

| build | pull request page | file view |
|---|---:|---:|
| `FileDiff` alone (today) | 331 KiB (92 KiB gzip) | |
| `FileDiff` and `File` together | 394 KiB (108 KiB gzip) | 394 KiB (108 KiB gzip) |

- **First time, nothing cached:** file views add 63 KiB (16 KiB gzip) to
  what the pull request page loads today. Almost all of it is `File`'s own
  code (`File`, `VirtualizedFile`, `FileRenderer`), which esbuild's split
  puts in the chunk both pages share, so the pull request page would load
  it too. Vite's split of the real app was not measured and may keep it out
  of the pull request page.
- **Per navigation, the pull request page's chunks cached:** a file view
  loads 0.2 KiB more before drawing.
- **To highlight,** a file view fetches the Highlights chunks on demand:
  510 KiB, 190 KiB gzip, with the WebAssembly inlined. `FileDiff` reaches
  the same chunks, so a browser that has highlighted a pull request has
  them cached.

### 4. Memory

Peak resident memory of the workerd process during one cold render, minus
the peak before it (median of 12):

| file | `file` mode | `highlights` mode |
|---|---:|---:|
| TS 256 KiB | +58 MiB | +19 MiB |
| TS 512 KiB | +102 MiB | +23 MiB |
| TS 1 MiB | **+190 MiB** | +39 MiB |

This is the whole process, not the isolate on its own. It includes heap that
V8 grew but did not give back, so it is an upper bound on the isolate's
working set, and V8 under a 128 MB cap would collect sooner. Even so,
rendering a 1 MiB file with the file renderer raises the process's peak RSS
by about 190 MiB, which is likely over a 128 MB isolate, and 512 KiB is
close to it. `codeToHtml` alone stays near 40 MiB. The two runs agree on
these figures.

## Recommendation, and what decides it

**Browser.** The server sends plain text lines, and the browser draws the
file with `File`, highlighted in the renderer's worker pool.

1. **On Workers Free the file renderer does not fit locally.** A cold
   isolate measured 10 to 11 ms median and 15 to 21 ms p95 for files of 1
   to 8 KiB here, and 23 ms median on the first run's machine, against
   10 ms of CPU; any request can land on a cold isolate. Warm, small files
   fit easily (1 KiB: 0 / 1 ms; 16 KiB: 1 / 3 ms). Whether a deployed cold
   render stays within 10 ms of CPU is unverified, and on these figures it
   would be marginal at best.
2. **Paid could run it, but the cost is high:**
   - about 0.05 to 0.15 ms per KiB warm here (0.11 to 0.26 on the first
     run's machine);
   - about 18 KiB of HTML sent per KiB of source;
   - process memory near or over 128 MB from about 512 KiB;
   - a server bundle 1,006 KiB larger with Shiki left out by an alias, and
     11,633 KiB larger without one.
3. **The browser costs little extra:** 63 KiB (16 KiB gzip) of `File` code
   on a first visit, 0.2 KiB per navigation once the pull request page's
   chunks are cached, plus the Highlights chunks the pull request page
   already uses. In Node the first screen of a 1 MiB file tokenises in
   about 0.5 ms warm with `StreamTokenizer`; a browser was not timed.

**One split is possible, but not recommended now.** On Paid, the server
could pre-highlight small files with `codeToHtml` alone (not the file
renderer), so the first paint arrives coloured. Locally, its cold p95 stays
within 10 ms up to at least 64 KiB here (32 KiB on the first run's
machine), and its warm p95 up to about 850 KiB. The browser would still have to load
`File` for blame's gutter, line selection and comments. That means two
render paths to keep visually identical, for a first-paint gain the stream
tokenizer already gives the browser. Revisit only if a measured first
paint on real pages says otherwise.

## Not measured

- **Deployed Workers.** These are local workerd numbers on two machines.
  Cloudflare limits CPU time, while this benchmark reads wall time; the
  clock it relies on is frozen in production, and Cloudflare's hardware
  and CPU accounting differ. A deployed probe, reporting CPU through the
  web Worker's existing `tail()` metrics, would settle whether a cold or
  warm render fits Free's 10 ms.
- **Cold CPU.** Cold samples have wall time only; the per-process CPU read
  from `/proc` covers warm samples.
- **The isolate's own heap peak.** Only the process's peak resident memory
  was read.
- **A real browser main thread.** DOM building, layout and paint are not
  included; Node stands in. Also not measured: the `File` component's own
  scheduling (worker pool, virtualised window), whether it tokenises only
  the visible window, and how Vite (rather than esbuild) splits the app's
  chunks.
- **Blame and history.** Blame's per-line annotations, and the history list
  (which needs no highlighting), were not rendered. Annotations add DOM per
  line, which favours the browser's virtualised window further.
- **Shiki as a fallback.** The app falls back to Shiki where Highlights
  cannot load. The Shiki highlighter was not timed, and on a server path it
  would bring back the 10,628 KiB that leaving Shiki out saves.
- **Startup CPU against Cloudflare's startup limit.** Only local wall time
  from spawn until listening was measured, not CPU, and not in production.
