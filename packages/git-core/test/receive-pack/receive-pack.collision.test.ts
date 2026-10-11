import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { commitBody, memoryServer, packOf, request, treeBody, writeObject } from "./support.js";

/*
 * A pushed object built with a SHA-1 collision attack is refused, as git
 * refuses it. The SHAttered fixtures in test/hash/fixtures are 320-byte
 * file prefixes; stored as a blob, git's "blob <size>\0" header shifts them
 * off the 64-byte block boundaries the attack depends on, so no real git
 * object made from them collides. This test therefore injects the collision
 * through the hasher path instead: the object-id hasher (git-core's `Sha1`,
 * which `receivedObjectId` uses for every received object) is wrapped so
 * that it raises `Sha1CollisionError` for one marked blob, exactly where
 * SHA-1DC would. The detector itself is tested on the fixtures in
 * test/hash/sha1dc.test.ts.
 */

const { MARKER } = vi.hoisted(() => ({ MARKER: "THIS BLOB COLLIDES" }));

vi.mock("../../src/hash/sha1.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/hash/sha1.js")>();
  const marker = new TextEncoder().encode(MARKER);
  const contains = (data: Uint8Array) => {
    outer: for (let i = 0; i + marker.length <= data.length; i++) {
      for (let k = 0; k < marker.length; k++) if (data[i + k] !== marker[k]) continue outer;
      return true;
    }
    return false;
  };
  class InjectedSha1 extends real.Sha1 {
    #attack = false;
    override update(data: Uint8Array): this {
      if (contains(data)) this.#attack = true;
      return super.update(data);
    }
    override digest(): Uint8Array {
      const digest = super.digest();
      if (this.#attack) throw new real.Sha1CollisionError(digest);
      return digest;
    }
  }
  return { ...real, Sha1: InjectedSha1 };
});

let sandbox: GitSandbox;
beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
});
afterAll(() => sandbox.dispose());

describe("receive-pack: SHA-1 collision attacks", () => {
  it("refuses a push holding an object that trips collision detection", async () => {
    const server = memoryServer();
    const blob = await writeObject(sandbox, "blob", `${MARKER}\n`);
    const tree = await writeObject(sandbox, "tree", treeBody([["100644", "pdf", blob]]));
    const commit = await writeObject(sandbox, "commit", commitBody(tree));
    const result = await server.push(
      request(
        [{ new: commit, ref: "refs/heads/main" }],
        await packOf(sandbox, [blob, tree, commit]),
      ),
    );
    expect(result.lines).toEqual([
      "unpack index-pack abnormal exit",
      "ng refs/heads/main unpacker error",
    ]);
    expect(result.result?.messages.join("\n")).toMatch(
      /^fatal: SHA-1 appears to be part of a collision attack: [0-9a-f]{40}$/m,
    );
    expect((await server.refStore.readRefs()).refs.size).toBe(0);
    expect(await server.packStore.listPacks()).toEqual([]);
  });

  it("accepts the same push without the marked blob", async () => {
    const server = memoryServer();
    const blob = await writeObject(sandbox, "blob", "harmless\n");
    const tree = await writeObject(sandbox, "tree", treeBody([["100644", "pdf", blob]]));
    const commit = await writeObject(sandbox, "commit", commitBody(tree));
    const result = await server.push(
      request(
        [{ new: commit, ref: "refs/heads/main" }],
        await packOf(sandbox, [blob, tree, commit]),
      ),
    );
    expect(result.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
  });
});
