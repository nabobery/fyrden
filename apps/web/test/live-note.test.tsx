// What a page listening for live hints tells the viewer while they are not
// coming: paused until a time, or refused for now and retrying; nothing
// while they flow.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveNote } from "../app/lib/use-live.js";

describe("the live note", () => {
  it("says until when live updates are paused, and that the page can still be refreshed", () => {
    const retryAt = Date.UTC(2026, 10, 2);
    const html = renderToString(<LiveNote status={{ kind: "paused", retryAt }} />);
    expect(html).toMatch(/^<p class="muted" role="status">Live updates are paused until/);
    expect(html).toContain('<time dateTime="2026-11-02T00:00:00.000Z">');
    expect(html).toContain(". You can still refresh this page.</p>");
  });

  it("says live updates are retried when refused for now", () => {
    expect(renderToString(<LiveNote status={{ kind: "temporary" }} />)).toBe(
      '<p class="muted" role="status">Live updates are temporarily unavailable. Retrying.</p>',
    );
  });

  it("says nothing while live updates flow", () => {
    expect(renderToString(<LiveNote status={{ kind: "live" }} />)).toBe("");
  });
});
