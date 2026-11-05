/**
 * The Node side of the benchmark: a stand-in for a browser's main thread
 * (same packages and entry points a browser bundle gets: `@pierre/highlights`'
 * default build with its WebAssembly inlined; V8 as in Chromium, but no DOM,
 * no layout and no paint). Bundled by esbuild and run once per sample by
 * `run.ts`, which passes one JSON command and reads one JSON line back.
 */
// biome-ignore-all lint/suspicious/noConsole: the result line is the output
import { readFileSync } from "node:fs";
import { loadRenderer, type Mode, styledSpans } from "./render.ts";

type Command =
  | { kind: "cold"; mode: Mode; path: string; name: string; lang: string }
  | { kind: "warm"; mode: Mode; path: string; name: string; lang: string; samples: number }
  | { kind: "first-screen"; path: string; lang: string; lines: number; samples: number }
  | { kind: "first-screen-cold"; path: string; lang: string; lines: number };

const command = JSON.parse(process.argv[2] ?? "{}") as Command;
const now = () => performance.now();

async function cold(c: Extract<Command, { kind: "cold" }>) {
  const text = readFileSync(c.path, "utf8");
  const cpu = process.cpuUsage();
  const start = now();
  const render = await loadRenderer(c.mode);
  const loaded = now();
  const html = await render(c.name, c.lang, text);
  const done = now();
  const used = process.cpuUsage(cpu);
  return {
    loadMs: loaded - start,
    renderMs: done - loaded,
    totalMs: done - start,
    cpuMs: (used.user + used.system) / 1000,
    htmlBytes: Buffer.byteLength(html),
    spans: styledSpans(html),
  };
}

async function warm(c: Extract<Command, { kind: "warm" }>) {
  const text = readFileSync(c.path, "utf8");
  const render = await loadRenderer(c.mode);
  for (let i = 0; i < 3; i++) await render(c.name, c.lang, text);
  const times: number[] = [];
  for (let i = 0; i < c.samples; i++) {
    const start = now();
    await render(c.name, c.lang, text);
    times.push(now() - start);
  }
  return { times };
}

const TOKEN_OPTIONS = {
  defaultColor: false,
  tokenizeMaxLineLength: 1000,
} as const;

type Token = { content: string; color?: string; fontStyle?: number; htmlStyle?: object };

/** A line's tokens as text and style, offsets left out (LiveTokenizer's are line-relative). */
function lineKey(tokens: readonly Token[]): string {
  return JSON.stringify(tokens.map((t) => [t.content, t.color, t.fontStyle, t.htmlStyle]));
}

/**
 * Checked outside the timing: `got` (a first screen) matches the whole
 * file's `codeToTokens` line for line, so no method is timed reading
 * unfinished or plain tokens.
 */
function checkScreen(
  method: string,
  got: readonly (readonly Token[])[],
  whole: readonly (readonly Token[])[],
) {
  for (const [line, tokens] of got.entries())
    if (lineKey(tokens) !== lineKey(whole[line] ?? []))
      throw new Error(`${method}: line ${line} of the first screen differs from codeToTokens`);
}

/** Each way of getting the first `lines` lines' tokens of a large file, timed. */
async function firstScreenOnce(text: string, lang: string, lines: number) {
  const hl = await import("@pierre/highlights");
  const [dark, light] = await Promise.all([
    import("@pierre/highlights/themes/github-dark-high-contrast"),
    import("@pierre/highlights/themes/github-light-high-contrast"),
  ]);
  const options = {
    ...TOKEN_OPTIONS,
    lang: lang as Parameters<typeof hl.codeToTokens>[1]["lang"],
    themes: { light: light.default, dark: dark.default },
  };

  // The whole file tokenized, as `codeToTokens` (and the file renderer) do.
  let start = now();
  const all = hl.codeToTokens(text, options);
  const wholeMs = now() - start;

  // StreamTokenizer: push the file in 16 KiB chunks until the first screen is complete.
  start = now();
  const stream = new hl.StreamTokenizer(options);
  const streamScreen: Token[][] = [];
  let pushed = 0;
  for (let at = 0; at < text.length && streamScreen.length < lines; at += 16 * 1024) {
    streamScreen.push(...stream.pushCode(text.slice(at, at + 16 * 1024)));
    pushed = Math.min(text.length, at + 16 * 1024);
  }
  const streamMs = now() - start;
  stream.dispose();
  checkScreen("StreamTokenizer", streamScreen.slice(0, lines), all.tokens);

  // LiveTokenizer: the whole document, with the first screen as its render
  // range. The constructor completes only what fits its time budget, and a
  // pending line reads back as plain text, so `flush(lines)` finishes the
  // first screen before it is read. `flush` clears the pause and schedules
  // the rest for a later task; pausing again keeps that work for the timed
  // `flush()` below.
  start = now();
  const live = new hl.LiveTokenizer({ ...options, code: text, renderRange: [0, lines] });
  live.pause();
  live.flush(lines);
  live.pause();
  const liveScreen: Token[][] = [];
  for (let line = 0; line < lines; line++) liveScreen.push(live.getLineTokens(line).tokens);
  const liveMs = now() - start;
  checkScreen("LiveTokenizer", liveScreen, all.tokens);
  // What finishing the rest synchronously costs (the background batches' total work).
  start = now();
  live.flush();
  const liveFlushMs = now() - start;
  live.dispose();

  return {
    wholeMs,
    wholeLines: all.tokens.length,
    streamMs,
    streamLines: streamScreen.length,
    streamCharsPushed: pushed,
    liveMs,
    liveFlushMs,
  };
}

async function main(): Promise<unknown> {
  switch (command.kind) {
    case "cold":
      return cold(command);
    case "warm":
      return warm(command);
    case "first-screen": {
      const text = readFileSync(command.path, "utf8");
      await firstScreenOnce(text, command.lang, command.lines);
      const runs = [];
      for (let i = 0; i < command.samples; i++)
        runs.push(await firstScreenOnce(text, command.lang, command.lines));
      return { runs };
    }
    case "first-screen-cold": {
      // A fresh process: importing Highlights (its WebAssembly compiled and
      // instantiated) and a StreamTokenizer's first screen, nothing else.
      const text = readFileSync(command.path, "utf8");
      const start = now();
      const hl = await import("@pierre/highlights");
      const imported = now();
      const stream = new hl.StreamTokenizer({
        ...TOKEN_OPTIONS,
        lang: command.lang as Parameters<typeof hl.codeToTokens>[1]["lang"],
        themes: {
          light: (await import("@pierre/highlights/themes/github-light-high-contrast")).default,
          dark: (await import("@pierre/highlights/themes/github-dark-high-contrast")).default,
        },
      });
      let got = 0;
      for (let at = 0; at < text.length && got < command.lines; at += 16 * 1024)
        got += stream.pushCode(text.slice(at, at + 16 * 1024)).length;
      const done = now();
      stream.dispose();
      return { importMs: imported - start, totalMs: done - start, lines: got };
    }
  }
}

console.log(JSON.stringify(await main()));
