// The files page owns one virtualizer: drawn files share it, the page sets
// it up when it mounts and cleans it up when it unmounts, and setting up
// again (React's StrictMode runs effects twice, a page mounts again) gives
// back a working instance, never a detached one.

import { describe, expect, it } from "vitest";
import { type Attachable, VirtualizerOwner } from "../app/components/diff/window-virtualizer.js";

class Fake implements Attachable {
  root: unknown = undefined;
  setups = 0;
  setup(root: Document) {
    // As the renderer's: a second setup while set up does nothing.
    if (this.root !== undefined) return;
    this.root = root;
    this.setups++;
  }
  cleanUp() {
    this.root = undefined;
  }
}

const document = { kind: "document" } as unknown as Document;
(globalThis as { document?: unknown }).document = document;

describe("the page's virtualizer", () => {
  it("is made once, by the first file, and set up when the page is attached", () => {
    const owner = new VirtualizerOwner<Fake>();
    const made: Fake[] = [];
    const create = () => {
      const f = new Fake();
      made.push(f);
      return f;
    };
    // A file renders, then the page's effect runs (children's effects first).
    const first = owner.instance(create);
    owner.ready();
    expect(first.root).toBeUndefined();
    owner.attach();
    expect(first.root).toBe(document);
    // Another file drawn later shares it, already set up.
    expect(owner.instance(create)).toBe(first);
    owner.ready();
    expect(made).toHaveLength(1);
    expect(first.setups).toBe(1);
  });

  it("survives its effects run twice (cleaned up, then set up again)", () => {
    const owner = new VirtualizerOwner<Fake>();
    const shared = owner.instance(() => new Fake());
    owner.attach();
    // StrictMode: every effect's clean-up, then every effect again, files before the page.
    owner.detach();
    expect(shared.root).toBeUndefined();
    owner.ready();
    expect(shared.root).toBeUndefined();
    owner.attach();
    expect(shared.root).toBe(document);
    expect(owner.instance(() => new Fake())).toBe(shared);
  });

  it("is cleaned up when the page unmounts, and a page mounted again has a working one", () => {
    const first = new VirtualizerOwner<Fake>();
    const old = first.instance(() => new Fake());
    first.attach();
    first.detach();
    expect(old.root).toBeUndefined();
    const again = new VirtualizerOwner<Fake>();
    const fresh = again.instance(() => new Fake());
    again.attach();
    expect(fresh).not.toBe(old);
    expect(fresh.root).toBe(document);
    // A file drawn on the page mounted again, after it attached.
    again.ready();
    expect(fresh.setups).toBe(1);
  });
});
