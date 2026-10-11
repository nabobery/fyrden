import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGitSandbox, type GitSandbox } from "../../testing/git-cli.js";
import { commitBody, memoryServer, packOf, request, treeBody, writeObject } from "./support.js";

/*
 * Re-authorization at the commit point (engine half): the push calls the
 * injected re-authorization once, after indexing and before any ref
 * transaction. A revoked token or grant (the callback refuses) aborts the
 * push with refs unchanged, whenever the revocation happened; a token that
 * only expired during an accepted upload is not a refusal (the callback
 * decides, as the Durable Object's does from the primary).
 */

let sandbox: GitSandbox;
let tree: string;
let blob: string;

beforeAll(async () => {
  sandbox = await createGitSandbox();
  await sandbox.git(["init", "-q", "-b", "main"]);
  blob = await writeObject(sandbox, "blob", "x\n");
  tree = await writeObject(sandbox, "tree", treeBody([["100644", "x", blob]]));
});
afterAll(() => sandbox.dispose());

interface Token {
  revoked: boolean;
  grantRevoked: boolean;
  expired: boolean;
}

/** The commit-point check of the Durable Object, over a fake token. */
function reauthorize(token: Token) {
  return async () => {
    if (token.revoked) return "push refused: the token was revoked";
    if (token.grantRevoked) return "push refused: the grant was revoked";
    // Expiry after the upload was accepted does not abort it.
    return undefined;
  };
}

async function newPush(message: string) {
  const commit = await writeObject(sandbox, "commit", commitBody(tree, [], message));
  return request(
    [{ new: commit, ref: "refs/heads/main" }],
    await packOf(sandbox, [blob, tree, commit]),
  );
}

describe("push.revoke-during-upload", () => {
  for (const [what, flip] of [
    ["token", (t: Token) => (t.revoked = true)],
    ["grant", (t: Token) => (t.grantRevoked = true)],
  ] as const) {
    it(`aborts with refs unchanged when the ${what} is revoked during the upload`, async () => {
      const server = memoryServer();
      const token: Token = { revoked: false, grantRevoked: false, expired: false };
      const body = await newPush(`upload-${what}`);
      flip(token); // between the upload and indexing
      const result = await server.push(body, { finalize: { reauthorize: reauthorize(token) } });
      expect(result.lines).toEqual([
        "unpack ok",
        `ng refs/heads/main push refused: the ${what} was revoked`,
      ]);
      expect((await server.refStore.readRefs()).refs.size).toBe(0);
      expect(await server.packStore.listPacks()).toEqual([]);
    });

    it(`aborts with refs unchanged when the ${what} is revoked during indexing`, async () => {
      const server = memoryServer();
      const token: Token = { revoked: false, grantRevoked: false, expired: false };
      let checkpoints = 0;
      const result = await server.push(await newPush(`index-${what}`), {
        finalize: { reauthorize: reauthorize(token) },
        onCheckpoint: () => {
          // Revoked after the parse phase, while the job still runs.
          if (++checkpoints === 1) flip(token);
        },
      });
      expect(checkpoints).toBeGreaterThan(1);
      expect(result.lines[1]).toBe(`ng refs/heads/main push refused: the ${what} was revoked`);
      expect((await server.refStore.readRefs()).refs.size).toBe(0);
    });
  }

  it("completes when the token merely expired during an accepted upload", async () => {
    const server = memoryServer();
    const token: Token = { revoked: false, grantRevoked: false, expired: false };
    let calls = 0;
    const result = await server.push(await newPush("expired"), {
      onCheckpoint: () => {
        token.expired = true;
      },
      finalize: {
        reauthorize: async () => {
          calls++;
          return reauthorize(token)();
        },
      },
    });
    expect(token.expired).toBe(true);
    expect(calls).toBe(1);
    expect(result.lines).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect((await server.refStore.readRefs()).refs.size).toBe(1);
  });

  it("does not re-authorize a push that failed before the commit point", async () => {
    const server = memoryServer();
    let calls = 0;
    const result = await server.push(
      request([{ new: "1".repeat(40), ref: "refs/heads/main" }], await packOf(sandbox, [])),
      {
        finalize: {
          reauthorize: async () => {
            calls++;
            return undefined;
          },
        },
      },
    );
    expect(result.lines).toEqual(["unpack ok", "ng refs/heads/main missing necessary objects"]);
    expect(calls).toBe(0);
  });
});
