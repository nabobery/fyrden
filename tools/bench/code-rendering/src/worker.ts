/**
 * The benchmark's Worker, run by workerd. `POST /render?mode=&name=&lang=&reps=`
 * with the file as the body renders it `reps` times and answers the time
 * taken inside the isolate (the body is read first, outside the timing).
 * `/noop` answers without loading anything (used to see the isolate is up).
 *
 * Local workerd advances `performance.now()` during synchronous work, at
 * 1 ms resolution (measured: a 79 ms loop reads 79); deployed Workers freeze
 * it until I/O, so this measurement is local only.
 */
import { loadRenderer, type Mode, type Render, styledSpans } from "./render.ts";

const renderers = new Map<Mode, Render>();
const encoder = new TextEncoder();

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/noop") return Response.json({ ok: true });
    const mode = url.searchParams.get("mode") as Mode;
    const name = url.searchParams.get("name") ?? "file.txt";
    const lang = url.searchParams.get("lang") ?? "text";
    const reps = Number(url.searchParams.get("reps") ?? "1");
    const text = await request.text();

    const start = performance.now();
    let render = renderers.get(mode);
    if (!render) {
      render = await loadRenderer(mode);
      renderers.set(mode, render);
    }
    const loaded = performance.now();
    let html = "";
    for (let i = 0; i < reps; i++) html = await render(name, lang, text);
    const done = performance.now();
    return Response.json({
      loadMs: loaded - start,
      renderMs: done - loaded,
      totalMs: done - start,
      reps,
      htmlBytes: encoder.encode(html).length,
      spans: styledSpans(html),
    });
  },
};
