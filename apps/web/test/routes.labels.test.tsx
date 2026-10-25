// Labels: the page lists a repository's labels a page at a time, each a
// chip in its colour with text that contrasts with it and a link to its
// issues; write access creates, edits (from the version and id the form
// showed) and deletes them, and copies the default set in. Hostile names
// and descriptions are text, never markup.

import { describe, expect, it } from "vitest";
import { colorOf, labelIssues, textOn } from "../app/lib/labels.js";
import { action, default as Labels, loader } from "../app/routes/repo.labels.js";
import { formPost, json, ORIGIN } from "./helpers/context.js";
import { api, pathOf, repo, VIEWER } from "./helpers/pulls.js";
import { ACTIVE_TAG, escaped, HOSTILE, renderPage } from "./helpers/render.js";

const params = { owner: "ada", repo: "demo" };
const ALL = { admin: true, maintain: true, push: true, triage: true, pull: true };
const READ_ONLY = { admin: false, maintain: false, push: false, triage: false, pull: true };

function label(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `label ${id}`,
    color: "d73a4a",
    description: null,
    default: false,
    version: 1,
    ...overrides,
  };
}

const pageData = (overrides: Record<string, unknown> = {}) => ({
  repo: { ...repo, permissions: ALL },
  at: { owner: "ada", repo: "demo" },
  origin: ORIGIN,
  labels: [label(1)],
  pages: { next: null, first: null },
  viewer: VIEWER,
  viewerKnown: true,
  ...overrides,
});

describe("a label's colour", () => {
  it("is taken as six hex digits, with or without its #", () => {
    expect(colorOf("#D73A4A")).toBe("d73a4a");
    expect(colorOf(" 0e8a16 ")).toBe("0e8a16");
    for (const bad of ["", "#fff", "red", "#12345g", "1234567"]) expect(colorOf(bad)).toBeNull();
  });

  it("chooses black or white text, whichever contrasts more", () => {
    expect(textOn("ffffff")).toBe("#000000");
    expect(textOn("000000")).toBe("#ffffff");
    expect(textOn("fbca04")).toBe("#000000");
    expect(textOn("0052cc")).toBe("#ffffff");
    // Every colour reads at 4.5:1 or more against one of them.
    const ratio = (hex: string) => {
      const l = [0, 2, 4]
        .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      const lum = 0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0);
      return textOn(hex) === "#000000" ? (lum + 0.05) / 0.05 : 1.05 / (lum + 0.05);
    };
    for (let v = 0; v <= 0xffffff; v += 0x010101 * 7 + 0x000301)
      expect(ratio(v.toString(16).padStart(6, "0"))).toBeGreaterThanOrEqual(4.5);
  });

  it("links its issues by name, or by id for a name holding a comma", () => {
    expect(labelIssues("ada", "demo", label(3, { name: "good first issue" }))).toBe(
      "/ada/demo/issues?labels=good+first+issue",
    );
    expect(labelIssues("ada", "demo", label(3, { name: "a,b" }))).toBe(
      "/ada/demo/issues?label_ids=3",
    );
  });
});

describe("the labels page", () => {
  it("asks for the repository, a page of labels after the cursor, and the viewer", async () => {
    const { context, calls } = api({
      "GET /api/repos/ada/demo": () => json({ ...repo, permissions: ALL }),
      "GET /api/repos/ada/demo/labels": () => json({ labels: [label(1)], next_cursor: "N" }),
    });
    const data = await loader({
      request: new Request(`${ORIGIN}/ada/demo/labels?cursor=C`, {
        headers: { Cookie: "fyrden_session=s" },
      }),
      context,
      params,
    } as never);
    expect(calls.map(pathOf)).toContain("GET /api/repos/ada/demo/labels?per_page=100&cursor=C");
    expect(data).toMatchObject({
      at: { owner: "ada", repo: "demo" },
      labels: [label(1)],
      pages: { next: "/ada/demo/labels?cursor=N", first: "/ada/demo/labels" },
      viewer: VIEWER,
    });
  });

  it("shows each label in its colour, hostile names and descriptions as text", () => {
    const html = renderPage(
      Labels,
      "/ada/demo/labels",
      pageData({ labels: [label(1, { name: HOSTILE, description: HOSTILE, color: "fbca04" })] }),
    );
    expect(html).toContain(escaped(HOSTILE));
    expect(html).not.toMatch(ACTIVE_TAG);
    expect(html).toContain("background-color:#fbca04;color:#000000");
  });

  it("shows its answer on a page whose URL spells the repository otherwise", () => {
    // Scoped by the URL's names, as the action scoped it.
    const html = renderPage(
      Labels,
      "/ADA/Demo/labels",
      pageData({ at: { owner: "ADA", repo: "Demo" } }),
      {
        error: "Give it a name and a colour.",
        scope: { viewer: VIEWER, owner: "ADA", repo: "Demo", page: "labels" },
        draft: { fields: { name: "mine", color: "00ff00", description: "" } },
      },
    );
    expect(html).toContain("Give it a name and a colour.");
    expect(html).toContain('value="mine"');
  });

  it("offers write access every change, a reader none", () => {
    const writer = renderPage(Labels, "/ada/demo/labels", pageData());
    for (const text of ["New label", "Edit", "Delete label", "Copy the default labels"])
      expect(writer, text).toContain(text);
    expect(writer).toMatch(
      /name="intent" value="edit"\/><input type="hidden" name="label_id" value="1"\/><input type="hidden" name="name" value="label 1"\/><input type="hidden" name="version" value="1"/,
    );
    const reader = renderPage(
      Labels,
      "/ada/demo/labels",
      pageData({ repo: { ...repo, permissions: READ_ONLY } }),
    );
    for (const text of ["New label", "Delete label", "Copy the default labels"])
      expect(reader, text).not.toContain(text);
    expect(reader).not.toMatch(/name="intent"/);
  });

  it("keeps a refused edit's draft and version, and shows one for a label not on the page to copy", () => {
    const scope = { viewer: VIEWER, owner: "ada", repo: "demo", page: "labels" };
    const html = renderPage(
      Labels,
      "/ada/demo/labels",
      pageData({ labels: [label(1, { version: 4 })] }),
      {
        error: "Someone changed it",
        scope,
        draft: {
          fields: { name: "renamed", color: "00ff00", description: "" },
          version: 3,
          target: 1,
        },
      },
    );
    expect(html).toContain('value="renamed"');
    expect(html).toMatch(
      /name="label_id" value="1"\/><input type="hidden" name="name" value="label 1"\/><input type="hidden" name="version" value="3"/,
    );
    const away = renderPage(Labels, "/ada/demo/labels", pageData({ labels: [] }), {
      error: "Someone changed it",
      scope,
      draft: {
        fields: { name: "gone one", color: "00ff00", description: "" },
        version: 3,
        target: 9,
      },
    });
    expect(away).toContain("Your unsent text");
    expect(away).toContain("gone one");
    // Another viewer's draft is never shown.
    const theirs = renderPage(Labels, "/ada/demo/labels", pageData(), {
      error: "x",
      scope: { ...scope, viewer: "usr_other" },
      draft: { fields: { name: "secret", color: "00ff00", description: "" }, target: 1 },
    });
    expect(theirs).not.toContain("secret");
  });
});

describe("changing labels", () => {
  async function act(fields: Record<string, string>, reply = () => json(label(1))) {
    const { context, calls } = api({
      "POST /api/repos/ada/demo/labels": () => json(label(2), 201),
      "PATCH /api/repos/ada/demo/labels/label%201": reply,
      "DELETE /api/repos/ada/demo/labels/label%201": () =>
        json({ name: "label 1", state: "deleted" }),
      "POST /api/repos/ada/demo/labels/defaults": () => json({ labels: [] }, 201),
    });
    const outcome = await action({
      request: formPost("/ada/demo/labels", { viewer: VIEWER, ...fields }),
      context,
      params,
    } as never);
    const sent = calls.find((c) => c.method !== "GET" && !c.url.includes("/auth/"));
    return {
      outcome,
      sent: sent && {
        path: pathOf(sent),
        body: await sent.text().then((t) => (t ? JSON.parse(t) : undefined)),
      },
    };
  }

  it("creates, edits from the id and version shown, deletes and copies the defaults", async () => {
    expect(
      (await act({ intent: "create", name: " bug ", color: "#D73A4A", description: "" })).sent,
    ).toEqual({
      path: "POST /api/repos/ada/demo/labels",
      body: { name: "bug", color: "d73a4a" },
    });
    const edited = await act({
      intent: "edit",
      label_id: "1",
      name: "label 1",
      new_name: "label one",
      color: "#00ff00",
      description: "",
      version: "3",
    });
    expect(edited.sent).toEqual({
      path: "PATCH /api/repos/ada/demo/labels/label%201",
      body: {
        new_name: "label one",
        color: "00ff00",
        description: null,
        expected_id: 1,
        expected_version: 3,
      },
    });
    expect(edited.outcome).toMatchObject({ ok: "edit", target: 1 });
    expect(
      (await act({ intent: "delete", label_id: "1", name: "label 1", version: "3" })).sent,
    ).toEqual({
      path: "DELETE /api/repos/ada/demo/labels/label%201",
      body: { expected_id: 1, expected_version: 3 },
    });
    expect((await act({ intent: "copy-defaults" })).sent?.path).toBe(
      "POST /api/repos/ada/demo/labels/defaults",
    );
  });

  it("sends nothing malformed, and keeps a refused edit's draft", async () => {
    for (const bad of [
      { intent: "create", name: "bug", color: "red" },
      { intent: "create", name: "", color: "#000000" },
      { intent: "edit", label_id: "x", name: "label 1", new_name: "a", color: "#000000" },
    ]) {
      const { sent, outcome } = await act(bad);
      expect(sent, JSON.stringify(bad)).toBeUndefined();
      expect(outcome).toMatchObject({ error: expect.any(String) });
    }
    const stale = await act(
      {
        intent: "edit",
        label_id: "1",
        name: "label 1",
        new_name: "mine",
        color: "#00ff00",
        description: "d",
        version: "3",
      },
      () => json({ code: "stale", detail: "d", current_version: 4 }, 409),
    );
    expect(stale.outcome).toMatchObject({
      error: expect.stringContaining("Someone changed it"),
      draft: { fields: { name: "mine", color: "00ff00", description: "d" }, version: 3, target: 1 },
    });
  });

  it("keeps the version a refused-here edit was written from", async () => {
    // Refused before it is sent (an empty name): its draft still carries version 3, so the
    // corrected one is checked against what it was written from, not the page's newer one.
    const { sent, outcome } = await act({
      intent: "edit",
      label_id: "1",
      name: "label 1",
      new_name: "  ",
      color: "#00ff00",
      description: "",
      version: "3",
    });
    expect(sent).toBeUndefined();
    expect(outcome).toMatchObject({ draft: { version: 3, target: 1 } });
  });

  it("sends nothing from a form made for another viewer", async () => {
    const { context, calls } = api({});
    const outcome = await action({
      request: formPost("/ada/demo/labels", { viewer: "usr_other", intent: "copy-defaults" }),
      context,
      params,
    } as never);
    expect(outcome).toMatchObject({ error: expect.stringContaining("someone else") });
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
