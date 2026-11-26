/**
 * The bench's worker: builds and keeps copies of one task's
 * `MaskMatcherCache` for a mask shape, drops them, and collects garbage, so
 * the driver can read the heap they retain through the inspector.
 */
import { MaskMatcherCache, maskRows } from "../../../../packages/domain/src/ci/mask.ts";
import { SHAPES } from "./shapes.ts";

let held: MaskMatcherCache[] = [];

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "";
    if (url.pathname === "/list") return Response.json(Object.keys(SHAPES));
    if (url.pathname === "/build") {
      // Own shapes only: a name such as `constructor` must not reach an inherited function.
      const shape = Object.hasOwn(SHAPES, name) ? SHAPES[name] : undefined;
      if (typeof shape !== "function") return new Response(`no shape ${name}`, { status: 404 });
      const copies = Number(url.searchParams.get("copies") ?? "1");
      held = [];
      let masks = shape();
      for (let k = 0; k < copies; k++) {
        masks = shape();
        const cache = new MaskMatcherCache();
        maskRows(masks, null, ["a row of log text"], { start: 1, cache });
        held.push(cache);
      }
      return Response.json({ masks: masks.length, bytes: held[0]?.bytes ?? 0 });
    }
    if (url.pathname === "/drop") {
      held = [];
      return Response.json({});
    }
    if (url.pathname === "/collect") {
      const gc = (globalThis as { gc?: () => void }).gc;
      gc?.();
      return Response.json({ collected: gc !== undefined });
    }
    return new Response("not found", { status: 404 });
  },
};
