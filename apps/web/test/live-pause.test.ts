// A tab's daily pause of live hints, kept per origin and viewer: in the
// tab's storage, checked when read (anything malformed, past or too distant
// let go), and in memory while the storage fails.

import { describe, expect, it } from "vitest";
import { LIVE_PAUSE_MAX_MS } from "../app/lib/live.js";
import { type PauseEnv, readPause, writePause } from "../app/lib/live-pause.js";

const NOW = Date.UTC(2026, 10, 1, 15, 30);
const TOMORROW = Date.UTC(2026, 10, 2);
const pause = { kind: "budget", retryAt: TOMORROW } as const;

/** A tab's storage; `failing`: every call throws, as a blocked or full one does. */
function tab(origin = "https://fyrden.test") {
  const items = new Map<string, string>();
  const state = { failing: false };
  const check = () => {
    if (state.failing) throw new DOMException("blocked", "SecurityError");
  };
  const env: PauseEnv = {
    origin,
    storage: () => ({
      getItem: (key) => {
        check();
        return items.get(key) ?? null;
      },
      setItem: (key, value) => {
        check();
        items.set(key, value);
      },
      removeItem: (key) => {
        check();
        items.delete(key);
      },
    }),
  };
  return { env, items, state };
}

/** A viewer no other test uses (the memory is the module's). */
let viewers = 0;
const someone = () => `usr_${++viewers}`;

describe("a tab's daily pause", () => {
  it("is kept versioned in the tab's storage, and read back until it passes", () => {
    const t = tab();
    const viewer = someone();
    writePause(viewer, pause, t.env);
    expect([...t.items.values()].map((v) => JSON.parse(v))).toEqual([
      { v: 1, kind: "budget", retryAt: TOMORROW },
    ]);
    expect(readPause(viewer, NOW, t.env)).toEqual(pause);
    expect(readPause(viewer, TOMORROW - 1, t.env)).toEqual(pause);
    // Passed: let go.
    expect(readPause(viewer, TOMORROW, t.env)).toBeNull();
    expect(t.items.size).toBe(0);
  });

  it("is a viewer's own, on its origin", () => {
    const t = tab();
    const ada = someone();
    writePause(ada, pause, t.env);
    expect(readPause(someone(), NOW, t.env)).toBeNull();
    expect(readPause(ada, NOW, tab("https://other.test").env)).toBeNull();
    expect(readPause(ada, NOW, t.env)).toEqual(pause);
  });

  it("is let go once cleared", () => {
    const t = tab();
    const viewer = someone();
    writePause(viewer, pause, t.env);
    writePause(viewer, null, t.env);
    expect(t.items.size).toBe(0);
    expect(readPause(viewer, NOW, t.env)).toBeNull();
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ v: 2, kind: "budget", retryAt: TOMORROW })],
    ["another kind", JSON.stringify({ v: 1, kind: "off", retryAt: TOMORROW })],
    ["a string time", JSON.stringify({ v: 1, kind: "budget", retryAt: String(TOMORROW) })],
    ["a fractional time", JSON.stringify({ v: 1, kind: "budget", retryAt: TOMORROW + 0.5 })],
    [
      "a time too far ahead",
      JSON.stringify({ v: 1, kind: "budget", retryAt: NOW + LIVE_PAUSE_MAX_MS + 1 }),
    ],
    ["null", "null"],
  ])("is let go when what is stored is %s", (_, stored) => {
    const t = tab();
    const viewer = someone();
    // Its key, as a pause kept and let go leaves it (and nothing in memory).
    writePause(viewer, pause, t.env);
    const [key] = [...t.items.keys()];
    writePause(viewer, null, t.env);
    t.items.set(key as string, stored);
    expect(readPause(viewer, NOW, t.env)).toBeNull();
    expect(t.items.size).toBe(0);
  });

  it("holds in memory while the storage fails, and only there", () => {
    const t = tab();
    const viewer = someone();
    t.state.failing = true;
    writePause(viewer, pause, t.env);
    expect(readPause(viewer, NOW, t.env)).toEqual(pause);
    // Readable again, the storage has none: the memory's still holds (this page's).
    t.state.failing = false;
    expect(t.items.size).toBe(0);
    expect(readPause(viewer, NOW, t.env)).toEqual(pause);
    expect(readPause(someone(), NOW, t.env)).toBeNull();
    t.state.failing = true;
    writePause(viewer, null, t.env);
    expect(readPause(viewer, NOW, t.env)).toBeNull();
    expect(readPause(viewer, TOMORROW, t.env)).toBeNull();
  });
});
