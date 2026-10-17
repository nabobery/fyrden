import { createContext, type ReactNode, useEffect, useState } from "react";

/** What the owner drives: the diff renderer's virtualizer, set up on the window's scroll. */
export interface Attachable {
  setup(root: Document): void;
  cleanUp(): void;
}

/**
 * The page's one virtualizer and whether the page is attached to the window:
 * the files drawn share the instance (made on first use, by the renderer's
 * module); the page sets it up when it mounts and cleans it up when it
 * unmounts. Setting up again after a clean-up reconnects the same instance,
 * so an effect run twice (React's StrictMode) or a page mounted again keeps
 * working: the drawn files connect to it from their own effects, queued
 * until it is set up.
 */
export class VirtualizerOwner<T extends Attachable = Attachable> {
  #instance: T | undefined;
  #attached = false;

  /** The shared instance, made with `create` the first time (not set up: see `ready`). */
  instance(create: () => T): T {
    this.#instance ??= create();
    return this.#instance;
  }

  /** Sets the instance up if the page is attached (a file drawn after the page mounted). */
  ready(): void {
    if (this.#attached) this.#instance?.setup(document);
  }

  attach(): void {
    this.#attached = true;
    this.#instance?.setup(document);
  }

  detach(): void {
    this.#attached = false;
    this.#instance?.cleanUp();
  }
}

export const VirtualizerOwnerContext = createContext<VirtualizerOwner | null>(null);

/** Gives the files under it one virtualizer, owned by this page. */
export function WindowVirtualizer({ children }: { children: ReactNode }) {
  const [owner] = useState(() => new VirtualizerOwner());
  useEffect(() => {
    owner.attach();
    return () => owner.detach();
  }, [owner]);
  return (
    <VirtualizerOwnerContext.Provider value={owner}>{children}</VirtualizerOwnerContext.Provider>
  );
}
