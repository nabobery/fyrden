// Unsent text on the files page is kept by pull request and by who is
// signed in: after the account changes (in another tab), the page never
// shows or sends one account's draft, or its reply's answer, as another's.

import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Drafts, draftsFor, useScopedKey } from "../app/components/drafts.js";
import { useDrafts } from "../app/components/kept-drafts.js";

const PAGE = "/ada/demo/pull/7";

function Key({ name }: { name: string }) {
  return <>{useScopedKey(name)}</>;
}

describe("drafts", () => {
  it("are keyed by pull request and viewer, fetchers too", () => {
    const keyAs = (viewer: string | null, page = PAGE) =>
      renderToString(
        <Drafts viewer={viewer} page={page}>
          <Key name="reply:1" />
        </Drafts>,
      );
    const keys = [keyAs("usr_a"), keyAs("usr_b"), keyAs(null), keyAs("usr_a", "/ada/demo/pull/8")];
    expect(new Set(keys).size).toBe(4);
    expect(keyAs("usr_a")).toBe(keys[0]);
  });

  it("are dropped when the viewer changes, and kept while it does not", () => {
    const a = draftsFor(undefined, "usr_a");
    a.store.set("reply:1", "Written as a.");
    expect(draftsFor(a, "usr_a")).toBe(a);
    const b = draftsFor(a, "usr_b");
    expect(b.viewer).toBe("usr_b");
    expect(b.store.get("reply:1")).toBe("");
    // Back to the first account: what it wrote went with the change.
    expect(draftsFor(b, "usr_a").store.get("reply:1")).toBe("");
  });
});

function Editor({ write, scope = "usr_a|ada/demo#7" }: { write?: string; scope?: string }) {
  const drafts = useDrafts(scope, undefined, {
    ofDraft: () => "body",
    ofAnswer: () => undefined,
  });
  if (write !== undefined) drafts.write("body", { fields: { body: write } });
  return <>{String(drafts.get("body")?.fields.body ?? "(none)")}</>;
}

describe("an issue page's unsent drafts", () => {
  it("outlive the page that held them in the browser, as when an error page replaced it", () => {
    const global = globalThis as { window?: unknown };
    global.window = {};
    try {
      renderToString(<Editor write="Half written." />);
      // The page drawn again (it came back after a failed reload): its draft is there.
      expect(renderToString(<Editor />)).toBe("Half written.");
      // Another viewer's, or another issue's, is not.
      expect(renderToString(<Editor scope="usr_b|ada/demo#7" />)).toBe("(none)");
    } finally {
      delete global.window;
    }
  });

  it("are never shared between a server's renders", () => {
    renderToString(<Editor write="Mine." scope="usr_c|ada/demo#7" />);
    expect(renderToString(<Editor scope="usr_c|ada/demo#7" />)).toBe("(none)");
  });
});
